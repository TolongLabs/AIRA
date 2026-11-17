import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { type Redactor, createRedactor } from '../records/redact.js'
import { endJobRun, recordFailure, startJobRun } from '../records/turn-record.js'
import { type Db, type Storage, isoNow } from './database.js'
import { insertFailure } from './failures.js'

// Verified local snapshots (docs/trd/storage.md#snapshots-and-the-off-host-copy).
// A snapshot counts only after it opens, passes integrity_check, and its row counts are within reason.

export type SnapshotReason = 'timer' | 'migration' | 'deploy' | 'manual'

export interface SnapshotResult {
  id: number
  state: 'verified' | 'failed'
  /** File name inside the snapshots folder. */
  file: string
  detail?: string
}

type Clock = () => Date
const wallClock: Clock = () => new Date()

function tableCounts(db: Db): Map<string, number> {
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .pluck()
    .all() as string[]
  // Table names come from the schema itself, quoted, never from input text.
  return new Map(
    names.map((name) => [
      name,
      db
        .prepare(`SELECT count(*) FROM "${name.replace(/"/g, '""')}"`)
        .pluck()
        .get() as number
    ])
  )
}

/** Opens the copy, runs integrity_check and compares row counts with the live file before and after the copy. */
function verify(path: string, before: Map<string, number>, after: Map<string, number>): string | undefined {
  let copy: Db | undefined
  try {
    copy = new Database(path, { fileMustExist: true })
    // The copy inherits WAL mode. A snapshot is one self-contained file, so it goes back to a rollback journal.
    const mode = copy.pragma('journal_mode = DELETE', { simple: true })
    if (mode !== 'delete') return `journal_mode is ${String(mode)}, not delete`
    const integrity = copy.pragma('integrity_check') as { integrity_check: string }[]
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
      return `integrity_check: ${integrity.map((row) => row.integrity_check).join('; ')}`
    }
    const counts = tableCounts(copy)
    for (const [table, live] of before) {
      const copied = counts.get(table)
      if (copied === undefined) return `table ${table} is missing from the snapshot`
      // The copy is taken while the core writes, so a count may sit anywhere between the two live counts.
      const low = Math.min(live, after.get(table) ?? live)
      const high = Math.max(live, after.get(table) ?? live)
      if (copied < low || copied > high) return `table ${table} has ${copied} rows, live has ${low} to ${high}`
    }
    return undefined
  } catch (error) {
    return `cannot open the snapshot: ${(error as Error).message}`
  } finally {
    copy?.close()
  }
}

/**
 * Takes one snapshot with the online backup and verifies it. An unverified snapshot is deleted and recorded as
 * backup_failed. Copy and verification faults return a failed result; setup or storage faults reject.
 */
export async function takeSnapshot(
  storage: Storage,
  snapshotsDir: string,
  reason: SnapshotReason,
  now: Clock = wallClock,
  options: { redactor?: Redactor; afterVerified?: () => void } = {}
): Promise<SnapshotResult> {
  const redactor = options.redactor ?? createRedactor()
  const jobId = randomUUID()
  let runId: number | undefined
  try {
    runId = storage.tx((db) => startJobRun(db, { kind: 'snapshot', jobId }, now))
    const result = await copySnapshot(storage, snapshotsDir, reason, now, jobId, redactor)
    if (result.state === 'verified') options.afterVerified?.()
    const id = runId
    storage.tx((db) => endJobRun(db, id, { outcome: result.state === 'verified' ? 'ok' : 'failed' }, now))
    return result
  } catch (error) {
    const id = runId
    storage.tx((db) => {
      recordFailure(db, { jobId, stage: 'snapshot', kind: 'backup_failed', error, handledBy: 'backup' }, redactor, now)
      if (id !== undefined) endJobRun(db, id, { outcome: 'failed' }, now)
    })
    throw error
  }
}

