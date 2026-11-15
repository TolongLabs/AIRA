import { type Db, isoNow } from '../storage/database.js'
import { insertFailure } from '../storage/failures.js'
import { type FailureKind } from './kinds.js'
import { type Redactor, shapeOf } from './redact.js'

// Writers for the turn record and its child tables (docs/trd/records.md).
// Every writer takes a Db from storage.tx() so callers can commit it with other writes.

type Clock = () => Date
const wallClock: Clock = () => new Date()

export type TurnStage = 'admitted' | 'built' | 'first_byte' | 'model_done' | 'cleaned' | 'returned'

const STAGE_COLUMN: Record<TurnStage, string> = {
  admitted: 'admitted_at',
  built: 'built_at',
  first_byte: 'first_byte_at',
  model_done: 'model_done_at',
  cleaned: 'cleaned_at',
  returned: 'returned_at'
}

/** Stamps one stage time on a running turn. The first stamp wins: a second call for the same stage changes nothing. */
export function markStage(db: Db, turnId: string, stage: TurnStage, now: Clock = wallClock): boolean {
  const column = STAGE_COLUMN[stage]
  const result = db
    .prepare(`UPDATE turn SET ${column} = ? WHERE turn_id = ? AND ${column} IS NULL`)
    .run(isoNow(now), turnId)
  return result.changes === 1
}

export interface TurnRecordFields {
  characterId?: string
  outcome?: 'delivered' | 'declined' | 'muted' | 'failed'
  failureKind?: FailureKind
  systemTokens?: number
  windowSize?: number
  recalledIds?: string[]
  mood?: string
  moodSource?: 'rules' | 'judge' | 'default'
  shapeSeed?: number
  lengthBypass?: string
  transport?: string
  role?: string
  model?: string
  attempts?: number
  inputTokens?: number
  outputTokens?: number
  cachedTokens?: number
  costUsd?: number
  replyChars?: number
  bubbleCount?: number
  stickerId?: string
  attachments?: string[]
  receipts?: string[]
  cleaningSteps?: string[]
}

const FIELD_COLUMN: Record<keyof TurnRecordFields, string> = {
  characterId: 'character_id',
  outcome: 'outcome',
  failureKind: 'failure_kind',
  systemTokens: 'system_tokens',
  windowSize: 'window_size',
  recalledIds: 'recalled_ids',
  mood: 'mood',
  moodSource: 'mood_source',
  shapeSeed: 'shape_seed',
  lengthBypass: 'length_bypass',
  transport: 'transport',
  role: 'role',
  model: 'model',
  attempts: 'attempts',
  inputTokens: 'input_tokens',
  outputTokens: 'output_tokens',
  cachedTokens: 'cached_tokens',
  costUsd: 'cost_usd',
  replyChars: 'reply_chars',
  bubbleCount: 'bubble_count',
  stickerId: 'sticker_id',
  attachments: 'attachments',
  receipts: 'receipts',
  cleaningSteps: 'cleaning_steps'
}

const JSON_FIELDS = new Set<keyof TurnRecordFields>(['recalledIds', 'attachments', 'receipts', 'cleaningSteps'])

/** Writes the given fields of the turn record. Fields left out are not changed. Returns false for an unknown turn. */
export function updateTurnRecord(db: Db, turnId: string, fields: TurnRecordFields): boolean {
  const sets: string[] = []
  const values: unknown[] = []
  for (const key of Object.keys(FIELD_COLUMN) as (keyof TurnRecordFields)[]) {
    const value = fields[key]
    if (value === undefined) continue
    sets.push(`${FIELD_COLUMN[key]} = ?`)
    values.push(JSON_FIELDS.has(key) ? JSON.stringify(value) : value)
  }
  if (sets.length === 0) {
    return db.prepare('SELECT 1 FROM turn WHERE turn_id = ?').get(turnId) !== undefined
  }
  values.push(turnId)
  const result = db.prepare(`UPDATE turn SET ${sets.join(', ')} WHERE turn_id = ?`).run(...values)
  return result.changes === 1
}

