import { describe, expect, it } from 'vitest'
import { FAILURE_KINDS, isFailureKind } from '../../src/records/kinds.js'
import { createRedactor } from '../../src/records/redact.js'
import { pruneRecords } from '../../src/records/retention.js'
import {
  endJobRun,
  markStage,
  recordFailure,
  recordModelCall,
  recordToolCall,
  saveDiagnostics,
  startJobRun,
  updateTurnRecord
} from '../../src/records/turn-record.js'
import { formatTurn, readTurn, stageDurations } from '../../src/records/turn-view.js'
import { type Storage } from '../../src/storage/database.js'
import { closeTurn, openTurn, receiveInbound } from '../../src/storage/turns.js'
import { tmpStorage } from '../support/tmp.js'

const clockAt = (iso: string) => () => new Date(iso)

function seedTurn(
  storage: Storage,
  turnId: string,
  options: { chatId?: string; mid?: string; senderId?: string; at?: string } = {}
): void {
  const chatId = options.chatId ?? 'chat-1'
  const mid = options.mid ?? `mid-${turnId}`
  const senderId = options.senderId ?? 'sender-1'
  const at = clockAt(options.at ?? '2026-01-01T10:00:00.000Z')
  receiveInbound(storage, { chatId, mid, senderId }, at)
  openTurn(storage, { turnId, chatId, senderId, kind: 'reply', mids: [mid] }, at)
}

describe('failure kinds', () => {
  it('contains unique kinds accepted by isFailureKind and rejects unknown ones', () => {
    expect(new Set(FAILURE_KINDS).size).toBe(FAILURE_KINDS.length)
    for (const kind of FAILURE_KINDS) {
      expect(isFailureKind(kind)).toBe(true)
    }
    expect(isFailureKind('not_a_real_kind')).toBe(false)
  })
})

