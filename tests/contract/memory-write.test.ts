import { describe, expect, it } from 'vitest'
import { closeDueEpisodes } from '../../src/memory/episodes.js'
import { episodeText } from '../../src/memory/extract.js'
import { searchMemory } from '../../src/memory/recall.js'
import { addNote, applyOperation, forgetBarrier, forgetItem, setLingo } from '../../src/memory/store.js'
import { FORGOTTEN_MESSAGE } from '../../src/memory/types.js'
import {
  type EpisodeMessage,
  memberLabels,
  type ProposedOperation,
  precheck,
  validateOperation,
  validateSummary
} from '../../src/memory/validate.js'
import { createMemoryWorker, RETRY_DELAYS_MS } from '../../src/memory/worker.js'
import { ModelError } from '../../src/models/types.js'
import { setSetting } from '../../src/settings/settings.js'
import type { Storage } from '../../src/storage/database.js'
import { openTurn, receiveInbound } from '../../src/storage/turns.js'
import type { AlertKind } from '../../src/turn/alerts.js'
import {
  activeChat,
  eventsOf,
  itemsOf,
  memoryConfig,
  quietLogger,
  say,
  scriptedJudge,
  scriptedModel,
  subject
} from '../support/memory.js'
import { tmpStorage } from '../support/tmp.js'

// The write path of docs/trd/memory.md: steps 2 to 10. Every name and message is invented.

const T0 = new Date('2026-03-01T10:00:00.000Z')
const later = (minutes: number) => new Date(T0.getTime() + minutes * 60_000)

const user = (id: number, senderId: string, content: string, skip = false): EpisodeMessage => ({
  id,
  role: 'user',
  senderId,
  content,
  skip
})
const bot = (id: number, content: string): EpisodeMessage => ({ id, role: 'assistant', content, skip: false })
const propose = (operation: Partial<ProposedOperation>): ProposedOperation => ({
  op: 'add',
  subject: 'member 1',
  key: 'likes.drink',
  value: 'teh tarik',
  quote: 'i really like teh tarik',
  ...operation
})

describe('precheck (step 4)', () => {
  it('drops an episode no message of which could support a fact', () => {
    expect(precheck([user(1, 'a', 'hi'), user(2, 'b', 'haha ok'), bot(3, 'I like long walks on the beach')])).toBe(
      false
    )
    expect(precheck([user(1, 'a', 'do you like teh tarik?')])).toBe(false)
    expect(precheck([user(1, 'a', 'I really like teh tarik', true)])).toBe(false)
    expect(precheck([user(1, 'a', FORGOTTEN_MESSAGE)])).toBe(false)
    expect(precheck([user(1, 'a', '[AIRA-SCHEDULED v1 kind=reminder owner=a] buy three bags of rice')])).toBe(false)
    expect(precheck([user(1, 'a', 'MEDIA:/data/files/one two three.jpg')])).toBe(false)
    expect(precheck([user(1, 'a', 'hi'), user(2, 'b', 'I really like teh tarik')])).toBe(true)
  })
})

