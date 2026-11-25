import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, resolve, sep } from 'node:path'
import { z } from 'zod'
import type { InstallationMode } from '../config/installation-mode.js'
import { verifyStandaloneOwnerToken } from '../config/standalone-owner.js'
import type { Logger } from '../records/logger.js'
import {
  createDashboardDiagnostics,
  type DashboardReason,
  type DashboardRoute,
  normalizeMethod,
  normalizeRoute
} from './dashboard-diagnostics.js'
import { chatSenders, inboundActivity, profileImage } from './dashboard-media.js'
import { authorizeOwner } from './owner-auth.js'
import { changeOwnerJob, ownerCronTransport } from './owner-cron.js'
import { changeOwnerMarkets } from './owner-markets.js'
import { handleOwnerMessageGet, handleOwnerMessagePost, isOwnerMessagePost, ownerMessageIdOf } from './owner-message.js'
import { proxyOwnerApi } from './owner-proxy.js'
import { dispatchGet, isKnownRoute, type SiteApiDeps } from './routes.js'
import { handleStudioExpressions } from './studio-expression-routes.js'
import {
  createStudioPack,
  getProfileDocuments,
  getStudioPack,
  StudioPackError,
  studioExpressionStore,
  updateStudioPack
} from './studio-packs.js'
import { dispatchWrite, hostAllowed, isWriteRoute, originAllowed } from './writes.js'

// The core's private HTTP API for the owner site (docs/trd/site.md#serving-the-api).

export interface SiteApiServerOptions extends SiteApiDeps {
  deploymentSettings?: (
    roles: ReturnType<SiteApiDeps['roles']>
  ) => import('../config/dashboard-types.js').DeploymentSettings
  marketsPath?: string
  ownerApiSocket?: string
  ownerApiOrigin?: string
  logger: Logger
  /** `site.allowedOrigins` */
  dashboardEntry?: boolean
  /** Standalone authority. In standalone the dashboard entry is forced and auth is local-only. */
  installationMode?: InstallationMode
  /** The local owner secret, loaded once at start-up. Required in standalone. */
  standaloneOwnerToken?: string
  allowedOrigins: readonly string[]
  /** The built site, served under /app/ (docs/trd/site.md#serving-the-site). Absent: no pages are served. */
  siteDir?: string
  /** Deployment activation readback (docs/trd/dashboard-state.md#deployment-activation-readback). */
  configStatus?: () => import('../config/status.js').ConfigStatusSnapshot
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
}

const entryAliases = new Map(
  Object.entries({
    '/': '/overview',
    '/app': '/overview',
    '/app/': '/overview',
    '/app/index.html': '/overview',
    '/app/chats.html': '/chats',
    '/app/send.html': '/chats/files',
    '/app/library.html': '/library',
    '/app/graph.html': '/library/graph',
    '/app/markets.html': '/markets',
    '/app/settings.html': '/system/settings',
    '/app/cron.html': '/automations/routines',
    '/app/notices.html': '/automations/notices'
  })
)

function dashboardPage(raw: string): boolean {
  try {
    const path = decodeURIComponent(raw)
    if (/^\/library\/item\/[^/]{1,2048}$/.test(raw)) return true
    // Encoded characters are valid only inside opaque record IDs.
    if (path !== raw && !raw.startsWith('/automations/routines/')) return false
    return /^\/(?:overview|chats(?:\/(?:files|defaults|c_[a-zA-Z0-9_-]+\/(?:settings|send)))?|characters(?:\/(?:new|import|simulator|[a-z0-9_-]+\/(?:edit|footer)))?|library(?:\/(?:graph|costs))?|automations(?:\/(?:routines(?:\/[a-zA-Z0-9_:.-]{1,160})?|notices))?|markets(?:\/(?:watchlist|alerts|news))?|system(?:\/(?:health|settings|appearance))?)$/.test(
      path
    )
  } catch {
    return false
  }
}

