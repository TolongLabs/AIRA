import { getChat } from '../settings/chats.js'
import type { Storage } from '../storage/database.js'
import type { TurnReply } from '../turn/pipeline.js'
import {
  portableReminderMid,
  type ReminderOccurrence,
  type ReminderScope,
  reminderChatEnabled,
  reminderMayDeliver,
  sameReminderScope
} from './reminder-scope.js'
import type { createStandaloneDeliveryLedger, DeliveryDescriptor, DeliveryOutcome } from './standalone-delivery.js'

interface ReminderRow {
  reminder_id: string
  chat_id: string
  owner_id: string
  target_id: string
  due_at: string
  repeat: string | null
  state: string
}
interface PendingRow {
  delivery_id: string
  chat_id: string
  inbound_mid: string
  reminder_id: string
  reminder_due_at: string
}
type RunReminder = (occurrence: ReminderOccurrence) => Promise<TurnReply | null>

/** The core owns due selection and destination; the adapter receives only an opaque item until claim. */
export function createStandaloneReminderQueue(
  storage: Storage,
  ledger: ReturnType<typeof createStandaloneDeliveryLedger>,
  currentScope: () => ReminderScope | null,
  now: () => Date
) {
  const current = (scope: ReminderScope) => sameReminderScope(currentScope(), scope)
  const inFlight = new Map<string, Promise<DeliveryDescriptor | null>>()

  function reminderRow(scope: ReminderScope, id: string): ReminderRow | undefined {
    return storage.read(
      (db) =>
        db
          .prepare(
            `SELECT reminder_id,chat_id,owner_id,target_id,due_at,repeat,state FROM reminder
       WHERE reminder_id=? AND standalone_route_id=? AND standalone_profile=?`
          )
          .get(id, scope.routeId, scope.profile) as ReminderRow | undefined
    )
  }

  function eligible(
    scope: ReminderScope,
    row: Pick<PendingRow, 'chat_id' | 'reminder_id' | 'reminder_due_at'>
  ): boolean {
    const reminder = reminderRow(scope, row.reminder_id)
    return Boolean(
      current(scope) &&
      reminder &&
      reminder.chat_id === row.chat_id &&
      reminder.owner_id === reminder.target_id &&
      ((reminder.state === 'fired' && reminder.due_at === row.reminder_due_at) ||
        (reminder.state === 'active' && reminder.repeat && reminder.due_at > row.reminder_due_at)) &&
      reminderMayDeliver(storage, row.chat_id, reminder.owner_id, reminder.target_id, now())
    )
  }

  function expire(scope: ReminderScope, id: string): void {
    storage.tx((db) =>
      db
        .prepare(
          `UPDATE standalone_delivery SET expires_at=min(expires_at,?)
       WHERE delivery_id=? AND route_id=? AND reminder_id IS NOT NULL AND state='pending'`
        )
        .run(now().toISOString(), id, scope.routeId)
    )
  }

  function binding(scope: ReminderScope, id: string): PendingRow | undefined {
    return storage.read(
      (db) =>
        db
          .prepare(
            `SELECT delivery_id,chat_id,inbound_mid,reminder_id,reminder_due_at FROM standalone_delivery
       WHERE delivery_id=? AND route_id=? AND reminder_id IS NOT NULL`
          )
          .get(id, scope.routeId) as PendingRow | undefined
    )
  }

  function bound(scope: ReminderScope, row: PendingRow) {
    return {
      routeId: scope.routeId,
      chatId: row.chat_id,
      mid: row.inbound_mid,
      id: row.delivery_id,
      reminderId: row.reminder_id,
      dueAt: row.reminder_due_at
    }
  }

  async function pollOnce(scope: ReminderScope, run: RunReminder): Promise<DeliveryDescriptor | null> {
    if (!current(scope)) return null
    const pending = storage.read(
      (db) =>
        db
          .prepare(
            `SELECT delivery_id,chat_id,inbound_mid,reminder_id,reminder_due_at FROM standalone_delivery
       WHERE route_id=? AND reminder_id IS NOT NULL AND state='pending' AND expires_at > ?
       ORDER BY created_at,delivery_id`
          )
          .all(scope.routeId, now().toISOString()) as PendingRow[]
    )
    for (const row of pending) {
      if (eligible(scope, row) && ledger.canClaimReminder(bound(scope, row)))
        return { id: row.delivery_id, kind: 'text' }
      expire(scope, row.delivery_id)
    }
    const due = storage.read(
      (db) =>
        db
          .prepare(
            `SELECT r.reminder_id,r.chat_id,r.owner_id,r.target_id,r.due_at,r.repeat,r.state
       FROM reminder r JOIN chat c ON c.chat_id=r.chat_id
       WHERE r.standalone_route_id=? AND r.standalone_profile=? AND r.state='active'
         AND c.status='active' AND r.due_at<=? AND r.owner_id=r.target_id
       ORDER BY r.due_at,r.reminder_id`
          )
          .all(scope.routeId, scope.profile, now().toISOString()) as ReminderRow[]
    )
    const row = due.find((item) => reminderChatEnabled(storage, item.chat_id))
    if (!row || !current(scope)) return null
    const occurrence = { ...scope, reminderId: row.reminder_id, dueAt: row.due_at }
    const reply = await run(occurrence)
    if (
      !reply?.turnId ||
      reply.replayed ||
      !eligible(scope, { chat_id: row.chat_id, reminder_id: row.reminder_id, reminder_due_at: row.due_at })
    )
      return null
    return ledger.issueReminder({
      ...occurrence,
      chatId: row.chat_id,
      mid: portableReminderMid(row.reminder_id, row.due_at),
      turnId: reply.turnId,
      replayed: reply.replayed
    })
  }

  async function poll(scope: ReminderScope, run: RunReminder): Promise<DeliveryDescriptor | null> {
    if (!current(scope)) return null
    const existing = inFlight.get(scope.routeId)
    if (existing) return existing
    const work = pollOnce(scope, run)
    inFlight.set(scope.routeId, work)
    try {
      return await work
    } finally {
      inFlight.delete(scope.routeId)
    }
  }

  function claim(scope: ReminderScope, id: string) {
    if (!current(scope)) return null
    const row = binding(scope, id)
    if (!row) return null
    if (!eligible(scope, row)) {
      expire(scope, id)
      return null
    }
    const chat = getChat(storage, row.chat_id)
    if (!chat) return null
    const item = ledger.claimReminder(bound(scope, row))
    if (!item) expire(scope, id)
    return item?.kind === 'text' ? { ...item, chat: chat.waId } : null
  }

  function ack(scope: ReminderScope, id: string, outcome: DeliveryOutcome): boolean {
    if (!current(scope)) return false
    const row = binding(scope, id)
    return Boolean(row && ledger.ackReminder({ ...bound(scope, row), outcome }))
  }

  return { poll, claim, ack }
}
