import { getChat, listChats } from '../settings/chats.js'
import { resolveSettings, type SettingLevel } from '../settings/settings.js'
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

  canClearCharacter(level: SettingLevel, scope: string): boolean {
    const chats = level === 'chat' ? [getChat(this.deps.storage, scope)] : listChats(this.deps.storage)
    const loaded = this.deps.packs().packs
    for (const chat of chats) {
      if (chat?.status !== 'active' || (level === 'type' && chat.type !== scope)) continue
      const binding = resolveSettings(this.deps.storage, chat)['character']
      if (binding?.level !== level) continue
      const next = resolveSettings(this.deps.storage, chat, { level, key: 'character' })['character']?.value
      if (typeof next !== 'string' || !loaded.has(next)) return false
    }
    return true
  }

  private isLoadedCharacter(value: unknown): boolean {
    return typeof value === 'string' && this.deps.packs().packs.has(value)
  }
}