describe('validateOperation (step 7)', () => {
  const messages = [
    user(1, 'alice', 'I really like *teh tarik*, two cups a day'),
    user(2, 'bob', 'alice also moved to the green house last year'),
    bot(3, 'Noted, the assistant prefers black coffee always'),
    user(4, 'bob', 'is it true you all moved to the green house?'),
    user(5, 'alice', 'my secret code is kept in the drawer', true),
    user(6, 'bob', 'we all agreed the trip is on friday\nMEDIA:/data/files/plan of the trip.jpg'),
    user(7, 'alice', '[AIRA-SCHEDULED v1 kind=reminder owner=alice] alice pays the rent on monday')
  ]
  const labels = memberLabels(messages)
  const check = (operation: Partial<ProposedOperation>) => validateOperation(propose(operation), messages, labels)

  it('labels members by order of first message', () => {
    expect([...labels]).toEqual([
      ['alice', 'member 1'],
      ['bob', 'member 2']
    ])
  })

  it('accepts a fact a member states about themselves, and records the message that said it', () => {
    expect(check({ value: 'teh tarik, 2 cups a day', quote: 'I really like teh tarik, two cups' })).toEqual({
      ok: false,
      reason: 'number_not_in_message'
    })
    const checked = check({})
    expect(checked).toEqual({
      ok: true,
      operation: {
        op: 'add',
        subjectId: 'alice',
        key: 'likes.drink',
        value: 'teh tarik',
        quote: 'i really like teh tarik',
        sourceMessageId: 1
      }
    })
  })

  it('maps the subject from the label, never from an id the model gives', () => {
    expect(check({ subject: 'alice' })).toEqual({ ok: false, reason: 'unknown_subject' })
    expect(check({ subject: 'member 9' })).toEqual({ ok: false, reason: 'unknown_subject' })
  })

  it('rejects each fault with its own reason', () => {
    expect(check({ key: 'Likes Drink!' })).toEqual({ ok: false, reason: 'invalid_key' })
    expect(check({ key: 'note.abc' })).toEqual({ ok: false, reason: 'reserved_key' })
    expect(check({ key: 'lingo.lah' })).toEqual({ ok: false, reason: 'reserved_key' })
    expect(check({ value: '' })).toEqual({ ok: false, reason: 'invalid_value' })
    expect(check({ value: 'x'.repeat(501) })).toEqual({ ok: false, reason: 'invalid_value' })
    expect(check({ quote: 'teh tarik' })).toEqual({ ok: false, reason: 'quote_too_short' })
    expect(check({ quote: 'i really like iced lemon tea' })).toEqual({ ok: false, reason: 'quote_not_found' })
  })

  it('never takes a quote from the assistant, a scheduled message, an attachment line or a noted message', () => {
    for (const quote of [
      'the assistant prefers black coffee',
      'alice pays the rent on monday',
      'plan of the trip',
      'my secret code is kept in the drawer'
    ]) {
      expect(check({ quote }), quote).toEqual({ ok: false, reason: 'quote_not_found' })
    }
  })

  it('rejects what one member states about another, and a question', () => {
    expect(check({ key: 'home', value: 'the green house', quote: 'alice also moved to the green house' })).toEqual({
      ok: false,
      reason: 'third_party'
    })
    expect(
      check({ subject: 'member 2', key: 'home', value: 'the green house', quote: 'you all moved to the green house' })
    ).toEqual({ ok: false, reason: 'quote_is_question' })
  })

  it('lets a fact about the chat quote any member', () => {
    const checked = check({
      subject: 'chat',
      key: 'trip.day',
      value: 'friday',
      quote: 'we all agreed the trip is on friday'
    })
    expect(checked).toMatchObject({ ok: true, operation: { key: 'trip.day', sourceMessageId: 6 } })
    expect(checked.ok && 'subjectId' in checked.operation).toBe(false)
  })

  it('needs no value to retire', () => {
    expect(check({ op: 'retire', value: undefined })).toMatchObject({ ok: true, operation: { op: 'retire' } })
  })

  it('refuses a summary that is too long or holds a number nobody wrote', () => {
    expect(validateSummary('They talked about drinks, two cups a day.', messages)).toBe(true)
    expect(validateSummary('They agreed to meet 14 times.', messages)).toBe(false)
    expect(validateSummary('', messages)).toBe(false)
    expect(validateSummary('x'.repeat(501), messages)).toBe(false)
  })

  it('writes the excerpt with labels only, without noted or removed messages', () => {
    const text = episodeText(messages, labels)
    expect(text).toContain('member 1: I really like *teh tarik*, two cups a day')
    expect(text).toContain('assistant: Noted')
    expect(text).not.toContain('alice:')
    expect(text).not.toContain('secret code')
    expect(text).not.toContain('pays the rent')
  })
})

