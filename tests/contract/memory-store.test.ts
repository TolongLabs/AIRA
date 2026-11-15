import { describe, expect, it } from 'vitest'
import { createMemoryPort } from '../../src/memory/port.js'
import { ftsQuery, memoryLine, recallForTurn, searchHistory, searchMemory } from '../../src/memory/recall.js'
import {
  activeFact,
  addNote,
  addSummary,
  applyOperation,
  expireUpcoming,
  forgetBarrier,
  forgetEpoch,
  forgetItem,
  getItem,
  newItemId,
  normaliseKey,
  normaliseText,
  recordEvent,
  setLingo
} from '../../src/memory/store.js'
import { FORGOTTEN_KEY, FORGOTTEN_MESSAGE, MAX_VALUE_CHARS, type MemoryJudge } from '../../src/memory/types.js'
import { ensureChat } from '../../src/settings/chats.js'
import type { Storage } from '../../src/storage/database.js'
import { enqueueJob, leaseNextJob } from '../../src/storage/leases.js'
import { openTurn, receiveInbound } from '../../src/storage/turns.js'
import { tmpStorage } from '../support/tmp.js'

const clockAt = (iso: string) => () => new Date(iso)

function expectFtsInSync(storage: Storage, chatId: string): void {
  const expected = storage.read(
    (db) =>
      db
        .prepare(
          `SELECT id FROM memory_item
           WHERE chat_id = ?
             AND ((kind = 'fact' AND status IN ('active', 'upcoming'))
               OR (kind IN ('episode', 'media') AND status <> 'forgotten'))
           ORDER BY id`
        )
        .pluck()
        .all(chatId) as string[]
  )
  const actual = storage.read(
    (db) =>
      db.prepare('SELECT item_id FROM memory_fts WHERE chat_id = ? ORDER BY item_id').pluck().all(chatId) as string[]
  )
  expect(actual).toEqual(expected)
}

