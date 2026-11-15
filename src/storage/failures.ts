import { type Db, isoNow } from './database.js'

// The minimal failure writer the persistence layer needs. Records (docs/trd/records.md) builds on this table.

export interface FailureInput {
  turnId?: string
  jobId?: string
  stage: string
  /** A failure kind from docs/trd/records.md#failure-kinds. */
  kind: string
  message: string
  stack?: string
  handledBy?: string
}

/** Writes one failure row. Call it inside a transaction, with the change it explains. */
export function insertFailure(db: Db, failure: FailureInput, now: () => Date = () => new Date()): number {
  const result = db
    .prepare(
      `INSERT INTO failure (turn_id, job_id, stage, kind, message, stack, handled_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      failure.turnId ?? null,
      failure.jobId ?? null,
      failure.stage,
      failure.kind,
      failure.message,
      failure.stack ?? null,
      failure.handledBy ?? null,
      isoNow(now)
    )
  return Number(result.lastInsertRowid)
}
