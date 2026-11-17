import { type Db, type Storage, StorageError, isoNow } from './database.js'
import { insertFailure } from './failures.js'

// Job leases (docs/trd/storage.md#everything-in-flight-is-a-row).
// A lease has an owner and an expiry. Nothing is in progress without one.

/** Every job table. Each has the lease columns of memory_job. The recovery pass walks this list. */
export const JOB_TABLES = ['memory_job', 'research_job'] as const
export type JobTable = (typeof JOB_TABLES)[number]

type Clock = () => Date
const wallClock: Clock = () => new Date()

export interface Job {
  jobId: string
  chatId: string
  payload: string
  /** How many times the job has been leased, this lease included. */
  attempts: number
}

function tableName(table: JobTable): string {
  // The name comes from a fixed list, never from input text.
  if (!JOB_TABLES.includes(table)) throw new StorageError(`unknown job table: ${String(table)}`, 'internal')
  return table
}

/** Queues a job. Queuing the same job id twice leaves one row. Call it inside a transaction. */
export function enqueueJob(
  db: Db,
  table: JobTable,
  job: {
    jobId: string
    chatId: string
    payload: string
    runAfter?: Date
    requesterId?: string
    topic?: string
    wantsPdf?: boolean
  },
  now: Clock = wallClock
): boolean {
  const at = isoNow(now)
  const research = table === 'research_job'
  if (research && (!job.requesterId || !job.topic))
    throw new StorageError('research job needs a requester and topic', 'internal')
  const result = db
    .prepare(
      `INSERT INTO ${tableName(table)} (job_id, chat_id, state, payload, run_after, created_at, updated_at${research ? ', requester_id, topic, wants_pdf' : ''})
       VALUES (?, ?, 'queued', ?, ?, ?, ?${research ? ', ?, ?, ?' : ''}) ON CONFLICT (job_id) DO NOTHING`
    )
    .run(
      ...[
        job.jobId,
        job.chatId,
        job.payload,
        job.runAfter?.toISOString() ?? at,
        at,
        at,
        ...(research ? [job.requesterId, job.topic, job.wantsPdf ? 1 : 0] : [])
      ]
    )
  return result.changes === 1
}

/** Returns every lease past its time to the queue. */
export function reapExpiredLeases(storage: Storage, table: JobTable, now: Clock = wallClock): number {
  return storage.tx((db) => reapIn(db, table, now))
}

function reapIn(db: Db, table: JobTable, now: Clock): number {
  const at = isoNow(now)
  if (table === 'research_job') return recoverResearch(db, at, true)
  return db
    .prepare(
      `UPDATE ${tableName(table)} SET state = 'queued', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE state = 'leased' AND lease_expires_at <= ?`
    )
    .run(at, at).changes
}

/**
 * Leases the oldest due job whose chat has no job in progress, so one chat's jobs run in order and never together.
 */
export function leaseNextJob(
  storage: Storage,
  table: JobTable,
  lease: { owner: string; leaseMs: number },
  now: Clock = wallClock
): Job | undefined {
  const name = tableName(table)
  return storage.tx((db) => {
    reapIn(db, table, now)
    const at = isoNow(now)
    const row = db
      .prepare(
        `SELECT job_id, chat_id, payload, attempts FROM ${name} AS candidate
         WHERE state = 'queued' AND run_after <= ?
           AND NOT EXISTS (SELECT 1 FROM ${name} AS busy WHERE busy.chat_id = candidate.chat_id AND busy.state = '${table === 'research_job' ? 'running' : 'leased'}')
           AND NOT EXISTS (
             SELECT 1 FROM ${name} AS earlier
             WHERE earlier.chat_id = candidate.chat_id AND earlier.state = 'queued'
               AND (earlier.created_at, earlier.rowid) < (candidate.created_at, candidate.rowid)
           )
         ORDER BY created_at, rowid LIMIT 1`
      )
      .get(at) as { job_id: string; chat_id: string; payload: string; attempts: number } | undefined
    if (!row) return undefined
    db.prepare(
      `UPDATE ${name} SET state = '${table === 'research_job' ? 'running' : 'leased'}', lease_owner = ?, lease_expires_at = ?, attempts = attempts + 1, updated_at = ?
       WHERE job_id = ?`
    ).run(lease.owner, new Date(now().getTime() + lease.leaseMs).toISOString(), at, row.job_id)
    return { jobId: row.job_id, chatId: row.chat_id, payload: row.payload, attempts: row.attempts + 1 }
  })
}

