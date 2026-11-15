import { createMemoryPort } from '../../src/memory/port.js'
import { recallForTurn, searchHistory, searchMemory } from '../../src/memory/recall.js'
import { forgetItem } from '../../src/memory/store.js'
import type { ProposedOperation } from '../../src/memory/validate.js'
import { type MemoryWorker, createMemoryWorker } from '../../src/memory/worker.js'
import type { ModelClient } from '../../src/models/types.js'
import type { Storage } from '../../src/storage/database.js'
import { releaseLeases } from '../../src/storage/leases.js'
import {
  activeChat,
  itemsOf,
  memoryConfig,
  quietLogger,
  say,
  scriptedJudge,
  scriptedModel,
  subject
} from '../support/memory.js'

// The memory simulator (docs/trd/harness.md#memory-simulator): generated chats and members, scripted facts,
// corrections, retractions and upcoming changes, and the ground truth of what should be remembered. It drives the
// real write path and recall. The model and the judge are scripted: no live call is made. Everything is invented.

const THINGS = ['favourite drink', 'home town', 'pet name', 'work place', 'weekend sport', 'lucky colour'] as const
const WORDS = ['amber', 'birch', 'cedar', 'delta', 'ember', 'fjord', 'grove', 'harbor'] as const
const NOISE = ['hi', 'haha ok', 'good morning all', 'lol', 'see you'] as const

/** A small seeded generator, so a failing seed can be run again. */
function rng(seed: number): () => number {
  let state = seed >>> 0 || 1
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}

export interface SimChat {
  chatId: string
  /** A token no other chat's values hold, to tell whose text a line is. */
  mark: string
  members: string[]
  /** The ground truth: what should be remembered now, by subject and key. */
  truth: Map<string, { subjectId: string; key: string; value: string }>
  /** Values that were said and must not be remembered: corrected, retracted, forgotten, gossip, questions. */
  gone: Set<string>
  notes: string[]
}

export interface Simulation {
  storage: Storage
  chats: SimChat[]
  clock: { at: Date }
  model: ReturnType<typeof scriptedModel>
  worker: MemoryWorker
  /** Writes a few scripted messages into every chat. */
  talk(rounds: number): void
  /** Lets the time pass that closes every episode, then runs jobs until none is left. */
  drain(workers?: MemoryWorker[]): Promise<void>
  newWorker(owner: string, client?: ModelClient): MemoryWorker
  /** Forgets one remembered fact of a chat by id, as the tool does. Returns its value. */
  forgetOne(chat: SimChat): string | undefined
  note(chat: SimChat): Promise<void>
}

const keyOf = (thing: string): string => thing.replace(' ', '.')
const slot = (subjectId: string, key: string): string => `${subjectId}|${key}`

/** The scripted model: it reads the excerpt as a careless model would, and proposes more than it should. */
function naiveModel(): ReturnType<typeof scriptedModel> {
  return scriptedModel((episode) => {
    const operations: ProposedOperation[] = []
    const labels = [...new Set([...episode.matchAll(/^(member \d+): /gm)].map((match) => match[1] as string))]
    for (const line of episode.split('\n')) {
      const said = /^(member \d+): (.*)$/.exec(line)
      if (!said) continue
      const [, label, text] = said as unknown as [string, string, string]
      const other = labels.find((candidate) => candidate !== label) ?? 'member 9'
      const add = (subject: string, thing: string, value: string, validUntil?: string): void => {
        operations.push({
          op: 'add',
          subject,
          key: keyOf(thing),
          value,
          quote: text,
          ...(validUntil === undefined ? {} : { validUntil })
        })
      }
      const stated = /^my (.+) is (.+)$/.exec(text)
      const dropped = /^i no longer have a (.+)$/.exec(text)
      const planned = /^from next month my (.+) will be (.+)$/.exec(text)
      const gossip = /^i heard their (.+) is (.+)$/.exec(text)
      const asked = /^is your (.+) still (.+)\?$/.exec(text)
      if (stated) add(label, stated[1] as string, stated[2] as string)
      else if (dropped) operations.push({ op: 'retire', subject: label, key: keyOf(dropped[1] as string), quote: text })
      else if (planned) add(label, planned[1] as string, planned[2] as string, '2099-01-01T00:00:00.000Z')
      // Gossip: the careless model files it under the other member. A question: under the one who asked.
      else if (gossip) add(other, gossip[1] as string, gossip[2] as string)
      else if (asked) add(label, asked[1] as string, asked[2] as string)
    }
    // And it invents: a quote nobody wrote, a member that is not there, a reserved key.
    const first = labels[0] ?? 'member 1'
    operations.push({
      op: 'add',
      subject: first,
      key: 'secret.plan',
      value: 'invented',
      quote: 'i never said this at all'
    })
    operations.push({
      op: 'add',
      subject: 'member 99',
      key: 'home.town',
      value: 'nowhere',
      quote: 'i never said this at all'
    })
    operations.push({
      op: 'add',
      subject: first,
      key: 'note.fake',
      value: 'invented',
      quote: 'i never said this at all'
    })
    return { operations }
  })
}

