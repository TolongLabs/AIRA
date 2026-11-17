import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { FailureKind } from '../../src/records/kinds.js'
import { buildReport, formatReport, newestSnapshotFile } from '../../src/records/report.js'
import { updateTurnRecord } from '../../src/records/turn-record.js'
import { archiveAndPrune } from '../../src/storage/archive.js'
import type { Storage } from '../../src/storage/database.js'
import { insertFailure } from '../../src/storage/failures.js'
import { takeSnapshot } from '../../src/storage/snapshot.js'
import { closeTurn, openTurn, receiveInbound } from '../../src/storage/turns.js'
import { tmpDir, tmpStorage } from '../support/tmp.js'

function addTurn(
  storage: Storage,
  input: {
    turnId: string
    mid: string
    kind: 'reply' | 'command' | 'scheduled'
    receivedAt: string
    returnedAt?: string
    state: 'delivered' | 'declined' | 'failed'
    role?: string
    costUsd?: number
    failureKind?: FailureKind
  }
): void {
  const startClock = () => new Date(input.receivedAt)
  receiveInbound(storage, { chatId: 'chat-1', mid: input.mid, senderId: 'sender-1' }, startClock)
  openTurn(
    storage,
    { turnId: input.turnId, chatId: 'chat-1', senderId: 'sender-1', kind: input.kind, mids: [input.mid] },
    startClock
  )
  storage.tx((db) => {
    updateTurnRecord(db, input.turnId, {
      outcome: input.state,
      ...(input.role ? { role: input.role } : {}),
      ...(input.costUsd !== undefined ? { costUsd: input.costUsd } : {}),
      ...(input.failureKind ? { failureKind: input.failureKind as never } : {})
    })
    if (input.returnedAt) {
      db.prepare('UPDATE turn SET returned_at = ? WHERE turn_id = ?').run(input.returnedAt, input.turnId)
    }
    if (input.failureKind) {
      insertFailure(db, { turnId: input.turnId, stage: 'model', kind: input.failureKind, message: 'err' }, startClock)
    }
  })
  const endClock = () => new Date(input.returnedAt ?? input.receivedAt)
  closeTurn(
    storage,
    {
      turnId: input.turnId,
      state: input.state,
      ...(input.state === 'delivered' ? { reply: `reply-${input.turnId}` } : {})
    },
    endClock
  )
}

describe('formatReport', () => {
  it('formats range, turn latencies, failures, cost and fallback rate with - for nulls', () => {
    const text = formatReport({
      from: '2026-01-01',
      to: '2026-02-01',
      turns: [
        { kind: 'reply', count: 10, p50Ms: 120.4, p90Ms: 450.9 },
        { kind: 'command', count: 2, p50Ms: null, p90Ms: null }
      ],
      failures: [{ kind: 'transient', count: 3 }],
      costUsd: 1.25,
      fallbackRate: 0.25
    })
    expect(text).toContain('2026-01-01 .. 2026-02-01')
    expect(text).toContain('reply: count=10 p50=120ms p90=451ms')
    expect(text).toContain('command: count=2 p50=- p90=-')
    expect(text).toContain('transient: count=3')
    expect(text).toContain('cost: $1.2500')
    expect(text).toContain('fallback_rate: 25.0%')

    const empty = formatReport({
      from: '2026-01-01',
      to: '2026-02-01',
      turns: [],
      failures: [],
      costUsd: 0,
      fallbackRate: null
    })
    expect(empty).toContain('fallback_rate: -')
  })
})

