import { type Db, type Storage, isoNow } from '../storage/database.js'
import type { WindowMessage } from './types.js'

// The conversation window (docs/trd/system.md#gateway-contract). The core keeps its own window in SQLite and
// rebuilds it from there after a restart. Every query filters by chat id.

/** Stores one user message of a chat. A message id is stored once: a repeat changes nothing. */
export function storeUserMessage(
  db: Db,
  message: { chatId: string; senderId: string; content: string; mid?: string },
  now: () => Date = () => new Date()
): boolean {
  const result = db
    .prepare(
      `INSERT INTO session_message (chat_id, role, sender_id, content, mid, created_at)
       VALUES (?, 'user', ?, ?, ?, ?) ON CONFLICT DO NOTHING`
    )
    .run(message.chatId, message.senderId, message.content, message.mid ?? null, isoNow(now))
  return result.changes === 1
}

/**
 * Gives a turn the user messages it answers: every message of the chat that no turn has claimed, and those of a
 * turn that was interrupted. Call it in the transaction that opens the turn. A message that arrives later
 * stays unclaimed, for the next turn.
 */
export function claimPending(db: Db, chatId: string, turnId: string): number {
  return db
    .prepare(
      `UPDATE session_message SET turn_id = ?
       WHERE chat_id = ? AND role = 'user'
         AND (turn_id IS NULL
           OR turn_id IN (SELECT turn_id FROM turn WHERE chat_id = ? AND state = 'interrupted'))`
    )
    .run(turnId, chatId, chatId).changes
}

interface Row {
  role: 'user' | 'assistant'
  sender_id: string | null
  content: string
  created_at: string
  turn_id: string | null
}

/**
 * The newest messages of one chat, oldest first, no older than windowDays. A reply is placed after the messages
 * its turn answered, so a message that arrived while that turn ran comes after the reply.
 */
export function readWindow(
  storage: Storage,
  chatId: string,
  limits: { windowDays: number; maxMessages: number },
  now: () => Date = () => new Date()
): WindowMessage[] {
  const cutoff = new Date(now().getTime() - limits.windowDays * 86_400_000).toISOString()
  const rows = storage.read(
    (db) =>
      db
        .prepare(
          `SELECT role, sender_id, content, created_at, turn_id,
             CASE WHEN role = 'assistant' THEN coalesce(
               (SELECT max(asked.id) FROM session_message AS asked
                WHERE asked.chat_id = message.chat_id AND asked.turn_id = message.turn_id AND asked.role = 'user'),
               message.id) + 0.5
             ELSE message.id END AS position
           FROM session_message AS message
           WHERE chat_id = ? AND created_at >= ? ORDER BY position DESC LIMIT ?`
        )
        .all(chatId, cutoff, limits.maxMessages) as Row[]
  )
  return rows.reverse().map((row) => ({
    role: row.role,
    ...(row.sender_id === null ? {} : { senderId: row.sender_id }),
    ...(row.turn_id === null ? {} : { turnId: row.turn_id }),
    content: row.content,
    at: row.created_at
  }))
}

/** The user messages a turn claimed: what it has to answer. */
export function pendingOf(window: WindowMessage[], turnId: string): WindowMessage[] {
  return window.filter((message) => message.role === 'user' && message.turnId === turnId)
}

/** The user texts of one chat that have no reply yet, read inside a transaction, to tell a repeat from a new text. */
export function unansweredTexts(db: Db, chatId: string): string[] {
  return db
    .prepare(
      `SELECT content FROM session_message AS message
       WHERE chat_id = ? AND role = 'user'
         AND (turn_id IS NULL OR NOT EXISTS (
           SELECT 1 FROM session_message AS reply WHERE reply.turn_id = message.turn_id AND reply.role = 'assistant'))
       ORDER BY id`
    )
    .pluck()
    .all(chatId) as string[]
}
