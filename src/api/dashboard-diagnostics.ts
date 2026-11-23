import { randomUUID } from 'node:crypto'
import type { Logger } from '../records/logger.js'

// Bounded redacted owner HTTP diagnostics (AIRA #371).
// The listener maps its own pathname to a canonical route and passes only typed safe metadata here.
// This module never sees a raw URL, route params, secrets, bodies or prompts.

export const DASHBOARD_ROUTES = [
  'health',
  'chats',
  'tools',
  'settings',
  'turns',
  'turn_by_id',
  'feedback_by_id',
  'report',
  'memory',
  'characters',
  'character_footer',
  'chat_status',
  'chat_label',
  'config',
  'owner_messages',
  'owner_message_by_id',
  'owner_cron',
  'owner_markets',
  'owner_proxy',
  'site_page',
  'unknown'
] as const

export type DashboardRoute = (typeof DASHBOARD_ROUTES)[number]

export const DASHBOARD_REASONS = [
  'ok',
  'origin_refused',
  'host_refused',
  'auth_missing',
  'auth_failed',
  'unconfigured',
  'unavailable',
  'invalid_body',
  'invalid_request',
  'not_found',
  'method_not_allowed',
  'conflict',
  'revision_required',
  'too_large',
  'unsupported_media',
  'internal',
  'unknown'
] as const

export type DashboardReason = (typeof DASHBOARD_REASONS)[number]

export const DASHBOARD_METHODS = ['GET', 'POST', 'PUT', 'HEAD', 'OTHER'] as const

export type DashboardMethod = (typeof DASHBOARD_METHODS)[number]

export const DEFAULT_MAX_EVENTS_PER_INTERVAL = 50
export const DEFAULT_INTERVAL_MS = 60_000
export const UNKNOWN_BUILD_ID = 'unknown'

const BUILD_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/
const GENERATED_ID_PATTERN = /^[0-9a-f-]{8,64}$/i

export function isDashboardRoute(value: unknown): value is DashboardRoute {
  return typeof value === 'string' && (DASHBOARD_ROUTES as readonly string[]).includes(value)
}

export function normalizeRoute(value: unknown): DashboardRoute {
  return isDashboardRoute(value) ? value : 'unknown'
}

export function isDashboardReason(value: unknown): value is DashboardReason {
  return typeof value === 'string' && (DASHBOARD_REASONS as readonly string[]).includes(value)
}

export function normalizeReason(value: unknown): DashboardReason {
  return isDashboardReason(value) ? value : 'unknown'
}

export function normalizeMethod(value: unknown): DashboardMethod {
  return DASHBOARD_METHODS.find((method) => method === value) ?? 'OTHER'
}

export function normalizeBuildId(value: unknown): string {
  return typeof value === 'string' && BUILD_ID_PATTERN.test(value) ? value : UNKNOWN_BUILD_ID
}

export function normalizeStatus(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599 ? value : 500
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

export interface DashboardDiagnosticsOptions {
  logger: Logger
  buildId: string
  now?: () => Date
  generateId?: () => string
  maxEventsPerInterval?: number
  intervalMs?: number
}

export interface ActiveDashboardRequest {
  requestId: string
  route: DashboardRoute
  method: DashboardMethod
  startMs: number
  startedAt: string
}

export interface DashboardOutcome {
  status: number
  reason: DashboardReason
}

export interface DashboardDiagnostics {
  begin(route: DashboardRoute, method: DashboardMethod): ActiveDashboardRequest
  finish(active: ActiveDashboardRequest, outcome: DashboardOutcome): void
  stats(): { emitted: number; dropped: number }
}

/** Create the diagnostics hook. Uses a Logger child; one generated request id per begin call. */
export function createDashboardDiagnostics(options: DashboardDiagnosticsOptions): DashboardDiagnostics {
  const log = options.logger.child({ module: 'site_api' })
  const buildId = normalizeBuildId(options.buildId)
  const now = options.now ?? (() => new Date())
  const generateId = options.generateId ?? (() => randomUUID())
  const maxEvents = clampInt(options.maxEventsPerInterval, DEFAULT_MAX_EVENTS_PER_INTERVAL, 1, 500)
  const intervalMs = clampInt(options.intervalMs, DEFAULT_INTERVAL_MS, 1000, 600_000)

  let windowStartMs = now().getTime()
  let inWindow = 0
  let emitted = 0
  let dropped = 0

  function nextId(): string {
    try {
      const candidate = generateId()
      if (typeof candidate === 'string' && GENERATED_ID_PATTERN.test(candidate)) return candidate
    } catch {
      // Fall through to a generated UUID.
    }
    return randomUUID()
  }

  function begin(route: DashboardRoute, method: DashboardMethod): ActiveDashboardRequest {
    const at = now()
    return {
      requestId: nextId(),
      route: normalizeRoute(route),
      method: normalizeMethod(method),
      startMs: at.getTime(),
      startedAt: at.toISOString()
    }
  }

  function finish(active: ActiveDashboardRequest, outcome: DashboardOutcome): void {
    const status = normalizeStatus(outcome?.status)
    const reason = normalizeReason(outcome?.reason)
    const endMs = now().getTime()
    if (endMs - windowStartMs >= intervalMs) {
      windowStartMs = endMs
      inWindow = 0
    }
    if (inWindow >= maxEvents) {
      dropped += 1
      return
    }
    inWindow += 1
    emitted += 1
    const fields = {
      requestId: active.requestId,
      buildId,
      route: active.route,
      method: active.method,
      status,
      reason,
      latencyMs: Math.max(0, endMs - active.startMs),
      at: active.startedAt
    }
    if (status >= 500) log.error('dashboard.request', fields)
    else if (status >= 400) log.warn('dashboard.request', fields)
    else log.info('dashboard.request', fields)
  }

  function stats(): { emitted: number; dropped: number } {
    return { emitted, dropped }
  }

  return { begin, finish, stats }
}
