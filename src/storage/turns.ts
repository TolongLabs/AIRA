import { type Db, type Storage, StorageError, isoNow } from './database.js'

// Inbound messages and turn states (docs/trd/storage.md#everything-in-flight-is-a-row).
// A repeated message id never runs a second turn while the first is running or has answered.

type Clock = () => Date
const wallClock: Clock = () => new Date()

export interface InboundKey {
  chatId: string
  /** The gateway's message id, from the scope marker. */
  mid: string
}

export type InboundStatus =
  /** First sight of this message. Run a turn. */
  | { status: 'new' }
  /** Seen before, and its turn was interrupted or never started. Run a turn again. */
  | { status: 'retry' }
  /** Its turn is running in this process. Wait for that turn. */
  | { status: 'running'; turnId: string }
  /** Its turn returned a reply. Return the stored reply; run nothing. */
  | { status: 'answered'; turnId: string; reply: string }
  /** Its turn ended with no reply. Return nothing; run nothing. */
  | { status: 'dropped' }

interface InboundRow {
  state: 'received' | 'answered' | 'dropped'
  turn_id: string | null
}

/**
 * Writes the inbound row before any other work, or reports what an earlier request with this id led to.
 * `onNew` runs in the same transaction when the message is seen for the first time, so its text can be stored
 * with it.
 */
export function receiveInbound(
  storage: Storage,
  input: InboundKey & { senderId: string; onNew?: (db: Db) => void },
  now: Clock = wallClock
): InboundStatus {
  return storage.tx((db) => {
    const inserted = db
      .prepare(
        `INSERT INTO inbound_message (chat_id, mid, sender_id, state, received_at)
         VALUES (?, ?, ?, 'received', ?) ON CONFLICT (chat_id, mid) DO NOTHING`
      )
      .run(input.chatId, input.mid, input.senderId, isoNow(now))
    if (inserted.changes === 1) {
      input.onNew?.(db)
      return { status: 'new' }
    }

    const row = db
      .prepare('SELECT state, turn_id FROM inbound_message WHERE chat_id = ? AND mid = ?')
      .get(input.chatId, input.mid) as InboundRow
    if (row.state === 'dropped') return { status: 'dropped' }
    if (row.state === 'answered') {
      const reply = db
        .prepare("SELECT content FROM session_message WHERE turn_id = ? AND role = 'assistant' AND chat_id = ?")
        .pluck()
        .get(row.turn_id, input.chatId) as string | undefined
      // The window is pruned after days; a retry arrives within a minute. An answered row with no reply left
      // is past any retry, so nothing is sent again.
      if (reply === undefined || row.turn_id === null) return { status: 'dropped' }
      return { status: 'answered', turnId: row.turn_id, reply }
    }
    if (row.turn_id !== null) {
      const state = db.prepare('SELECT state FROM turn WHERE turn_id = ?').pluck().get(row.turn_id)
      if (state === 'running') return { status: 'running', turnId: row.turn_id }
    }
    return { status: 'retry' }
  })
}

export interface OpenTurnInput {
  turnId: string
  chatId: string
  senderId: string
  kind: 'reply' | 'command' | 'scheduled'
  /** The inbound messages this turn answers. Empty for a turn the gateway's schedule started without one. */
  mids: readonly string[]
  stage?: string
  /** Further writes that must commit with the opening record, such as claiming the window messages. */
  also?: (db: Db) => void
}

/** Writes the opening turn record and binds its inbound messages to it, in one transaction. */
export function openTurn(storage: Storage, input: OpenTurnInput, now: Clock = wallClock): void {
  storage.tx((db) => {
    db.prepare(
      `INSERT INTO turn (turn_id, chat_id, sender_id, kind, state, stage, received_at)
       VALUES (?, ?, ?, ?, 'running', ?, ?)`
    ).run(input.turnId, input.chatId, input.senderId, input.kind, input.stage ?? 'receive', isoNow(now))
    const bind = db.prepare(
      `UPDATE inbound_message SET turn_id = ?
       WHERE chat_id = ? AND mid = ? AND state = 'received'
         AND (turn_id IS NULL OR (SELECT state FROM turn WHERE turn_id = inbound_message.turn_id) <> 'running')`
    )
    for (const mid of input.mids) {
      if (bind.run(input.turnId, input.chatId, mid).changes !== 1) {
        throw new StorageError(
          `inbound message ${mid} is unknown, already closed, or bound to a running turn`,
          'internal'
        )
      }
    }
    input.also?.(db)
  })
}

