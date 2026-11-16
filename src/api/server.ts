import { timingSafeEqual } from 'node:crypto'
import { type Server, type ServerResponse, createServer } from 'node:http'
import type { Logger } from '../records/logger.js'
import { type SiteApiDeps, dispatchGet, isKnownRoute } from './routes.js'

// The core's private HTTP API for the owner site (docs/trd/site.md#serving-the-api).

export interface SiteApiServerOptions extends SiteApiDeps {
  token: string
  logger: Logger
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

  async function handle(
    method: string | undefined,
    rawUrl: string | undefined,
    authorization: string | undefined,
    response: ServerResponse
  ): Promise<void> {
    if (!tokenMatches(authorization, expectedToken)) {
      json(response, 401, { error: 'unauthorized' })
      return
    }

    let url: URL
    try {
      url = new URL(rawUrl ?? '/', 'http://localhost')
    } catch {
      json(response, 400, { error: 'bad_request' })
      return
    }

    if (!isKnownRoute(url.pathname)) {
      json(response, 404, { error: 'not_found' })
      return
    }

    if (method !== 'GET') {
      json(response, 405, { error: 'method_not_allowed' })
      return
    }

    const result = await dispatchGet(options, url)
    json(response, result.status, result.body)
  }

  return createServer((request, response) => {
    void handle(request.method, request.url, request.headers.authorization, response).catch((error: unknown) => {
      log.error('site_api.error', { error })
      json(response, 500, { error: 'internal' })
    })
  })
}
