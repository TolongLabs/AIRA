import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { isoNow, type Storage } from './database.js'
import { insertFailure } from './failures.js'
import { type SweepResult, sweepFiles } from './files.js'
import { JOB_TABLES, releaseLeases } from './leases.js'

// The start-up recovery pass (docs/trd/storage.md#start-up-sequence, step 4).

export interface RecoveryOptions {
  filesDir: string
  snapshotsDir: string
  /** Reconciles reminders with the gateway's schedule. Tools (docs/trd/tools.md) supplies it. */
  reconcileReminders?: () => number
  now?: () => Date
}

export interface RecoveryReport {
  interruptedTurns: string[]
  releasedLeases: number
  remindersRecreated: number
  failedSnapshots: string[]
  files: SweepResult
}

/** Every running turn becomes interrupted, with a failure record that names the stage it reached. */
export function interruptRunningTurns(storage: Storage, now: () => Date = () => new Date()): string[] {
  return storage.tx((db) => {
    const running = db.prepare("SELECT turn_id, stage FROM turn WHERE state = 'running'").all() as {
      turn_id: string
      stage: string
    }[]
    const interrupt = db.prepare("UPDATE turn SET state = 'interrupted', ended_at = ? WHERE turn_id = ?")
    for (const turn of running) {
      interrupt.run(isoNow(now), turn.turn_id)
      insertFailure(
        db,
        {
          turnId: turn.turn_id,
          stage: turn.stage,
          kind: 'turn_interrupted',
          message: `the process stopped while the turn was at stage ${turn.stage}`,
          handledBy: 'recovery'
        },
        now
      )
    }
    return running.map((turn) => turn.turn_id)
  })
}

/** A snapshot that never finished becomes failed and its file is removed. */
export function failUnfinishedSnapshots(
  storage: Storage,
  snapshotsDir: string,
  now: () => Date = () => new Date()
): string[] {
  const started = storage.read(
    (db) =>
      db.prepare("SELECT id, file FROM backup_run WHERE state = 'started'").all() as { id: number; file: string }[]
  )
  for (const run of started) {
    if (run.file !== '') rmSync(join(snapshotsDir, run.file), { force: true })
    storage.tx((db) => {
      db.prepare(
        "UPDATE backup_run SET state = 'failed', detail = ?, ended_at = ? WHERE id = ? AND state = 'started'"
      ).run('the process stopped before the snapshot was verified', isoNow(now), run.id)
      insertFailure(
        db,
        {
          stage: 'snapshot',
          kind: 'backup_failed',
          message: `snapshot ${run.id} never finished`,
          handledBy: 'recovery'
        },
        now
      )
    })
  }
  return started.map((run) => run.file)
}

/**
 * The snapshots folder holds verified snapshots and nothing else. A kill during a copy or its verification can
 * leave a journal or a part of a file there; this removes every entry that is not a verified snapshot. A verified
 * row whose file is gone is marked removed, with a failure record.
 */
export function sweepSnapshots(storage: Storage, snapshotsDir: string, now: () => Date = () => new Date()): string[] {
  mkdirSync(snapshotsDir, { recursive: true })
  const verified = storage.read(
    (db) =>
      db.prepare("SELECT id, file FROM backup_run WHERE state = 'verified' AND removed_at IS NULL").all() as {
        id: number
        file: string
      }[]
  )
  const keep = new Set(verified.map((run) => run.file))
  const present = new Set(readdirSync(snapshotsDir))
  const removed = [...present].filter((entry) => !keep.has(entry))
  for (const entry of removed) rmSync(join(snapshotsDir, entry), { recursive: true, force: true })
  const lost = verified.filter((run) => !present.has(run.file))
  if (lost.length > 0) {
    storage.tx((db) => {
      for (const run of lost) {
        db.prepare('UPDATE backup_run SET removed_at = ? WHERE id = ?').run(isoNow(now), run.id)
        insertFailure(
          db,
          {
            stage: 'snapshot',
            kind: 'backup_failed',
            message: `verified snapshot ${run.file} is missing`,
            handledBy: 'recovery'
          },
          now
        )
      }
    })
  }
  return removed
}

export function runRecovery(storage: Storage, options: RecoveryOptions): RecoveryReport {
  const now = options.now ?? (() => new Date())
  const interruptedTurns = interruptRunningTurns(storage, now)
  let releasedLeases = 0
  for (const table of JOB_TABLES) releasedLeases += releaseLeases(storage, table, undefined, now)
  const remindersRecreated = options.reconcileReminders?.() ?? 0
  const failedSnapshots = failUnfinishedSnapshots(storage, options.snapshotsDir, now)
  sweepSnapshots(storage, options.snapshotsDir, now)
  const files = sweepFiles(storage, options.filesDir, now)
  return { interruptedTurns, releasedLeases, remindersRecreated, failedSnapshots, files }
}
