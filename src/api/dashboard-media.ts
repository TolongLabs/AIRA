import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { convertExpression, STUDIO_MAX_INPUT_BYTES } from '../media/studio-expression.js'
import { getChat } from '../settings/chats.js'
import { writeFileAtomic } from '../storage/files.js'
import type { RouteResult, SiteApiDeps } from './routes.js'

export type ProfileKind = 'chats' | 'characters'

function imagePath(root: string, kind: ProfileKind, id: string) {
  return join(root, 'dashboard-portraits', kind, id + '.webp')
}

export function hasPortrait(root: string, kind: ProfileKind, id: string) {
  return /^[a-zA-Z0-9_-]{1,128}$/.test(id) && existsSync(imagePath(root, kind, id))
}

export async function profileImage(
  deps: SiteApiDeps,
  kind: ProfileKind,
  id: string,
  method: string,
  payload?: unknown
): Promise<RouteResult> {
  const exists = kind === 'chats' ? getChat(deps.storage, id) : deps.packs().packs.get(id)
  if (!exists || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) return { status: 404, body: { error: 'not_found' } }
  const path = imagePath(deps.paths.root, kind, id)
  if (method === 'GET')
    return { status: 200, body: { image: existsSync(path) ? readFileSync(path).toString('base64') : null } }
  if (method !== 'PUT') return { status: 405, body: { error: 'method_not_allowed' } }
  const { image, mime } = (payload ?? {}) as { image?: unknown; mime?: unknown }
  if (typeof image !== 'string' || typeof mime !== 'string' || image.length > Math.ceil(STUDIO_MAX_INPUT_BYTES / 3) * 4)
    return { status: 400, body: { error: 'invalid_image' } }
  const converted = await convertExpression(Buffer.from(image, 'base64'), mime, undefined, 'cover')
  if (!converted.ok) return { status: converted.reason === 'busy' ? 503 : 400, body: { error: converted.reason } }
  writeFileAtomic(path, converted.data)
  return { status: 200, body: { saved: true } }
}

export function inboundActivity(deps: SiteApiDeps) {
  const today = (deps.now?.() ?? new Date()).toISOString().slice(0, 10)
  const end = new Date(today + 'T00:00:00Z')
  const start = new Date(end.getTime() - (84 + end.getUTCDay()) * 86400000)
  const until = new Date(end.getTime() + 86400000)
  // Scheduled turns also receive a deduplication row in the inbound table.
  const counts = deps.storage.read((db) =>
    db
      .prepare(
        `SELECT substr(m.received_at,1,10) AS day, count(*) AS count FROM inbound_message m
          LEFT JOIN turn t ON t.turn_id=m.turn_id WHERE m.received_at >= ? AND m.received_at < ?
          AND (t.kind IS NULL OR t.kind!='scheduled') AND m.sender_id GLOB 's_*'
          GROUP BY day ORDER BY day`
      )
      .all(start.toISOString(), until.toISOString())
  )
  return { start: start.toISOString().slice(0, 10), today, counts }
}

export function chatSenders(deps: SiteApiDeps, id: string): RouteResult {
  if (!getChat(deps.storage, id)) return { status: 404, body: { error: 'not_found' } }
  const senders = deps.storage.read((db) =>
    db
      .prepare(
        `
    SELECT m.sender_id AS id, (SELECT i.display_name FROM identity i WHERE i.subject_id=m.sender_id AND i.display_name IS NOT NULL ORDER BY i.created_at DESC LIMIT 1) AS label
    FROM inbound_message m WHERE m.chat_id=? AND m.sender_id GLOB 's_*' GROUP BY m.sender_id ORDER BY MAX(m.received_at) DESC LIMIT 50
  `
      )
      .all(id)
  )
  return { status: 200, body: { senders } }
}
