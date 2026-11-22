import { randomBytes } from 'node:crypto'
import { isoNow, type Storage } from '../storage/database.js'
import { SettingError } from './settings.js'

// Chats and identities (docs/trd/data.md#chats-and-identities).
// Maps external WhatsApp ids to internal c_ / s_ ids. Never writes a WhatsApp id or label to setting_change.

type Clock = () => Date
const wallClock: Clock = () => new Date()

export interface Chat {
  chatId: string
  waId: string
  type: 'dm' | 'group'
  label: string
  status: 'pending' | 'active'
}

interface ChatRow {
  chat_id: string
  wa_id: string
  type: 'dm' | 'group'
  label: string
  status: 'pending' | 'active'
}

function toChat(row: ChatRow): Chat {
  return {
    chatId: row.chat_id,
    waId: row.wa_id,
    type: row.type,
    label: row.label,
    status: row.status
  }
}

function newId(prefix: 'c_' | 's_'): string {
  return prefix + randomBytes(6).toString('hex')
}

/** Returns the chat for a WhatsApp id, creating it as pending at first sight. Never changes an existing row. */
export function ensureChat(
  storage: Storage,
  input: { waId: string; type: 'dm' | 'group' },
  now: Clock = wallClock
): Chat & { created: boolean } {
  return storage.tx((db) => {
    const existing = db
      .prepare('SELECT chat_id, wa_id, type, label, status FROM chat WHERE wa_id = ?')
      .get(input.waId) as ChatRow | undefined
    if (existing) return { ...toChat(existing), created: false }

    const chatId = newId('c_')
    db.prepare(
      `INSERT INTO chat (chat_id, wa_id, type, label, status, created_at)
       VALUES (?, ?, ?, '', 'pending', ?)`
    ).run(chatId, input.waId, input.type, isoNow(now))
    return { chatId, waId: input.waId, type: input.type, label: '', status: 'pending', created: true }
  })
}

export function getChat(storage: Storage, chatId: string): Chat | undefined {
  return storage.read((db) => {
    const stmt = db.prepare('SELECT chat_id, wa_id, type, label, status FROM chat WHERE chat_id = ?')
    const row = stmt.get(chatId) as ChatRow | undefined
    return row ? toChat(row) : undefined
  })
}

export function getChatByWaId(storage: Storage, waId: string): Chat | undefined {
  return storage.read((db) => {
    const stmt = db.prepare('SELECT chat_id, wa_id, type, label, status FROM chat WHERE wa_id = ?')
    const row = stmt.get(waId) as ChatRow | undefined
    return row ? toChat(row) : undefined
  })
}

export function listChats(storage: Storage): Chat[] {
  return storage.read((db) => {
    const rows = db
      .prepare('SELECT chat_id, wa_id, type, label, status FROM chat ORDER BY created_at, chat_id')
      .all() as ChatRow[]
    return rows.map(toChat)
  })
}

/** Sets pending or active. Logs the change. Returns false when the chat does not exist or already has that status. */
export function setChatStatus(
  storage: Storage,
  input: { chatId: string; status: 'pending' | 'active'; actor: string },
  now: Clock = wallClock
): boolean {
  return storage.tx((db) => {
    const stmt = db.prepare('SELECT status FROM chat WHERE chat_id = ?').pluck()
    const current = stmt.get(input.chatId) as 'pending' | 'active' | undefined
    if (current === undefined || current === input.status) return false

    db.prepare('UPDATE chat SET status = ? WHERE chat_id = ?').run(input.status, input.chatId)
    db.prepare(
      `INSERT INTO setting_change (target, actor, level, scope, key, old_value, new_value, changed_at)
       VALUES ('chat', ?, 'chat', ?, 'status', ?, ?, ?)`
    ).run(input.actor, input.chatId, JSON.stringify(current), JSON.stringify(input.status), isoNow(now))
    return true
  })
}

/** Sets the chat label. Logs the change without storing label text. Returns false when missing or unchanged. */
export function setChatLabel(
  storage: Storage,
  input: { chatId: string; label: string; actor: string },
  now: Clock = wallClock
): boolean {
  return storage.tx((db) => {
    const stmt = db.prepare('SELECT label FROM chat WHERE chat_id = ?').pluck()
    const current = stmt.get(input.chatId) as string | undefined
    if (current === undefined || current === input.label) return false

    db.prepare('UPDATE chat SET label = ? WHERE chat_id = ?').run(input.label, input.chatId)
    db.prepare(
      `INSERT INTO setting_change (target, actor, level, scope, key, old_value, new_value, changed_at)
       VALUES ('chat', ?, 'chat', ?, 'label', NULL, NULL, ?)`
    ).run(input.actor, input.chatId, isoNow(now))
    return true
  })
}

