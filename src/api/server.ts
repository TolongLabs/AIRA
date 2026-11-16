import { timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import { extname, resolve, sep } from 'node:path'
import type { Logger } from '../records/logger.js'
import { type SiteApiDeps, dispatchGet, isKnownRoute } from './routes.js'
import { type SiteWriteDeps, dispatchWrite, hostAllowed, isWriteRoute, originAllowed } from './writes.js'

// The core's private HTTP API for the owner site (docs/trd/site.md#serving-the-api).

export interface SiteApiServerOptions extends SiteWriteDeps {
  token: string
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

function tokenMatches(authorization: string | undefined, expected: Buffer): boolean {
  if (authorization === undefined || !authorization.startsWith('Bearer ')) return false
  const provided = Buffer.from(authorization.slice(7), 'utf8')
  if (provided.length !== expected.length) return false
  return timingSafeEqual(provided, expected)
}

export function createSiteApiServer(options: SiteApiServerOptions): Server {
  const log = options.logger.child({ module: 'site_api' })
  const expectedToken = Buffer.from(options.token, 'utf8')

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = (request.url ?? '/').split('?')[0] ?? '/'
    if (!path.startsWith('/api/')) {
      await serveSite(path, request.method, response)
      return
    }

    if (!tokenMatches(request.headers.authorization, expectedToken)) {
      json(response, 401, { error: 'unauthorized' })
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
      if (result.status === 200) log.info('site_api.write', { route: 'chat_status' })
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
