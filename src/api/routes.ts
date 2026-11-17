import type { PackSet } from '../character/loader.js'
import { listChatItems } from '../memory/store.js'
import { buildReport, newestSnapshotFile } from '../records/report.js'
import { listChats } from '../settings/chats.js'
import { resolveSettings } from '../settings/settings.js'
import type { Storage } from '../storage/database.js'
import type { DataPaths } from '../storage/startup.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { ToolMode } from '../tools/types.js'

// Read handlers for the core's site API (docs/trd/site.md#read-routes).
// All reads go through storage.read or the verified snapshot/archive report. Nothing here writes.

export interface RoleHealth {
  configured: boolean
  breakerOpen: boolean
}

export interface SiteApiDeps {
  /** Runs after a write that changed something, such as rewriting the gateway's chat flags. */
  onWrite?: () => void
  registry: ToolRegistry
  storage: Storage
  /** The character packs as they load now. */
  packs: () => PackSet
  paths: DataPaths
  version: string
  ready: () => boolean
  activeTurns: () => number
  roles: () => {
    main: RoleHealth
    fallback: RoleHealth
    judge: RoleHealth
    media: RoleHealth
  }
  now?: () => Date
}

export interface RouteResult {
  status: number
  body: unknown
}

const DEFAULT_TURNS_LIMIT = 50
const MAX_TURNS_LIMIT = 200
const REPORT_WINDOW_MS = 7 * 86_400_000
const ISO_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

function ok(body: unknown): RouteResult {
  return { status: 200, body }
}

function error(status: number, code: string): RouteResult {
  return { status, body: { error: code } }
}

function handleHealth(deps: SiteApiDeps): RouteResult {
  return ok({
    status: deps.ready() ? 'ready' : 'starting',
    version: deps.version,
    activeTurns: deps.activeTurns(),
    roles: deps.roles()
  })
}

function handleChats(deps: SiteApiDeps): RouteResult {
  const chats = listChats(deps.storage).map((chat) => ({
    ...chat,
    settings: resolveSettings(deps.storage, chat)
  }))
  return ok({ chats })
}

function handleTools(deps: SiteApiDeps): RouteResult {
  const features = new Map<string, { name: string; mode: ToolMode; commands: string[] }[]>()
  for (const tool of deps.registry.all()) {
    if (!tool.feature) continue
    const tools = features.get(tool.feature) ?? []
    tools.push({
      name: tool.name,
      mode: tool.mode,
      commands: tool.command?.names.map((name) => `/${name}`) ?? []
    })
    features.set(tool.feature, tools)
  }
  return ok({ features: [...features].map(([key, tools]) => ({ key, tools })) })
}

function handleSettings(deps: SiteApiDeps, params: URLSearchParams): RouteResult {
  const level = params.get('level')
  const scope = params.get('scope') ?? ''
  if (level !== 'global' && level !== 'type' && level !== 'chat') {
    return error(400, 'invalid_level')
  }
  if (level === 'global' && scope !== '') {
    return error(400, 'invalid_scope')
  }
  if (level === 'type' && scope !== 'dm' && scope !== 'group') {
    return error(400, 'invalid_scope')
  }
  if (level === 'chat' && scope === '') {
    return error(400, 'invalid_scope')
  }

  const rows = deps.storage.read(
    (db) =>
      db.prepare('SELECT key, value FROM setting WHERE level = ? AND scope = ? ORDER BY key').all(level, scope) as {
        key: string
        value: string
      }[]
  )
  const values: Record<string, unknown> = {}
  for (const row of rows) {
    values[row.key] = JSON.parse(row.value)
  }
  return ok({ level, scope, values })
}

function parseLimit(raw: string | null): number | undefined {
  if (raw === null || raw === '') return DEFAULT_TURNS_LIMIT
  if (!/^\d+$/.test(raw)) return undefined
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TURNS_LIMIT) return undefined
  return value
}