/** One file of the build, or undefined. A path that leaves the build folder is never read. */
async function siteFile(siteDir: string, pathname: string): Promise<{ body: Buffer; type: string } | undefined> {
  let relative: string
  try {
    relative = decodeURIComponent(pathname.slice('/app/'.length))
  } catch {
    return undefined
  }
  if (pathname.startsWith('/app/preview/') && dashboardPage(pathname.slice('/app/preview'.length)))
    relative = 'preview.html'
  if (relative === '' || relative.endsWith('/')) relative += 'index.html'
  const root = resolve(siteDir)
  const file = resolve(root, relative)
  if (!file.startsWith(root + sep)) return undefined
  const type = TYPES[extname(file).toLowerCase()]
  if (!type) return undefined
  try {
    return { body: await readFile(file), type }
  } catch {
    return undefined
  }
}

const MAX_BODY_BYTES = 16 * 1024

/** The JSON body, or a reason code. Reads at most MAX_BODY_BYTES. */
async function readJson(
  request: IncomingMessage,
  limit = MAX_BODY_BYTES
): Promise<{ body: unknown } | { error: string; status: number }> {
  const type = request.headers['content-type'] ?? ''
  if (!/^application\/json(\s*;|$)/i.test(type)) return { status: 415, error: 'unsupported_media_type' }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += (chunk as Buffer).length
    if (size > limit) return { status: 413, error: 'body_too_large' }
    chunks.push(chunk as Buffer)
  }
  try {
    return { body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  } catch {
    return { status: 400, error: 'invalid_json' }
  }
}

const studioDocument = z.record(z.string(), z.unknown())
const studioDocuments = z.strictObject({ card: studioDocument, moods: studioDocument, lines: studioDocument })
const studioCreate = z.union([
  studioDocuments.extend({ id: z.string() }),
  z.strictObject({ id: z.string(), sourceId: z.string() })
])
const studioChange = z.strictObject({
  expectedRevision: z.string().regex(/^[0-9a-f]{64}$/),
  patch: studioDocuments.partial()
})

async function serveStudio(
  options: SiteApiServerOptions,
  request: IncomingMessage,
  response: ServerResponse,
  id?: string
) {
  try {
    if (id && request.method === 'GET') {
      const documents = new URL(request.url ?? '/', 'http://localhost').searchParams.get('view') === 'documents'
      return json(response, 200, documents ? getProfileDocuments(options, id) : getStudioPack(options, id))
    }
    if (request.method !== (id ? 'PUT' : 'POST')) return json(response, 405, { error: 'method_not_allowed' })
    const data = await readJson(request, 768 * 1024)
    if ('error' in data) return json(response, data.status, { error: data.error })
    if (id) {
      const result = studioChange.safeParse(data.body)
      if (!result.success) return json(response, 400, { error: 'invalid_body' })
      const saved = updateStudioPack(options, id, {
        expectedRevision: result.data.expectedRevision,
        ...result.data.patch
      })
      if (saved.changed) options.onWrite?.()
      return json(response, 200, saved)
    }
    const result = studioCreate.safeParse(data.body)
    if (!result.success) return json(response, 400, { error: 'invalid_body' })
    const input = result.data
    const created = createStudioPack(
      options,
      'sourceId' in input ? { sourceId: input.sourceId, newId: input.id } : input
    )
    options.onWrite?.()
    return json(response, 201, created)
  } catch (error) {
    if (error instanceof StudioPackError) return json(response, error.status, { error: error.code })
    throw error
  }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(body))
}

function writeRouteName(pathname: string): string {
  if (pathname === '/api/settings') return 'setting'
  if (pathname.startsWith('/api/characters/')) return 'character_footer'
  if (pathname.endsWith('/label')) return 'chat_label'
  return 'chat_status'
}

