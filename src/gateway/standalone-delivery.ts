import { randomUUID } from 'node:crypto'
import type { Db, Storage } from '../storage/database.js'
import { BUBBLE_BREAK, NO_REPLY } from './response.js'
import { type ReportDocumentMetadata, readStandaloneReport } from './standalone-document.js'

// A durable, one-time external delivery obligation, not the core's returned turn state.
// docs/trd/storage.md#standalone-delivery-ledger
const CLAIM_LIFETIME_MS = 10 * 60_000

interface Binding {
  routeId: string
  chatId: string
  mid: string
}

type Issue = Binding & { turnId: string; replayed: boolean }
type Claim = Binding & { id: string }
type ReminderDelivery = { reminderId: string; dueAt: string }
export type DeliveryOutcome = 'confirmed' | 'failed' | 'unknown'
export interface DeliveryDescriptor {
  id: string
  kind: 'text' | 'document'
}
export type ClaimedDelivery =
  | { id: string; kind: 'text'; text: string }
  | ({ id: string; kind: 'document'; base64: string } & ReportDocumentMetadata)

/** The existing standalone text boundary: never return legacy attachment directives. */
export function standaloneReplyText(content: string): string | null {
  const text = content
    .split(BUBBLE_BREAK)
    .join('\n')
    .split(/\r\n|[\r\n\u2028\u2029]/)
    .filter((line) => !line.trimStart().startsWith('MEDIA:'))
    .join('\n')
    .trim()
  return text !== '' && text !== NO_REPLY && text.length <= 32_768 ? text : null
}

function storedReply(db: Db, input: Binding & { turnId: string }): string | null {
  const value = db
    .prepare(
      `SELECT s.content
       FROM inbound_message i
       JOIN turn t ON t.turn_id = i.turn_id AND t.chat_id = i.chat_id
       JOIN session_message s ON s.turn_id = t.turn_id AND s.chat_id = t.chat_id AND s.role = 'assistant'
       JOIN chat c ON c.chat_id = i.chat_id
       WHERE i.chat_id = ? AND i.mid = ? AND i.turn_id = ? AND i.state = 'answered'
         AND t.state IN ('delivered', 'failed') AND c.status = 'active'`
    )
    .pluck()
    .get(input.chatId, input.mid, input.turnId)
  return typeof value === 'string' ? standaloneReplyText(value) : null
}

