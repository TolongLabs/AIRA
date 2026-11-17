import { createHash, randomBytes } from 'node:crypto'
import { type Db, isoNow, type Storage } from '../storage/database.js'
import {
  FORGOTTEN_KEY,
  FORGOTTEN_MESSAGE,
  MAX_VALUE_CHARS,
  MEMORY_KEY,
  type MemoryItem,
  type MemoryKind,
  type MemoryOperation,
  type MemoryStatus,
  type OperationOutcome,
  RESERVED_KEY_PREFIXES
} from './types.js'

type Clock = () => Date
const wallClock: Clock = () => new Date()

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/
const REASON_CODE = /^[a-z0-9_.]+$/

interface MemoryItemRow {
  id: string
  chat_id: string
  kind: MemoryKind
  subject_id: string | null
  key: string | null
  value: string
  status: MemoryStatus
  pinned: number
  source_turn: string | null
  source_job: string | null
  source_message_id: number | null
  valid_until: string | null
  created_at: string
  updated_at: string
}

function rowToItem(row: MemoryItemRow): MemoryItem {
  return {
    id: row.id,
    chatId: row.chat_id,
    kind: row.kind,
    ...(row.subject_id !== null ? { subjectId: row.subject_id } : {}),
    ...(row.key !== null ? { key: row.key } : {}),
    value: row.value,
    status: row.status,
    pinned: row.pinned === 1,
    ...(row.source_turn !== null ? { sourceTurn: row.source_turn } : {}),
    ...(row.source_job !== null ? { sourceJob: row.source_job } : {}),
    ...(row.source_message_id !== null ? { sourceMessageId: row.source_message_id } : {}),
    ...(row.valid_until !== null ? { validUntil: row.valid_until } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function syncFts(
  db: Db,
  chatId: string,
  row: { id: string; kind: MemoryKind; key?: string | null; value: string; status: MemoryStatus }
): void {
  db.prepare('DELETE FROM memory_fts WHERE item_id = ? AND chat_id = ?').run(row.id, chatId)
  const recallable =
    row.kind === 'fact' ? row.status === 'active' || row.status === 'upcoming' : row.status !== 'forgotten'
  if (!recallable) return
  const text = row.kind === 'fact' && row.key ? `${row.key.replaceAll('.', ' ')} ${row.value}` : row.value
  db.prepare('INSERT INTO memory_fts (item_id, chat_id, text) VALUES (?, ?, ?)').run(row.id, chatId, text)
}

function factInSlot(
  db: Db,
  chatId: string,
  subjectId: string | undefined,
  key: string,
  status: 'active' | 'upcoming'
): MemoryItem | undefined {
  const row = db
    .prepare(
      `SELECT id, chat_id, kind, subject_id, key, value, status, pinned, source_turn, source_job,
              source_message_id, valid_until, created_at, updated_at
       FROM memory_item
       WHERE chat_id = ? AND kind = 'fact' AND status = ? AND key = ?
         AND coalesce(subject_id, '') = coalesce(?, '')`
    )
    .get(chatId, status, key, subjectId ?? null) as MemoryItemRow | undefined
  return row ? rowToItem(row) : undefined
}

export function newItemId(): string {
  return `m_${randomBytes(8).toString('hex')}`
}

export function normaliseKey(raw: string): string | undefined {
  const key = raw
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
  return MEMORY_KEY.test(key) ? key : undefined
}

/** For comparing two texts: NFKC, lower case, WhatsApp markup characters (* _ ~ `) removed, blank space collapsed, trimmed. */
export function normaliseText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[*_~`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function getItem(db: Db, chatId: string, itemId: string): MemoryItem | undefined {
  const row = db
    .prepare(
      `SELECT id, chat_id, kind, subject_id, key, value, status, pinned, source_turn, source_job,
              source_message_id, valid_until, created_at, updated_at
       FROM memory_item
       WHERE id = ? AND chat_id = ?`
    )
    .get(itemId, chatId) as MemoryItemRow | undefined
  return row ? rowToItem(row) : undefined
}

/** The active fact of one slot. */
export function activeFact(db: Db, chatId: string, subjectId: string | undefined, key: string): MemoryItem | undefined {
  return factInSlot(db, chatId, subjectId, key, 'active')
}

function isFutureIsoTime(raw: string, now: Clock): boolean {
  if (!ISO_TIME.test(raw)) return false
  const ms = Date.parse(raw)
  return !Number.isNaN(ms) && ms > now().getTime()
}

/** Applies one validated operation. Returns what happened. Never throws for a rejected operation. */
export function applyOperation(
  db: Db,
  chatId: string,
  operation: MemoryOperation,
  source: { turnId?: string; jobId?: string },
  now: Clock = wallClock
): OperationOutcome {
  if (!MEMORY_KEY.test(operation.key)) {
    return { accepted: false, reason: 'invalid_key' }
  }
  if (RESERVED_KEY_PREFIXES.some((prefix) => operation.key.startsWith(prefix))) {
    return { accepted: false, reason: 'reserved_key' }
  }
  const trimmedValue = operation.value?.trim() ?? ''
  if (operation.op !== 'retire' && (trimmedValue.length === 0 || trimmedValue.length > MAX_VALUE_CHARS)) {
    return { accepted: false, reason: 'invalid_value' }
  }
  if (operation.validUntil !== undefined && !isFutureIsoTime(operation.validUntil, now)) {
    return { accepted: false, reason: 'invalid_valid_until' }
  }

  try {
    return db.transaction((): OperationOutcome => {
      const at = isoNow(now)
      if (operation.op === 'retire') {
        const existing = activeFact(db, chatId, operation.subjectId, operation.key)
        if (!existing) return { accepted: false, reason: 'nothing_to_retire' }
        db.prepare("UPDATE memory_item SET status = 'retired', updated_at = ? WHERE id = ? AND chat_id = ?").run(
          at,
          existing.id,
          chatId
        )
        syncFts(db, chatId, {
          id: existing.id,
          kind: 'fact',
          key: existing.key,
          value: existing.value,
          status: 'retired'
        })
        return { accepted: true, itemId: existing.id, effect: 'retired' }
      }

      const targetStatus = operation.validUntil !== undefined ? 'upcoming' : 'active'
      const existing = factInSlot(db, chatId, operation.subjectId, operation.key, targetStatus)
      if (existing && normaliseText(existing.value) === normaliseText(trimmedValue)) {
        return { accepted: true, itemId: existing.id, effect: 'unchanged' }
      }

      if (existing) {
        db.prepare("UPDATE memory_item SET status = 'superseded', updated_at = ? WHERE id = ? AND chat_id = ?").run(
          at,
          existing.id,
          chatId
        )
        syncFts(db, chatId, {
          id: existing.id,
          kind: 'fact',
          key: existing.key,
          value: existing.value,
          status: 'superseded'
        })
      }

      const id = newItemId()
      db.prepare(
        `INSERT INTO memory_item (
           id, chat_id, kind, subject_id, key, value, status, pinned,
           source_turn, source_job, source_message_id, valid_until, created_at, updated_at
         ) VALUES (?, ?, 'fact', ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        chatId,
        operation.subjectId ?? null,
        operation.key,
        trimmedValue,
        targetStatus,
        source.turnId ?? null,
        source.jobId ?? null,
        operation.sourceMessageId ?? null,
        operation.validUntil ?? null,
        at,
        at
      )
      syncFts(db, chatId, { id, kind: 'fact', key: operation.key, value: trimmedValue, status: targetStatus })
      return { accepted: true, itemId: id, effect: existing ? 'replaced' : 'added' }
    })()
  } catch {
    return { accepted: false, reason: 'constraint' }
  }
}

