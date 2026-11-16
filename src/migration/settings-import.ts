import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { ensureChat, setChatStatus } from '../settings/chats.js'
import { definitionFor } from '../settings/keys.js'
import { setSetting } from '../settings/settings.js'
import type { Storage } from '../storage/database.js'
import { waIdOfFolder } from './readers.js'

// The one-time settings and binding migration (docs/trd/data.md#migration-from-the-old-store). It reads a private
// copy of the old binding file and state files, plans every change, and applies the plan only when asked.
// Reports hold counts and reason codes only.

export type ChatType = 'dm' | 'group'

export interface PlannedSetting {
  level: 'global' | 'chat'
  /** The chat's WhatsApp id for a chat-level setting. Empty for a global one. */
  chat: string
  key: string
  value: unknown
}

export interface SettingsPlan {
  chats: { waId: string; type: ChatType }[]
  settings: PlannedSetting[]
  /** Reason code to count: what was not carried over, and why. */
  reported: Record<string, number>
}

export const ACTOR = 'migration'

function count(plan: SettingsPlan, reason: string): void {
  plan.reported[reason] = (plan.reported[reason] ?? 0) + 1
}

const typeOf = (waId: string): ChatType => (waId.endsWith('@g.us') ? 'group' : 'dm')

/** A binding's chat as the old file wrote it: `@` as `.`, or a phone number (Assumption A-10). */
export function waIdOfBinding(value: unknown, plan: SettingsPlan): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const text = value.trim()
  if (/^\+\d{6,}$/.test(text)) {
    count(plan, 'phone_binding')
    return `${text.slice(1)}@s.whatsapp.net`
  }
  if (text.includes('@')) return text
  return waIdOfFolder(text)
}

/** `group/whatsapp/<folder>` keys, or `whatsapp:<id>` keys. */
function waIdOfStateKey(key: string): string | undefined {
  if (key.startsWith('whatsapp:')) return key.slice('whatsapp:'.length) || undefined
  const parts = key.split('/')
  if (parts.length === 3 && (parts[0] === 'dm' || parts[0] === 'group') && parts[1] === 'whatsapp') {
    return waIdOfFolder(parts[2] ?? '')
  }
  return undefined
}