export function recordModelCall(
  db: Db,
  call: {
    turnId?: string
    jobId?: string
    role: string
    model: string
    transport: string
    attempt: number
    startedAt: Date
    durationMs: number
    inputTokens?: number
    outputTokens?: number
    cachedTokens?: number
    costUsd?: number
    failureKind?: FailureKind
  }
): number {
  const result = db
    .prepare(
      `INSERT INTO model_call (
         turn_id, job_id, role, model, transport, attempt, started_at, duration_ms,
         input_tokens, output_tokens, cached_tokens, cost_usd, failure_kind
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      call.turnId ?? null,
      call.jobId ?? null,
      call.role,
      call.model,
      call.transport,
      call.attempt,
      call.startedAt.toISOString(),
      call.durationMs,
      call.inputTokens ?? null,
      call.outputTokens ?? null,
      call.cachedTokens ?? null,
      call.costUsd ?? null,
      call.failureKind ?? null
    )
  return Number(result.lastInsertRowid)
}

export function recordToolCall(
  db: Db,
  call: {
    turnId: string
    tool: string
    source: 'model' | 'command'
    startedAt: Date
    durationMs: number
    outcome: string
    receiptId?: string
    /** The call's arguments. Only their shape is stored. */
    args?: unknown
  }
): number {
  const argsShape = call.args === undefined ? null : JSON.stringify(shapeOf(call.args))
  const result = db
    .prepare(
      `INSERT INTO tool_call (turn_id, tool, source, started_at, duration_ms, outcome, receipt_id, args_shape)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      call.turnId,
      call.tool,
      call.source,
      call.startedAt.toISOString(),
      call.durationMs,
      call.outcome,
      call.receiptId ?? null,
      argsShape
    )
  return Number(result.lastInsertRowid)
}

export function startJobRun(
  db: Db,
  run: { kind: string; chatId?: string; jobId?: string },
  now: Clock = wallClock
): number {
  const result = db
    .prepare('INSERT INTO job_run (kind, chat_id, job_id, started_at) VALUES (?, ?, ?, ?)')
    .run(run.kind, run.chatId ?? null, run.jobId ?? null, isoNow(now))
  return Number(result.lastInsertRowid)
}

export function endJobRun(
  db: Db,
  id: number,
  result: { outcome: string; counts?: Record<string, number> },
  now: Clock = wallClock
): boolean {
  const counts = result.counts === undefined ? null : JSON.stringify(result.counts)
  const updated = db
    .prepare('UPDATE job_run SET ended_at = ?, outcome = ?, counts = ? WHERE id = ?')
    .run(isoNow(now), result.outcome, counts, id)
  return updated.changes === 1
}

/** Writes one failure row, handled or not. Message and stack pass through the redactor before they are stored. */
export function recordFailure(
  db: Db,
  failure: {
    turnId?: string
    jobId?: string
    stage: string
    kind: FailureKind
    error: unknown
    handledBy?: string
  },
  redactor: Redactor,
  now: Clock = wallClock
): number {
  const err = failure.error instanceof Error ? failure.error : undefined
  const message = redactor.scrub(err ? err.message : String(failure.error))
  const stack = err?.stack !== undefined ? redactor.scrub(err.stack) : undefined
  return insertFailure(
    db,
    {
      turnId: failure.turnId,
      jobId: failure.jobId,
      stage: failure.stage,
      kind: failure.kind,
      message,
      stack,
      handledBy: failure.handledBy
    },
    now
  )
}

/** Keeps the request and reply of a failed turn, verbatim. One row per turn: a second call replaces the first. */
export function saveDiagnostics(
  db: Db,
  input: { turnId: string; request: string; reply?: string },
  now: Clock = wallClock
): void {
  db.prepare(
    `INSERT INTO failure_diagnostics (turn_id, request, reply, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (turn_id) DO UPDATE SET
       request = excluded.request,
       reply = excluded.reply,
       created_at = excluded.created_at`
  ).run(input.turnId, input.request, input.reply ?? null, isoNow(now))
}