/** Stores one summary of an episode or one media reading. Returns its id. */
export function addSummary(
  db: Db,
  chatId: string,
  input: { kind: 'episode' | 'media'; value: string; jobId?: string; turnId?: string },
  now: Clock = wallClock
): string {
  const value = input.value.trim()
  if (value.length === 0) throw new Error('summary value must not be empty')
  const id = newItemId()
  const at = isoNow(now)
  db.prepare(
    `INSERT INTO memory_item (
       id, chat_id, kind, subject_id, key, value, status, pinned,
       source_turn, source_job, source_message_id, valid_until, created_at, updated_at
     ) VALUES (?, ?, ?, NULL, NULL, ?, 'active', 0, ?, ?, NULL, NULL, ?, ?)`
  ).run(id, chatId, input.kind, value, input.turnId ?? null, input.jobId ?? null, at, at)
  syncFts(db, chatId, { id, kind: input.kind, value, status: 'active' })
  return id
}

/** A fact a member stored by hand. The same text for the same subject is stored once. */
export function addNote(
  db: Db,
  chatId: string,
  input: { subjectId: string; text: string; turnId?: string },
  now: Clock = wallClock
): { itemId: string; effect: 'added' | 'unchanged' } {
  const value = input.text.trim()
  if (value.length === 0 || value.length > MAX_VALUE_CHARS) {
    throw new Error('note text must be between 1 and 500 characters')
  }

  const existingRows = db
    .prepare(
      `SELECT id, value FROM memory_item
       WHERE chat_id = ? AND kind = 'fact' AND status = 'active' AND subject_id = ? AND key LIKE 'note.%'`
    )
    .all(chatId, input.subjectId) as { id: string; value: string }[]

  const norm = normaliseText(value)
  const existing = existingRows.find((row) => normaliseText(row.value) === norm)

  if (existing) {
    if (input.turnId !== undefined) {
      db.prepare("UPDATE session_message SET memory_skip = 1 WHERE chat_id = ? AND turn_id = ? AND role = 'user'").run(
        chatId,
        input.turnId
      )
    }
    return { itemId: existing.id, effect: 'unchanged' }
  }

  const id = newItemId()
  const key = `note.${randomBytes(6).toString('hex')}`
  const at = isoNow(now)
  db.prepare(
    `INSERT INTO memory_item (
       id, chat_id, kind, subject_id, key, value, status, pinned,
       source_turn, source_job, source_message_id, valid_until, created_at, updated_at
     ) VALUES (?, ?, 'fact', ?, ?, ?, 'active', 0, ?, NULL, NULL, NULL, ?, ?)`
  ).run(id, chatId, input.subjectId, key, value, input.turnId ?? null, at, at)
  syncFts(db, chatId, { id, kind: 'fact', key, value, status: 'active' })

  if (input.turnId !== undefined) {
    db.prepare("UPDATE session_message SET memory_skip = 1 WHERE chat_id = ? AND turn_id = ? AND role = 'user'").run(
      chatId,
      input.turnId
    )
  }
  return { itemId: id, effect: 'added' }
}