describe('turn records and child records', () => {
  it('markStage stamps once, ignores a second call, and returns false for an unknown turn', () => {
    const storage = tmpStorage()
    seedTurn(storage, 't-1')

    expect(storage.tx((db) => markStage(db, 't-1', 'admitted', clockAt('2026-01-01T10:00:01.000Z')))).toBe(true)
    expect(storage.tx((db) => markStage(db, 't-1', 'admitted', clockAt('2026-01-01T10:00:09.000Z')))).toBe(false)
    expect(storage.tx((db) => markStage(db, 'unknown', 'admitted', clockAt('2026-01-01T10:00:01.000Z')))).toBe(false)

    const admittedAt = storage.read((db) =>
      db.prepare('SELECT admitted_at FROM turn WHERE turn_id = ?').pluck().get('t-1')
    )
    expect(admittedAt).toBe('2026-01-01T10:00:01.000Z')
  })

  it('updateTurnRecord writes only given fields, serialises arrays, and commits inside closeTurn', () => {
    const storage = tmpStorage()
    seedTurn(storage, 't-1')

    storage.tx((db) => {
      expect(updateTurnRecord(db, 'unknown', { mood: 'calm' })).toBe(false)
      expect(updateTurnRecord(db, 't-1', { characterId: 'char-a', mood: 'warm', moodSource: 'rules' })).toBe(true)
    })

    const closed = closeTurn(
      storage,
      {
        turnId: 't-1',
        state: 'delivered',
        reply: 'hi there',
        also: (db) => {
          updateTurnRecord(db, 't-1', {
            outcome: 'delivered',
            recalledIds: ['mem-1', 'mem-2'],
            cleaningSteps: ['trim']
          })
        }
      },
      clockAt('2026-01-01T10:00:05.000Z')
    )
    expect(closed).toBe(true)

    const row = storage.read((db) => db.prepare('SELECT * FROM turn WHERE turn_id = ?').get('t-1')) as Record<
      string,
      unknown
    >
    expect(row['character_id']).toBe('char-a')
    expect(row['mood']).toBe('warm')
    expect(row['mood_source']).toBe('rules')
    expect(row['outcome']).toBe('delivered')
    expect(JSON.parse(row['recalled_ids'] as string)).toEqual(['mem-1', 'mem-2'])
    expect(JSON.parse(row['cleaning_steps'] as string)).toEqual(['trim'])
    expect(row['sticker_id']).toBeNull()
  })

  it('recordModelCall and recordToolCall link to the turn and store only argument shapes', () => {
    const storage = tmpStorage()
    seedTurn(storage, 't-1')

    storage.tx((db) => {
      recordModelCall(db, {
        turnId: 't-1',
        role: 'reply',
        model: 'test-model',
        transport: 'http',
        attempt: 1,
        startedAt: new Date('2026-01-01T10:00:02.000Z'),
        durationMs: 250,
        inputTokens: 100,
        outputTokens: 20,
        costUsd: 0.001
      })
      recordToolCall(db, {
        turnId: 't-1',
        tool: 'lookup',
        source: 'model',
        startedAt: new Date('2026-01-01T10:00:01.500Z'),
        durationMs: 40,
        outcome: 'ok',
        args: { query: 'secret-value-123', limit: 5 }
      })
    })

    const rawTool = storage.read((db) =>
      db.prepare('SELECT turn_id, args_shape FROM tool_call WHERE turn_id = ?').get('t-1')
    ) as { turn_id: string; args_shape: string }
    expect(rawTool.turn_id).toBe('t-1')
    expect(rawTool.args_shape).not.toContain('secret-value-123')
    expect(JSON.parse(rawTool.args_shape)).toEqual({ query: 'string', limit: 'number' })
  })

  it('recordFailure keeps Error details, masks secrets, hashes ids, and handles non-Errors', () => {
    const storage = tmpStorage()
    seedTurn(storage, 't-1')
    const redactor = createRedactor({ secrets: ['super-secret-token'], salt: 'test-salt' })

    storage.tx((db) => {
      const err = new Error('failed with super-secret-token for 12345@lid')
      recordFailure(
        db,
        { turnId: 't-1', stage: 'model', kind: 'transient', error: err, handledBy: 'retry' },
        redactor,
        clockAt('2026-01-01T10:00:02.000Z')
      )
      recordFailure(
        db,
        { turnId: 't-1', stage: 'clean', kind: 'internal', error: 'plain string fault' },
        redactor,
        clockAt('2026-01-01T10:00:03.000Z')
      )
    })

    const rows = storage.read((db) =>
      db.prepare('SELECT message, stack, handled_by FROM failure WHERE turn_id = ? ORDER BY id').all('t-1')
    ) as { message: string; stack: string | null; handled_by: string | null }[]

    expect(rows).toHaveLength(2)
    expect(rows[0]?.message).not.toContain('super-secret-token')
    expect(rows[0]?.message).toContain('[secret]')
    expect(rows[0]?.message).not.toContain('12345@lid')
    expect(rows[0]?.message).toContain(redactor.hash('12345@lid'))
    expect(rows[0]?.stack).toContain('Error:')
    expect(rows[0]?.stack).not.toContain('super-secret-token')
    expect(rows[0]?.handled_by).toBe('retry')

    expect(rows[1]?.message).toBe('plain string fault')
    expect(rows[1]?.stack).toBeNull()
  })

  it('saveDiagnostics stores verbatim text and replaces on a second call', () => {
    const storage = tmpStorage()
    seedTurn(storage, 't-1')

    storage.tx((db) => {
      saveDiagnostics(db, { turnId: 't-1', request: 'first req', reply: 'first rep' }, clockAt('2026-01-01T10:00:01Z'))
      saveDiagnostics(db, { turnId: 't-1', request: 'second req' }, clockAt('2026-01-01T10:00:02Z'))
    })

    const rows = storage.read((db) => db.prepare('SELECT * FROM failure_diagnostics WHERE turn_id = ?').all('t-1')) as {
      request: string
      reply: string | null
      created_at: string
    }[]
    expect(rows).toHaveLength(1)
    expect(rows[0]?.request).toBe('second req')
    expect(rows[0]?.reply).toBeNull()
    expect(rows[0]?.created_at).toBe('2026-01-01T10:00:02.000Z')
  })

  it('keeps a handled failure on record when the turn is later delivered', () => {
    const storage = tmpStorage()
    seedTurn(storage, 't-1')
    const redactor = createRedactor()

    storage.tx((db) => {
      recordFailure(
        db,
        { turnId: 't-1', stage: 'model', kind: 'rate_limit', error: new Error('slow down'), handledBy: 'retry' },
        redactor
      )
    })
    expect(closeTurn(storage, { turnId: 't-1', state: 'delivered', reply: 'recovered' })).toBe(true)

    const count = storage.read((db) => db.prepare('SELECT count(*) FROM failure WHERE turn_id = ?').pluck().get('t-1'))
    expect(count).toBe(1)
  })

  it('starts and ends a job_run with counts', () => {
    const storage = tmpStorage()
    const id = storage.tx((db) =>
      startJobRun(db, { kind: 'memory', chatId: 'chat-1' }, clockAt('2026-01-01T10:00:00Z'))
    )
    const ok = storage.tx((db) =>
      endJobRun(db, id, { outcome: 'ok', counts: { added: 2 } }, clockAt('2026-01-01T10:00:05Z'))
    )
    expect(ok).toBe(true)

    const row = storage.read((db) => db.prepare('SELECT * FROM job_run WHERE id = ?').get(id)) as Record<
      string,
      unknown
    >
    expect(row['outcome']).toBe('ok')
    expect(JSON.parse(row['counts'] as string)).toEqual({ added: 2 })
    expect(row['ended_at']).toBe('2026-01-01T10:00:05.000Z')
  })
})