/** Notes the stage a running turn has reached, so an interruption can say where it stopped. */
export function advanceTurn(storage: Storage, turnId: string, stage: string): boolean {
  return storage.tx(
    (db) =>
      db.prepare("UPDATE turn SET stage = ? WHERE turn_id = ? AND state = 'running'").run(stage, turnId).changes === 1
  )
}

export interface CloseTurnInput {
  turnId: string
  state: 'delivered' | 'declined' | 'failed'
  /** The content returned to the gateway. Required for delivered, absent for declined, optional for failed. */
  reply?: string
  /**
   * When one turn answers several merged messages, the one message the reply is returned for. The others are
   * closed as dropped, so a repeat of one of them returns nothing and the reply goes out once.
   */
  replyMid?: string
  /** Further writes that must commit with the close: window rows, records, receipts. */
  also?: (db: Db) => void
}

function settleTurnMessages(db: Db, input: { turnId: string; reply?: string; replyMid?: string }, at: string): void {
  if (input.reply !== undefined) {
    db.prepare(
      `INSERT INTO session_message (chat_id, turn_id, role, content, created_at)
       SELECT chat_id, turn_id, 'assistant', ?, ? FROM turn WHERE turn_id = ?`
    ).run(input.reply, at, input.turnId)
  }
  db.prepare(
    `UPDATE inbound_message
     SET state = CASE WHEN ? = 0 THEN 'dropped' WHEN ? IS NULL OR mid = ? THEN 'answered' ELSE 'dropped' END,
         closed_at = ?
     WHERE turn_id = ? AND state = 'received'`
  ).run(input.reply === undefined ? 0 : 1, input.replyMid ?? null, input.replyMid ?? null, at, input.turnId)
}

/**
 * Closes a running turn, stores its reply and closes its inbound messages, in one transaction.
 * Returns false and writes nothing when the turn is not running. Only after this returns true is the reply
 * acknowledged and safe to send.
 */
export function closeTurn(storage: Storage, input: CloseTurnInput, now: Clock = wallClock): boolean {
  if ((input.state === 'delivered') !== (input.reply !== undefined) && input.state !== 'failed') {
    throw new StorageError('a delivered turn needs a reply, and a declined turn has none', 'internal')
  }
  return storage.tx((db) => {
    const at = isoNow(now)
    const closed = db
      .prepare("UPDATE turn SET state = ?, ended_at = ? WHERE turn_id = ? AND state = 'running'")
      .run(input.state, at, input.turnId)
    if (closed.changes !== 1) return false
    settleTurnMessages(db, input, at)
    input.also?.(db)
    return true
  })
}

export interface FailTurnInput {
  turnId: string
  reply?: string
  replyMid?: string
  /** When false, leaves inbound messages in `received` so a gateway retry can run the turn again. */
  closeInbound?: boolean
  also?: (db: Db, stage: string) => void
}

/**
 * Closes a running turn as failed in one small transaction and passes its reached stage to `also`.
 * Returns false and writes nothing when no running turn exists for `turnId`.
 */
export function closeTurnAsFailed(storage: Storage, input: FailTurnInput, now: Clock = wallClock): boolean {
  return storage.tx((db) => {
    const sql = "SELECT stage FROM turn WHERE turn_id = ? AND state = 'running'"
    const row = db.prepare(sql).get(input.turnId) as { stage: string } | undefined
    if (!row) return false
    const at = isoNow(now)
    db.prepare("UPDATE turn SET state = 'failed', ended_at = ? WHERE turn_id = ? AND state = 'running'").run(
      at,
      input.turnId
    )
    if (input.closeInbound ?? true) {
      settleTurnMessages(db, input, at)
    }
    input.also?.(db, row.stage)
    return true
  })
}
