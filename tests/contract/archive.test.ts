import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { FailureKind } from '../../src/records/kinds.js'
import { recordModelCall, updateTurnRecord } from '../../src/records/turn-record.js'
import { archiveAndPrune, writeParquet } from '../../src/storage/archive.js'
import type { Storage } from '../../src/storage/database.js'
import { insertFailure } from '../../src/storage/failures.js'
import { closeTurn, openTurn, receiveInbound } from '../../src/storage/turns.js'
import { tmpDir, tmpStorage } from '../support/tmp.js'

const CONFIG = { retentionDays: 90, diagnosticsHours: 72, windowDays: 7 }

function seedTurn(
  storage: Storage,
  input: {
    turnId: string
    mid: string
    at: string
    kind?: 'reply' | 'command' | 'scheduled'
    failureKind?: FailureKind
  }
): void {
  const clock = () => new Date(input.at)
  receiveInbound(
    storage,
    {
      chatId: 'chat-1',
      mid: input.mid,
      senderId: 'sender-1',
      onNew: (db) => {
        db.prepare(
          "INSERT INTO session_message (chat_id, role, sender_id, content, created_at) VALUES ('chat-1', 'user', 'sender-1', ?, ?)"
        ).run(`text-${input.turnId}`, input.at)
      }
    },
    clock
  )
  openTurn(
    storage,
    { turnId: input.turnId, chatId: 'chat-1', senderId: 'sender-1', kind: input.kind ?? 'reply', mids: [input.mid] },
    clock
  )
  storage.tx((db) => {
    updateTurnRecord(db, input.turnId, {
      outcome: input.failureKind ? 'failed' : 'delivered',
      role: 'main',
      costUsd: 0.01,
      ...(input.failureKind ? { failureKind: input.failureKind as never } : {})
    })
    recordModelCall(db, {
      turnId: input.turnId,
      role: 'main',
      model: 'test-model',
      transport: 'api',
      attempt: 1,
      startedAt: new Date(input.at),
      durationMs: 50,
      costUsd: 0.01
    })
    if (input.failureKind) {
      insertFailure(db, { turnId: input.turnId, stage: 'model', kind: input.failureKind, message: 'err' }, clock)
      db.prepare('INSERT INTO failure_diagnostics (turn_id, request, reply, created_at) VALUES (?, ?, ?, ?)').run(
        input.turnId,
        'secret request',
        'secret reply',
        input.at
      )
    }
  })
  closeTurn(
    storage,
    {
      turnId: input.turnId,
      state: input.failureKind ? 'failed' : 'delivered',
      reply: `reply-${input.turnId}`
    },
    clock
  )
}

async function readParquetRows(filePath: string): Promise<Record<string, unknown>[]> {
  const { DuckDBInstance } = await import('@duckdb/node-api')
  const instance = await DuckDBInstance.create(':memory:')
  const conn = await instance.connect()
  try {
    const res = await conn.runAndReadAll(`SELECT * FROM read_parquet('${filePath.replace(/'/g, "''")}')`)
    return res.getRowObjectsJS()
  } finally {
    conn.closeSync()
    instance.closeSync()
  }
}

describe('archiveAndPrune', () => {
  it('exports old rows to Parquet by table and month before deleting them, and keeps recent rows', async () => {
    const storage = tmpStorage()
    const archiveDir = tmpDir('aira-archive-')
    seedTurn(storage, { turnId: 't-jan', mid: 'm-1', at: '2026-01-10T10:00:00.000Z' })
    seedTurn(storage, { turnId: 't-feb', mid: 'm-2', at: '2026-02-15T10:00:00.000Z', failureKind: 'transient' })
    seedTurn(storage, { turnId: 't-recent', mid: 'm-3', at: '2026-06-01T10:00:00.000Z' })

    const result = await archiveAndPrune(storage, {
      archiveDir,
      config: CONFIG,
      enabled: true,
      now: () => new Date('2026-06-15T00:00:00.000Z')
    })

    expect(result).toBeDefined()
    expect(result?.retention.counts['turn']).toBe(2)
    expect(result?.files).toContain(join('turn', '2026-01', 'turn-20260615T000000Z.parquet'))
    expect(result?.files).toContain(join('turn', '2026-02', 'turn-20260615T000000Z.parquet'))
    expect(result?.files).toContain(join('model_call', '2026-01', 'model_call-20260615T000000Z.parquet'))
    expect(result?.files).toContain(join('failure', '2026-02', 'failure-20260615T000000Z.parquet'))

    // Verbatim tables are never archived.
    expect(existsSync(join(archiveDir, 'session_message'))).toBe(false)
    expect(existsSync(join(archiveDir, 'failure_diagnostics'))).toBe(false)

    // Read Parquet back with DuckDB and compare turn ids.
    const janTurns = await readParquetRows(join(archiveDir, 'turn', '2026-01', 'turn-20260615T000000Z.parquet'))
    const febTurns = await readParquetRows(join(archiveDir, 'turn', '2026-02', 'turn-20260615T000000Z.parquet'))
    expect(janTurns.map((row) => row['turn_id'])).toEqual(['t-jan'])
    expect(febTurns.map((row) => row['turn_id'])).toEqual(['t-feb'])

    // Recent row stays in the database; old rows are gone.
    const remaining = storage.read((db) => db.prepare('SELECT turn_id FROM turn').pluck().all() as string[])
    expect(remaining).toEqual(['t-recent'])
    storage.check()
  })

  it('does nothing when enabled is false', async () => {
    const storage = tmpStorage()
    const archiveDir = tmpDir('aira-archive-')
    seedTurn(storage, { turnId: 't-old', mid: 'm-1', at: '2026-01-10T10:00:00.000Z' })

    const result = await archiveAndPrune(storage, {
      archiveDir,
      config: CONFIG,
      enabled: false,
      now: () => new Date('2026-06-15T00:00:00.000Z')
    })

    expect(result).toBeUndefined()
    expect(readdirSync(archiveDir)).toEqual([])
    expect(storage.read((db) => db.prepare('SELECT count(*) FROM turn').pluck().get())).toBe(1)
    storage.check()
  })

  it('deletes nothing and leaves no partial file when writeParquet fails', async () => {
    const storage = tmpStorage()
    const parent = tmpDir('aira-archive-parent-')
    const fileAsArchiveDir = join(parent, 'not-a-dir')
    writeFileSync(fileAsArchiveDir, 'occupied')
    seedTurn(storage, { turnId: 't-old', mid: 'm-1', at: '2026-01-10T10:00:00.000Z' })

    await expect(
      archiveAndPrune(storage, {
        archiveDir: fileAsArchiveDir,
        config: CONFIG,
        enabled: true,
        now: () => new Date('2026-06-15T00:00:00.000Z')
      })
    ).rejects.toThrow()

    expect(storage.read((db) => db.prepare('SELECT count(*) FROM turn').pluck().get())).toBe(1)
    expect(readdirSync(parent)).toEqual(['not-a-dir'])
    storage.check()
  })

  it('refuses a table or month that is not well formed', async () => {
    const archiveDir = tmpDir('aira-archive-')
    await expect(writeParquet(archiveDir, 'bad-table!', '2026-01', [{ a: 1 }], '20260615T000000Z')).rejects.toThrow()
    await expect(writeParquet(archiveDir, 'turn', '2026-1', [{ a: 1 }], '20260615T000000Z')).rejects.toThrow()
    await expect(writeParquet(archiveDir, 'turn', '../2026', [{ a: 1 }], '20260615T000000Z')).rejects.toThrow()
  })
})
