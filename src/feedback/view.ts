import { readTurn } from '../records/turn-view.js'
import type { Db } from '../storage/database.js'

interface FeedbackRow {
  report_id: string
  chat_id: string
  turn_ids: string
  answers: string | null
  [key: string]: unknown
}

/** The maintainer view excludes the reference; it reads answers beside their recorded chat turns. */
export function readFeedback(db: Db, reportId: string) {
  const row = db
    .prepare(
      `SELECT report_id, chat_id, subject_id, turn_id, turn_ids, state, issued_at, expires_at,
              received_at, closed_at, form_seq, answers FROM feedback_report WHERE report_id = ?`
    )
    .get(reportId) as FeedbackRow | undefined
  if (!row) return undefined
  const turnIds = JSON.parse(row.turn_ids) as string[]
  const turns = turnIds.flatMap((turnId) => {
    const view = readTurn(db, turnId)
    return view?.turn['chat_id'] === row.chat_id ? [view] : []
  })
  return {
    report: { ...row, turn_ids: turnIds, answers: row.answers === null ? null : JSON.parse(row.answers) },
    turns
  }
}
