import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelClient } from '../../src/models/types.js'
import { itemsOf } from '../support/memory.js'
import { tmpStorage } from '../support/tmp.js'
import {
  type SimChat,
  type Simulation,
  activeFacts,
  crashRecovery,
  createSimulation,
  everythingRecalled
} from './memory-sim.js'

// The five checks of docs/trd/harness.md#memory-simulator, over several generated worlds.

const SEEDS = [1, 2, 3, 4, 5, 6]
const floors = JSON.parse(readFileSync(new URL('./floors.json', import.meta.url), 'utf8')) as {
  precision: number
  recall: number
}

const truthSet = (chat: SimChat): Set<string> =>
  new Set([...chat.truth.values()].map((fact) => `${fact.subjectId}|${fact.key}|${fact.value}`))

/** Every text of one chat that the database holds for memory: items, the index, and the window. */
function storedText(sim: Simulation, chat: SimChat): string {
  return sim.storage.read((db) =>
    JSON.stringify([
      db.prepare('SELECT key, value FROM memory_item WHERE chat_id = ?').all(chat.chatId),
      db.prepare('SELECT text FROM memory_fts WHERE chat_id = ?').all(chat.chatId),
      db.prepare('SELECT content FROM session_message WHERE chat_id = ?').all(chat.chatId)
    ])
  )
}

function allQueries(sim: Simulation): string[] {
  const values = sim.chats.flatMap((chat) => [...[...chat.truth.values()].map((fact) => fact.value), ...chat.gone])
  return [...values, 'favourite drink home town pet name work place', 'gate code word', 'my is']
}

function assertNoStuckJob(sim: Simulation): void {
  const open = sim.storage.read((db) =>
    db.prepare("SELECT job_id, state FROM memory_job WHERE state IN ('queued', 'leased', 'failed')").all()
  )
  expect(open).toEqual([])
}

// Each scenario runs many memory operations; 5 s timed out on a loaded workstation (#174).
vi.setConfig({ testTimeout: 30_000 })

