import { randomBytes } from 'node:crypto'
import { type Db, StorageError } from '../storage/database.js'
import { insertFailure } from '../storage/failures.js'

const REFERENCE_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'
const REFERENCE_PATTERN = /^[a-z2-7]{10}$/

export interface FeedbackAnswers {
  whatWentWrong: string
  expected: string
  kind: string
  when: string
  severity: string
}

export interface FeedbackSubmission {
  seq: number
  ref: string
  submittedAt: string
  answers: FeedbackAnswers
}

export interface OpenFeedbackInput {
  chatId: string
  subjectId: string
  turnId: string
  issuedAt: string
  expiresAt: string
}

export interface OpenFeedbackResult {
  reportId: string
  reference: string
  expiresAt: string
  turnIds: string[]
  created: boolean
}

interface OpenFeedbackDbRow {
  report_id: string
  ref: string
  expires_at: string
  turn_ids: string
}

interface ReportRow {
  report_id: string
  state: 'open' | 'received' | 'closed' | 'expired'
  expires_at: string
}

function randomReference(): string {
  const bytes = randomBytes(7)
  let bits = 0n
  for (const byte of bytes) bits = (bits << 8n) | BigInt(byte)
  bits >>= 6n
  let out = ''
  for (let shift = 45n; shift >= 0n; shift -= 5n) {
    out += REFERENCE_ALPHABET[Number((bits >> shift) & 31n)]
  }
  return out
}

function randomReportId(): string {
  return `fb_${randomBytes(6).toString('hex')}`
}

function parseTurnIds(text: string): string[] {
  const value = JSON.parse(text) as unknown
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new StorageError('feedback report has invalid turn ids', 'internal')
  }
  return value
}

/** Finds the sender's reusable report. Expired-by-time rows do not count as open. */
export function findOpenFeedbackReport(
  db: Db,
  chatId: string,
  subjectId: string,
  nowIso: string
): OpenFeedbackResult | undefined {
  const row = db
    .prepare(
      `SELECT report_id, ref, expires_at, turn_ids FROM feedback_report
       WHERE chat_id = ? AND subject_id = ? AND state = 'open' AND expires_at > ?`
    )
    .get(chatId, subjectId, nowIso) as OpenFeedbackDbRow | undefined
  return row
    ? {
        reportId: row.report_id,
        reference: row.ref,
        expiresAt: row.expires_at,
        turnIds: parseTurnIds(row.turn_ids),
        created: false
      }
    : undefined
}

function recentTurnIds(db: Db, chatId: string, commandTurnId: string): string[] {
  const newest = db
    .prepare(
      `SELECT turn_id FROM turn
       WHERE chat_id = ? AND turn_id <> ? AND state <> 'running'
       ORDER BY received_at DESC, turn_id DESC LIMIT 5`
    )
    .pluck()
    .all(chatId, commandTurnId) as string[]
  return newest.reverse()
}

/** Creates or reuses a report. Call inside ToolContext.commit so its result and first receipt are atomic. */
export function openFeedbackReport(db: Db, input: OpenFeedbackInput): OpenFeedbackResult {
  db.prepare(
    `UPDATE feedback_report SET state = 'expired'
     WHERE chat_id = ? AND subject_id = ? AND state = 'open' AND expires_at <= ?`
  ).run(input.chatId, input.subjectId, input.issuedAt)
  const existing = findOpenFeedbackReport(db, input.chatId, input.subjectId, input.issuedAt)
  if (existing) return existing

  const turnIds = recentTurnIds(db, input.chatId, input.turnId)
  for (let attempt = 0; attempt < 5; attempt++) {
    const reportId = randomReportId()
    const reference = randomReference()
    try {
      db.prepare(
        `INSERT INTO feedback_report
           (report_id, ref, chat_id, subject_id, turn_id, turn_ids, state, issued_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`
      ).run(
        reportId,
        reference,
        input.chatId,
        input.subjectId,
        input.turnId,
        JSON.stringify(turnIds),
        input.issuedAt,
        input.expiresAt
      )
      return { reportId, reference, expiresAt: input.expiresAt, turnIds, created: true }
    } catch (error) {
      const code = (error as { code?: unknown }).code
      if (code !== 'SQLITE_CONSTRAINT_PRIMARYKEY' && code !== 'SQLITE_CONSTRAINT_UNIQUE') throw error
    }
  }
  throw new StorageError('could not allocate a unique feedback report id and reference', 'internal')
}

/** True when a sync could accept at least one report now. */
export function hasOpenFeedback(db: Db, nowIso: string): boolean {
  return (
    db.prepare("SELECT 1 FROM feedback_report WHERE state = 'open' AND expires_at > ? LIMIT 1").get(nowIso) !==
    undefined
  )
}

/** Marks unused references expired. */
export function expireFeedback(db: Db, nowIso: string): number {
  return db.prepare("UPDATE feedback_report SET state = 'expired' WHERE state = 'open' AND expires_at <= ?").run(nowIso)
    .changes
}

/** Clears submitted answers after retention; report metadata stays for replay classification. */
export function pruneFeedbackAnswers(db: Db, beforeIso: string): number {
  return db
    .prepare(
      "UPDATE feedback_report SET answers = NULL WHERE answers IS NOT NULL AND state IN ('received', 'closed') AND received_at < ?"
    )
    .run(beforeIso).changes
}

export type FeedbackClassification = 'received' | 'rejected' | 'replay'

/** Classifies one validated upstream row and advances the cursor in the same transaction. */
export function classifyFeedbackSubmission(
  db: Db,
  submission: FeedbackSubmission,
  input: { nowIso: string; jobId: string }
): FeedbackClassification {
  const after = feedbackCursor(db)
  if (submission.seq <= after) return 'replay'

  const report = db
    .prepare('SELECT report_id, state, expires_at FROM feedback_report WHERE ref = ?')
    .get(submission.ref) as ReportRow | undefined
  let reason: string | undefined
  if (!REFERENCE_PATTERN.test(submission.ref) || !report) reason = 'unknown_reference'
  else if (report.state === 'received' || report.state === 'closed') reason = 'reference_reused'
  else if (report.state === 'expired' || report.expires_at <= input.nowIso) reason = 'expired_reference'
  else if (submission.answers.whatWentWrong.trim() === '') reason = 'invalid_answers'

  if (reason === undefined && report) {
    const updated = db
      .prepare(
        `UPDATE feedback_report SET state = 'received', form_seq = ?, answers = ?, received_at = ?
         WHERE report_id = ? AND state = 'open'`
      )
      .run(submission.seq, JSON.stringify(submission.answers), input.nowIso, report.report_id)
    if (updated.changes !== 1) throw new StorageError('feedback report changed during classification', 'internal')
  } else {
    if (report?.state === 'open' && reason === 'expired_reference') {
      db.prepare("UPDATE feedback_report SET state = 'expired' WHERE report_id = ?").run(report.report_id)
    }
    insertFailure(
      db,
      {
        jobId: input.jobId,
        stage: 'feedback_sync',
        kind: 'feedback_rejected',
        message: `feedback row rejected: ${reason ?? 'invalid'}`,
        handledBy: 'feedback_sync'
      },
      () => new Date(input.nowIso)
    )
  }

  db.prepare('UPDATE feedback_cursor SET "after" = ?, updated_at = ? WHERE singleton = 1').run(
    submission.seq,
    input.nowIso
  )
  return reason === undefined ? 'received' : 'rejected'
}

export function feedbackCursor(db: Db): number {
  return db.prepare('SELECT "after" FROM feedback_cursor WHERE singleton = 1').pluck().get() as number
}
