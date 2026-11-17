import { getChat } from '../settings/chats.js'
import { resolveSetting } from '../settings/settings.js'
import type { Storage } from '../storage/database.js'
import { FORGOTTEN_MESSAGE, type MemoryKind, type MemoryStatus } from './types.js'

export interface FoundItem {
  itemId: string
  kind: MemoryKind
  subjectId?: string
  key?: string
  value: string
  status: MemoryStatus
  pinned: boolean
  validUntil?: string
  updatedAt: string
}

interface FoundRow {
  id: string
  kind: MemoryKind
  subject_id: string | null
  key: string | null
  value: string
  status: MemoryStatus
  pinned: number
  valid_until: string | null
  updated_at: string
}

function rowToFound(row: FoundRow): FoundItem {
  return {
    itemId: row.id,
    kind: row.kind,
    ...(row.subject_id !== null ? { subjectId: row.subject_id } : {}),
    ...(row.key !== null ? { key: row.key } : {}),
    value: row.value,
    status: row.status,
    pinned: row.pinned === 1,
    ...(row.valid_until !== null ? { validUntil: row.valid_until } : {}),
    updatedAt: row.updated_at
  }
}

/**
 * A full-text query from free text: at most 12 distinct words of 2 or more letters or digits,
 * each in double quotes, joined with OR. Undefined when no word is left.
 */
export function ftsQuery(text: string): string | undefined {
  const matches = text.match(/[\p{L}\p{N}]{2,}/gu)
  if (!matches) return undefined
  const seen = new Set<string>()
  const terms: string[] = []
  for (const word of matches) {
    const lower = word.toLowerCase()
    if (seen.has(lower)) continue
    seen.add(lower)
    terms.push(`"${lower}"`)
    if (terms.length >= 12) break
  }
  return terms.length > 0 ? terms.join(' OR ') : undefined
}

/** Facts and summaries of this chat that match the words, best first. */
export function searchMemory(storage: Storage, chatId: string, query: string, limit: number): FoundItem[] {
  if (limit <= 0) return []
  const fts = ftsQuery(query)
  if (!fts) return []

  const rows = storage.read(
    (db) =>
      db
        .prepare(
          `SELECT
             memory_item.id,
             memory_item.kind,
             memory_item.subject_id,
             memory_item.key,
             memory_item.value,
             memory_item.status,
             memory_item.pinned,
             memory_item.valid_until,
             memory_item.updated_at
           FROM memory_fts
           JOIN memory_item
             ON memory_item.id = memory_fts.item_id
            AND memory_item.chat_id = memory_fts.chat_id
           WHERE memory_fts MATCH ?
             AND memory_fts.chat_id = ?
             AND memory_item.chat_id = ?
             AND (
               (memory_item.kind = 'fact' AND memory_item.status IN ('active', 'upcoming'))
               OR (memory_item.kind IN ('episode', 'media') AND memory_item.status <> 'forgotten')
             )
           ORDER BY bm25(memory_fts)
           LIMIT ?`
        )
        .all(fts, chatId, chatId, limit) as FoundRow[]
  )
  return rows.map(rowToFound)
}

/** What was said in this chat before: window messages and episode summaries that contain the words, newest first. */
export function searchHistory(
  storage: Storage,
  chatId: string,
  query: string,
  limit: number
): { at: string; senderId?: string; text: string }[] {
  if (limit <= 0) return []
  const trimmed = query.trim()
  if (trimmed.length === 0) return []

  const escaped = trimmed.replace(/[\\%_]/g, (ch) => `\\${ch}`)
  const pattern = `%${escaped}%`

  const messageRows = storage.read(
    (db) =>
      db
        .prepare(
          `SELECT created_at, sender_id, content
           FROM session_message
           WHERE chat_id = ?
             AND content <> ?
             AND content LIKE ? ESCAPE '\\'
           ORDER BY id DESC
           LIMIT ?`
        )
        .all(chatId, FORGOTTEN_MESSAGE, pattern, limit) as {
        created_at: string
        sender_id: string | null
        content: string
      }[]
  )

  const messages = messageRows.map((row) => ({
    at: row.created_at,
    ...(row.sender_id !== null ? { senderId: row.sender_id } : {}),
    text: row.content
  }))

  const episodes = searchMemory(storage, chatId, query, limit)
    .filter((item) => item.kind === 'episode')
    .map((item) => ({ at: item.updatedAt, text: item.value }))

  return [...messages, ...episodes].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, limit)
}

