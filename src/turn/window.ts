import { FORGOTTEN_MESSAGE } from '../memory/types.js'
import { type Db, isoNow, type Storage } from '../storage/database.js'
import type { WindowMessage } from './types.js'

// The conversation window (docs/trd/system.md#gateway-contract). The core keeps its own window in SQLite and
// rebuilds it from there after a restart. Every query filters by chat id.

/** Stores one user message of a chat. A message id is stored once: a repeat changes nothing. */
export function storeUserMessage(
  db: Db,
  message: {
    chatId: string
    senderId: string
    content: string
    mid?: string
    quote?: { text: string; id?: string; ofAira: boolean }
  },
  now: () => Date = () => new Date()
): boolean {
  const result = db
    .prepare(
      `INSERT INTO session_message (chat_id, role, sender_id, content, mid, quote, quote_mid, quote_of_aira, created_at)
       VALUES (?, 'user', ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`
    )
    .run(
      message.chatId,
      message.senderId,
      message.content,
      message.mid ?? null,
      message.quote?.text ?? null,
      message.quote?.id ?? null,
      message.quote?.ofAira ? 1 : 0,
      isoNow(now)
    )
  return result.changes === 1
}

/**
 * Gives a turn the user messages it answers: every message of the chat that no turn has claimed, and those of a
 * turn that was interrupted. Call it in the transaction that opens the turn. A message that arrives later
 * stays unclaimed, for the next turn.
 */
/**
 * Claims the chat's unanswered user messages for a turn, up to and including the message `upToMid` when it is
 * stored. A message after it waits for its own turn, so a command is never answered inside another turn.
 */
export function claimPending(db: Db, chatId: string, turnId: string, upToMid?: string): number {
  const last =
    upToMid === undefined
      ? undefined
      : (
          db
            .prepare(`SELECT max(id) AS id FROM session_message WHERE chat_id = ? AND role = 'user' AND mid = ?`)
            .get(chatId, upToMid) as { id: number | null }
        ).id
  return db
    .prepare(
      `UPDATE session_message SET turn_id = ?
       WHERE chat_id = ? AND role = 'user' AND id <= ?
         AND (turn_id IS NULL
           OR turn_id IN (SELECT turn_id FROM turn WHERE chat_id = ? AND state = 'interrupted'))`
    )
    .run(turnId, chatId, last ?? Number.MAX_SAFE_INTEGER, chatId).changes
}

interface Row {
  role: 'user' | 'assistant'
  sender_id: string | null
  content: string
  quote: string | null
  quote_of_aira: number
  created_at: string
  turn_id: string | null
  by_code: number
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
          `SELECT role, sender_id, content, quote, quote_of_aira, created_at, turn_id,
             CASE WHEN role = 'assistant' AND turn_id IS NOT NULL AND NOT EXISTS (
               SELECT 1 FROM model_call WHERE model_call.turn_id = message.turn_id) THEN 1 ELSE 0 END AS by_code,
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
    ...(row.by_code === 1 ? { byCode: true } : {}),
    content: row.content,
    ...(row.quote === null ? {} : { quote: { text: row.quote, ofAira: row.quote_of_aira === 1 } }),
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

/** Quote hops a link may be read through, counted from the message a member quotes. */
export const QUOTE_HOPS = 3

/**
 * The stored texts of the user messages a quote chain reaches, from the quoted message up, in this chat only. A
 * missing or empty message ends the chain, as does a removed one. A quoted message that is itself removed returns
 * 'removed', so the saved quote note is not read in its place.
 */
function storedQuoteTexts(db: Db, chatId: string, quoteId: string): string[] | 'removed' {
  const texts: string[] = []
  let mid: string | null = quoteId
  for (let hop = 0; hop < QUOTE_HOPS && mid !== null; hop++) {
    const row = db
      .prepare(
        `SELECT content, quote_mid FROM session_message
         WHERE chat_id = ? AND role = 'user' AND mid = ? ORDER BY id DESC LIMIT 1`
      )
      .get(chatId, mid) as { content: string; quote_mid: string | null } | undefined
    if (row?.content === FORGOTTEN_MESSAGE) return hop === 0 ? 'removed' : texts
    if (!row || row.content.trim() === '') break
    texts.push(row.content)
    mid = row.quote_mid
  }
  return texts
}

/**
 * The texts a turn's messages reach through their quotes, newest message first. Each follows its stored quote chain
 * in the same chat for up to QUOTE_HOPS messages. A message whose chain reaches nothing keeps its quote note, unless
 * the quoted message was removed: then nothing is read, not even the saved note.
 */
export function quoteChainTexts(db: Db, chatId: string, turnId: string): string[] {
  const rows = db
    .prepare(
      `SELECT quote, quote_mid FROM session_message
       WHERE chat_id = ? AND turn_id = ? AND role = 'user' ORDER BY id DESC`
    )
    .all(chatId, turnId) as { quote: string | null; quote_mid: string | null }[]
  return rows.flatMap((row) => {
    const note = row.quote === null || row.quote.trim() === '' ? [] : [row.quote]
    if (row.quote_mid === null) return note
    const stored = storedQuoteTexts(db, chatId, row.quote_mid)
    if (stored === 'removed') return []
    return stored.length > 0 ? stored : note
  })
}