/** The slot of one of a chat's own words, or undefined when the word holds no letter or digit. */
export function lingoKey(rawWord: string): string | undefined {
  const word = rawWord.normalize('NFKC').toLowerCase().trim()
  if (!/[\p{L}\p{N}]/u.test(word)) return undefined
  const latin = word
    .replace(/[^a-z0-9]+/g, '_')
    .slice(0, 40)
    .replace(/^_+|_+$/g, '')
  // A key holds a-z and digits only. A word in another script gets a slot from its hash, so two words never share one.
  const part =
    latin !== '' && !/[^\p{ASCII}]/u.test(word)
      ? latin
      : `w_${createHash('sha256').update(word).digest('hex').slice(0, 16)}`
  return `lingo.${part}`
}

/** What one of this chat's words means. A new meaning replaces the old one. */
export function setLingo(
  db: Db,
  chatId: string,
  input: { word: string; meaning: string; turnId?: string },
  now: Clock = wallClock
): string {
  const key = lingoKey(input.word)
  if (key === undefined) throw new Error('lingo word must contain letters or digits')

  const value = input.meaning.trim()
  if (value.length === 0 || value.length > MAX_VALUE_CHARS) {
    throw new Error('lingo meaning must be between 1 and 500 characters')
  }

  const existing = activeFact(db, chatId, undefined, key)
  if (existing && normaliseText(existing.value) === normaliseText(value)) {
    return existing.id
  }

  const at = isoNow(now)
  if (existing) {
    db.prepare("UPDATE memory_item SET status = 'superseded', updated_at = ? WHERE id = ? AND chat_id = ?").run(
      at,
      existing.id,
      chatId
    )
    syncFts(db, chatId, { id: existing.id, kind: 'fact', key, value: existing.value, status: 'superseded' })
  }

  const id = newItemId()
  db.prepare(
    `INSERT INTO memory_item (
       id, chat_id, kind, subject_id, key, value, status, pinned,
       source_turn, source_job, source_message_id, valid_until, created_at, updated_at
     ) VALUES (?, ?, 'fact', NULL, ?, ?, 'active', 0, ?, NULL, NULL, NULL, ?, ?)`
  ).run(id, chatId, key, value, input.turnId ?? null, at, at)
  syncFts(db, chatId, { id, kind: 'fact', key, value, status: 'active' })
  return id
}

