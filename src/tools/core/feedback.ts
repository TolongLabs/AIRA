import { z } from 'zod'
import { openFeedbackReport } from '../../feedback/store.js'
import type { Db } from '../../storage/database.js'
import type { ToolDefinition } from '../types.js'

const emptySchema = z.strictObject({})

export interface FeedbackToolOptions {
  formUrl: string
  referenceEntryId: string
  refTtlHours: number
}

interface StoredReceiptRow {
  receipt_id: string
}

function formEnabled(options: FeedbackToolOptions): boolean {
  if (!options.formUrl || !/^\d+$/.test(options.referenceEntryId) || options.refTtlHours <= 0) return false
  try {
    return new URL(options.formUrl).protocol === 'https:'
  } catch {
    return false
  }
}

function formUrl(options: FeedbackToolOptions, ref: string): string {
  const url = new URL(options.formUrl)
  url.searchParams.set('usp', 'pp_url')
  url.searchParams.set(`entry.${options.referenceEntryId}`, ref)
  return url.toString()
}

function storedReceipt(db: Db, reportId: string, chatId: string): string {
  const row = db
    .prepare(
      `SELECT receipt_id FROM receipt
       WHERE target = ? AND chat_id = ? AND tool = 'feedback_link'
         AND receipt.kind = 'feedback.opened'
       ORDER BY receipt.created_at LIMIT 1`
    )
    .get(reportId, chatId) as StoredReceiptRow | undefined
  if (!row) throw new Error('open feedback report has no receipt')
  return row.receipt_id
}

export function feedbackLinkTool(options: FeedbackToolOptions): ToolDefinition<z.infer<typeof emptySchema>> {
  return {
    name: 'feedback_link',
    description: 'Opens the private feedback form for this conversation.',
    schema: emptySchema,
    mode: 'explicit',
    mutates: true,
    feature: 'features.feedback',
    permission: () => formEnabled(options),
    command: {
      names: ['report'],
      kind: 'direct',
      usage: '/report',
      directArgs: () => ({})
    },
    handler(_args, context) {
      const committed = context.commit((db) => {
        const at = context.now()
        const atIso = at.toISOString()
        const expiresAt = new Date(at.getTime() + options.refTtlHours * 3_600_000).toISOString()
        const opened = openFeedbackReport(db, {
          chatId: context.chat.chatId,
          subjectId: context.senderId,
          turnId: context.turnId,
          issuedAt: atIso,
          expiresAt
        })
        const data = { reference: opened.reference, url: formUrl(options, opened.reference) }
        return {
          data,
          receipt: {
            kind: 'feedback.opened',
            target: opened.reportId,
            state: { reference: opened.reference },
            ...(opened.created ? {} : { reuseReceiptId: storedReceipt(db, opened.reportId, context.chat.chatId) })
          }
        }
      })
      return { ok: true, data: committed.data }
    }
  }
}