describe('turn view and formatting', () => {
  it('reads a turn, skips missing stage stamps, formats events in time order, and omits diagnostics', () => {
    const storage = tmpStorage()
    seedTurn(storage, 't-view', { at: '2026-01-01T10:00:00.000Z' })
    const redactor = createRedactor()

    storage.tx((db) => {
      markStage(db, 't-view', 'admitted', clockAt('2026-01-01T10:00:00.100Z'))
      // Skip 'built' intentionally
      markStage(db, 't-view', 'model_done', clockAt('2026-01-01T10:00:00.600Z'))
      recordToolCall(db, {
        turnId: 't-view',
        tool: 'search',
        source: 'model',
        startedAt: new Date('2026-01-01T10:00:00.300Z'),
        durationMs: 50,
        outcome: 'ok'
      })
      recordFailure(
        db,
        { turnId: 't-view', stage: 'model', kind: 'transient', error: new Error('blip'), handledBy: 'retry' },
        redactor,
        clockAt('2026-01-01T10:00:00.200Z')
      )
      recordModelCall(db, {
        turnId: 't-view',
        role: 'reply',
        model: 'm-1',
        transport: 'http',
        attempt: 2,
        startedAt: new Date('2026-01-01T10:00:00.400Z'),
        durationMs: 180
      })
      saveDiagnostics(db, { turnId: 't-view', request: 'VERBATIM_DIAGNOSTIC_TEXT' })
    })
    closeTurn(storage, { turnId: 't-view', state: 'delivered', reply: 'done' }, clockAt('2026-01-01T10:00:01.000Z'))

    const view = storage.read((db) => readTurn(db, 't-view'))
    expect(view).toBeDefined()
    if (!view) return

    expect(stageDurations(view.turn)).toEqual([
      { stage: 'admitted', ms: 100 },
      { stage: 'model_done', ms: 500 }
    ])

    const text = formatTurn(view)
    expect(text).toContain('turn t-view reply delivered')
    expect(text).toContain('admitted +100 ms')
    expect(text).toContain('model_done +500 ms')
    expect(text).not.toContain('VERBATIM_DIAGNOSTIC_TEXT')

    const failureIdx = text.indexOf('2026-01-01T10:00:00.200Z failure')
    const toolIdx = text.indexOf('2026-01-01T10:00:00.300Z tool')
    const modelIdx = text.indexOf('2026-01-01T10:00:00.400Z model')
    expect(failureIdx).toBeGreaterThan(-1)
    expect(toolIdx).toBeGreaterThan(failureIdx)
    expect(modelIdx).toBeGreaterThan(toolIdx)
  })
})

