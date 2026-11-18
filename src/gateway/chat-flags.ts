import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PackSet } from '../character/loader.js'
import { listChats } from '../settings/chats.js'
import { resolveSettings } from '../settings/settings.js'
import type { Storage } from '../storage/database.js'
import { writeFileAtomic } from '../storage/files.js'
import { resolveNames } from '../turn/name-call.js'

// Per-chat gateway flags (docs/trd/system.md#chat-flags-file).
// This file is the one place outside the chat table where WhatsApp ids are written; never log them.

export interface ChatFlagsEntry {
  voice?: 'all'
  reactions?: true
  reactionChance?: number
  names?: string[]
  free?: true
  autofetch?: true
}

export interface ChatFlagsFile {
  version: 1
  chats: Record<string, ChatFlagsEntry>
}

export type PacksSource = PackSet | (() => PackSet)

/** Builds the flags object for every active chat that has voice, reactions, name call, free response or autofetch on. */
export function buildChatFlags(storage: Storage, packs?: PacksSource): ChatFlagsFile {
  const chats: Record<string, ChatFlagsEntry> = {}
  let loaded: PackSet | undefined
  const getPacks = (): PackSet | undefined => {
    if (loaded === undefined && packs !== undefined) {
      loaded = typeof packs === 'function' ? packs() : packs
    }
    return loaded
  }

  for (const chat of listChats(storage)) {
    if (chat.status !== 'active') continue
    const settings = resolveSettings(storage, chat)
    const voice = settings['features.voice']?.value === true
    const muted = Boolean(settings['muted']?.value)
    const reactions = settings['reactions']?.value === true && !muted
    const chanceValue = settings['reactions.chance']?.value
    const reactionChance = typeof chanceValue === 'number' ? chanceValue / 100 : 0.33
    const free = chat.type === 'group' && settings['freeResponse']?.value === true
    const autofetch = chat.type === 'group' && settings['features.autofetch']?.value === true && !muted
    const nameCall = chat.type === 'group' && settings['nameCall']?.value === true
    let names: string[] = []
    if (nameCall) {
      const characterId = settings['character']?.value
      const pack = typeof characterId === 'string' ? getPacks()?.packs.get(characterId) : undefined
      names = resolveNames(settings, pack)
    }
    if (!voice && !reactions && names.length === 0 && !free && !autofetch) continue
    const entry: ChatFlagsEntry = {}
    if (voice) entry.voice = 'all'
    if (reactions) {
      entry.reactions = true
      entry.reactionChance = reactionChance
    }
    if (names.length > 0) entry.names = names
    if (free) entry.free = true
    if (autofetch) entry.autofetch = true
    chats[chat.waId] = entry
  }
  return { version: 1, chats }
}

/** Writes `<dataDir>/gateway/chats.json` atomically when the content changed. Returns true if it wrote. */
export function writeChatFlags(storage: Storage, dataDir: string, packs?: PacksSource): boolean {
  const filePath = join(dataDir, 'gateway', 'chats.json')
  const content = `${JSON.stringify(buildChatFlags(storage, packs), null, 2)}\n`
  try {
    if (readFileSync(filePath, 'utf8') === content) return false
  } catch {
    // Missing or unreadable file: write it fresh.
  }
  writeFileAtomic(filePath, content)
  return true
}
