import { readFileSync } from 'node:fs'
import type { PackSet } from '../character/loader.js'
import type { InstallationMode, StandaloneReadiness } from '../config/installation-mode.js'
import { readFeedback } from '../feedback/view.js'
import { DEFAULT_TOOL_LABELS, plainLabel } from '../format/footer.js'
import { listChatItems } from '../memory/store.js'
import { buildReport, newestSnapshotFile } from '../records/report.js'
import { displayNameFor, listChats } from '../settings/chats.js'
import { scopeSnapshot } from '../settings/settings.js'
import { type SocialMirrorSettings, socialCapabilities } from '../social/readers.js'
import type { Storage } from '../storage/database.js'
import type { DataPaths } from '../storage/startup.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { ToolMode } from '../tools/types.js'
import { hasPortrait } from './dashboard-media.js'
import { resolveOwnerTarget } from './owner-message.js'
import { getStudioFooter, StudioPackError } from './studio-packs.js'

// Read handlers for the core's site API (docs/trd/site.md#read-routes).
// All reads go through storage.read or the verified snapshot/archive report. Nothing here writes.

export interface RoleHealth {
  configured: boolean
  breakerOpen: boolean
}

export interface SiteApiDeps {
  /** Runs after a write that changed something, such as rewriting the gateway's chat flags. */
  onWrite?: () => void
  /** Optional read-only gateway channel directory JSON for fallback chat names. */
  channelDirectoryPath?: string
  /** Standalone authority. Only standalone answers the extended health shape. */
  installationMode?: InstallationMode
  standaloneReadiness?: () => StandaloneReadiness
  registry: ToolRegistry
  extractorAvailable?: boolean
  socialMirrors?: SocialMirrorSettings
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

const DEFAULT_CHANNEL_DIRECTORY_PATH = '/gateway/directory/channel_directory.json'
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

function readChannelDirectory(path: string): Map<string, string> {
  if (path === '') return new Map()
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      platforms?: { whatsapp?: unknown }
    }
    const entries = parsed?.platforms?.whatsapp
    if (!Array.isArray(entries)) return new Map()
    const names = new Map<string, string>()
    for (const entry of entries) {
      if (typeof entry !== 'object' || entry === null) continue
      const id = (entry as { id?: unknown }).id
      const name = (entry as { name?: unknown }).name
      if (typeof id === 'string' && id !== '' && typeof name === 'string') {
        const trimmed = name.trim()
        if (trimmed !== '') names.set(id, trimmed)
      }
    }
    return names
  } catch {
    return new Map()
  }
}

function handleHealth(deps: SiteApiDeps): RouteResult {
  const base = {
    status: deps.ready() ? 'ready' : 'starting',
    version: deps.version,
    activeTurns: deps.activeTurns(),
    roles: deps.roles()
  }
  // Standalone keeps the legacy envelope and adds its readiness shape
  // (docs/trd/site.md#standalone-owner-authentication). No success is invented:
  // configuration stays setup_required until the model store packet lands.
  if (deps.installationMode !== 'standalone') return ok(base)
  const readiness = deps.standaloneReadiness?.()
  return ok({
    ...base,
    schemaVersion: 1,
    installationMode: 'standalone',
    configuration: 'setup_required',
    chatbot: 'inactive',
    chatbotReason: 'model_setup_required',
    ...readiness,
    capabilities: {
      hostOwnerService: false,
      subscriptionRunner: false,
      fileBrowser: false,
      gatewayConnection: readiness?.hermes?.state === 'connected',
      scheduler: false
    }
  })
}

function handleChats(deps: SiteApiDeps, dashboard: boolean): RouteResult {
  const rawChats = listChats(deps.storage)
  const directory = rawChats.some((chat) => chat.label === '')
    ? readChannelDirectory(deps.channelDirectoryPath ?? DEFAULT_CHANNEL_DIRECTORY_PATH)
    : new Map<string, string>()
  const activity = deps.storage.read(
    (db) =>
      new Map(
        (
          db.prepare('SELECT chat_id, MAX(received_at) AS last_seen FROM inbound_message GROUP BY chat_id').all() as {
            chat_id: string
            last_seen: string
          }[]
        ).map((row) => [row.chat_id, row.last_seen])
      )
  )
  const chats = rawChats.map((chat) => {
    const label =
      chat.label ||
      directory.get(chat.waId) ||
      (chat.type === 'dm' ? displayNameFor(deps.storage, chat.waId) : undefined) ||
      ''
    const snapshot = deps.storage.read((db) => scopeSnapshot(db, 'chat', chat.chatId, chat.type))
    return {
      ...chat,
      ...(dashboard && hasPortrait(deps.paths.root, 'chats', chat.chatId) ? { hasPortrait: true } : {}),
      ...(dashboard ? { deliveryTarget: resolveOwnerTarget(deps.storage, chat.chatId) ?? null } : {}),
      storedLabel: chat.label,
      lastInboundAt: activity.get(chat.chatId) ?? null,
      label,
      settings: snapshot.effective,
      settingsRevision: snapshot.revision
    }
  })
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
  return ok({
    features: [...features].map(([key, tools]) => ({ key, tools })),
    socialCapabilities: socialCapabilities(deps.extractorAvailable ?? false, deps.socialMirrors)
  })
}

