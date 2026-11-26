import type { Storage } from '../storage/database.js'
import type { MemoryPort } from '../tools/ports.js'
import { memoryLine, searchHistory, searchMemory } from './recall.js'
import { addNote, forgetBarrier, forgetItem, setLingo } from './store.js'
import { MAX_VALUE_CHARS, type MemoryJudge } from './types.js'

export interface MemoryPortOptions {
  storage: Storage
  judge?: MemoryJudge
  verifyThreshold: number
  timeoutMs: number
  excludeAbandonedPortable?: boolean
}

export function createMemoryPort(options: MemoryPortOptions): MemoryPort {
  return {
    recall(chatId, query, limit, askerId) {
      const present = new Map<string, string>(askerId === undefined ? [] : [[askerId, 'the person asking']])
      return searchMemory(options.storage, chatId, query, limit).map((item) => ({
        itemId: item.itemId,
        text: memoryLine(item, present, 'another member')
      }))
    },

    history(chatId, query, limit) {
      return searchHistory(options.storage, chatId, query, limit, options.excludeAbandonedPortable)
    },

    async checkNote(input, signal) {
      const text = input.text.trim()
      if (text.length === 0 || text.length > MAX_VALUE_CHARS) {
        return { ok: false, reason: 'invalid_text' }
      }
      if (!options.judge) {
        return { ok: false, reason: 'judge_unavailable' }
      }
      // The note must be what the member said in this turn, so the excerpt is the member's own messages.
      const own = options.storage.read(
        (db) =>
          db
            .prepare(
              `SELECT content FROM session_message
               WHERE chat_id = ? AND turn_id = ? AND role = 'user' AND sender_id = ? ORDER BY id`
            )
            .pluck()
            .all(input.chatId, input.turnId, input.subjectId) as string[]
      )
      if (own.length === 0) {
        return { ok: false, reason: 'not_supported' }
      }
      const episode = own.join('\n')

      const combined = AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs)])
      let probability: number
      try {
        probability = await options.judge.verify(
          { operation: `keep this note about the member who wrote it: "${text}"`, quote: episode, episode },
          combined
        )
      } catch {
        return { ok: false, reason: 'judge_unavailable' }
      }

      if (typeof probability !== 'number' || Number.isNaN(probability)) {
        return { ok: false, reason: 'judge_unavailable' }
      }
      if (probability < options.verifyThreshold) {
        return { ok: false, reason: 'not_supported' }
      }
      return { ok: true }
    },

    note(db, input) {
      return addNote(db, input.chatId, {
        subjectId: input.subjectId,
        text: input.text,
        turnId: input.turnId
      })
    },

    forget(db, input) {
      return forgetItem(db, input.chatId, input.itemId)
    },

    forgetPending(db, input) {
      forgetBarrier(db, input.chatId)
    },

    lingo(db, input) {
      return setLingo(db, input.chatId, {
        word: input.word,
        meaning: input.meaning,
        turnId: input.turnId
      })
    }
  }
}