/** Names the job a row of this chat came from. The migration marks what it imports. */
export function setSource(db: Db, chatId: string, itemId: string, sourceJob: string): void {
  db.prepare('UPDATE memory_item SET source_job = ? WHERE id = ? AND chat_id = ?').run(sourceJob, itemId, chatId)
}

/** The forget barrier of docs/trd/memory.md. Returns how many queued jobs it ended. */
export function forgetBarrier(db: Db, chatId: string, now: Clock = wallClock): number {
  const newestRow = db.prepare('SELECT coalesce(max(id), 0) FROM session_message WHERE chat_id = ?').pluck().get(chatId)
  const newestId = typeof newestRow === 'number' ? newestRow : 0
  const at = isoNow(now)

  db.prepare(
    `INSERT INTO memory_cursor (chat_id, through_message_id, forget_epoch, updated_at)
     VALUES (?, ?, 1, ?)
     ON CONFLICT (chat_id) DO UPDATE SET
       through_message_id = max(memory_cursor.through_message_id, excluded.through_message_id),
       forget_epoch = memory_cursor.forget_epoch + 1,
       updated_at = excluded.updated_at`
  ).run(chatId, newestId, at)

  const queuedJobs = db
    .prepare("SELECT job_id FROM memory_job WHERE chat_id = ? AND state = 'queued'")
    .pluck()
    .all(chatId) as string[]

  if (queuedJobs.length > 0) {
    db.prepare(
      "UPDATE memory_job SET state = 'done', last_error = 'forget_barrier', updated_at = ? WHERE chat_id = ? AND state = 'queued'"
    ).run(at, chatId)
    for (const jobId of queuedJobs) {
      recordEvent(db, chatId, { jobId, step: 'job', outcome: 'skipped', reason: 'forget_barrier' }, now)
    }
  }
  return queuedJobs.length
}

/** Forgets one fact of this chat, with everything that could show it again, then sets the barrier. */
export function forgetItem(db: Db, chatId: string, itemId: string, now: Clock = wallClock): boolean {
  const target = db
    .prepare(
      `SELECT id, subject_id, key FROM memory_item
       WHERE id = ? AND chat_id = ? AND kind = 'fact' AND status <> 'forgotten'`
    )
    .get(itemId, chatId) as { id: string; subject_id: string | null; key: string } | undefined

  if (!target) {
    forgetBarrier(db, chatId, now)
    return false
  }

  const at = isoNow(now)
  // Every version of the fact: the row named, and the older and newer rows of the same subject and key.
  const slot = db
    .prepare(
      `SELECT id, source_turn, source_job, source_message_id FROM memory_item
       WHERE chat_id = ? AND kind = 'fact' AND coalesce(subject_id, '') = coalesce(?, '')
         AND key = ? AND status <> 'forgotten'`
    )
    .all(chatId, target.subject_id, target.key) as {
    id: string
    source_turn: string | null
    source_job: string | null
    source_message_id: number | null
  }[]

  const clearFact = db.prepare(
    "UPDATE memory_item SET status = 'forgotten', value = '', key = ?, pinned = 0, updated_at = ? WHERE id = ? AND chat_id = ?"
  )
  const deleteFts = db.prepare('DELETE FROM memory_fts WHERE item_id = ? AND chat_id = ?')
  const episodesOf = db.prepare(
    "SELECT id FROM memory_item WHERE chat_id = ? AND kind = 'episode' AND source_job = ? AND status <> 'forgotten'"
  )
  const clearEpisode = db.prepare(
    "UPDATE memory_item SET status = 'forgotten', value = '', updated_at = ? WHERE id = ? AND chat_id = ?"
  )
  const deleteEmbedding = db.prepare('DELETE FROM memory_embedding WHERE item_id = ? AND chat_id = ?')
  const clearMessage = db.prepare('UPDATE session_message SET content = ? WHERE id = ? AND chat_id = ?')
  const clearTurnMessages = db.prepare(
    "UPDATE session_message SET content = ? WHERE chat_id = ? AND turn_id = ? AND role = 'user'"
  )
  // A quote is a copy of the quoted message's text.
  const clearQuotesOfMessage = db.prepare(
    `UPDATE session_message SET quote = NULL WHERE chat_id = ? AND quote_mid IS NOT NULL
       AND quote_mid = (SELECT mid FROM session_message WHERE id = ? AND chat_id = ?)`
  )
  const clearQuotesOfTurn = db.prepare(
    `UPDATE session_message SET quote = NULL WHERE chat_id = ? AND quote_mid IN (
       SELECT mid FROM session_message WHERE chat_id = ? AND turn_id = ? AND role = 'user' AND mid IS NOT NULL)`
  )
  const isNote = target.key.startsWith('note.')

  for (const row of slot) {
    clearFact.run(FORGOTTEN_KEY, at, row.id, chatId)
    deleteFts.run(row.id, chatId)
    // The summary of the episode the version came from.
    if (row.source_job !== null) {
      for (const episodeId of episodesOf.pluck().all(chatId, row.source_job) as string[]) {
        clearEpisode.run(at, episodeId, chatId)
        deleteFts.run(episodeId, chatId)
        deleteEmbedding.run(episodeId, chatId)
      }
    }
    // The window message that said it. A note has no quote: the messages of the turn that stored it said it.
    if (row.source_message_id !== null) {
      clearMessage.run(FORGOTTEN_MESSAGE, row.source_message_id, chatId)
      clearQuotesOfMessage.run(chatId, row.source_message_id, chatId)
    }
    if (isNote && row.source_turn !== null) {
      clearTurnMessages.run(FORGOTTEN_MESSAGE, chatId, row.source_turn)
      clearQuotesOfTurn.run(chatId, chatId, row.source_turn)
    }
  }

  recordEvent(db, chatId, { step: 'forget', outcome: 'done', itemId }, now)
  forgetBarrier(db, chatId, now)
  return true
}

