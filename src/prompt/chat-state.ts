import { type Db, type Storage, isoNow } from '../storage/database.js'

export interface ChatStateKey {
  chatId: string
  characterId: string
  key: string
}

export function getChatState(storage: Storage, key: ChatStateKey): unknown {
  const row = storage.read(
    (db) =>
      db
        .prepare('SELECT value FROM chat_state WHERE chat_id = ? AND character_id = ? AND key = ?')
        .get(key.chatId, key.characterId, key.key) as { value: string } | undefined
  )
  if (!row) return undefined
  return JSON.parse(row.value) as unknown
}

export function setChatState(db: Db, key: ChatStateKey, value: unknown, now: () => Date = () => new Date()): void {
  db.prepare(
    `INSERT INTO chat_state (chat_id, character_id, key, value, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (chat_id, character_id, key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at`
  ).run(key.chatId, key.characterId, key.key, JSON.stringify(value), isoNow(now))
}