describe('buildReport', () => {
  it('uses inbound arrival for latency and date range before the turn opens', async () => {
    const dataDir = tmpDir('aira-report-arrival-')
    const storage = tmpStorage({ dir: dataDir })
    addTurn(storage, {
      turnId: 'arrival-turn',
      mid: 'arrival-mid',
      kind: 'reply',
      state: 'delivered',
      receivedAt: '2026-01-02T00:00:01.500Z',
      returnedAt: '2026-01-02T00:00:02.000Z'
    })
    storage.tx((db) => updateTurnRecord(db, 'arrival-turn', { arrivedAt: '2026-01-01T23:59:59.000Z' }))
    const snapshot = await takeSnapshot(storage, join(dataDir, 'snapshots'), 'manual')
    const report = await buildReport({
      snapshotFile: join(dataDir, 'snapshots', snapshot.file),
      archiveDir: join(dataDir, 'archive'),
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-02T00:00:00.000Z'
    })
    expect(report.turns).toEqual([{ kind: 'reply', count: 1, p50Ms: 3000, p90Ms: 3000 }])
  })

  it('combines snapshot and archive, deduplicates overlap, and computes percentiles, cost, failures and fallback rate', async () => {
    const dataDir = tmpDir('aira-report-')
    const storage = tmpStorage({ dir: dataDir })
    const snapshotsDir = join(dataDir, 'snapshots')
    const archiveDir = join(dataDir, 'archive')

    // Old turns in Jan 2026 (will be in both snapshot-1 and archive, testing deduplication).
    addTurn(storage, {
      turnId: 't-1',
      mid: 'm-1',
      kind: 'reply',
      receivedAt: '2026-01-10T10:00:00.000Z',
      returnedAt: '2026-01-10T10:00:00.100Z', // 100ms
      state: 'delivered',
      role: 'main',
      costUsd: 0.1
    })
    addTurn(storage, {
      turnId: 't-2',
      mid: 'm-2',
      kind: 'reply',
      receivedAt: '2026-01-11T10:00:00.000Z',
      returnedAt: '2026-01-11T10:00:00.300Z', // 300ms
      state: 'delivered',
      role: 'fallback',
      costUsd: 0.2
    })
    addTurn(storage, {
      turnId: 't-3',
      mid: 'm-3',
      kind: 'command',
      receivedAt: '2026-01-12T10:00:00.000Z',
      state: 'failed',
      failureKind: 'transient',
      costUsd: 0.05
    })

    // Take snapshot while old turns are still in SQLite.
    const snap1 = await takeSnapshot(storage, snapshotsDir, 'manual', () => new Date('2026-06-01T00:00:00.000Z'))
    expect(snap1.state).toBe('verified')

    // Add a recent turn in May 2026 (in snapshot 2 only) and one in June 2026 (outside [from, to)).
    addTurn(storage, {
      turnId: 't-4',
      mid: 'm-4',
      kind: 'reply',
      receivedAt: '2026-05-15T10:00:00.000Z',
      returnedAt: '2026-05-15T10:00:00.500Z', // 500ms
      state: 'delivered',
      role: 'main',
      costUsd: 0.3
    })
    addTurn(storage, {
      turnId: 't-out',
      mid: 'm-5',
      kind: 'reply',
      receivedAt: '2026-06-01T00:00:00.000Z',
      returnedAt: '2026-06-01T00:00:01.000Z',
      state: 'delivered',
      role: 'main',
      costUsd: 9.99
    })

    // Archive and prune old turns (Jan 2026). Now Jan turns are in BOTH snap1 and archive!
    await archiveAndPrune(storage, {
      archiveDir,
      config: { retentionDays: 90, diagnosticsHours: 72, windowDays: 7 },
      enabled: true,
      now: () => new Date('2026-06-01T00:00:00.000Z')
    })

    // Take second snapshot: has t-4 and t-out, while t-1..t-3 come from archive.
    const snap2 = await takeSnapshot(storage, snapshotsDir, 'manual', () => new Date('2026-06-02T00:00:00.000Z'))
    expect(snap2.state).toBe('verified')

    const report = await buildReport({
      snapshotFile: join(snapshotsDir, snap2.file),
      archiveDir,
      from: '2026-01-01',
      to: '2026-06-01'
    })

    expect(report.turns).toEqual([
      { kind: 'command', count: 1, p50Ms: null, p90Ms: null },
      { kind: 'reply', count: 3, p50Ms: 300, p90Ms: 460 }
    ])
    expect(report.failures).toEqual([{ kind: 'transient', count: 1 }])
    expect(report.costUsd).toBeCloseTo(0.65, 6)
    expect(report.fallbackRate).toBeCloseTo(1 / 3, 6)

    // Test overlap deduplication directly against snap1 (which also contains t-1..t-3) + archive.
    const overlapReport = await buildReport({
      snapshotFile: join(snapshotsDir, snap1.file),
      archiveDir,
      from: '2026-01-01',
      to: '2026-02-01'
    })
    expect(overlapReport.turns).toEqual([
      { kind: 'command', count: 1, p50Ms: null, p90Ms: null },
      { kind: 'reply', count: 2, p50Ms: 200, p90Ms: 280 }
    ])
    expect(overlapReport.failures).toEqual([{ kind: 'transient', count: 1 }])
    expect(overlapReport.costUsd).toBeCloseTo(0.35, 6)
  })
})

describe('newestSnapshotFile', () => {
  it('returns the newest snapshot that passes an integrity check, without the live database', async () => {
    const dataDir = tmpDir('aira-report-pick-')
    const storage = tmpStorage({ dir: dataDir })
    const snapshotsDir = join(dataDir, 'snapshots')
    expect(newestSnapshotFile(snapshotsDir)).toBeUndefined()

    const first = await takeSnapshot(storage, snapshotsDir, 'manual', () => new Date('2026-06-01T00:00:00.000Z'))
    const second = await takeSnapshot(storage, snapshotsDir, 'manual', () => new Date('2026-06-02T00:00:00.000Z'))
    expect(newestSnapshotFile(snapshotsDir)).toBe(join(snapshotsDir, second.file))

    // A newer file that is not a database, and a file with another name, are passed over.
    writeFileSync(join(snapshotsDir, 'aira-20260603T000000Z-99.db'), 'not a database')
    writeFileSync(join(snapshotsDir, 'notes.txt'), 'x')
    expect(newestSnapshotFile(snapshotsDir)).toBe(join(snapshotsDir, second.file))
    expect(first.file < second.file).toBe(true)
  })
})
