import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { isMap, parseDocument } from 'yaml'
import { z } from 'zod'
import { loadPack } from '../character/loader.js'
import { cardSchema, footerLabelSchema, PACK_ID } from '../character/schema.js'
import { writeUnavailableLine } from '../character/unavailable.js'
import { setChatStatus } from '../settings/chats.js'
import { definitionFor } from '../settings/keys.js'
import { SettingError, setSetting, unsetSetting } from '../settings/settings.js'
import { isoNow } from '../storage/database.js'
import { footerKindsFor, type RouteResult, type SiteApiDeps } from './routes.js'

// The site API's write routes (docs/trd/site.md#write-routes). Each write is one transaction with a change record.

const CHAT_STATUS = /^\/api\/chats\/([^/]+)\/status$/
const CHARACTER_FOOTER = /^\/api\/characters\/([^/]+)\/footer$/
const statusBody = z.strictObject({ status: z.enum(['active', 'pending']) })
const footerBody = z.strictObject({
  icon: z.union([z.string(), z.null()]).optional(),
  labels: z.record(z.string(), z.union([z.string(), z.null()])).optional()
})
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
  return CHAT_STATUS.test(pathname) || pathname === SETTINGS || CHARACTER_FOOTER.test(pathname)
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

interface FooterChange {
  key: string
  oldValue: string | null
  newValue: string | null
}

function footerChanges(
  before: { icon?: string; labels?: Record<string, string> } | undefined,
  after: { icon?: string; labels?: Record<string, string> } | undefined
): FooterChange[] {
  const changes: FooterChange[] = []
  if (before?.icon !== after?.icon) {
    changes.push({
      key: 'toolFooter.icon',
      oldValue: before?.icon === undefined ? null : JSON.stringify(before.icon),
      newValue: after?.icon === undefined ? null : JSON.stringify(after.icon)
    })
  }
  const oldLabels = before?.labels ?? {}
  const newLabels = after?.labels ?? {}
  const keys = new Set([...Object.keys(oldLabels), ...Object.keys(newLabels)])
  for (const kind of [...keys].sort()) {
    const prev = Object.hasOwn(oldLabels, kind) ? oldLabels[kind] : undefined
    const next = Object.hasOwn(newLabels, kind) ? newLabels[kind] : undefined
    if (prev !== next) {
      changes.push({
        key: `toolFooter.labels.${kind}`,
        oldValue: prev === undefined ? null : JSON.stringify(prev),
        newValue: next === undefined ? null : JSON.stringify(next)
      })
    }
  }
  return changes
}

function resolveDataPackDir(
  deps: SiteApiDeps,
  id: string
): { ok: true; dir: string } | { ok: false; result: RouteResult } {
  if (!PACK_ID.test(id)) return { ok: false, result: { status: 404, body: { error: 'not_found' } } }
  const set = deps.packs()
  const loaded = set.packs.get(id)
  if (loaded) {
    if (loaded.source !== 'data') return { ok: false, result: { status: 409, body: { error: 'pack_read_only' } } }
    return { ok: true, dir: loaded.dir }
  }
  const fault = set.faults.find((entry) => entry.id === id)
  if (!fault) return { ok: false, result: { status: 404, body: { error: 'not_found' } } }
  if (resolve(fault.dir) !== resolve(join(deps.paths.root, 'characters', id))) {
    return { ok: false, result: { status: 409, body: { error: 'pack_read_only' } } }
  }
  return { ok: true, dir: fault.dir }
}