/** Extends a lease the owner still holds. False means the lease was lost and the work must stop. */
export function extendLease(
  storage: Storage,
  table: JobTable,
  lease: { jobId: string; owner: string; leaseMs: number },
  now: Clock = wallClock
): boolean {
  return storage.tx(
    (db) =>
      db
        .prepare(
          `UPDATE ${tableName(table)} SET lease_expires_at = ?, updated_at = ?
           WHERE job_id = ? AND state = '${table === 'research_job' ? 'running' : 'leased'}' AND lease_owner = ? AND lease_expires_at > ?`
        )
        .run(
          new Date(now().getTime() + lease.leaseMs).toISOString(),
          isoNow(now),
          lease.jobId,
          lease.owner,
          isoNow(now)
        ).changes === 1
  )
}

/**
 * Marks a job done and commits the handler's writes in the same transaction, so running the handler twice for one
 * job leaves the same rows as running it once. False means the lease was lost; nothing is written.
 */
export function completeJob(
  storage: Storage,
  table: JobTable,
  done: { jobId: string; owner: string; apply?: (db: Db) => void },
  now: Clock = wallClock
): boolean {
  return storage.tx((db) => {
    const result = db
      .prepare(
        `UPDATE ${tableName(table)} SET state = 'done', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE job_id = ? AND state = '${table === 'research_job' ? 'running' : 'leased'}' AND lease_owner = ?`
      )
      .run(isoNow(now), done.jobId, done.owner)
    if (result.changes !== 1) return false
    done.apply?.(db)
    return true
  })
}

/**
 * Ends a failed attempt. The job returns to the queue after the next delay, or becomes failed when no retry is
 * left. Returns the new state, or undefined when the lease was lost.
 */
export function failJob(
  storage: Storage,
  table: JobTable,
  failed: { jobId: string; owner: string; error: string; retryDelaysMs: readonly number[] },
  now: Clock = wallClock
): 'queued' | 'failed' | undefined {
  const name = tableName(table)
  return storage.tx((db) => {
    const attempts = db
      .prepare(
        `SELECT attempts FROM ${name} WHERE job_id = ? AND state = '${table === 'research_job' ? 'running' : 'leased'}' AND lease_owner = ?`
      )
      .pluck()
      .get(failed.jobId, failed.owner) as number | undefined
    if (attempts === undefined) return undefined
    const delay = failed.retryDelaysMs[attempts - 1]
    const state = delay === undefined ? 'failed' : 'queued'
    db.prepare(
      `UPDATE ${name} SET state = ?, lease_owner = NULL, lease_expires_at = NULL, last_error = ?,
         run_after = ?, updated_at = ? WHERE job_id = ?`
    ).run(state, failed.error, new Date(now().getTime() + (delay ?? 0)).toISOString(), isoNow(now), failed.jobId)
    return state
  })
}

/**
 * Returns leases to the queue without waiting for their expiry. With an owner, only that owner's leases (shutdown).
 * Without one, every lease (start-up: one process writes the file, so every earlier owner is gone).
 * A lease given back at shutdown does not count as an attempt. One cut short by a crash does, so a job that
 * kills the process cannot retry for ever.
 */
export function releaseLeases(storage: Storage, table: JobTable, owner?: string, now: Clock = wallClock): number {
  if (table === 'research_job' && owner === undefined) {
    return storage.tx((db) => recoverResearch(db, isoNow(now), false))
  }
  return storage.tx(
    (db) =>
      db
        .prepare(
          `UPDATE ${tableName(table)}
           SET state = 'queued', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?,
             attempts = CASE WHEN ? IS NULL THEN attempts ELSE max(attempts - 1, 0) END
           WHERE state = '${table === 'research_job' ? 'running' : 'leased'}' AND (? IS NULL OR lease_owner = ?)`
        )
        .run(isoNow(now), owner ?? null, owner ?? null, owner ?? null).changes
  )
}

/** A research job may survive one interrupted attempt, never a third start. */
function recoverResearch(db: Db, at: string, expiredOnly: boolean): number {
  const failed = db
    .prepare(
      "SELECT job_id FROM research_job WHERE state = 'running' AND attempts >= 2 AND (? = 0 OR lease_expires_at <= ?)"
    )
    .all(expiredOnly ? 1 : 0, at) as { job_id: string }[]
  const changed = db
    .prepare(
      `UPDATE research_job SET
    state = CASE WHEN attempts >= 2 THEN 'failed' ELSE 'queued' END,
    ended_at = CASE WHEN attempts >= 2 THEN ? ELSE ended_at END,
    last_error = CASE WHEN attempts >= 2 THEN 'interrupted' ELSE last_error END,
    lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
    WHERE state = 'running' AND (? = 0 OR lease_expires_at <= ?)`
    )
    .run(at, at, expiredOnly ? 1 : 0, at).changes
  for (const row of failed)
    insertFailure(
      db,
      {
        jobId: row.job_id,
        stage: 'research',
        kind: 'internal',
        message: 'interrupted',
        handledBy: 'line:researchFailed'
      },
      () => new Date(at)
    )
  return changed
}