async function copySnapshot(
  storage: Storage,
  snapshotsDir: string,
  reason: SnapshotReason,
  now: Clock,
  jobId: string,
  redactor: Redactor
): Promise<SnapshotResult> {
  mkdirSync(snapshotsDir, { recursive: true })
  const stamp = isoNow(now)
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')
  const { id, file, before } = storage.tx((db) => {
    const run = db
      .prepare("INSERT INTO backup_run (reason, state, file, started_at) VALUES (?, 'started', '', ?)")
      .run(reason, isoNow(now))
    const runId = Number(run.lastInsertRowid)
    const name = `aira-${stamp}-${runId}.db`
    db.prepare('UPDATE backup_run SET file = ? WHERE id = ?').run(name, runId)
    return { id: runId, file: name, before: tableCounts(db) }
  })
  const path = join(snapshotsDir, file)

  let fault: string | undefined
  try {
    await storage.backup(path)
    fault = verify(path, before, storage.read(tableCounts))
    if (fault === undefined) {
      const fd = openSync(path, 'r')
      try {
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
    }
  } catch (error) {
    fault = `backup failed: ${(error as Error).message}`
  }

  if (fault !== undefined) {
    for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(path + suffix, { force: true })
    const detail = fault
    storage.tx((db) => {
      db.prepare("UPDATE backup_run SET state = 'failed', detail = ?, ended_at = ? WHERE id = ?").run(
        detail,
        isoNow(now),
        id
      )
      insertFailure(
        db,
        { jobId, stage: 'snapshot', kind: 'backup_failed', message: redactor.scrub(detail), handledBy: 'backup' },
        now
      )
    })
    return { id, state: 'failed', file, detail }
  }

  const bytes = statSync(path).size
  storage.tx((db) =>
    db
      .prepare("UPDATE backup_run SET state = 'verified', bytes = ?, ended_at = ? WHERE id = ?")
      .run(bytes, isoNow(now), id)
  )
  return { id, state: 'verified', file }
}

/** Removes verified snapshots older than keepDays. The newest verified snapshot always stays. */
export function pruneSnapshots(
  storage: Storage,
  snapshotsDir: string,
  keepDays: number,
  now: Clock = wallClock
): string[] {
  const cutoff = new Date(now().getTime() - keepDays * 86_400_000).toISOString()
  const old = storage.read(
    (db) =>
      db
        .prepare(
          `SELECT id, file FROM backup_run
           WHERE state = 'verified' AND removed_at IS NULL AND started_at < ?
             AND id <> (SELECT max(id) FROM backup_run WHERE state = 'verified' AND removed_at IS NULL)`
        )
        .all(cutoff) as { id: number; file: string }[]
  )
  for (const row of old) {
    rmSync(join(snapshotsDir, row.file), { force: true })
    storage.tx((db) => db.prepare('UPDATE backup_run SET removed_at = ? WHERE id = ?').run(isoNow(now), row.id))
  }
  return old.map((row) => row.file)
}

/** The newest verified snapshot still on the volume, for reports and restores. */
export function latestSnapshot(storage: Storage): string | undefined {
  return storage.read(
    (db) =>
      db
        .prepare("SELECT file FROM backup_run WHERE state = 'verified' AND removed_at IS NULL ORDER BY id DESC LIMIT 1")
        .pluck()
        .get() as string | undefined
  )
}

/**
 * Takes a snapshot every everyMin minutes and prunes old ones. One snapshot runs at a time. Returns a stop
 * function that waits for a running snapshot to finish.
 */
export function startSnapshotTimer(
  storage: Storage,
  snapshotsDir: string,
  options: {
    everyMin: number
    keepDays: number
    onResult?: (result: SnapshotResult) => void
    onError?: (error: unknown) => void
    redactor?: Redactor
    now?: Clock
  }
): () => Promise<void> {
  let running: Promise<void> | undefined
  const tick = () => {
    if (running) return
    running = takeSnapshot(storage, snapshotsDir, 'timer', options.now, {
      redactor: options.redactor,
      afterVerified: () => {
        pruneSnapshots(storage, snapshotsDir, options.keepDays, options.now)
      }
    })
      .then((result) => {
        if (result.state === 'failed') options.onError?.(new Error(result.detail ?? 'snapshot failed'))
        options.onResult?.(result)
      })
      .catch((error: unknown) => {
        options.onError?.(error)
      })
      .finally(() => {
        running = undefined
      })
  }
  const timer = setInterval(tick, options.everyMin * 60_000)
  timer.unref()
  return async () => {
    clearInterval(timer)
    await running
  }
}