function diagnosticRoute(path: string): DashboardRoute {
  if (path === '/owner-api/messages') return 'owner_messages'
  if (path.startsWith('/owner-api/messages/')) return 'owner_message_by_id'
  if (path === '/owner-api/cron') return 'owner_cron'
  if (path === '/owner-api/settings/markets') return 'owner_markets'
  if (!path.startsWith('/owner-api/core/')) return 'owner_proxy'
  const parts = path.slice('/owner-api/core/'.length).split('/')
  if (parts.length === 1) return normalizeRoute(parts[0])
  if (parts[0] === 'characters') return parts[2] === 'footer' ? 'character_footer' : 'characters'
  if (parts[0] === 'chats')
    return parts[2] === 'status' ? 'chat_status' : parts[2] === 'label' ? 'chat_label' : 'unknown'
  return parts[0] === 'turns' ? 'turn_by_id' : parts[0] === 'feedback' ? 'feedback_by_id' : 'unknown'
}

const statusReasons: Record<number, DashboardReason> = {
  400: 'invalid_request',
  401: 'auth_missing',
  403: 'auth_failed',
  404: 'not_found',
  405: 'method_not_allowed',
  409: 'conflict',
  413: 'too_large',
  415: 'unsupported_media',
  428: 'revision_required',
  500: 'internal',
  502: 'unavailable',
  503: 'unavailable'
}