describe('retention pruning', () => {
  it('prunes old turns, children, diagnostics, and window messages while preserving running turns and setting_change', () => {
    const storage = tmpStorage()
    const redactor = createRedactor()

    // Old delivered turn (100 days old) with all children
    seedTurn(storage, 't-old', { mid: 'm-old', at: '2025-09-01T00:00:00.000Z' })
    storage.tx((db) => {
      recordModelCall(db, {
        turnId: 't-old',
        role: 'reply',
        model: 'm-1',
        transport: 'http',
        attempt: 1,
        startedAt: new Date('2025-09-01T00:00:01.000Z'),
        durationMs: 10
      })
      recordToolCall(db, {
        turnId: 't-old',
        tool: 'ping',
        source: 'command',
        startedAt: new Date('2025-09-01T00:00:02.000Z'),
        durationMs: 5,
        outcome: 'ok'
      })
      recordFailure(
        db,
        { turnId: 't-old', stage: 'model', kind: 'transient', error: 'old err' },
        redactor,
        clockAt('2025-09-01T00:00:03.000Z')
      )
      saveDiagnostics(db, { turnId: 't-old', request: 'old diag' }, clockAt('2025-09-01T00:00:04.000Z'))
    })
    closeTurn(storage, { turnId: 't-old', state: 'delivered', reply: 'old reply' }, clockAt('2025-09-01T00:00:05.000Z'))

    // Old running turn (100 days old): must stay
    seedTurn(storage, 't-running', { mid: 'm-run', at: '2025-09-01T00:00:00.000Z' })

    // Recent turn (10 days old): turn stays, its 10-day-old window message goes (>7 days), diagnostics go (>72 hours)
    seedTurn(storage, 't-recent', { mid: 'm-rec', at: '2026-01-01T00:00:00.000Z' })
    storage.tx((db) => {
      saveDiagnostics(db, { turnId: 't-recent', request: 'recent diag' }, clockAt('2026-01-01T00:00:01.000Z'))
    })
    closeTurn(
      storage,
      { turnId: 't-recent', state: 'delivered', reply: 'recent reply' },
      clockAt('2026-01-01T00:00:02.000Z')
    )

    // Setting change: never pruned
    storage.tx((db) => {
      db.prepare(
        `INSERT INTO setting_change (target, actor, level, scope, key, new_value, changed_at)
         VALUES ('setting', 'admin', 'global', '', 'k', '"v"', '2020-01-01T00:00:00.000Z')`
      ).run()
    })

    const exportedTables: string[] = []
    const result = pruneRecords(
      storage,
      { retentionDays: 90, diagnosticsHours: 72, windowDays: 7 },
      {
        now: clockAt('2026-01-11T00:00:00.000Z'),
        beforeDelete: (table) => {
          exportedTables.push(table)
        }
      }
    )

    expect(exportedTables).toContain('turn')
    expect(exportedTables).toContain('model_call')
    expect(exportedTables).toContain('tool_call')
    expect(exportedTables).toContain('failure')
    expect(exportedTables).toContain('inbound_message')
    expect(exportedTables).not.toContain('session_message')
    expect(exportedTables).not.toContain('failure_diagnostics')

    expect(result.counts['turn']).toBe(1)
    expect(result.counts['model_call']).toBe(1)
    expect(result.counts['tool_call']).toBe(1)
    expect(result.counts['failure']).toBe(1)
    expect(result.counts['inbound_message']).toBe(1)
    expect(result.counts['failure_diagnostics']).toBe(2)
    expect(result.counts['session_message']).toBe(2)

    const remainingTurns = storage.read((db) =>
      db.prepare('SELECT turn_id FROM turn ORDER BY turn_id').pluck().all()
    ) as string[]
    expect(remainingTurns).toEqual(['t-recent', 't-running'])

    const settingChanges = storage.read((db) => db.prepare('SELECT count(*) FROM setting_change').pluck().get())
    expect(settingChanges).toBe(1)

    const jobRow = storage.read((db) =>
      db.prepare('SELECT kind, outcome, counts FROM job_run WHERE id = ?').get(result.jobRunId)
    ) as {
      kind: string
      outcome: string
      counts: string
    }
    expect(jobRow.kind).toBe('retention')
    expect(jobRow.outcome).toBe('ok')
    expect(JSON.parse(jobRow.counts)).toEqual(result.counts)

    expect(() => storage.check()).not.toThrow()
  })
})
