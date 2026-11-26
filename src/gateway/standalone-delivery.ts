import { randomUUID } from 'node:crypto'
import type { Db, Storage } from '../storage/database.js'
import { BUBBLE_BREAK, NO_REPLY } from './response.js'

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
export type DeliveryOutcome = 'confirmed' | 'failed' | 'unknown'
export interface DeliveryDescriptor {
  id: string
  kind: 'text'
}

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
  options: { currentRoute: () => string | null; now?: () => Date }
) {
  const now = options.now ?? (() => new Date())
  const current = (input: Binding) => options.currentRoute() === input.routeId

  function issue(input: Issue): DeliveryDescriptor[] {
    if (input.replayed || !current(input)) return []
    const at = now()
    return storage.tx((db) => {
      if (storedReply(db, input) === null || !current(input)) return []
      const id = randomUUID()
      const inserted = db
        .prepare(
          `INSERT INTO standalone_delivery
             (delivery_id, route_id, chat_id, inbound_mid, turn_id, position, kind, state, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, 0, 'text', 'pending', ?, ?)
           ON CONFLICT (turn_id, position) DO NOTHING`
        )
        .run(
          id,
          input.routeId,
          input.chatId,
          input.mid,
          input.turnId,
          at.toISOString(),
          new Date(at.getTime() + CLAIM_LIFETIME_MS).toISOString()
        )
      return inserted.changes === 1 ? [{ id, kind: 'text' }] : []
    })
  }

  function claim(input: Claim): (DeliveryDescriptor & { text: string }) | null {
    if (!current(input)) return null
    const at = now().toISOString()
    return storage.tx((db) => {
      const row = db
        .prepare(
          `SELECT turn_id FROM standalone_delivery
           WHERE delivery_id = ? AND route_id = ? AND chat_id = ? AND inbound_mid = ?
             AND kind = 'text' AND state = 'pending' AND expires_at > ?`
        )
        .get(input.id, input.routeId, input.chatId, input.mid, at) as { turn_id: string } | undefined
      if (!row) return null
      const text = storedReply(db, { ...input, turnId: row.turn_id })
      if (text === null || !current(input)) return null
      const claimed = db
        .prepare(
          `UPDATE standalone_delivery SET state = 'claimed', claimed_at = ? WHERE delivery_id = ? AND state = 'pending'`
        )
        .run(at, input.id)
      return claimed.changes === 1 && current(input) ? { id: input.id, kind: 'text', text } : null
    })
  }

  function ack(input: Claim & { outcome: DeliveryOutcome }): boolean {
    if (!current(input)) return false
    return storage.tx((db) => {
      const state = db
        .prepare(
          `SELECT state FROM standalone_delivery
           WHERE delivery_id = ? AND route_id = ? AND chat_id = ? AND inbound_mid = ?`
        )
        .pluck()
        .get(input.id, input.routeId, input.chatId, input.mid)
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

  return { issue, claim, ack, hasIssued }
}