export function createSimulation(storage: Storage, seed: number): Simulation {
  const random = rng(seed)
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T
  const clock = { at: new Date('2026-04-01T08:00:00.000Z') }
  const now = () => clock.at
  const tick = (ms: number) => {
    clock.at = new Date(clock.at.getTime() + ms)
  }

  // Five people. Each chat holds some of them, so one person is in several chats with the same subject id.
  const people = [1, 2, 3, 4, 5].map((index) => subject(storage, `test-sim-person-${index}`))
  const chats: SimChat[] = [0, 1, 2, 3, 4].map((index) => {
    const type = index < 3 ? 'group' : 'dm'
    const members = type === 'dm' ? [people[index - 3] as string] : people.filter((_, at) => (at + index) % 5 < 3)
    return {
      chatId: activeChat(storage, `test-sim-chat-${index}`, type),
      mark: `zq${'abcde'[index]}`,
      members,
      truth: new Map(),
      gone: new Set(),
      notes: []
    }
  })

  const model = naiveModel()
  const judge = scriptedJudge()
  const config = { ...memoryConfig, memory: { episodeIdleMs: 180_000, episodeMaxMessages: 6 } }
  const newWorker = (owner: string, client: ModelClient = model): MemoryWorker =>
    createMemoryWorker({ storage, config, client, judge, logger: quietLogger, owner, now })
  const worker = newWorker('sim-1')
  const port = createMemoryPort({ storage, judge, verifyThreshold: 0.5, timeoutMs: 200 })

  let serial = 0
  const value = (chat: SimChat): string => {
    serial += 1
    return `${pick(WORDS)} ${chat.mark}${serial}k`
  }
  const post = (chat: SimChat, senderId: string, text: string): void => {
    tick(20_000)
    say(storage, { chatId: chat.chatId, senderId, text, at: clock.at })
  }

  const step = (chat: SimChat): void => {
    const member = pick(chat.members)
    const thing = pick(THINGS)
    const key = keyOf(thing)
    const roll = random()
    const current = chat.truth.get(slot(member, key))
    if (roll < 0.4) {
      const next = value(chat)
      if (current) chat.gone.add(current.value)
      chat.truth.set(slot(member, key), { subjectId: member, key, value: next })
      post(chat, member, `my ${thing} is ${next}`)
    } else if (roll < 0.5 && current) {
      chat.gone.add(current.value)
      chat.truth.delete(slot(member, key))
      post(chat, member, `i no longer have a ${thing}`)
    } else if (roll < 0.6) {
      // An upcoming change is stored beside the active fact. It is not part of the active ground truth.
      post(chat, member, `from next month my ${thing} will be ${value(chat)}`)
    } else if (roll < 0.75) {
      const gossip = value(chat)
      chat.gone.add(gossip)
      post(chat, member, `i heard their ${thing} is ${gossip}`)
    } else if (roll < 0.85) {
      const asked = value(chat)
      chat.gone.add(asked)
      post(chat, member, `is your ${thing} still ${asked}?`)
    } else {
      post(chat, member, pick(NOISE))
    }
    if (random() < 0.3) {
      tick(5_000)
      say(storage, { chatId: chat.chatId, text: 'ok, noted', at: clock.at })
    }
  }

  return {
    storage,
    chats,
    clock,
    model,
    worker,
    newWorker,
    talk(rounds) {
      for (let round = 0; round < rounds; round += 1) for (const chat of chats) step(chat)
    },
    async drain(workers = [worker]) {
      tick(600_000)
      for (let guard = 0; guard < 500; guard += 1) {
        const results = await Promise.all(workers.map((each) => each.tick()))
        if (results.every((result) => result === 'idle')) return
      }
      throw new Error('the simulator did not drain')
    },
    forgetOne(chat) {
      const target = [...chat.truth.values()][0]
      if (!target) return undefined
      // As the tool does: search first, then forget exactly one fact by its id.
      const found = port.recall(chat.chatId, target.value, 8).find((candidate) => candidate.text.includes(target.value))
      if (!found) throw new Error('a remembered fact was not found by recall')
      if (!storage.tx((db) => forgetItem(db, chat.chatId, found.itemId, now))) throw new Error('forget found no fact')
      chat.truth.delete(slot(target.subjectId, target.key))
      chat.gone.add(target.value)
      return target.value
    },
    async note(chat) {
      const member = pick(chat.members)
      const text = `remember the gate code word is ${value(chat)}`
      const checked = await port.checkNote(
        { chatId: chat.chatId, subjectId: member, text },
        new AbortController().signal
      )
      if (!checked.ok) throw new Error(`the note was refused: ${checked.reason}`)
      storage.tx((db) => port.note(db, { chatId: chat.chatId, subjectId: member, text, turnId: 'sim-no-turn' }))
      chat.notes.push(text)
    }
  }
}

/** What the store holds as active facts of a chat, without notes: `subject|key|value`. */
export function activeFacts(storage: Storage, chat: SimChat): Set<string> {
  return new Set(
    itemsOf(storage, chat.chatId)
      .filter((item) => item.kind === 'fact' && item.status === 'active' && !item.key?.startsWith('note.'))
      .map((item) => `${item.subject_id}|${item.key}|${item.value}`)
  )
}

/** Everything a turn or a tool of this chat can read from memory, as one text. */
export function everythingRecalled(sim: Simulation, chat: SimChat, queries: string[]): string {
  const present = new Map(chat.members.map((member, index) => [member, `member ${index + 1}`]))
  const parts: string[] = []
  for (const query of queries) {
    parts.push(...searchMemory(sim.storage, chat.chatId, query, 50).map((item) => `${item.key} ${item.value}`))
    parts.push(...searchHistory(sim.storage, chat.chatId, query, 50).map((item) => item.text))
    parts.push(
      ...recallForTurn(sim.storage, { chatId: chat.chatId, present, queryTexts: [query], tokenBudget: 100_000 })
    )
  }
  return parts.join('\n')
}

/** Simulates a crash: every lease returns to the queue, as the start-up recovery pass does. */
export function crashRecovery(storage: Storage): number {
  return releaseLeases(storage, 'memory_job')
}