describe('memory store', () => {
  it('generates item ids and normalises keys and texts', () => {
    expect(newItemId()).toMatch(/^m_[0-9a-f]{16}$/)
    expect(normaliseKey('Likes Food-Now')).toBe('likes_food_now')
    expect(normaliseKey('a.b.c')).toBe('a.b.c')
    expect(normaliseKey('bad!key')).toBeUndefined()
    expect(normaliseKey('')).toBeUndefined()
    expect(normaliseText('  *Hello*   _World_ ~test~ `code`  ')).toBe('hello world test code')
  })

  it('applyOperation handles add, update, supersede, unchanged, retire, upcoming and every rejection', () => {
    const storage = tmpStorage()
    const chat = ensureChat(storage, { waId: 'fake-chat-1', type: 'group' })
    const t0 = clockAt('2026-11-16T00:00:00.000Z')
    const future = '2027-01-01T00:00:00.000Z'

    const outcomes = storage.tx((db) => ({
      badKey: applyOperation(db, chat.chatId, { op: 'add', key: 'Bad Key!', value: 'x', quote: 'q' }, {}, t0),
      reserved: applyOperation(db, chat.chatId, { op: 'add', key: 'note.mine', value: 'x', quote: 'q' }, {}, t0),
      reservedLingo: applyOperation(db, chat.chatId, { op: 'add', key: 'lingo.brb', value: 'x', quote: 'q' }, {}, t0),
      emptyVal: applyOperation(db, chat.chatId, { op: 'add', key: 'likes.tea', value: '   ', quote: 'q' }, {}, t0),
      longVal: applyOperation(
        db,
        chat.chatId,
        { op: 'add', key: 'likes.tea', value: 'a'.repeat(MAX_VALUE_CHARS + 1), quote: 'q' },
        {},
        t0
      ),
      pastUntil: applyOperation(
        db,
        chat.chatId,
        { op: 'add', key: 'likes.tea', value: 'oolong', quote: 'q', validUntil: '2026-11-15T00:00:00.000Z' },
        {},
        t0
      ),
      badUntil: applyOperation(
        db,
        chat.chatId,
        { op: 'add', key: 'likes.tea', value: 'oolong', quote: 'q', validUntil: 'not-a-date' },
        {},
        t0
      ),
      retireNothing: applyOperation(db, chat.chatId, { op: 'retire', key: 'likes.tea', quote: 'q' }, {}, t0)
    }))

    expect(outcomes.badKey).toEqual({ accepted: false, reason: 'invalid_key' })
    expect(outcomes.reserved).toEqual({ accepted: false, reason: 'reserved_key' })
    expect(outcomes.reservedLingo).toEqual({ accepted: false, reason: 'reserved_key' })
    expect(outcomes.emptyVal).toEqual({ accepted: false, reason: 'invalid_value' })
    expect(outcomes.longVal).toEqual({ accepted: false, reason: 'invalid_value' })
    expect(outcomes.pastUntil).toEqual({ accepted: false, reason: 'invalid_valid_until' })
    expect(outcomes.badUntil).toEqual({ accepted: false, reason: 'invalid_valid_until' })
    expect(outcomes.retireNothing).toEqual({ accepted: false, reason: 'nothing_to_retire' })

    const add1 = storage.tx((db) =>
      applyOperation(
        db,
        chat.chatId,
        { op: 'add', subjectId: 'subj-1', key: 'likes.tea', value: 'jasmine tea', quote: 'i like jasmine tea' },
        { turnId: 't-1', jobId: 'j-1' },
        t0
      )
    )
    expect(add1).toMatchObject({ accepted: true, effect: 'added' })
    expectFtsInSync(storage, chat.chatId)

    const same = storage.tx((db) =>
      applyOperation(
        db,
        chat.chatId,
        { op: 'update', subjectId: 'subj-1', key: 'likes.tea', value: ' *Jasmine*  Tea ', quote: 'q' },
        {},
        t0
      )
    )
    expect(same).toEqual({ accepted: true, itemId: add1.accepted ? add1.itemId : '', effect: 'unchanged' })

    const replaced = storage.tx((db) =>
      applyOperation(
        db,
        chat.chatId,
        { op: 'supersede', subjectId: 'subj-1', key: 'likes.tea', value: 'matcha', quote: 'q' },
        {},
        clockAt('2026-11-16T01:00:00.000Z')
      )
    )
    expect(replaced).toMatchObject({ accepted: true, effect: 'replaced' })
    expectFtsInSync(storage, chat.chatId)

    if (add1.accepted && replaced.accepted) {
      expect(storage.read((db) => getItem(db, chat.chatId, add1.itemId)?.status)).toBe('superseded')
      expect(storage.read((db) => getItem(db, chat.chatId, replaced.itemId)?.status)).toBe('active')
    }

    // Upcoming beside active does not touch active
    const upcoming = storage.tx((db) =>
      applyOperation(
        db,
        chat.chatId,
        { op: 'add', subjectId: 'subj-1', key: 'likes.tea', value: 'hoji', quote: 'q', validUntil: future },
        {},
        t0
      )
    )
    expect(upcoming).toMatchObject({ accepted: true, effect: 'added' })
    expect(storage.read((db) => activeFact(db, chat.chatId, 'subj-1', 'likes.tea')?.value)).toBe('matcha')
    expectFtsInSync(storage, chat.chatId)

    // Retire active fact
    const retired = storage.tx((db) =>
      applyOperation(db, chat.chatId, { op: 'retire', subjectId: 'subj-1', key: 'likes.tea', quote: 'q' }, {}, t0)
    )
    expect(retired).toMatchObject({ accepted: true, effect: 'retired' })
    expect(storage.read((db) => activeFact(db, chat.chatId, 'subj-1', 'likes.tea'))).toBeUndefined()
    expectFtsInSync(storage, chat.chatId)

    // Expire upcoming
    const expired = storage.tx((db) => expireUpcoming(db, chat.chatId, clockAt('2027-01-02T00:00:00.000Z')))
    expect(expired).toBe(1)
    expectFtsInSync(storage, chat.chatId)
  })

  it('keeps an earlier operation when a later one hits a constraint in the same transaction', () => {
    const storage = tmpStorage()
    const chat = ensureChat(storage, { waId: 'fake-chat-2', type: 'group' })

    const res = storage.tx((db) => {
      const first = applyOperation(db, chat.chatId, { op: 'add', key: 'city', value: 'Lisbon', quote: 'q' }, {})
      const second = applyOperation(
        db,
        chat.chatId,
        { op: 'add', subjectId: '', key: 'bad.subject', value: 'x', quote: 'q' },
        {}
      )
      return { first, second }
    })

    expect(res.first).toMatchObject({ accepted: true, effect: 'added' })
    expect(res.second).toEqual({ accepted: false, reason: 'constraint' })
    expect(storage.read((db) => activeFact(db, chat.chatId, undefined, 'city')?.value)).toBe('Lisbon')
    expectFtsInSync(storage, chat.chatId)
  })

  it('enforces one active fact per slot and separates NULL subject from member subject', () => {
    const storage = tmpStorage()
    const chat = ensureChat(storage, { waId: 'fake-chat-3', type: 'group' })

    const chatFact = storage.tx((db) =>
      applyOperation(db, chat.chatId, { op: 'add', key: 'language', value: 'English', quote: 'q' }, {})
    )
    const memberFact = storage.tx((db) =>
      applyOperation(
        db,
        chat.chatId,
        { op: 'add', subjectId: 'subj-1', key: 'language', value: 'Spanish', quote: 'q' },
        {}
      )
    )
    expect(chatFact.accepted && memberFact.accepted).toBe(true)
    expect(storage.read((db) => activeFact(db, chat.chatId, undefined, 'language')?.value)).toBe('English')
    expect(storage.read((db) => activeFact(db, chat.chatId, 'subj-1', 'language')?.value)).toBe('Spanish')

    expect(() =>
      storage.tx((db) => {
        db.prepare(
          `INSERT INTO memory_item (id, chat_id, kind, subject_id, key, value, status, pinned, created_at, updated_at)
           VALUES ('m_dup', ?, 'fact', 'subj-1', 'language', 'French', 'active', 0, '2026-11-16T00:00:00.000Z', '2026-11-16T00:00:00.000Z')`
        ).run(chat.chatId)
      })
    ).toThrow()
  })

  it('addNote deduplicates by normalised text, marks turn user rows memory_skip, and stores distinct notes', () => {
    const storage = tmpStorage()
    const chat = ensureChat(storage, { waId: 'fake-chat-4', type: 'dm' })
    receiveInbound(storage, { chatId: chat.chatId, mid: 'm1', senderId: 'subj-1' })
    openTurn(storage, { turnId: 't-note', chatId: chat.chatId, senderId: 'subj-1', kind: 'reply', mids: ['m1'] })
    storage.tx((db) => {
      db.prepare(
        "INSERT INTO session_message (chat_id, turn_id, role, sender_id, content, created_at) VALUES (?, 't-note', 'user', 'subj-1', 'remember i love figs', '2026-11-16T00:00:00.000Z')"
      ).run(chat.chatId)
      db.prepare(
        "INSERT INTO session_message (chat_id, turn_id, role, sender_id, content, created_at) VALUES (?, 't-note', 'assistant', NULL, 'noted', '2026-11-16T00:00:01.000Z')"
      ).run(chat.chatId)
    })

    const first = storage.tx((db) =>
      addNote(db, chat.chatId, { subjectId: 'subj-1', text: 'loves figs', turnId: 't-note' })
    )
    const dup = storage.tx((db) => addNote(db, chat.chatId, { subjectId: 'subj-1', text: ' *Loves*  Figs ' }))
    const second = storage.tx((db) => addNote(db, chat.chatId, { subjectId: 'subj-1', text: 'allergic to peanuts' }))

    expect(first.effect).toBe('added')
    expect(dup).toEqual({ itemId: first.itemId, effect: 'unchanged' })
    expect(second.effect).toBe('added')
    expect(second.itemId).not.toBe(first.itemId)
    expectFtsInSync(storage, chat.chatId)

    const skips = storage.read(
      (db) =>
        db.prepare('SELECT role, memory_skip FROM session_message WHERE chat_id = ? ORDER BY id').all(chat.chatId) as {
          role: string
          memory_skip: number
        }[]
    )
    expect(skips).toEqual([
      { role: 'user', memory_skip: 1 },
      { role: 'assistant', memory_skip: 0 }
    ])
  })

  it('setLingo stores, deduplicates, supersedes and rejects empty words', () => {
    const storage = tmpStorage()
    const chat = ensureChat(storage, { waId: 'fake-chat-5', type: 'group' })

    const id1 = storage.tx((db) => setLingo(db, chat.chatId, { word: 'BRB!!', meaning: 'be right back' }))
    const same = storage.tx((db) => setLingo(db, chat.chatId, { word: 'brb', meaning: 'Be Right Back' }))
    const id2 = storage.tx((db) => setLingo(db, chat.chatId, { word: 'brb', meaning: 'back in five' }))

    expect(same).toBe(id1)
    expect(id2).not.toBe(id1)
    expect(storage.read((db) => getItem(db, chat.chatId, id1)?.status)).toBe('superseded')
    expect(storage.read((db) => activeFact(db, chat.chatId, undefined, 'lingo.brb')?.value)).toBe('back in five')
    expect(() => storage.tx((db) => setLingo(db, chat.chatId, { word: '!!!', meaning: 'x' }))).toThrow()
    expectFtsInSync(storage, chat.chatId)
  })

  it('forgetItem clears the fact, older versions, episode summary, embedding, source message, and sets barrier', () => {
    const storage = tmpStorage()
    const chat = ensureChat(storage, { waId: 'fake-chat-6', type: 'group' })

    const msgId = storage.tx((db) => {
      const info = db
        .prepare(
          "INSERT INTO session_message (chat_id, role, sender_id, content, created_at) VALUES (?, 'user', 'subj-1', 'i live in porto', '2026-11-16T00:00:00.000Z')"
        )
        .run(chat.chatId)
      return Number(info.lastInsertRowid)
    })

    const v1 = storage.tx((db) =>
      applyOperation(
        db,
        chat.chatId,
        { op: 'add', subjectId: 'subj-1', key: 'home.city', value: 'Braga', quote: 'q' },
        {}
      )
    )
    const v2 = storage.tx((db) =>
      applyOperation(
        db,
        chat.chatId,
        { op: 'update', subjectId: 'subj-1', key: 'home.city', value: 'Porto', quote: 'q', sourceMessageId: msgId },
        { jobId: 'job-ep-1' }
      )
    )
    const epId = storage.tx((db) => {
      const id = addSummary(db, chat.chatId, {
        kind: 'episode',
        value: 'Talked about moving to Porto',
        jobId: 'job-ep-1'
      })
      db.prepare(
        "INSERT INTO memory_embedding (item_id, chat_id, model, vector, created_at) VALUES (?, ?, 'test', zeroblob(4), '2026-11-16T00:00:00.000Z')"
      ).run(id, chat.chatId)
      return id
    })

    expect(v1.accepted && v2.accepted).toBe(true)
    if (!v1.accepted || !v2.accepted) return

    const forgotten = storage.tx((db) => forgetItem(db, chat.chatId, v2.itemId))
    expect(forgotten).toBe(true)
    expectFtsInSync(storage, chat.chatId)

    const clearedV2 = storage.read((db) => getItem(db, chat.chatId, v2.itemId))
    const clearedV1 = storage.read((db) => getItem(db, chat.chatId, v1.itemId))
    const clearedEp = storage.read((db) => getItem(db, chat.chatId, epId))
    expect(clearedV2).toMatchObject({ status: 'forgotten', value: '', key: FORGOTTEN_KEY, pinned: false })
    expect(clearedV1).toMatchObject({ status: 'forgotten', value: '', key: FORGOTTEN_KEY, pinned: false })
    expect(clearedEp).toMatchObject({ status: 'forgotten', value: '' })

    expect(
      storage.read((db) => db.prepare('SELECT count(*) FROM memory_embedding WHERE item_id = ?').pluck().get(epId))
    ).toBe(0)
    expect(
      storage.read((db) => db.prepare('SELECT content FROM session_message WHERE id = ?').pluck().get(msgId))
    ).toBe(FORGOTTEN_MESSAGE)
    expect(
      storage.read((db) =>
        db
          .prepare("SELECT outcome FROM memory_event WHERE chat_id = ? AND step = 'forget' AND item_id = ?")
          .pluck()
          .get(chat.chatId, v2.itemId)
      )
    ).toBe('done')

    expect(searchMemory(storage, chat.chatId, 'Porto', 10)).toEqual([])
    expect(
      recallForTurn(storage, {
        chatId: chat.chatId,
        present: new Map([['subj-1', 'member 1']]),
        queryTexts: ['Porto'],
        tokenBudget: 500
      })
    ).toEqual([])

    const secondForget = storage.tx((db) => forgetItem(db, chat.chatId, v2.itemId))
    expect(secondForget).toBe(false)
    expect(storage.read((db) => forgetEpoch(db, chat.chatId))).toBe(2)
  })

  it('forgetBarrier updates cursor, ends queued jobs, leaves leased and other-chat jobs, and runs on unknown id', () => {
    const storage = tmpStorage()
    const chatA = ensureChat(storage, { waId: 'fake-chat-a', type: 'group' })
    const chatB = ensureChat(storage, { waId: 'fake-chat-b', type: 'group' })

    const newestA = storage.tx((db) => {
      const info = db
        .prepare(
          "INSERT INTO session_message (chat_id, role, sender_id, content, created_at) VALUES (?, 'user', 's1', 'hi', '2026-11-16T00:00:00.000Z')"
        )
        .run(chatA.chatId)
      enqueueJob(db, 'memory_job', { jobId: 'job-a-leased', chatId: chatA.chatId, payload: '{}' })
      enqueueJob(db, 'memory_job', { jobId: 'job-a-queued', chatId: chatA.chatId, payload: '{}' })
      enqueueJob(db, 'memory_job', { jobId: 'job-b-queued', chatId: chatB.chatId, payload: '{}' })
      return Number(info.lastInsertRowid)
    })

    const leased = leaseNextJob(storage, 'memory_job', { owner: 'worker-1', leaseMs: 60_000 })
    expect(leased?.jobId).toBe('job-a-leased')

    expect(storage.read((db) => forgetEpoch(db, chatA.chatId))).toBe(0)
    const ended = storage.tx((db) => forgetBarrier(db, chatA.chatId))
    expect(ended).toBe(1)
    expect(storage.read((db) => forgetEpoch(db, chatA.chatId))).toBe(1)

    const cursor = storage.read(
      (db) =>
        db
          .prepare('SELECT through_message_id, forget_epoch FROM memory_cursor WHERE chat_id = ?')
          .get(chatA.chatId) as { through_message_id: number; forget_epoch: number }
    )
    expect(cursor).toEqual({ through_message_id: newestA, forget_epoch: 1 })

    const jobStates = storage.read(
      (db) =>
        db.prepare('SELECT job_id, state, last_error FROM memory_job ORDER BY job_id').all() as {
          job_id: string
          state: string
          last_error: string | null
        }[]
    )
    expect(jobStates).toEqual([
      { job_id: 'job-a-leased', state: 'leased', last_error: null },
      { job_id: 'job-a-queued', state: 'done', last_error: 'forget_barrier' },
      { job_id: 'job-b-queued', state: 'queued', last_error: null }
    ])

    // Unknown id still bumps barrier
    storage.tx((db) => forgetItem(db, chatA.chatId, 'm_does_not_exist'))
    expect(storage.read((db) => forgetEpoch(db, chatA.chatId))).toBe(2)
  })

  it('recordEvent refuses a reason that is not a code', () => {
    const storage = tmpStorage()
    const chat = ensureChat(storage, { waId: 'fake-chat-ev', type: 'dm' })
    expect(() =>
      storage.tx((db) => recordEvent(db, chat.chatId, { step: 'validate', outcome: 'rejected', reason: 'bad reason!' }))
    ).toThrow()
    storage.tx((db) =>
      recordEvent(db, chat.chatId, { step: 'validate', outcome: 'rejected', reason: 'quote.not_found_1' })
    )
  })

  it('ftsQuery sanitises punctuation, quotes and FTS operators without syntax errors', () => {
    const storage = tmpStorage()
    const chat = ensureChat(storage, { waId: 'fake-chat-fts', type: 'dm' })
    storage.tx((db) =>
      applyOperation(db, chat.chatId, { op: 'add', key: 'likes.tea', value: 'sencha', quote: 'q' }, {})
    )

    expect(ftsQuery('')).toBeUndefined()
    expect(ftsQuery('a ! ? .')).toBeUndefined()
    expect(ftsQuery('AND OR NOT NEAR( "sencha"* )')).toBe('"and" OR "or" OR "not" OR "near" OR "sencha"')

    for (const bad of ['', '   ', '!!!', '"unclosed', 'AND OR NOT', 'NEAR(a, b)', 'sencha*']) {
      expect(() => searchMemory(storage, chat.chatId, bad, 5)).not.toThrow()
    }
    expect(searchMemory(storage, chat.chatId, 'NEAR( "sencha"* )', 5)).toHaveLength(1)
  })

  it('recallForTurn orders pinned, notes, search facts and summaries within tokenBudget with safe labels', () => {
    const storage = tmpStorage()
    const chat = ensureChat(storage, { waId: 'fake-chat-recall', type: 'group' })
    const present = new Map([['subj-1', 'member 1']])

    storage.tx((db) => {
      const p1 = applyOperation(
        db,
        chat.chatId,
        { op: 'add', subjectId: 'subj-1', key: 'role', value: 'host', quote: 'q' },
        {},
        clockAt('2026-11-16T00:01:00.000Z')
      )
      const pAbsent = applyOperation(
        db,
        chat.chatId,
        { op: 'add', subjectId: 'subj-absent', key: 'role', value: 'guest', quote: 'q' },
        {},
        clockAt('2026-11-16T00:02:00.000Z')
      )
      if (p1.accepted && pAbsent.accepted) {
        db.prepare('UPDATE memory_item SET pinned = 1 WHERE id IN (?, ?)').run(p1.itemId, pAbsent.itemId)
      }
      addNote(
        db,
        chat.chatId,
        { subjectId: 'subj-1', text: 'drinks oolong daily' },
        clockAt('2026-11-16T00:03:00.000Z')
      )
      applyOperation(
        db,
        chat.chatId,
        {
          op: 'add',
          subjectId: 'subj-absent',
          key: 'trip',
          value: 'oolong farm',
          quote: 'q',
          validUntil: '2027-02-01T00:00:00.000Z'
        },
        {},
        clockAt('2026-11-16T00:04:00.000Z')
      )
      addSummary(
        db,
        chat.chatId,
        { kind: 'episode', value: 'Discussed oolong harvests' },
        clockAt('2026-11-16T00:05:00.000Z')
      )
    })

    expect(recallForTurn(storage, { chatId: chat.chatId, present, queryTexts: ['oolong'], tokenBudget: 0 })).toEqual([])

    const lines = recallForTurn(storage, { chatId: chat.chatId, present, queryTexts: ['oolong'], tokenBudget: 500 })
    expect(lines).toEqual([
      'member 1: role: host',
      'member 1: drinks oolong daily',
      'someone not in this conversation: trip: oolong farm (upcoming until 2027-02-01T00:00:00.000Z)',
      'this chat: Discussed oolong harvests'
    ])
    for (const line of lines) {
      expect(line).not.toContain('subj-1')
      expect(line).not.toContain('subj-absent')
    }

    const tight = recallForTurn(storage, { chatId: chat.chatId, present, queryTexts: ['oolong'], tokenBudget: 8 })
    expect(tight).toEqual(['member 1: role: host'])

    // memoryLine direct check
    expect(
      memoryLine(
        { itemId: 'm_1', kind: 'fact', key: 'city', value: 'Lisbon', status: 'active', pinned: false, updatedAt: '' },
        present
      )
    ).toBe('this chat: city: Lisbon')
  })

  it('searchHistory escapes LIKE wildcards, skips FORGOTTEN_MESSAGE, and includes episode summaries', () => {
    const storage = tmpStorage()
    const chat = ensureChat(storage, { waId: 'fake-chat-hist', type: 'dm' })
    storage.tx((db) => {
      db.prepare(
        "INSERT INTO session_message (chat_id, role, sender_id, content, created_at) VALUES (?, 'user', 's1', '100%_widget match', '2026-11-16T00:01:00.000Z')"
      ).run(chat.chatId)
      db.prepare(
        "INSERT INTO session_message (chat_id, role, sender_id, content, created_at) VALUES (?, 'user', 's1', '1000 widget nonmatch', '2026-11-16T00:02:00.000Z')"
      ).run(chat.chatId)
      db.prepare(
        "INSERT INTO session_message (chat_id, role, sender_id, content, created_at) VALUES (?, 'user', 's1', ?, '2026-11-16T00:03:00.000Z')"
      ).run(chat.chatId, FORGOTTEN_MESSAGE)
      addSummary(
        db,
        chat.chatId,
        { kind: 'episode', value: 'Discussed oolong tea' },
        clockAt('2026-11-16T00:04:00.000Z')
      )
    })

    const hits = searchHistory(storage, chat.chatId, '100%_widget', 10)
    expect(hits).toEqual([{ at: '2026-11-16T00:01:00.000Z', senderId: 's1', text: '100%_widget match' }])

    const combined = searchHistory(storage, chat.chatId, 'tea', 10)
    expect(combined).toEqual([{ at: '2026-11-16T00:04:00.000Z', text: 'Discussed oolong tea' }])
    expect(searchHistory(storage, chat.chatId, 'removed', 10)).toEqual([])
  })

  it('createMemoryPort checkNote enforces validation, judge availability, threshold and timeout', async () => {
    const storage = tmpStorage()
    const chat = ensureChat(storage, { waId: 'fake-chat-port', type: 'dm' })
    const ac = new AbortController()

    const noJudge = createMemoryPort({ storage, verifyThreshold: 0.5, timeoutMs: 50 })
    expect(await noJudge.checkNote({ chatId: chat.chatId, subjectId: 's1', text: '   ' }, ac.signal)).toEqual({
      ok: false,
      reason: 'invalid_text'
    })
    expect(
      await noJudge.checkNote(
        { chatId: chat.chatId, subjectId: 's1', text: 'x'.repeat(MAX_VALUE_CHARS + 1) },
        ac.signal
      )
    ).toEqual({ ok: false, reason: 'invalid_text' })
    expect(await noJudge.checkNote({ chatId: chat.chatId, subjectId: 's1', text: 'likes tea' }, ac.signal)).toEqual({
      ok: false,
      reason: 'judge_unavailable'
    })

    const rejectingJudge: MemoryJudge = {
      admit: async () => 0,
      verify: async () => {
        throw new Error('down')
      }
    }
    const portErr = createMemoryPort({ storage, judge: rejectingJudge, verifyThreshold: 0.5, timeoutMs: 50 })
    expect(await portErr.checkNote({ chatId: chat.chatId, subjectId: 's1', text: 'likes tea' }, ac.signal)).toEqual({
      ok: false,
      reason: 'judge_unavailable'
    })

    const hangingJudge: MemoryJudge = {
      admit: async () => 0,
      verify: (_input, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')))
        })
    }
    const portTimeout = createMemoryPort({ storage, judge: hangingJudge, verifyThreshold: 0.5, timeoutMs: 20 })
    expect(await portTimeout.checkNote({ chatId: chat.chatId, subjectId: 's1', text: 'likes tea' }, ac.signal)).toEqual(
      {
        ok: false,
        reason: 'judge_unavailable'
      }
    )

    let score = 0.4
    const judge: MemoryJudge = { admit: async () => 1, verify: async () => score }
    const port = createMemoryPort({ storage, judge, verifyThreshold: 0.5, timeoutMs: 50 })
    expect(await port.checkNote({ chatId: chat.chatId, subjectId: 's1', text: 'likes tea' }, ac.signal)).toEqual({
      ok: false,
      reason: 'not_supported'
    })
    score = 0.8
    expect(await port.checkNote({ chatId: chat.chatId, subjectId: 's1', text: 'likes tea' }, ac.signal)).toEqual({
      ok: true
    })
  })
})
