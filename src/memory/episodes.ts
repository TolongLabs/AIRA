import type { Storage } from '../storage/database.js'
import { isoNow } from '../storage/database.js'
import { enqueueJob } from '../storage/leases.js'

// Steps 2 and 3 of the write path (docs/trd/memory.md#write-path): an episode closes and its job is queued.

/** What a memory job covers. It holds ids and counts only, never text. */
export interface EpisodePayload {
  fromId: number
  throughId: number
  /** How many window messages the range held when the job was queued. */
  count: number
  /** The chat's forget counter when the job was queued. The job applies nothing if it changed. */
  forgetEpoch: number
}

export interface EpisodeLimits {
  idleMs: number
  maxMessages: number
}

/**
 * Closes the open episode of every active chat that is due: idle for idleMs, or maxMessages long. The job row and
 * the cursor move in one transaction, so a message is covered by exactly one job. Returns how many jobs it queued.
 */
export function closeDueEpisodes(storage: Storage, limits: EpisodeLimits, now: () => Date = () => new Date()): number {
  const chats = storage.read(
    (db) => db.prepare("SELECT chat_id FROM chat WHERE status = 'active' ORDER BY chat_id").pluck().all() as string[]
  )
  let queued = 0
  for (const chatId of chats) {
    queued += storage.tx((db) => {
      const cursor = db
        .prepare('SELECT through_message_id, forget_epoch FROM memory_cursor WHERE chat_id = ?')
        .get(chatId) as { through_message_id: number; forget_epoch: number } | undefined
      const through = cursor?.through_message_id ?? 0
      const rows = db
        .prepare('SELECT id, created_at FROM session_message WHERE chat_id = ? AND id > ? ORDER BY id LIMIT ?')
        .all(chatId, through, limits.maxMessages) as { id: number; created_at: string }[]
      const last = rows.at(-1)
      const first = rows[0]
      if (!first || !last) return 0
      const idle = now().getTime() - new Date(last.created_at).getTime() >= limits.idleMs
      if (rows.length < limits.maxMessages && !idle) return 0
      const payload: EpisodePayload = {
        fromId: first.id,
        throughId: last.id,
        count: rows.length,
        forgetEpoch: cursor?.forget_epoch ?? 0
      }
      enqueueJob(
        db,
        'memory_job',
        { jobId: `mem_${chatId}_${first.id}_${last.id}`, chatId, payload: JSON.stringify(payload) },
        now
      )
      db.prepare(
        `INSERT INTO memory_cursor (chat_id, through_message_id, forget_epoch, updated_at) VALUES (?, ?, 0, ?)
         ON CONFLICT (chat_id) DO UPDATE SET through_message_id = excluded.through_message_id,
           updated_at = excluded.updated_at`
      ).run(chatId, last.id, isoNow(now))
      return 1
    })
  }
  return queued
}