export function createStandaloneDeliveryLedger(
  storage: Storage,
  options: {
    currentRoute: () => string | null
    now?: () => Date
    filesDir?: string
    mayDeliverDocument?: (routeId: string, chatId: string) => boolean
  }
) {
  const now = options.now ?? (() => new Date())
  const current = (input: Binding) => options.currentRoute() === input.routeId
  const report = (db: Db, input: Binding & { turnId: string; sha256?: string; receiptId?: string }) =>
    options.filesDir && options.mayDeliverDocument?.(input.routeId, input.chatId)
      ? readStandaloneReport(db, options.filesDir, input)
      : null

  function issueBound(input: Issue, reminder?: ReminderDelivery): DeliveryDescriptor[] {
    if (input.replayed || !current(input)) return []
    const at = now()
    return storage.tx((db) => {
      if (storedReply(db, input) === null || !current(input)) return []
      const id = randomUUID()
      const inserted = db
        .prepare(
          `INSERT INTO standalone_delivery
             (delivery_id, route_id, chat_id, inbound_mid, turn_id, position, kind, state, created_at, expires_at,
              reminder_id, reminder_due_at)
           VALUES (?, ?, ?, ?, ?, 0, 'text', 'pending', ?, ?, ?, ?)
           ON CONFLICT DO NOTHING`
        )
        .run(
          id,
          input.routeId,
          input.chatId,
          input.mid,
          input.turnId,
          at.toISOString(),
          new Date(at.getTime() + CLAIM_LIFETIME_MS).toISOString(),
          reminder?.reminderId ?? null,
          reminder?.dueAt ?? null
        )
      if (inserted.changes !== 1) return []
      const items: DeliveryDescriptor[] = [{ id, kind: 'text' }]
      const document = !reminder && current(input) ? report(db, input) : null
      if (document && current(input)) {
        const documentId = randomUUID()
        const recorded = db
          .prepare(
            `INSERT INTO standalone_delivery
             (delivery_id, route_id, chat_id, inbound_mid, turn_id, position, kind, file_sha256, report_receipt_id, state, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, 1, 'document', ?, ?, 'pending', ?, ?)
           ON CONFLICT (turn_id, position) DO NOTHING`
          )
          .run(
            documentId,
            input.routeId,
            input.chatId,
            input.mid,
            input.turnId,
            document.sha256,
            document.receiptId,
            at.toISOString(),
            new Date(at.getTime() + CLAIM_LIFETIME_MS).toISOString()
          )
        if (recorded.changes === 1) items.push({ id: documentId, kind: 'document' })
      }
      return items
    })
  }

  function claimBound(input: Claim, reminder?: ReminderDelivery): ClaimedDelivery | null {
    if (!current(input)) return null
    const at = now().toISOString()
    return storage.tx((db) => {
      const row = db
        .prepare(
          `SELECT turn_id, kind, file_sha256, report_receipt_id FROM standalone_delivery
           WHERE delivery_id = ? AND route_id = ? AND chat_id = ? AND inbound_mid = ?
             AND state = 'pending' AND expires_at > ?
             AND reminder_id IS ? AND reminder_due_at IS ?`
        )
        .get(
          input.id,
          input.routeId,
          input.chatId,
          input.mid,
          at,
          reminder?.reminderId ?? null,
          reminder?.dueAt ?? null
        ) as
        | { turn_id: string; kind: 'text' | 'document'; file_sha256: string | null; report_receipt_id: string | null }
        | undefined
      if (!row) return null
      const text = storedReply(db, { ...input, turnId: row.turn_id })
      if (text === null || !current(input)) return null
      const document =
        row.kind === 'document' && row.file_sha256 && row.report_receipt_id
          ? report(db, { ...input, turnId: row.turn_id, sha256: row.file_sha256, receiptId: row.report_receipt_id })
          : null
      if (row.kind === 'document' && !document) return null
      if (!current(input)) return null
      const claimed = db
        .prepare(
          `UPDATE standalone_delivery SET state = 'claimed', claimed_at = ? WHERE delivery_id = ? AND state = 'pending'`
        )
        .run(at, input.id)
      if (claimed.changes !== 1 || !current(input)) return null
      if (!document) return { id: input.id, kind: 'text', text }
      const { data, receiptId: _receiptId, ...metadata } = document
      return { id: input.id, kind: 'document', ...metadata, base64: data.toString('base64') }
    })
  }

  function ackBound(input: Claim & { outcome: DeliveryOutcome }, reminder?: ReminderDelivery): boolean {
    if (!current(input)) return false
    return storage.tx((db) => {
      const state = db
        .prepare(
          `SELECT state FROM standalone_delivery
           WHERE delivery_id = ? AND route_id = ? AND chat_id = ? AND inbound_mid = ?
             AND reminder_id IS ? AND reminder_due_at IS ?`
        )
        .pluck()
        .get(input.id, input.routeId, input.chatId, input.mid, reminder?.reminderId ?? null, reminder?.dueAt ?? null)
      if (state === input.outcome) return true
      if (state !== 'claimed' || !current(input)) return false
      return (
        db
          .prepare(
            `UPDATE standalone_delivery SET state = ?, finished_at = ? WHERE delivery_id = ? AND state = 'claimed'`
          )
          .run(input.outcome, now().toISOString(), input.id).changes === 1
      )
    })
  }

  /** Poll may repeat only a still-claimable reminder, not a missing or pruned reply. */
  function canClaimReminder(input: Claim & ReminderDelivery): boolean {
    if (!current(input)) return false
    return storage.read((db) => {
      const turnId = db
        .prepare(
          `SELECT turn_id FROM standalone_delivery
         WHERE delivery_id=? AND route_id=? AND chat_id=? AND inbound_mid=?
           AND reminder_id=? AND reminder_due_at=? AND kind='text'
           AND state='pending' AND expires_at>?`
        )
        .pluck()
        .get(input.id, input.routeId, input.chatId, input.mid, input.reminderId, input.dueAt, now().toISOString())
      return typeof turnId === 'string' && storedReply(db, { ...input, turnId }) !== null
    })
  }

  /** A v1 replay after a v2 attempt must not deliver that same persisted turn again. */
  function hasIssued(input: { chatId: string; mid: string; turnId: string }): boolean {
    return storage.read(
      (db) =>
        db
          .prepare('SELECT 1 FROM standalone_delivery WHERE turn_id = ? AND chat_id = ? AND inbound_mid = ? LIMIT 1')
          .pluck()
          .get(input.turnId, input.chatId, input.mid) === 1
    )
  }

  return {
    issue: (input: Issue) => issueBound(input),
    claim: (input: Claim) => claimBound(input),
    ack: (input: Claim & { outcome: DeliveryOutcome }) => ackBound(input),
    issueReminder: (input: Issue & ReminderDelivery) => issueBound(input, input)[0] ?? null,
    canClaimReminder,
    claimReminder: (input: Claim & ReminderDelivery) => claimBound(input, input),
    ackReminder: (input: Claim & ReminderDelivery & { outcome: DeliveryOutcome }) => ackBound(input, input),
    hasIssued
  }
}