export function createSiteApiServer(options: SiteApiServerOptions): Server {
  const log = options.logger.child({ module: 'site_api' })

  const diagnostics = createDashboardDiagnostics({ logger: log, buildId: process.env.AIRA_BUILD_SHA ?? 'unknown' })
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let target = request.url ?? '/'
    if (target.startsWith('/owner-api/')) {
      const active = diagnostics.begin(diagnosticRoute(target.split('?')[0] ?? ''), normalizeMethod(request.method))
      response.setHeader('x-request-id', active.requestId)
      response.setHeader('cache-control', 'no-store')
      response.once('finish', () =>
        diagnostics.finish(active, {
          status: response.statusCode,
          reason: statusReasons[response.statusCode] ?? (response.statusCode < 400 ? 'ok' : 'unknown')
        })
      )
    }
    const standalone = options.installationMode === 'standalone'
    // Standalone always serves the dashboard entry (docs/trd/site.md#standalone-owner-authentication).
    const entry = standalone || options.dashboardEntry === true
    const dashboard = target.startsWith('/owner-api/core/')
    const protectedEntry = entry && (target.startsWith('/api/') || target.startsWith('/owner-api/'))
    if (dashboard || protectedEntry) {
      response.setHeader('cache-control', 'no-store')
      if (
        !hostAllowed(request.headers.host) ||
        !originAllowed(request.headers.origin, options.allowedOrigins, request.headers.host)
      )
        return json(response, 403, { error: 'origin_refused' })
      const token = request.headers['x-tolongai-token']
      if (typeof token !== 'string' || !token.trim()) return json(response, 401, { error: 'owner_token_required' })
      if (standalone) {
        // The local credential never leaves this check: no host fallback, no host request.
        if (!options.standaloneOwnerToken || !verifyStandaloneOwnerToken(options.standaloneOwnerToken, token))
          return json(response, 401, { error: 'owner_token_required' })
        // A valid local token grants the core prefix and the classic core API only. Host-owned
        // operations do not exist in standalone, so they fail here, before any proxy, send or cron path.
        if (!dashboard && target.startsWith('/owner-api/'))
          return json(response, 503, { error: 'capability_unavailable' })
      } else {
        if (!options.ownerApiOrigin && !options.ownerApiSocket)
          return json(response, 503, { error: 'owner_service_unconfigured' })
        const auth = await authorizeOwner(options, token)
        if (!auth.ok) return json(response, auth.status, { error: auth.code })
      }
      if (dashboard) target = '/api/' + target.slice('/owner-api/core/'.length)
    }
    const path = target.split('?')[0] ?? '/'
    if (dashboard) {
      if (path === '/api/activity') {
        if (request.method !== 'GET') return json(response, 405, { error: 'method_not_allowed' })
        return json(response, 200, inboundActivity(options))
      }
      const senders = /^\/api\/chats\/(c_[a-zA-Z0-9_-]+)\/senders$/.exec(path)
      if (senders) {
        if (request.method !== 'GET') return json(response, 405, { error: 'method_not_allowed' })
        const result = chatSenders(options, senders[1]!)
        return json(response, result.status, result.body)
      }
      const portrait = /^\/api\/(characters|chats)\/([a-zA-Z0-9_-]{1,128})\/profile-image$/.exec(path)
      if (portrait) {
        const data = request.method === 'PUT' ? await readJson(request, 5600000) : { body: undefined }
        if ('error' in data) return json(response, data.status, { error: data.error })
        const result = await profileImage(
          options,
          portrait[1] as 'characters' | 'chats',
          portrait[2]!,
          request.method ?? '',
          data.body
        )
        return json(response, result.status, result.body)
      }
      if (path === '/api/deployment-settings') {
        if (request.method !== 'GET') return json(response, 405, { error: 'method_not_allowed' })
        if (!options.deploymentSettings) return json(response, 503, { error: 'configuration_unavailable' })
        return json(response, 200, options.deploymentSettings(options.roles()))
      }
      if (path === '/api/config') {
        if (request.method !== 'GET') return json(response, 405, { error: 'method_not_allowed' })
        const snapshot =
          options.configStatus?.() ??
          (() => {
            const at = new Date().toISOString()
            return {
              appliedRevision: null,
              currentRevision: null,
              status: 'memory_only' as const,
              checkedAt: at,
              appliedAt: at
            }
          })()
        return json(response, 200, snapshot)
      }
      const expression = /^\/api\/characters\/([^/]+)\/expressions(?:\/([^/]+))?$/.exec(path)
      if (expression?.[1])
        return handleStudioExpressions(request, response, studioExpressionStore(options), {
          id: expression[1],
          name: expression[2]
        })
      const match = /^\/api\/characters\/([a-z0-9_-]+)\/studio$/.exec(path)
      if (match || (path === '/api/characters' && request.method === 'POST'))
        return serveStudio(options, request, response, match?.[1])
    }
    if (path === '/owner-api/messages' || path.startsWith('/owner-api/messages/')) {
      response.setHeader('cache-control', 'no-store')
      if (isOwnerMessagePost(path, request.method)) return handleOwnerMessagePost(request, response, options)
      const id = ownerMessageIdOf(path, request.method)
      if (id) return handleOwnerMessageGet(request, response, options, id)
      return json(response, 405, { error: 'method_not_allowed' })
    }
    if ((path === '/owner-api/cron' || path === '/owner-api/settings/markets') && request.method === 'POST') {
      if (
        !hostAllowed(request.headers.host) ||
        !originAllowed(request.headers.origin, options.allowedOrigins, request.headers.host)
      )
        return json(response, 403, { error: 'origin_refused' })
      if (!options.ownerApiSocket && !options.ownerApiOrigin)
        return json(response, 503, { error: 'owner_service_unconfigured' })
      const body = await readJson(request)
      if ('error' in body) return json(response, body.status, { error: body.error })
      const token = request.headers['x-tolongai-token']
      if (typeof token !== 'string' || !token.trim()) return json(response, 401, { error: 'Owner token required' })
      try {
        const authorize = ownerCronTransport(
          options.ownerApiOrigin ?? 'http://owner.internal',
          options.ownerApiSocket,
          token,
          '/api/settings'
        )
        const check = await authorize()
        if (check.status !== 200) return json(response, check.status, check.body)
        if (!check.body.markets || typeof check.body.markets !== 'object' || Array.isArray(check.body.markets))
          return json(response, 502, { error: 'Invalid owner settings response' })
        if (path.endsWith('/markets')) {
          if (!options.marketsPath || !check.body.markets)
            return json(response, 503, { error: 'Market settings unavailable' })
          const result = changeOwnerMarkets(options.marketsPath, body.body)
          return json(response, result.status, result.body)
        }
        const call = ownerCronTransport(
          options.ownerApiOrigin ?? 'http://owner.internal',
          options.ownerApiSocket,
          typeof token === 'string' ? token : ''
        )
        const result = await changeOwnerJob(options.storage, body.body, call)
        return json(response, result.status, result.body)
      } catch {
        return json(response, 502, { error: 'Owner request interrupted. Reload to check the saved state.' })
      }
    }
    if (path.startsWith('/owner-api/'))
      return proxyOwnerApi(request, response, options.ownerApiOrigin, options.allowedOrigins, options.ownerApiSocket)
    if (!path.startsWith('/api/')) {
      await serveSite(path, request.method, response, target.slice(path.length))
      return
    }

    let url: URL
    try {
      url = new URL(target, 'http://localhost')
    } catch {
      json(response, 400, { error: 'bad_request' })
      return
    }

    if (request.method !== 'GET' && isWriteRoute(url.pathname)) {
      if (!hostAllowed(request.headers.host)) {
        json(response, 403, { error: 'host_refused' })
        return
      }
      if (!originAllowed(request.headers.origin, options.allowedOrigins, request.headers.host)) {
        json(response, 403, { error: 'origin_refused' })
        return
      }
      const read = await readJson(request)
      if ('error' in read) {
        json(response, read.status, { error: read.error })
        return
      }
      if (
        dashboard &&
        url.pathname === '/api/settings' &&
        (!read.body || typeof read.body !== 'object' || !('expectedRevision' in read.body))
      )
        return json(response, 428, { error: 'revision_required' })
      if (
        dashboard &&
        /^\/api\/characters\/[^/]+\/footer$/.test(url.pathname) &&
        (!read.body || typeof read.body !== 'object' || !('expectedRevision' in read.body))
      )
        return json(response, 428, { error: 'revision_required' })
      const result = dispatchWrite(options, request.method ?? '', url.pathname, read.body)
      if (result.status === 200) log.info('site_api.write', { route: writeRouteName(url.pathname) })
      json(response, result.status, result.body)
      return
    }

    if (!isKnownRoute(url.pathname)) {
      json(response, 404, { error: 'not_found' })
      return
    }

    if (request.method !== 'GET') {
      json(response, 405, { error: 'method_not_allowed' })
      return
    }

    const result = await dispatchGet(options, url, dashboard)
    json(response, result.status, result.body)
  }

  async function serveSite(
    path: string,
    method: string | undefined,
    response: ServerResponse,
    query: string
  ): Promise<void> {
    if (method !== 'GET' && method !== 'HEAD') {
      json(response, 405, { error: 'method_not_allowed' })
      return
    }
    if (options.siteDir && options.dashboardEntry) {
      const redirect = entryAliases.get(path)
      if (redirect) {
        response.writeHead(302, { location: redirect + query, 'cache-control': 'no-store' }).end()
        return
      }
      if (dashboardPage(path)) path = '/app/preview.html'
    }
    if (path === '/' && options.siteDir) {
      response.writeHead(302, { location: '/app/' }).end()
      return
    }
    const file = options.siteDir && path.startsWith('/app/') ? await siteFile(options.siteDir, path) : undefined
    if (!file) {
      json(response, 404, { error: 'not_found' })
      return
    }
    // Hashed assets never change; pages are checked again on every load.
    const cache = path.startsWith('/app/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'
    response.writeHead(200, {
      'content-type': file.type,
      'cache-control': cache,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer'
    })
    response.end(method === 'HEAD' ? undefined : file.body)
  }

  return createServer((request, response) => {
    void handle(request, response).catch(() => {
      log.error('site_api.error', { reason: 'internal', requestId: response.getHeader('x-request-id') })
      json(response, 500, { error: 'internal' })
    })
  })
}
