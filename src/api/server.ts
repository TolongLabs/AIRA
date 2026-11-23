import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, resolve, sep } from 'node:path'
import type { Logger } from '../records/logger.js'
import { changeOwnerJob, ownerCronTransport } from './owner-cron.js'
import { changeOwnerMarkets } from './owner-markets.js'
import { handleOwnerMessageGet, handleOwnerMessagePost, isOwnerMessagePost, ownerMessageIdOf } from './owner-message.js'
import { proxyOwnerApi } from './owner-proxy.js'
import { dispatchGet, isKnownRoute, type SiteApiDeps } from './routes.js'
import { dispatchWrite, hostAllowed, isWriteRoute, originAllowed } from './writes.js'

// The core's private HTTP API for the owner site (docs/trd/site.md#serving-the-api).

export interface SiteApiServerOptions extends SiteApiDeps {
  marketsPath?: string
  ownerApiSocket?: string
  ownerApiOrigin?: string
  logger: Logger
  /** `site.allowedOrigins` */
  allowedOrigins: readonly string[]
  /** The built site, served under /app/ (docs/trd/site.md#serving-the-site). Absent: no pages are served. */
  siteDir?: string
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

/** One file of the build, or undefined. A path that leaves the build folder is never read. */
async function siteFile(siteDir: string, pathname: string): Promise<{ body: Buffer; type: string } | undefined> {
  let relative: string
  try {
    relative = decodeURIComponent(pathname.slice('/app/'.length))
  } catch {
    return undefined
  }
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
async function readJson(request: IncomingMessage): Promise<{ body: unknown } | { error: string; status: number }> {
  const type = request.headers['content-type'] ?? ''
  if (!/^application\/json(\s*;|$)/i.test(type)) return { status: 415, error: 'unsupported_media_type' }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) return { status: 413, error: 'body_too_large' }
    chunks.push(chunk as Buffer)
  }
  try {
    return { body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  } catch {
    return { status: 400, error: 'invalid_json' }
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

export function createSiteApiServer(options: SiteApiServerOptions): Server {
  const log = options.logger.child({ module: 'site_api' })

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = (request.url ?? '/').split('?')[0] ?? '/'
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
      await serveSite(path, request.method, response)
      return
    }

    let url: URL
    try {
      url = new URL(request.url ?? '/', 'http://localhost')
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

    const result = await dispatchGet(options, url)
    json(response, result.status, result.body)
  }

  async function serveSite(path: string, method: string | undefined, response: ServerResponse): Promise<void> {
    if (method !== 'GET' && method !== 'HEAD') {
      json(response, 405, { error: 'method_not_allowed' })
      return
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
    void handle(request, response).catch((error: unknown) => {
      log.error('site_api.error', { error })
      json(response, 500, { error: 'internal' })
    })
  })
}
