import { stickerHostPath } from '../character/unavailable.js'
import type { Storage } from '../storage/database.js'
import type { ReplyCleaner } from '../turn/types.js'
import { getChatState, setChatState } from './chat-state.js'
import { pick } from './random.js'

/** One sticker of the mood, never the last one sent in this chat when the mood has another. Undefined when the mood has none. */
export function pickSticker(input: { stickers: string[]; last?: string; random: () => number }): string | undefined {
  if (input.stickers.length === 0) return undefined
  if (input.stickers.length === 1) return input.stickers[0]
  const filtered = input.last !== undefined ? input.stickers.filter((s) => s !== input.last) : input.stickers
  const pool = filtered.length > 0 ? filtered : input.stickers
  return pick(pool, input.random)
}

export interface StickerOptions {
  storage: Storage
  /** gateway.hostDataDir: the data volume's path on the host, where the gateway reads the file. */
  hostDataDir: string
  random?: () => number
  now?: () => Date
}

/** Wraps a cleaner: after the reply is cleaned, adds the mood's sticker as the last line of the content. */
export function withStickers(cleaner: ReplyCleaner, options: StickerOptions): ReplyCleaner {
  const random = options.random ?? Math.random
  const now = options.now ?? (() => new Date())

  return {
    clean(input) {
      const cleaned = cleaner.clean(input)
      if (cleaned.content.length === 0) return cleaned
      if (cleaned.replacedBy !== undefined) return cleaned
      if (input.context.settings['expressions']?.value === false) return cleaned

      const pack = input.context.character
      if (pack.source !== 'data') return cleaned

      const moodName = input.built.record.mood
      const mood = moodName ? pack.moods.get(moodName) : undefined
      if (!mood || mood.stickers.length === 0) return cleaned

      try {
        const key = {
          chatId: input.context.chat.chatId,
          characterId: pack.id,
          key: 'lastSticker'
        }
        const rawLast = getChatState(options.storage, key)
        const last = typeof rawLast === 'string' ? rawLast : undefined
        const file = pickSticker({ stickers: mood.stickers, last, random })
        if (!file) return cleaned

        const mediaPath = stickerHostPath(options.hostDataDir, pack.id, file)
        options.storage.tx((db) => {
          setChatState(db, key, file, now)
        })

        const pdfs = cleaned.content.split('\n').filter((line) => /^MEDIA:.*\.pdf$/.test(line))
        const body = cleaned.content
          .split('\n')
          .filter((line) => !pdfs.includes(line))
          .join('\n')
        return {
          ...cleaned,
          content: [body, `MEDIA:${mediaPath}`, ...pdfs].join('\n'),
          stickerId: file,
          attachments: [
            ...(cleaned.attachments ?? []).filter((path) => !path.endsWith('.pdf')),
            mediaPath,
            ...(cleaned.attachments ?? []).filter((path) => path.endsWith('.pdf'))
          ]
        }
      } catch {
        return cleaned
      }
    }
  }
}