function handleTurns(deps: SiteApiDeps, params: URLSearchParams): RouteResult {
  const limit = parseLimit(params.get('limit'))
  if (limit === undefined) return error(400, 'invalid_limit')

  const chat = params.get('chat')
  const beforeRaw = params.get('before')
  let beforeIso: string | undefined
  if (beforeRaw !== null && beforeRaw !== '') {
    if (!ISO_TIME_PATTERN.test(beforeRaw) || Number.isNaN(Date.parse(beforeRaw))) {
      return error(400, 'invalid_before')
    }
    beforeIso = new Date(beforeRaw).toISOString()
  }

  const conditions: string[] = []
  const args: unknown[] = []
  if (chat !== null && chat !== '') {
    conditions.push('chat_id = ?')
    args.push(chat)
  }
  if (beforeIso !== undefined) {
    conditions.push('received_at < ?')
    args.push(beforeIso)
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  args.push(limit)

  const turns = deps.storage.read(
    (db) =>
      db.prepare(`SELECT * FROM turn ${where} ORDER BY received_at DESC, rowid DESC LIMIT ?`).all(...args) as Record<
        string,
        unknown
      >[]
  )
  return ok({ turns })
}

function handleTurnById(deps: SiteApiDeps, rawId: string): RouteResult {
  let turnId: string
  try {
    turnId = decodeURIComponent(rawId)
  } catch {
    return error(400, 'invalid_turn_id')
  }

  const data = deps.storage.read((db) => {
    const turn = db.prepare('SELECT * FROM turn WHERE turn_id = ?').get(turnId) as Record<string, unknown> | undefined
    if (!turn) return undefined
    const modelCalls = db.prepare('SELECT * FROM model_call WHERE turn_id = ? ORDER BY id').all(turnId) as Record<
      string,
      unknown
    >[]
    const toolCalls = db.prepare('SELECT * FROM tool_call WHERE turn_id = ? ORDER BY id').all(turnId) as Record<
      string,
      unknown
    >[]
    const failureRows = db
      .prepare('SELECT stage, kind, handled_by, created_at FROM failure WHERE turn_id = ? ORDER BY id')
      .all(turnId) as { stage: string; kind: string; handled_by: string | null; created_at: string }[]
    const failures = failureRows.map((row) => ({
      stage: row.stage,
      kind: row.kind,
      handledBy: row.handled_by,
      createdAt: row.created_at
    }))
    return { turn, modelCalls, toolCalls, failures }
  })

  if (!data) return error(404, 'not_found')
  return ok(data)
}

async function handleReport(deps: SiteApiDeps): Promise<RouteResult> {
  const snapshotFile = newestSnapshotFile(deps.paths.snapshots)
  if (!snapshotFile) return error(404, 'no_snapshot')

  const toDate = (deps.now ?? (() => new Date()))()
  const fromDate = new Date(toDate.getTime() - REPORT_WINDOW_MS)
  const report = await buildReport({
    snapshotFile,
    archiveDir: deps.paths.archive,
    from: fromDate.toISOString(),
    to: toDate.toISOString()
  })
  return ok(report)
}

function handleMemory(deps: SiteApiDeps, params: URLSearchParams): RouteResult {
  const chatId = params.get('chat')
  if (!chatId) return error(400, 'chat_required')

  const items = listChatItems(deps.storage, chatId)
  return ok({ items })
}

function handleCharacters(deps: SiteApiDeps): RouteResult {
  const set = deps.packs()
  const characters = [...set.packs.values()]
    .map((pack) => ({
      id: pack.id,
      displayName: pack.card.displayName,
      source: pack.source,
      languages: pack.card.languages
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
  const faults = set.faults.map((fault) => ({ id: fault.id, reason: fault.message }))
  return ok({ characters, faults })
}

const TURN_BY_ID = /^\/api\/turns\/([^/]+)$/
const STATIC_ROUTES = new Set([
  '/api/health',
  '/api/chats',
  '/api/tools',
  '/api/settings',
  '/api/turns',
  '/api/report',
  '/api/memory',
  '/api/characters'
])

export function isKnownRoute(pathname: string): boolean {
  return STATIC_ROUTES.has(pathname) || TURN_BY_ID.test(pathname)
}

export async function dispatchGet(deps: SiteApiDeps, url: URL): Promise<RouteResult> {
  const path = url.pathname
  if (path === '/api/health') return handleHealth(deps)
  if (path === '/api/chats') return handleChats(deps)
  if (path === '/api/tools') return handleTools(deps)
  if (path === '/api/settings') return handleSettings(deps, url.searchParams)
  if (path === '/api/turns') return handleTurns(deps, url.searchParams)
  const turnMatch = TURN_BY_ID.exec(path)
  if (turnMatch?.[1] !== undefined) return handleTurnById(deps, turnMatch[1])
  if (path === '/api/report') return handleReport(deps)
  if (path === '/api/memory') return handleMemory(deps, url.searchParams)
  if (path === '/api/characters') return handleCharacters(deps)
  return error(404, 'not_found')
}
