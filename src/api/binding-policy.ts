import { getChat } from '../settings/chats.js'
import { definitionFor } from '../settings/keys.js'
import { resolveSettings } from '../settings/settings.js'
import type { SiteApiDeps } from './routes.js'

/** Enforces that active chats keep a loaded effective character binding. */
export class ChatBindingPolicy {
  constructor(private readonly deps: Pick<SiteApiDeps, 'storage' | 'packs'>) {}

  canActivate(chatId: string): boolean {
    const chat = getChat(this.deps.storage, chatId)
    if (!chat) return false
    const resolved = resolveSettings(this.deps.storage, chat)
    return this.isLoadedCharacter(resolved['character']?.value)
  }

  canClearChatCharacter(chatId: string): boolean {
    const chat = getChat(this.deps.storage, chatId)
    if (chat?.status !== 'active') return true
    return this.isLoadedCharacter(this.inheritedCharacter(chat.type))
  }

  private inheritedCharacter(chatType: 'dm' | 'group'): unknown {
    const def = definitionFor('character')
    if (!def) return undefined
    const rows = this.deps.storage.read(
      (db) =>
        db
          .prepare(
            `SELECT value
             FROM setting
             WHERE key = 'character'
               AND ((level = 'type' AND scope = ?)
                 OR (level = 'global' AND scope = ''))
             ORDER BY CASE level WHEN 'type' THEN 1 ELSE 2 END`
          )
          .all(chatType) as { value: string }[]
    )
    for (const row of rows) {
      let parsed: unknown
      try {
        parsed = JSON.parse(row.value)
      } catch {
        continue
      }
      const checked = def.schema.safeParse(parsed)
      if (checked.success) return checked.data
    }
    return undefined
  }

  private isLoadedCharacter(value: unknown): boolean {
    return typeof value === 'string' && this.deps.packs().packs.has(value)
  }
}