describe('closeDueEpisodes (steps 2 and 3)', () => {
  const limits = { idleMs: 180_000, maxMessages: 4 }
  const jobs = (storage: Storage) =>
    storage.read(
      (db) =>
        db.prepare('SELECT job_id, chat_id, state, payload FROM memory_job ORDER BY rowid').all() as {
          job_id: string
          chat_id: string
          state: string
          payload: string
        }[]
    )

  it('leaves an episode open and queues nothing when memory is off at any settings level', () => {
    for (const level of ['global', 'type', 'chat'] as const) {
      const storage = tmpStorage()
      const chatId = activeChat(storage, '0000000000@g.us')
      for (let index = 0; index < limits.maxMessages; index++) {
        say(storage, { chatId, senderId: 'member', text: 'I really like green tea', at: T0 })
      }
      setSetting(storage, {
        level,
        scope: level === 'global' ? '' : level === 'type' ? 'group' : chatId,
        key: 'features.memory',
        value: false,
        actor: 'test'
      })
      expect(closeDueEpisodes(storage, limits, () => later(10))).toBe(0)
      expect(jobs(storage)).toEqual([])
      expect(
        storage.read((db) => db.prepare('SELECT * FROM memory_cursor WHERE chat_id = ?').get(chatId))
      ).toBeUndefined()
    }
  })

  it('starts with new messages after enabling memory, without extracting the off window', () => {
    const storage = tmpStorage()
    const chatId = activeChat(storage, '0000000000@g.us')
    const setting = { level: 'chat' as const, scope: chatId, key: 'features.memory', actor: 'test' }
    setSetting(storage, { ...setting, value: false }, () => T0)
    say(storage, { chatId, senderId: 'member', text: 'I really like green tea', at: later(1) })
    expect(closeDueEpisodes(storage, limits, () => later(5))).toBe(0)
    say(storage, { chatId, senderId: 'member', text: 'I live near the river', at: later(6) })
    setSetting(storage, { ...setting, value: true }, () => later(7))
    expect(closeDueEpisodes(storage, limits, () => later(10))).toBe(0)
    const next = say(storage, { chatId, senderId: 'member', text: 'I prefer iced tea', at: later(11) })
    expect(closeDueEpisodes(storage, limits, () => later(20))).toBe(1)
    expect(JSON.parse(jobs(storage)[0]?.payload ?? '')).toMatchObject({ fromId: next, throughId: next, count: 1 })
  })

  it('queues one job for an idle episode, moves the cursor with it, and never covers a message twice', () => {
    const storage = tmpStorage()
    const chatId = activeChat(storage, 'test-g1')
    const first = say(storage, { chatId, senderId: 'a', text: 'one two three', at: T0 })
    const last = say(storage, { chatId, text: 'reply', at: later(1) })

    expect(closeDueEpisodes(storage, limits, () => later(2))).toBe(0)
    expect(closeDueEpisodes(storage, limits, () => later(5))).toBe(1)
    expect(closeDueEpisodes(storage, limits, () => later(6))).toBe(0)
    const [job] = jobs(storage)
    expect(JSON.parse(job?.payload ?? '')).toEqual({ fromId: first, throughId: last, count: 2, forgetEpoch: 0 })
    // The payload holds ids and counts only.
    expect(job?.payload).not.toContain('one two three')

    const next = say(storage, { chatId, senderId: 'a', text: 'four five six', at: later(7) })
    expect(closeDueEpisodes(storage, limits, () => later(20))).toBe(1)
    expect(JSON.parse(jobs(storage)[1]?.payload ?? '')).toMatchObject({ fromId: next, throughId: next, count: 1 })
  })

  it('closes at the message limit without waiting, keeps the forget counter, and skips a pending chat', () => {
    const storage = tmpStorage()
    const chatId = activeChat(storage, 'test-g1')
    storage.tx((db) => forgetBarrier(db, chatId, () => T0))
    for (let index = 0; index < 6; index += 1) say(storage, { chatId, senderId: 'a', text: `line ${index}`, at: T0 })
    const pending = tmpPending(storage)
    say(storage, { chatId: pending, senderId: 'a', text: 'never active here', at: T0 })

    expect(closeDueEpisodes(storage, limits, () => T0)).toBe(1)
    const all = jobs(storage)
    expect(all).toHaveLength(1)
    expect(JSON.parse(all[0]?.payload ?? '')).toMatchObject({ count: 4, forgetEpoch: 1 })
    expect(
      storage.read((db) => db.prepare('SELECT forget_epoch FROM memory_cursor WHERE chat_id = ?').pluck().get(chatId))
    ).toBe(1)
  })

  it('closes at memory.pageMessages 5 while the default stays 25', async () => {
    const custom = tmpStorage()
    const customChatId = activeChat(custom, '0000000000@g.us')
    setSetting(custom, { level: 'chat', scope: customChatId, key: 'memory.pageMessages', value: 5, actor: 'test' })
    for (let index = 0; index < 4; index += 1) {
      say(custom, { chatId: customChatId, senderId: 'a', text: `msg ${index}`, at: T0 })
    }
    expect(closeDueEpisodes(custom, { idleMs: 180_000, maxMessages: 25 }, () => T0)).toBe(0)
    say(custom, { chatId: customChatId, senderId: 'a', text: 'msg 4', at: T0 })

    const worker = createMemoryWorker({
      storage: custom,
      config: memoryConfig,
      client: scriptedModel(() => ({ operations: [] })),
      logger: quietLogger,
      now: () => T0
    })
    expect(await worker.tick()).toBe('skipped')
    expect(jobs(custom)).toHaveLength(1)
    expect(JSON.parse(jobs(custom)[0]?.payload ?? '')).toMatchObject({ count: 5 })

    const standard = tmpStorage()
    const defaultChatId = activeChat(standard, '0000000000@g.us')
    for (let index = 0; index < 24; index += 1) {
      say(standard, { chatId: defaultChatId, senderId: 'a', text: `msg ${index}`, at: T0 })
    }
    expect(closeDueEpisodes(standard, { idleMs: 180_000, maxMessages: 25 }, () => T0)).toBe(0)
    say(standard, { chatId: defaultChatId, senderId: 'a', text: 'msg 24', at: T0 })
    expect(closeDueEpisodes(standard, { idleMs: 180_000, maxMessages: 25 }, () => T0)).toBe(1)
    expect(JSON.parse(jobs(standard)[0]?.payload ?? '')).toMatchObject({ count: 25 })
  })
})

