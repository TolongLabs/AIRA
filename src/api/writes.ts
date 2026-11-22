import { z } from 'zod'
import { writeUnavailableLine } from '../character/unavailable.js'
import { setChatLabel, setChatStatus } from '../settings/chats.js'
import { definitionFor } from '../settings/keys.js'
import { SettingError, setSetting, unsetSetting } from '../settings/settings.js'
import { ChatBindingPolicy } from './binding-policy.js'
import { CharacterFooterWriter } from './footer-writer.js'
import type { RouteResult, SiteApiDeps } from './routes.js'

// The site API's write routes (docs/trd/site.md#write-routes). Each write is one transaction with a change record.

const CHAT_STATUS = /^\/api\/chats\/([^/]+)\/status$/
const CHAT_LABEL = /^\/api\/chats\/([^/]+)\/label$/
const CHARACTER_FOOTER = /^\/api\/characters\/([^/]+)\/footer$/
const statusBody = z.strictObject({ status: z.enum(['active', 'pending']) })
const labelBody = z.strictObject({ label: z.string().trim().max(120) })
const SETTINGS = '/api/settings'
const settingBody = z.strictObject({
  level: z.enum(['global', 'type', 'chat']),
  scope: z.string().max(200),
  key: z.string().min(1).max(100),
  // null clears the row and restores inheritance.
  value: z.unknown()
})

/** The actor named in `setting_change` for a change made through the site. */
export const SITE_ACTOR = 'site'

export function isWriteRoute(pathname: string): boolean {
  return (
    CHAT_STATUS.test(pathname) || CHAT_LABEL.test(pathname) || pathname === SETTINGS || CHARACTER_FOOTER.test(pathname)
  )
}

/** `Host` must be an IP address or localhost with a port, so a rebound name cannot reach the API. */
export function hostAllowed(host: string | undefined): boolean {
  if (host === undefined) return false
  return /^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-fA-F:]+\]):\d{1,5}$/.test(host)
}

/** A request with `Origin` is accepted from the API's own origin or a listed one. A request from a server sends none. */
export function originAllowed(origin: string | undefined, allowed: readonly string[], host?: string): boolean {
  if (origin === undefined) return true
  if (host !== undefined && origin === `http://${host}`) return true
  return allowed.some((entry) => new URL(entry).origin === origin)
}

function chatExists(deps: SiteApiDeps, chatId: string): boolean {
  return deps.storage.read((db) => db.prepare('SELECT 1 FROM chat WHERE chat_id = ?').get(chatId) !== undefined)
}

function writeSetting(deps: SiteApiDeps, body: unknown): RouteResult {
  const parsed = settingBody.safeParse(body)
  if (!parsed.success || !('value' in (body as object))) return { status: 400, body: { error: 'invalid_body' } }
  const { level, scope, key, value } = parsed.data
  if (!definitionFor(key)) return { status: 400, body: { error: 'invalid_setting' } }
  if (level === 'chat' && !chatExists(deps, scope)) return { status: 404, body: { error: 'not_found' } }
  if (key === 'character' && value !== null && !(typeof value === 'string' && deps.packs().packs.has(value))) {
    return { status: 400, body: { error: 'unknown_character' } }
  }
  if (key === 'character' && value === null && !new ChatBindingPolicy(deps).canClearCharacter(level, scope)) {
    return { status: 400, body: { error: 'missing_character' } }
  }
  const current = deps.storage.read(
    (db) =>
      db
        .prepare('SELECT value FROM setting WHERE level = ? AND scope = ? AND key = ?')
        .pluck()
        .get(level, scope, key) as string | undefined
  )
  try {
    if (value === null) {
      const changed = unsetSetting(deps.storage, { level, scope, key, actor: SITE_ACTOR }, deps.now)
      if (changed) deps.onWrite?.()
      return { status: 200, body: { level, scope, key, value: null, changed } }
    }
    if (current !== undefined && current === JSON.stringify(value)) {
      return { status: 200, body: { level, scope, key, value, changed: false } }
    }
    setSetting(deps.storage, { level, scope, key, value, actor: SITE_ACTOR }, deps.now)
  } catch (error) {
    if (error instanceof SettingError) return { status: 400, body: { error: 'invalid_setting' } }
    throw error
  }
  if (level === 'global' && key === 'character' && typeof value === 'string') {
    const pack = deps.packs().packs.get(value)
    if (pack) writeUnavailableLine(deps.paths.root, pack)
  }
  deps.onWrite?.()
  return { status: 200, body: { level, scope, key, value, changed: true } }
}

function parseChatWrite<T>(
  deps: SiteApiDeps,
  method: string,
  rawChatId: string,
  body: unknown,
  schema: z.ZodType<T>
): { ok: true; chatId: string; data: T } | { ok: false; result: RouteResult } {
  if (method !== 'PUT') return { ok: false, result: { status: 405, body: { error: 'method_not_allowed' } } }
  let chatId: string
  try {
    chatId = decodeURIComponent(rawChatId)
  } catch {
    return { ok: false, result: { status: 400, body: { error: 'invalid_chat_id' } } }
  }
  const parsed = schema.safeParse(body)
  if (!parsed.success) return { ok: false, result: { status: 400, body: { error: 'invalid_body' } } }
  if (!chatExists(deps, chatId)) return { ok: false, result: { status: 404, body: { error: 'not_found' } } }
  return { ok: true, chatId, data: parsed.data }
}

export function dispatchWrite(deps: SiteApiDeps, method: string, path: string, body: unknown): RouteResult {
  if (path === SETTINGS) {
    if (method !== 'PUT') return { status: 405, body: { error: 'method_not_allowed' } }
    return writeSetting(deps, body)
  }
  const footerMatch = CHARACTER_FOOTER.exec(path)
  if (footerMatch?.[1]) {
    if (method !== 'PUT') return { status: 405, body: { error: 'method_not_allowed' } }
    let id: string
    try {
      id = decodeURIComponent(footerMatch[1])
    } catch {
      return { status: 400, body: { error: 'invalid_character_id' } }
    }
    return new CharacterFooterWriter(deps).write(id, body)
  }
  const labelMatch = CHAT_LABEL.exec(path)
  if (labelMatch?.[1]) {
    const parsed = parseChatWrite(deps, method, labelMatch[1], body, labelBody)
    if (!parsed.ok) return parsed.result
    const label = parsed.data.label
    const changed = setChatLabel(deps.storage, { chatId: parsed.chatId, label, actor: SITE_ACTOR }, deps.now)
    return { status: 200, body: { chatId: parsed.chatId, label, changed } }
  }
  const match = CHAT_STATUS.exec(path)
  if (!match?.[1]) return { status: 404, body: { error: 'not_found' } }
  const parsed = parseChatWrite(deps, method, match[1], body, statusBody)
  if (!parsed.ok) return parsed.result
  if (parsed.data.status === 'active' && !new ChatBindingPolicy(deps).canActivate(parsed.chatId)) {
    return { status: 400, body: { error: 'missing_character' } }
  }
  const changed = setChatStatus(
    deps.storage,
    { chatId: parsed.chatId, status: parsed.data.status, actor: SITE_ACTOR },
    deps.now
  )
  if (changed) deps.onWrite?.()
  return { status: 200, body: { chatId: parsed.chatId, status: parsed.data.status, changed } }
}