describe.each(SEEDS)('memory simulator, seed %i', (seed) => {
  let fetchSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    // Zero live calls: a request to anything fails the run.
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('the simulator made a live call')
    })
  })
  afterEach(() => {
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('Drift: what is remembered matches the ground truth, and is found again by recall', async () => {
    const sim = createSimulation(tmpStorage(), seed)
    sim.talk(30)
    await sim.drain()
    for (const chat of sim.chats) await sim.note(chat)
    sim.talk(10)
    await sim.drain()
    assertNoStuckJob(sim)

    let kept = 0
    let right = 0
    let wanted = 0
    for (const chat of sim.chats) {
      const stored = activeFacts(sim.storage, chat)
      const truth = truthSet(chat)
      kept += stored.size
      wanted += truth.size
      for (const fact of stored) if (truth.has(fact)) right += 1

      // Recall finds every remembered fact and note by its own words, and nothing that was taken back.
      for (const fact of chat.truth.values()) {
        expect(everythingRecalled(sim, chat, [`${fact.key.replace('.', ' ')} ${fact.value}`])).toContain(fact.value)
      }
      for (const note of chat.notes) expect(everythingRecalled(sim, chat, [note])).toContain(note)
    }
    expect(wanted).toBeGreaterThan(10)
    expect(right / kept).toBeGreaterThanOrEqual(floors.precision)
    expect(right / wanted).toBeGreaterThanOrEqual(floors.recall)
    // The careless model proposed far more than was stored.
    expect(sim.model.calls).toBeGreaterThan(5)
  })

  it('Isolation: no item or recalled text appears in a chat other than its own', async () => {
    const sim = createSimulation(tmpStorage(), seed)
    sim.talk(30)
    await sim.drain()
    for (const chat of sim.chats) await sim.note(chat)
    const queries = allQueries(sim)
    for (const chat of sim.chats) {
      const foreign = new RegExp(`zq[^${chat.mark.slice(2)}\\W]\\d`)
      expect(everythingRecalled(sim, chat, queries)).not.toMatch(foreign)
      expect(storedText(sim, chat)).not.toMatch(foreign)
      // The chat does remember its own.
      expect(itemsOf(sim.storage, chat.chatId).length).toBeGreaterThan(0)
    }
    // One person is in several chats, with the same subject id and separate facts.
    const shared = sim.chats.flatMap((chat) => chat.members).filter((member, at, all) => all.indexOf(member) !== at)
    expect(shared.length).toBeGreaterThan(0)
  })

  it('Forget: a forgotten fact is found nowhere, and no other fact changes', async () => {
    const sim = createSimulation(tmpStorage(), seed)
    sim.talk(30)
    await sim.drain()
    const before = new Map(sim.chats.map((chat) => [chat.chatId, activeFacts(sim.storage, chat)]))

    const chat = sim.chats.find((candidate) => candidate.truth.size > 1) as SimChat
    const forgotten = sim.forgetOne(chat) as string
    expect(forgotten).toBeDefined()

    expect(everythingRecalled(sim, chat, [forgotten, ...allQueries(sim)])).not.toContain(forgotten)
    expect(storedText(sim, chat)).not.toContain(forgotten)
    for (const other of sim.chats) {
      const now = activeFacts(sim.storage, other)
      const expected = new Set(before.get(other.chatId))
      if (other === chat) for (const fact of expected) if (fact.endsWith(`|${forgotten}`)) expected.delete(fact)
      expect(now).toEqual(expected)
    }

    // What is said after the forget is remembered as before, and the forgotten fact does not come back.
    sim.talk(15)
    await sim.drain()
    assertNoStuckJob(sim)
    expect(activeFacts(sim.storage, chat)).toEqual(truthSet(chat))
    expect(storedText(sim, chat)).not.toContain(forgotten)
  })

  it('Lost Writes: two workers at once store every accepted operation once', async () => {
    const sim = createSimulation(tmpStorage(), seed)
    const workers = [sim.worker, sim.newWorker('sim-2'), sim.newWorker('sim-3')]
    for (let round = 0; round < 4; round += 1) {
      sim.talk(12)
      await sim.drain(workers)
    }
    assertNoStuckJob(sim)
    for (const chat of sim.chats) {
      expect(activeFacts(sim.storage, chat)).toEqual(truthSet(chat))
      const slots = itemsOf(sim.storage, chat.chatId)
        .filter((item) => item.kind === 'fact' && item.status === 'active')
        .map((item) => `${item.subject_id}|${item.key}`)
      expect(new Set(slots).size).toBe(slots.length)
    }
  })

  it('Recovery: a job in flight at a crash is run again after the restart, and nothing is lost', async () => {
    const sim = createSimulation(tmpStorage(), seed)
    sim.talk(20)
    sim.clock.at = new Date(sim.clock.at.getTime() + 600_000)

    // A worker dies while the model is still answering: its lease stays behind.
    let release: (error: Error) => void = () => {}
    const hanging: ModelClient = {
      call: () =>
        new Promise((_, reject) => {
          release = reject
        })
    }
    const dying = sim.newWorker('sim-dead', hanging).tick()
    await vi.waitFor(() =>
      expect(
        sim.storage.read((db) => db.prepare("SELECT count(*) FROM memory_job WHERE state = 'leased'").pluck().get())
      ).toBe(1)
    )
    const itemsAtCrash = sim.chats.map((chat) => itemsOf(sim.storage, chat.chatId).length)

    expect(crashRecovery(sim.storage)).toBe(1)
    await sim.drain([sim.newWorker('sim-after')])
    // The dead worker's late answer changes nothing: its lease is gone.
    release(new Error('too late'))
    expect(await dying).toBe('lost')

    assertNoStuckJob(sim)
    expect(itemsAtCrash.reduce((sum, count) => sum + count, 0)).toBeLessThan(
      sim.chats.reduce((sum, chat) => sum + itemsOf(sim.storage, chat.chatId).length, 0)
    )
    for (const chat of sim.chats) expect(activeFacts(sim.storage, chat)).toEqual(truthSet(chat))
  })
})