function tmpPending(storage: Storage): string {
  return storage.tx((db) => {
    db.prepare(
      "INSERT INTO chat (chat_id, wa_id, type, label, status, created_at) VALUES ('c_pending', 'test-p', 'group', '', 'pending', ?)"
    ).run(T0.toISOString())
    return 'c_pending'
  })
}

describe('the memory worker (steps 4 to 10)', () => {
  function scene() {
    const storage = tmpStorage()
    const chatId = activeChat(storage, 'test-g1')
    const alice = subject(storage, 'test-alice')
    const bob = subject(storage, 'test-bob')
    const clock = { at: later(10) }
    const now = () => clock.at
    const ids = {
      tea: say(storage, { chatId, senderId: alice, text: 'I really like teh tarik in the morning', at: T0 }),
      reply: say(storage, { chatId, text: 'Good choice!', at: T0 }),
      move: say(storage, { chatId, senderId: bob, text: 'I moved to the hill town in 2019', at: T0 })
    }
    return { storage, chatId, alice, bob, clock, now, ids }
  }
  const good = {
    operations: [
      {
        op: 'add' as const,
        subject: 'member 1',
        key: 'likes.drink',
        value: 'teh tarik',
        quote: 'I really like teh tarik'
      },
      {
        op: 'add' as const,
        subject: 'member 2',
        key: 'home.town',
        value: 'the hill town, since 2019',
        quote: 'I moved to the hill town in 2019'
      }
    ],
    summary: 'They talked about a morning drink and a move in 2019.'
  }

  it('stores accepted facts with their source, one summary, and events without any text', async () => {
    const { storage, chatId, alice, bob, now, ids } = scene()
    const model = scriptedModel(() => good)
    const judge = scriptedJudge()
    const worker = createMemoryWorker({ storage, config: memoryConfig, client: model, judge, logger: quietLogger, now })

    expect(await worker.tick()).toBe('done')
    expect(await worker.tick()).toBe('idle')
    expect(model.calls).toBe(1)
    // The models read labels, never an id.
    expect(model.episodes[0]).toContain('member 1: I really like teh tarik')
    expect(model.episodes[0]).not.toContain(alice)

    const items = itemsOf(storage, chatId)
    expect(
      items.map((item) => [item.kind, item.subject_id, item.key, item.value, item.status, item.source_message_id])
    ).toEqual([
      ['fact', alice, 'likes.drink', 'teh tarik', 'active', ids.tea],
      ['fact', bob, 'home.town', 'the hill town, since 2019', 'active', ids.move],
      ['episode', null, null, 'They talked about a morning drink and a move in 2019.', 'active', null]
    ])
    expect(new Set(items.map((item) => item.source_job)).size).toBe(1)
    expect(searchMemory(storage, chatId, 'teh tarik', 5).map((item) => item.key)).toContain('likes.drink')

    const events = eventsOf(storage, chatId)
    expect(events.map((event) => `${event.step}/${event.outcome}`)).toEqual([
      'apply/accepted',
      'apply/accepted',
      'apply/accepted',
      'job/done'
    ])
    const recorded = JSON.stringify([
      events,
      storage.read((db) => db.prepare('SELECT payload, last_error FROM memory_job').all())
    ])
    for (const word of ['teh', 'tarik', 'hill', '2019', 'morning']) expect(recorded).not.toContain(word)
  })

  it('rejects one operation alone, for each reason, and keeps the rest', async () => {
    const { storage, chatId, now } = scene()
    const model = scriptedModel(() => ({
      operations: [
        good.operations[0] as ProposedOperation,
        {
          op: 'add',
          subject: 'member 1',
          key: 'home.town',
          value: 'the hill town',
          quote: 'I moved to the hill town in 2019'
        },
        { op: 'add', subject: 'member 2', key: 'home.since', value: '2021', quote: 'I moved to the hill town in 2019' },
        { op: 'add', subject: 'member 2', key: 'note.x', value: 'x', quote: 'I moved to the hill town in 2019' },
        { op: 'retire', subject: 'member 2', key: 'pet.name', quote: 'I moved to the hill town in 2019' },
        good.operations[1] as ProposedOperation
      ]
    }))
    const judge = scriptedJudge({ verify: (input) => (input.operation.includes('likes.drink') ? 0.1 : 0.9) })
    const worker = createMemoryWorker({ storage, config: memoryConfig, client: model, judge, logger: quietLogger, now })

    expect(await worker.tick()).toBe('done')
    expect(itemsOf(storage, chatId).map((item) => item.key)).toEqual(['home.town'])
    expect(
      eventsOf(storage, chatId)
        .filter((event) => event.outcome === 'rejected')
        .map((event) => `${event.step}:${event.reason}`)
    ).toEqual([
      'verify:not_supported',
      'validate:third_party',
      'validate:number_not_in_message',
      'validate:reserved_key',
      'apply:nothing_to_retire'
    ])
  })

  it('fails closed: no judge, a low admission, or a judge that fails on one operation', async () => {
    const none = scene()
    const model = scriptedModel(() => good)
    const idle = createMemoryWorker({
      storage: none.storage,
      config: memoryConfig,
      client: model,
      logger: quietLogger,
      now: none.now
    })
    expect(await idle.tick()).toBe('skipped')
    expect(model.calls).toBe(0)
    expect(eventsOf(none.storage, none.chatId)).toEqual([
      { step: 'admit', outcome: 'skipped', op: null, reason: 'judge_unavailable' }
    ])

    const low = scene()
    const lowWorker = createMemoryWorker({
      storage: low.storage,
      config: memoryConfig,
      client: model,
      judge: scriptedJudge({ admit: () => 0.2 }),
      logger: quietLogger,
      now: low.now
    })
    expect(await lowWorker.tick()).toBe('skipped')
    expect(model.calls).toBe(0)
    expect(itemsOf(low.storage, low.chatId)).toEqual([])

    const flaky = scene()
    const flakyWorker = createMemoryWorker({
      storage: flaky.storage,
      config: memoryConfig,
      client: model,
      judge: scriptedJudge({
        verify: (input) => {
          if (input.operation.includes('home.town')) throw new Error('down')
          if (input.operation.includes('summary')) return new Promise<number>(() => {})
          return 0.9
        }
      }),
      logger: quietLogger,
      now: flaky.now
    })
    expect(await flakyWorker.tick()).toBe('done')
    expect(itemsOf(flaky.storage, flaky.chatId).map((item) => item.key)).toEqual(['likes.drink'])
    expect(eventsOf(flaky.storage, flaky.chatId).filter((event) => event.reason === 'judge_unavailable')).toHaveLength(
      2
    )
  })

  it('retries a failed job after 1, 5, 20 and 60 minutes, then keeps it as failed and alerts', async () => {
    const { storage, chatId, clock, now } = scene()
    const model = scriptedModel(() => 'this is not json')
    const alerts: AlertKind[] = []
    const worker = createMemoryWorker({
      storage,
      config: memoryConfig,
      client: model,
      judge: scriptedJudge(),
      logger: quietLogger,
      alerter: { raise: (kind) => alerts.push(kind) > 0 },
      now
    })
    expect(await worker.tick()).toBe('retry')
    for (const [index, delay] of RETRY_DELAYS_MS.entries()) {
      clock.at = new Date(clock.at.getTime() + delay - 1000)
      expect(await worker.tick(), `before delay ${index}`).toBe('idle')
      clock.at = new Date(clock.at.getTime() + 1000)
      expect(await worker.tick()).toBe(index === RETRY_DELAYS_MS.length - 1 ? 'failed' : 'retry')
    }
    expect(model.calls).toBe(5)
    expect(storage.read((db) => db.prepare('SELECT state, last_error, attempts FROM memory_job').get())).toEqual({
      state: 'failed',
      last_error: 'model_malformed',
      attempts: 5
    })
    expect(alerts).toEqual(['memory_job_failed'])
    expect(
      storage.read((db) => db.prepare("SELECT kind, message, stack FROM failure WHERE stage = 'memory'").all())
    ).toEqual(
      Array.from({ length: 5 }, () => ({
        kind: 'memory_job_failed',
        message: 'the extraction reply is not JSON',
        stack: expect.stringContaining('the extraction reply is not JSON')
      }))
    )
    expect(itemsOf(storage, chatId)).toEqual([])
    clock.at = later(100_000)
    expect(await worker.tick()).toBe('idle')
  })

  it('retries when the judge cannot answer the admission, and when the model fails', async () => {
    const { storage, now } = scene()
    let down = true
    const worker = createMemoryWorker({
      storage,
      config: memoryConfig,
      client: scriptedModel(() => new ModelError('rate_limit', 'slow down')),
      judge: scriptedJudge({
        admit: () => {
          if (down) throw new ModelError('transient', 'down')
          return 0.9
        }
      }),
      logger: quietLogger,
      now
    })
    expect(await worker.tick()).toBe('retry')
    expect(storage.read((db) => db.prepare('SELECT last_error FROM memory_job').pluck().get())).toBe('model_transient')
    down = false
    storage.tx((db) => db.prepare("UPDATE memory_job SET run_after = '2000-01-01T00:00:00.000Z'").run())
    expect(await worker.tick()).toBe('retry')
    expect(storage.read((db) => db.prepare('SELECT last_error FROM memory_job').pluck().get())).toBe('model_rate_limit')
  })

  it('never ends as done on a part of its episode', async () => {
    const { storage, chatId, now, ids } = scene()
    closeDueEpisodes(storage, memoryConfig.memory && { idleMs: 1, maxMessages: 25 }, now)
    storage.tx((db) => db.prepare('DELETE FROM session_message WHERE id = ?').run(ids.tea))
    const model = scriptedModel(() => good)
    const worker = createMemoryWorker({
      storage,
      config: memoryConfig,
      client: model,
      judge: scriptedJudge(),
      logger: quietLogger,
      now
    })
    expect(await worker.tick()).toBe('failed')
    expect(model.calls).toBe(0)
    expect(storage.read((db) => db.prepare('SELECT state, last_error FROM memory_job').get())).toEqual({
      state: 'failed',
      last_error: 'episode_pruned'
    })
    expect(itemsOf(storage, chatId)).toEqual([])
  })

  it('applies nothing when a forget happens while the job runs', async () => {
    const { storage, chatId, now } = scene()
    const model = scriptedModel(() => {
      // A member forgets something in this chat while the model is still answering.
      storage.tx((db) => forgetItem(db, chatId, 'm_unknown', now))
      return good
    })
    const worker = createMemoryWorker({
      storage,
      config: memoryConfig,
      client: model,
      judge: scriptedJudge(),
      logger: quietLogger,
      now
    })
    expect(await worker.tick()).toBe('skipped')
    expect(itemsOf(storage, chatId)).toEqual([])
    expect(eventsOf(storage, chatId)).toEqual([{ step: 'job', outcome: 'skipped', op: null, reason: 'forget_barrier' }])
    expect(storage.read((db) => db.prepare('SELECT state FROM memory_job').pluck().get())).toBe('done')
  })

  it('ends a queued job that a forget overtook, and extracts nothing said before the forget', async () => {
    const { storage, chatId, now } = scene()
    closeDueEpisodes(storage, { idleMs: 1, maxMessages: 25 }, now)
    storage.tx((db) => forgetBarrier(db, chatId, now))
    const model = scriptedModel(() => good)
    const worker = createMemoryWorker({
      storage,
      config: memoryConfig,
      client: model,
      judge: scriptedJudge(),
      logger: quietLogger,
      now
    })
    expect(await worker.tick()).toBe('idle')
    expect(model.calls).toBe(0)
    expect(itemsOf(storage, chatId)).toEqual([])
  })

  it('waits while background work is paused, and never throws', async () => {
    const { storage, now } = scene()
    const model = scriptedModel(() => good)
    let paused = true
    const worker = createMemoryWorker({
      storage,
      config: memoryConfig,
      client: model,
      judge: scriptedJudge(),
      logger: quietLogger,
      paused: () => paused,
      now
    })
    expect(await worker.tick()).toBe('paused')
    expect(storage.read((db) => db.prepare('SELECT count(*) FROM memory_job').pluck().get())).toBe(0)
    paused = false
    expect(await worker.tick()).toBe('done')
  })

  it('runs one chat at a time in order, and two chats one after the other', async () => {
    const { storage, chatId, alice, now } = scene()
    const other = activeChat(storage, 'test-g2')
    say(storage, { chatId: other, senderId: alice, text: 'I really like teh tarik in the morning', at: T0 })
    const model = scriptedModel((episode) => ({
      operations: episode.includes('hill town') ? good.operations : [good.operations[0] as ProposedOperation]
    }))
    const worker = createMemoryWorker({
      storage,
      config: memoryConfig,
      client: model,
      judge: scriptedJudge(),
      logger: quietLogger,
      now
    })
    expect([await worker.tick(), await worker.tick(), await worker.tick()]).toEqual(['done', 'done', 'idle'])
    expect(itemsOf(storage, chatId).map((item) => item.key)).toEqual(['likes.drink', 'home.town'])
    expect(itemsOf(storage, other).map((item) => item.key)).toEqual(['likes.drink'])
  })

  it('a job queued before memory is switched off writes nothing', async () => {
    for (const level of ['chat', 'type', 'global'] as const) {
      const { storage, chatId, now } = scene()
      closeDueEpisodes(storage, { idleMs: 1, maxMessages: 25 }, now)
      const cursorBefore = storage.read((db) => db.prepare('SELECT * FROM memory_cursor WHERE chat_id = ?').get(chatId))
      setSetting(
        storage,
        {
          level,
          scope: level === 'global' ? '' : level === 'type' ? 'group' : chatId,
          key: 'features.memory',
          value: false,
          actor: 'test'
        },
        now
      )
      const model = scriptedModel(() => good)
      const judge = scriptedJudge()
      const alerts: AlertKind[] = []
      const worker = createMemoryWorker({
        storage,
        config: memoryConfig,
        client: model,
        judge,
        logger: quietLogger,
        alerter: { raise: (kind) => alerts.push(kind) > 0 },
        now
      })

      expect(await worker.tick()).toBe('skipped')
      expect(model.calls).toBe(0)
      expect(judge.admitted).toBe(0)
      expect(itemsOf(storage, chatId)).toEqual([])
      expect(storage.read((db) => db.prepare('SELECT state, last_error FROM memory_job').get())).toEqual({
        state: 'done',
        last_error: null
      })
      expect(storage.read((db) => db.prepare('SELECT * FROM memory_cursor WHERE chat_id = ?').get(chatId))).toEqual(
        cursorBefore
      )
      expect(storage.read((db) => db.prepare("SELECT * FROM failure WHERE stage = 'memory'").all())).toEqual([])
      expect(alerts).toEqual([])
      expect(eventsOf(storage, chatId)).toEqual([{ step: 'job', outcome: 'skipped', op: null, reason: 'memory_off' }])
      expect(await worker.tick()).toBe('idle')
    }
  })

  it('a job of a chat with memory on still runs', async () => {
    const { storage, chatId, now } = scene()
    closeDueEpisodes(storage, { idleMs: 1, maxMessages: 25 }, now)
    setSetting(storage, { level: 'chat', scope: chatId, key: 'features.memory', value: true, actor: 'test' }, now)
    const model = scriptedModel(() => good)
    const worker = createMemoryWorker({
      storage,
      config: memoryConfig,
      client: model,
      judge: scriptedJudge(),
      logger: quietLogger,
      now
    })

    expect(await worker.tick()).toBe('done')
    expect(model.calls).toBe(1)
    expect(itemsOf(storage, chatId).map((item) => item.key)).toEqual(['likes.drink', 'home.town', null])
    expect(storage.read((db) => db.prepare('SELECT state FROM memory_job').pluck().get())).toBe('done')
    expect(await worker.tick()).toBe('idle')
  })

  it('applies nothing when memory is switched off while the job runs', async () => {
    const { storage, chatId, now } = scene()
    closeDueEpisodes(storage, { idleMs: 1, maxMessages: 25 }, now)
    const cursorBefore = storage.read((db) => db.prepare('SELECT * FROM memory_cursor WHERE chat_id = ?').get(chatId))
    const model = scriptedModel(() => {
      setSetting(storage, { level: 'chat', scope: chatId, key: 'features.memory', value: false, actor: 'test' }, now)
      return good
    })
    const worker = createMemoryWorker({
      storage,
      config: memoryConfig,
      client: model,
      judge: scriptedJudge(),
      logger: quietLogger,
      now
    })

    expect(await worker.tick()).toBe('skipped')
    expect(itemsOf(storage, chatId)).toEqual([])
    expect(storage.read((db) => db.prepare('SELECT state, last_error FROM memory_job').get())).toEqual({
      state: 'done',
      last_error: null
    })
    expect(storage.read((db) => db.prepare('SELECT * FROM memory_cursor WHERE chat_id = ?').get(chatId))).toEqual(
      cursorBefore
    )
    expect(eventsOf(storage, chatId)).toEqual([{ step: 'job', outcome: 'skipped', op: null, reason: 'memory_off' }])
  })
})