function writeCharacterFooter(deps: SiteApiDeps, id: string, body: unknown): RouteResult {
  const parsed = footerBody.safeParse(body)
  if (!parsed.success) return { status: 400, body: { error: 'invalid_body' } }

  const resolved = resolveDataPackDir(deps, id)
  if (!resolved.ok) return resolved.result
  const { dir } = resolved

  const cardPath = join(dir, 'card.yml')
  let oldBytes: Buffer
  try {
    oldBytes = readFileSync(cardPath)
  } catch {
    return { status: 409, body: { error: 'pack_unparseable' } }
  }

  let doc: ReturnType<typeof parseDocument>
  let currentRaw: unknown
  try {
    doc = parseDocument(oldBytes.toString('utf8'))
    if (doc.errors.length > 0) return { status: 409, body: { error: 'pack_unparseable' } }
    currentRaw = doc.toJS()
  } catch {
    return { status: 409, body: { error: 'pack_unparseable' } }
  }
  const currentParsed = cardSchema.safeParse(currentRaw)
  if (!currentParsed.success) return { status: 409, body: { error: 'pack_unparseable' } }
  const currentCard = currentParsed.data

  const patch = parsed.data
  if (patch.labels) {
    const knownKinds = new Set(footerKindsFor(deps.registry).map((entry) => entry.kind))
    for (const kind of Object.keys(patch.labels)) {
      if (!knownKinds.has(kind)) return { status: 400, body: { error: 'unknown_footer_kind' } }
    }
  }

  if (patch.icon === null) {
    doc.deleteIn(['toolFooter', 'icon'])
  } else if (patch.icon !== undefined) {
    doc.setIn(['toolFooter', 'icon'], patch.icon)
  }

  if (patch.labels) {
    for (const [kind, value] of Object.entries(patch.labels)) {
      if (value === null) {
        doc.deleteIn(['toolFooter', 'labels', kind])
      } else {
        const checked = footerLabelSchema.safeParse(value)
        if (!checked.success) return { status: 400, body: { error: 'invalid_footer' } }
        doc.setIn(['toolFooter', 'labels', kind], checked.data)
      }
    }
  }

  const labelsNode = doc.getIn(['toolFooter', 'labels'], true)
  if (isMap(labelsNode) && labelsNode.items.length === 0) doc.deleteIn(['toolFooter', 'labels'])
  const footerNode = doc.getIn(['toolFooter'], true)
  if (isMap(footerNode) && footerNode.items.length === 0) doc.deleteIn(['toolFooter'])

  const nextParsed = cardSchema.safeParse(doc.toJS())
  if (!nextParsed.success) return { status: 400, body: { error: 'invalid_footer' } }
  const nextCard = nextParsed.data

  const changes = footerChanges(currentCard.toolFooter, nextCard.toolFooter)
  if (changes.length === 0) {
    return { status: 200, body: { id, toolFooter: currentCard.toolFooter ?? {}, changed: false } }
  }

  const tmpPath = join(dir, 'card.yml.tmp')
  const nextText = doc.toString()
  const at = isoNow(deps.now)
  const rowIds: number[] = []
  deps.storage.tx((db) => {
    try {
      writeFileSync(tmpPath, nextText, 'utf8')
      renameSync(tmpPath, cardPath)
    } catch (error) {
      try {
        unlinkSync(tmpPath)
      } catch {
        // ignore cleanup failure
      }
      throw error
    }
    const insert = db.prepare(
      `INSERT INTO setting_change (target, actor, level, scope, key, old_value, new_value, changed_at)
       VALUES ('pack', ?, NULL, ?, ?, ?, ?, ?)`
    )
    for (const change of changes) {
      const info = insert.run(SITE_ACTOR, id, change.key, change.oldValue, change.newValue, at)
      rowIds.push(Number(info.lastInsertRowid))
    }
  })

  try {
    loadPack(dir, 'data')
  } catch {
    writeFileSync(tmpPath, oldBytes)
    renameSync(tmpPath, cardPath)
    deps.storage.tx((db) => {
      const remove = db.prepare('DELETE FROM setting_change WHERE id = ?')
      for (const rowId of rowIds) remove.run(rowId)
    })
    return { status: 400, body: { error: 'invalid_footer' } }
  }

  return { status: 200, body: { id, toolFooter: nextCard.toolFooter ?? {}, changed: true } }
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
    return writeCharacterFooter(deps, id, body)
  }
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
  if (changed) deps.onWrite?.()
  return { status: 200, body: { chatId, status: parsed.data.status, changed } }
}