function handleSettings(deps: SiteApiDeps, params: URLSearchParams, dashboard: boolean): RouteResult {
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

  const snapshot = deps.storage.read((db) => scopeSnapshot(db, level, scope))
  return ok(dashboard ? { level, scope, ...snapshot } : { level, scope, values: snapshot.values })
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

export function footerKindsFor(registry: ToolRegistry): { kind: string; defaultLabel: string }[] {
  const kinds = new Set<string>(Object.keys(DEFAULT_TOOL_LABELS))
  for (const tool of registry.all()) {
    kinds.add(tool.name)
  }
  return [...kinds]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((kind) => ({ kind, defaultLabel: plainLabel(kind) }))
}

function handleCharacters(deps: SiteApiDeps, dashboard: boolean): RouteResult {
  const set = deps.packs()
  const characters = [...set.packs.values()]
    .map((pack) => ({
      id: pack.id,
      ...(dashboard && hasPortrait(deps.paths.root, 'characters', pack.id) ? { hasPortrait: true } : {}),
      displayName: pack.card.displayName,
      ...(pack.card.aliases ? { aliases: pack.card.aliases } : {}),
      source: pack.source,
      languages: pack.card.languages,
      toolFooter: pack.card.toolFooter ?? {}
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
  const faults = set.faults.map((fault) => ({ id: fault.id, reason: fault.message }))
  return ok({ characters, faults, footerKinds: footerKindsFor(deps.registry) })
}

function handleFooter(deps: SiteApiDeps, rawId: string): RouteResult {
  let id: string
  try {
    id = decodeURIComponent(rawId)
  } catch {
    return error(400, 'invalid_character_id')
  }
  try {
    const read = getStudioFooter(deps, id)
    return ok({ id: read.id, revision: read.revision, toolFooter: read.toolFooter })
  } catch (err) {
    if (err instanceof StudioPackError) {
      if (err.code === 'invalid_id') return error(404, 'not_found')
      if (err.code === 'not_found') return error(404, 'not_found')
      if (err.code === 'pack_unparseable') return error(409, 'pack_unparseable')
      return error(err.status, err.code)
    }
    throw err
  }
}

const TURN_BY_ID = /^\/api\/turns\/([^/]+)$/
const FEEDBACK_BY_ID = /^\/api\/feedback\/([^/]+)$/
const CHARACTER_FOOTER_GET = /^\/api\/characters\/([^/]+)\/footer$/
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
  return (
    STATIC_ROUTES.has(pathname) ||
    TURN_BY_ID.test(pathname) ||
    FEEDBACK_BY_ID.test(pathname) ||
    CHARACTER_FOOTER_GET.test(pathname)
  )
}

export async function dispatchGet(deps: SiteApiDeps, url: URL, dashboard = false): Promise<RouteResult> {
  const path = url.pathname
  if (path === '/api/health') return handleHealth(deps)
  if (path === '/api/chats') return handleChats(deps, dashboard)
  if (path === '/api/tools') return handleTools(deps)
  if (path === '/api/settings') return handleSettings(deps, url.searchParams, dashboard)
  if (path === '/api/turns') return handleTurns(deps, url.searchParams)
  const turnMatch = TURN_BY_ID.exec(path)
  if (turnMatch?.[1] !== undefined) return handleTurnById(deps, turnMatch[1])
  const feedbackMatch = FEEDBACK_BY_ID.exec(path)
  if (feedbackMatch?.[1] !== undefined) {
    let id: string
    try {
      id = decodeURIComponent(feedbackMatch[1])
    } catch {
      return error(400, 'invalid_report_id')
    }
    const view = deps.storage.read((db) => readFeedback(db, id))
    return view ? ok(view) : error(404, 'not_found')
  }
  if (path === '/api/report') return handleReport(deps)
  if (path === '/api/memory') return handleMemory(deps, url.searchParams)
  if (path === '/api/characters') return handleCharacters(deps, dashboard)
  const footerMatch = CHARACTER_FOOTER_GET.exec(path)
  if (footerMatch?.[1] !== undefined) return handleFooter(deps, footerMatch[1])
  return error(404, 'not_found')
}