/** The chat's forget counter, for a job to compare when it applies. 0 when the chat has no cursor row. */
export function forgetEpoch(db: Db, chatId: string): number {
  const epoch = db.prepare('SELECT forget_epoch FROM memory_cursor WHERE chat_id = ?').pluck().get(chatId)
  return typeof epoch === 'number' ? epoch : 0
}

/** Upcoming facts of this chat whose time has passed become retired. Returns how many. */
export function expireUpcoming(db: Db, chatId: string, now: Clock = wallClock): number {
  const at = isoNow(now)
  const ids = db
    .prepare(
      "SELECT id FROM memory_item WHERE chat_id = ? AND kind = 'fact' AND status = 'upcoming' AND valid_until <= ?"
    )
    .pluck()
    .all(chatId, at) as string[]

  if (ids.length === 0) return 0
  const retire = db.prepare("UPDATE memory_item SET status = 'retired', updated_at = ? WHERE id = ? AND chat_id = ?")
  const deleteFts = db.prepare('DELETE FROM memory_fts WHERE item_id = ? AND chat_id = ?')
  for (const id of ids) {
    retire.run(at, id, chatId)
    deleteFts.run(id, chatId)
  }
  return ids.length
}

export function recordEvent(
  db: Db,
  chatId: string,
  event: { jobId?: string; step: string; outcome: string; op?: string; itemId?: string; reason?: string },
  now: Clock = wallClock
): void {
  if (event.reason !== undefined && !REASON_CODE.test(event.reason)) {
    throw new Error(`invalid memory event reason code: ${event.reason}`)
  }
  db.prepare(
    `INSERT INTO memory_event (job_id, chat_id, step, outcome, op, item_id, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    event.jobId ?? null,
    chatId,
    event.step,
    event.outcome,
    event.op ?? null,
    event.itemId ?? null,
    event.reason ?? null,
    isoNow(now)
  )
}

export interface ChatItemRow {
  id: string
  kind: string
  subjectId: string | null
  key: string | null
  value: string
  status: string
  updatedAt: string
}

/** Every memory item of one chat that is not forgotten, newest first, for the owner site (docs/trd/site.md). */
export function listChatItems(storage: Storage, chatId: string): ChatItemRow[] {
  const rows = storage.read(
    (db) =>
      db
        .prepare(
          `SELECT id, kind, subject_id, key, value, status, updated_at
           FROM memory_item
           WHERE chat_id = ? AND status <> 'forgotten'
           ORDER BY updated_at DESC, id ASC`
        )
        .all(chatId) as {
        id: string
        kind: string
        subject_id: string | null
        key: string | null
        value: string
        status: string
        updated_at: string
      }[]
  )
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    subjectId: row.subject_id,
    key: row.key,
    value: row.value,
    status: row.status,
    updatedAt: row.updated_at
  }))
}