function readJson(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined
  const value = JSON.parse(readFileSync(path, 'utf8')) as unknown
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

const valid = (key: string, value: unknown): boolean => definitionFor(key)?.schema.safeParse(value).success === true

/** Plans the migration from a private copy. `characters` maps an old personality name to a pack id. */
export function planSettingsMigration(dir: string, characters: Map<string, string>, now: Date): SettingsPlan {
  const plan: SettingsPlan = { chats: [], settings: [], reported: {} }
  const chats = new Map<string, ChatType>()
  const addChat = (waId: string, type: ChatType = typeOf(waId)) => {
    if (!chats.has(waId)) chats.set(waId, type)
  }
  const add = (setting: PlannedSetting) => {
    if (!valid(setting.key, setting.value)) return count(plan, `${setting.key}_invalid`)
    plan.settings.push(setting)
  }
  const character = (name: unknown): string | undefined => {
    const id = typeof name === 'string' ? characters.get(name) : undefined
    if (id === undefined) count(plan, 'personality_unmapped')
    return id
  }

  const bindingsFile = join(dir, 'bindings.yaml')
  if (existsSync(bindingsFile)) {
    const file = (parseYaml(readFileSync(bindingsFile, 'utf8')) ?? {}) as Record<string, unknown>
    const defaults = (file['defaults'] ?? {}) as Record<string, unknown>
    if (defaults['personality'] !== undefined) {
      const id = character(defaults['personality'])
      if (id) add({ level: 'global', chat: '', key: 'character', value: id })
    }
    for (const key of ['mode', 'permissions', 'models'])
      if (defaults[key] !== undefined) count(plan, `default_${key}_no_key`)
    if (file['owner'] !== undefined) count(plan, 'owner_no_key')
    for (const binding of (Array.isArray(file['bindings']) ? file['bindings'] : []) as Record<string, unknown>[]) {
      const match = (binding?.['match'] ?? {}) as Record<string, unknown>
      if (match['platform'] !== 'whatsapp' || (match['kind'] !== 'dm' && match['kind'] !== 'group')) {
        count(plan, 'binding_unreadable')
        continue
      }
      const waId = waIdOfBinding(match['chat'], plan)
      if (!waId) {
        count(plan, 'binding_unreadable')
        continue
      }
      addChat(waId, match['kind'])
      if (binding['personality'] !== undefined) {
        const id = character(binding['personality'])
        if (id) add({ level: 'chat', chat: waId, key: 'character', value: id })
      }
      const permissions = (binding['permissions'] ?? {}) as Record<string, unknown>
      if (permissions['photos'] === 'on' || permissions['photos'] === 'off') {
        add({ level: 'chat', chat: waId, key: 'features.photos', value: permissions['photos'] === 'on' })
      }
      if (permissions['agent'] !== undefined) count(plan, 'agent_no_key')
      if (permissions['autofetch'] !== undefined) count(plan, 'autofetch_no_key')
      if (binding['mode'] !== undefined) count(plan, 'mode_no_key')
      if (binding['models'] !== undefined) count(plan, 'models_no_key')
    }
  }

  const byChat = (name: string, each: (waId: string, value: unknown) => void) => {
    const file = readJson(join(dir, name))
    for (const [key, value] of Object.entries(file ?? {})) {
      const waId = waIdOfStateKey(key)
      if (!waId) {
        count(plan, `${name}_unreadable`)
        continue
      }
      addChat(waId)
      each(waId, value)
    }
  }
  byChat('language.json', (waId, value) => add({ level: 'chat', chat: waId, key: 'language', value }))
  byChat('lessons.json', (waId, value) => add({ level: 'chat', chat: waId, key: 'features.lessons', value }))
  byChat('faces.json', () => count(plan, 'tone_no_key'))
  byChat('quiet.json', (waId, value) => {
    // A mute until a time. A time that has passed is no mute; a mute with no end (the old "hold") still holds.
    const until = typeof value === 'number' ? value * 1000 : Number.NaN
    if (Number.isFinite(until) && until <= now.getTime()) return count(plan, 'mute_expired')
    add({ level: 'chat', chat: waId, key: 'muted', value: { by: ACTOR, at: now.toISOString() } })
  })

  plan.chats = [...chats].map(([waId, type]) => ({ waId, type }))
  return plan
}

export interface ApplyResult {
  chatsCreated: number
  chatsActivated: number
  settingsWritten: number
  alreadySet: number
}

/** Applies a plan in one transaction. A value already set is kept, never replaced. A second run changes nothing. */
export function applySettingsPlan(
  storage: Storage,
  plan: SettingsPlan,
  now: () => Date = () => new Date()
): ApplyResult {
  const result: ApplyResult = { chatsCreated: 0, chatsActivated: 0, settingsWritten: 0, alreadySet: 0 }
  // Reads go through the transaction's own connection: the read connection does not see what it has not committed.
  storage.tx((db) => {
    const chatIds = new Map<string, string>()
    for (const chat of plan.chats) {
      const row = ensureChat(storage, { waId: chat.waId, type: chat.type }, now)
      chatIds.set(chat.waId, row.chatId)
      if (row.created) result.chatsCreated++
      if (setChatStatus(storage, { chatId: row.chatId, status: 'active', actor: ACTOR }, now)) result.chatsActivated++
    }
    const currentOf = db.prepare('SELECT value FROM setting WHERE level = ? AND scope = ? AND key = ?').pluck()
    for (const setting of plan.settings) {
      const scope = setting.level === 'global' ? '' : chatIds.get(setting.chat)
      if (scope === undefined) throw new Error('a planned chat setting names a chat the plan did not create')
      const current = currentOf.get(setting.level, scope, setting.key) as string | undefined
      if (current !== undefined) {
        if (current !== JSON.stringify(setting.value)) result.alreadySet++
        continue
      }
      setSetting(storage, { level: setting.level, scope, key: setting.key, value: setting.value, actor: ACTOR }, now)
      result.settingsWritten++
    }
  })
  return result
}