/**
 * The label of each person in a window, as the prompt writes them: `member N` in a group, by order of first
 * message. A subject id never enters the prompt.
 */
export function presentLabels(
  window: { role: 'user' | 'assistant'; senderId?: string }[],
  group: boolean
): Map<string, string> {
  const labels = new Map<string, string>()
  for (const message of window) {
    if (message.role !== 'user') continue
    const key = message.senderId ?? ''
    if (!labels.has(key)) labels.set(key, group ? `member ${labels.size + 1}` : 'the member')
  }
  labels.delete('')
  return labels
}

/** One memory line: who it is about, the key, the value. */
export function memoryLine(
  item: FoundItem,
  present: Map<string, string>,
  absent = 'someone not in this conversation'
): string {
  const who = item.subjectId === undefined ? 'this chat' : (present.get(item.subjectId) ?? absent)

  const base =
    item.kind !== 'fact' || item.key?.startsWith('note.')
      ? item.value
      : `${(item.key ?? '').replaceAll('.', ' ')}: ${item.value}`

  const suffix = item.status === 'upcoming' && item.validUntil ? ` (upcoming until ${item.validUntil})` : ''
  return `${who}: ${base}${suffix}`
}

/** The memory lines for prompt block 4, within a token budget. */
export function recallForTurn(
  storage: Storage,
  input: {
    chatId: string
    /** The subjects present in the window, with the label the prompt uses for each, such as 'member 2'. */
    present: Map<string, string>
    /** The newest user messages, to match facts against. */
    queryTexts: string[]
    tokenBudget: number
    now?: () => Date
  }
): string[] {
  if (input.tokenBudget <= 0) return []
  const chat = getChat(storage, input.chatId)
  if (chat && resolveSetting(storage, chat, 'features.memory').value === false) return []

  const pinnedRows = storage.read(
    (db) =>
      db
        .prepare(
          `SELECT id, kind, subject_id, key, value, status, pinned, valid_until, updated_at
           FROM memory_item
           WHERE chat_id = ? AND kind = 'fact' AND status = 'active' AND pinned = 1
           ORDER BY updated_at DESC, rowid DESC`
        )
        .all(input.chatId) as FoundRow[]
  )
  const pinned = pinnedRows
    .map(rowToFound)
    .filter((item) => item.subjectId === undefined || input.present.has(item.subjectId))

  const noteRows = storage.read(
    (db) =>
      db
        .prepare(
          `SELECT id, kind, subject_id, key, value, status, pinned, valid_until, updated_at
           FROM memory_item
           WHERE chat_id = ? AND kind = 'fact' AND status = 'active' AND key LIKE 'note.%'
           ORDER BY updated_at DESC, rowid DESC
           LIMIT 10`
        )
        .all(input.chatId) as FoundRow[]
  )
  const notes = noteRows.map(rowToFound)

  const joined = input.queryTexts.join(' ').trim()
  const searchResults = joined.length > 0 ? searchMemory(storage, input.chatId, joined, 20) : []
  // The search already ranks by keyword match.
  const searchFacts = searchResults.filter((item) => item.kind === 'fact')

  const summaries = searchResults.filter((item) => item.kind === 'episode' || item.kind === 'media')

  const ordered = [...pinned, ...notes, ...searchFacts, ...summaries]
  const seen = new Set<string>()
  const lines: string[] = []
  let usedTokens = 0

  for (const item of ordered) {
    if (seen.has(item.itemId)) continue
    seen.add(item.itemId)
    const line = memoryLine(item, input.present)
    const tokens = Math.ceil(line.length / 3)
    if (usedTokens + tokens > input.tokenBudget) break
    lines.push(line)
    usedTokens += tokens
  }

  return lines
}
