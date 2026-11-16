import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { listChats } from '../settings/chats.js'
import { resolveSettings } from '../settings/settings.js'
import type { Storage } from '../storage/database.js'
import { writeFileAtomic } from '../storage/files.js'

// Per-chat gateway flags (docs/trd/system.md#chat-flags-file).
// This file is the one place outside the chat table where WhatsApp ids are written; never log them.

export interface ChatFlagsEntry {
  voice?: 'all'
  reactions?: true
}

export interface ChatFlagsFile {
  version: 1
  chats: Record<string, ChatFlagsEntry>
}

/** Builds the flags object for every active chat that has voice or reactions enabled. */
export function buildChatFlags(storage: Storage): ChatFlagsFile {
  const chats: Record<string, ChatFlagsEntry> = {}
  for (const chat of listChats(storage)) {
    if (chat.status !== 'active') continue
    const settings = resolveSettings(storage, chat)
    const voice = settings['features.voice']?.value === true
    const reactions = settings['reactions']?.value === true
    if (!voice && !reactions) continue
    const entry: ChatFlagsEntry = {}
    if (voice) entry.voice = 'all'
    if (reactions) entry.reactions = true
    chats[chat.waId] = entry
  }
  return { version: 1, chats }
}

/** Writes `<dataDir>/gateway/chats.json` atomically when the content changed. Returns true if it wrote. */
export function writeChatFlags(storage: Storage, dataDir: string): boolean {
  const filePath = join(dataDir, 'gateway', 'chats.json')
  const content = `${JSON.stringify(buildChatFlags(storage), null, 2)}\n`
  try {
    if (readFileSync(filePath, 'utf8') === content) return false
  } catch {
    // Missing or unreadable file: write it fresh.
  }
  writeFileAtomic(filePath, content)
  return true
}