describe('forget, after review', () => {
  it('removes the text of the messages that stored a note', () => {
    const storage = tmpStorage()
    const chatId = activeChat(storage, 'test-g1')
    const alice = subject(storage, 'test-alice')
    receiveInbound(storage, { chatId, mid: 'm-1', senderId: alice }, () => T0)
    openTurn(storage, { turnId: 't-1', chatId, senderId: alice, kind: 'reply', mids: ['m-1'] }, () => T0)
    const asked = say(storage, {
      chatId,
      senderId: alice,
      text: 'remember my locker is number 4411',
      at: T0,
      turnId: 't-1'
    })
    const { itemId } = storage.tx((db) =>
      addNote(db, chatId, { subjectId: alice, text: 'locker number 4411', turnId: 't-1' })
    )

    expect(storage.tx((db) => forgetItem(db, chatId, itemId))).toBe(true)
    const content = storage.read((db) =>
      db.prepare('SELECT content FROM session_message WHERE id = ?').pluck().get(asked)
    )
    expect(content).toBe(FORGOTTEN_MESSAGE)
    expect(JSON.stringify(itemsOf(storage, chatId))).not.toContain('4411')
  })

  it('removes the message behind every version of the fact, not only the newest', () => {
    const storage = tmpStorage()
    const chatId = activeChat(storage, 'test-g1')
    const alice = subject(storage, 'test-alice')
    const first = say(storage, { chatId, senderId: alice, text: 'I live in the old quarter', at: T0 })
    const second = say(storage, { chatId, senderId: alice, text: 'I live in the new quarter now', at: later(1) })
    const other = say(storage, { chatId, senderId: alice, text: 'I like durian a lot', at: later(2) })
    const apply = (key: string, value: string, sourceMessageId: number) =>
      storage.tx((db) =>
        applyOperation(db, chatId, { op: 'add', subjectId: alice, key, value, quote: value, sourceMessageId }, {})
      )
    apply('home', 'the old quarter', first)
    const newest = apply('home', 'the new quarter', second)
    apply('likes.fruit', 'durian', other)

    expect(storage.tx((db) => forgetItem(db, chatId, newest.accepted ? newest.itemId : ''))).toBe(true)
    const contents = storage.read((db) =>
      db.prepare('SELECT content FROM session_message WHERE chat_id = ? ORDER BY id').pluck().all(chatId)
    )
    expect(contents).toEqual([FORGOTTEN_MESSAGE, FORGOTTEN_MESSAGE, 'I like durian a lot'])
    expect(itemsOf(storage, chatId).map((item) => [item.key, item.value, item.status])).toEqual([
      ['forgotten', '', 'forgotten'],
      ['forgotten', '', 'forgotten'],
      ['likes.fruit', 'durian', 'active']
    ])
  })

  it('gives a word in another script its own slot', () => {
    const storage = tmpStorage()
    const chatId = activeChat(storage, 'test-g1')
    const one = storage.tx((db) => setLingo(db, chatId, { word: '加油', meaning: 'keep going' }))
    const two = storage.tx((db) => setLingo(db, chatId, { word: '吃饭', meaning: 'to eat' }))
    const again = storage.tx((db) => setLingo(db, chatId, { word: '加油', meaning: 'keep going' }))
    expect(one).not.toBe(two)
    expect(again).toBe(one)
    expect(itemsOf(storage, chatId).filter((item) => item.status === 'active')).toHaveLength(2)
    expect(() => storage.tx((db) => setLingo(db, chatId, { word: '!!!', meaning: 'x' }))).toThrow()
  })
})