/** Returns the subject for a WhatsApp id, creating a new subject at first sight. */
export function ensureSubject(storage: Storage, waId: string, now: Clock = wallClock): string {
  return storage.tx((db) => {
    const stmt = db.prepare('SELECT subject_id FROM identity WHERE wa_id = ?').pluck()
    const existing = stmt.get(waId) as string | undefined
    if (existing !== undefined) return existing

    const subjectId = newId('s_')
    db.prepare('INSERT INTO identity (wa_id, subject_id, created_at) VALUES (?, ?, ?)').run(
      waId,
      subjectId,
      isoNow(now)
    )
    return subjectId
  })
}

/** Maps a WhatsApp id to an existing subject, so two ids of one person share it. Logs the change. */
export function linkIdentity(
  storage: Storage,
  input: { waId: string; subjectId: string; actor: string },
  now: Clock = wallClock
): void {
  storage.tx((db) => {
    const subjectExists = db.prepare('SELECT 1 FROM identity WHERE subject_id = ? LIMIT 1').pluck().get(input.subjectId)
    if (subjectExists === undefined) {
      throw new SettingError(`unknown subject: ${input.subjectId}`)
    }

    const stmt = db.prepare('SELECT subject_id FROM identity WHERE wa_id = ?').pluck()
    const oldSubject = stmt.get(input.waId) as string | undefined
    if (oldSubject === input.subjectId) return

    const at = isoNow(now)
    db.prepare(
      `INSERT INTO identity (wa_id, subject_id, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT (wa_id) DO UPDATE SET subject_id = excluded.subject_id`
    ).run(input.waId, input.subjectId, at)

    db.prepare(
      `INSERT INTO setting_change (target, actor, level, scope, key, old_value, new_value, changed_at)
       VALUES ('chat', ?, NULL, NULL, 'identity', ?, ?, ?)`
    ).run(
      input.actor,
      oldSubject !== undefined ? JSON.stringify(oldSubject) : null,
      JSON.stringify(input.subjectId),
      at
    )
  })
}

/** Keeps the display name the gateway gave a sender, for names in the prompt and in mentions. */
export function setDisplayName(storage: Storage, waId: string, name: string): void {
  storage.tx((db) => {
    db.prepare('UPDATE identity SET display_name = ? WHERE wa_id = ? AND display_name IS NOT ?').run(name, waId, name)
  })
}

/** The display names of subjects, by subject id. */
export function displayNames(storage: Storage, subjectIds: string[]): Map<string, string> {
  if (subjectIds.length === 0) return new Map()
  const rows = storage.read(
    (db) =>
      db
        .prepare(
          `SELECT subject_id, display_name FROM identity WHERE display_name IS NOT NULL
           AND subject_id IN (${subjectIds.map(() => '?').join(',')})`
        )
        .all(...subjectIds) as { subject_id: string; display_name: string }[]
  )
  return new Map(rows.map((row) => [row.subject_id, row.display_name]))
}

/** The display name of a WhatsApp id, if the core has seen one (directly or on a linked identity). */
export function displayNameFor(storage: Storage, waId: string): string | undefined {
  return storage.read((db) => {
    const direct = db
      .prepare("SELECT display_name FROM identity WHERE wa_id = ? AND display_name IS NOT NULL AND display_name <> ''")
      .pluck()
      .get(waId) as string | undefined
    if (direct !== undefined) return direct
    return db
      .prepare(
        `SELECT i2.display_name FROM identity i1
         JOIN identity i2 ON i2.subject_id = i1.subject_id
         WHERE i1.wa_id = ? AND i2.display_name IS NOT NULL AND i2.display_name <> ''
         LIMIT 1`
      )
      .pluck()
      .get(waId) as string | undefined
  })
}

/** The display name of a WhatsApp id written as a bare number in a mention, if the core has seen it. */
export function displayNameOfNumber(storage: Storage, number: string): string | undefined {
  return storage.read(
    (db) =>
      db
        .prepare('SELECT display_name FROM identity WHERE display_name IS NOT NULL AND (wa_id = ? OR wa_id LIKE ?)')
        .pluck()
        .get(number, `${number}@%`) as string | undefined
  )
}
