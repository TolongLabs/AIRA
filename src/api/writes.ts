import { z } from 'zod'
import { setChatStatus } from '../settings/chats.js'
import type { RouteResult, SiteApiDeps } from './routes.js'

// The site API's write routes (docs/trd/site.md#write-routes). Each write is one transaction with a change record.

const CHAT_STATUS = /^\/api\/chats\/([^/]+)\/status$/
const statusBody = z.strictObject({ status: z.enum(['active', 'pending']) })

/** The actor named in `setting_change` for a change made through the site. */
export const SITE_ACTOR = 'site'

export function isWriteRoute(pathname: string): boolean {
  return CHAT_STATUS.test(pathname)
}

/** `Host` must be an IP address or localhost with a port, so a rebound name cannot reach the API. */
export function hostAllowed(host: string | undefined): boolean {
  if (host === undefined) return false
  return /^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-fA-F:]+\]):\d{1,5}$/.test(host)
}

/** A request with `Origin` is accepted only from a listed origin. A request from a server sends none. */
export function originAllowed(origin: string | undefined, allowed: readonly string[]): boolean {
  if (origin === undefined) return true
  return allowed.some((entry) => new URL(entry).origin === origin)
}

function chatExists(deps: SiteApiDeps, chatId: string): boolean {
  return deps.storage.read((db) => db.prepare('SELECT 1 FROM chat WHERE chat_id = ?').get(chatId) !== undefined)
}

export function dispatchWrite(deps: SiteApiDeps, method: string, path: string, body: unknown): RouteResult {
  const match = CHAT_STATUS.exec(path)
  if (!match?.[1]) return { status: 404, body: { error: 'not_found' } }
  if (method !== 'PUT') return { status: 405, body: { error: 'method_not_allowed' } }
  let chatId: string
  try {
    chatId = decodeURIComponent(match[1])
  } catch {
    return { status: 400, body: { error: 'invalid_chat_id' } }
  }
  const parsed = statusBody.safeParse(body)
  if (!parsed.success) return { status: 400, body: { error: 'invalid_body' } }
  if (!chatExists(deps, chatId)) return { status: 404, body: { error: 'not_found' } }
  const changed = setChatStatus(deps.storage, { chatId, status: parsed.data.status, actor: SITE_ACTOR }, deps.now)
  return { status: 200, body: { chatId, status: parsed.data.status, changed } }
}
