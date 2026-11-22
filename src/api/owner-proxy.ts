import { type IncomingMessage, type ServerResponse, request as upstreamRequest } from 'node:http'
import { dirname, join } from 'node:path'
import { hostAllowed, originAllowed } from './writes.js'

/** Forward owner API traffic to the configured host service. Its token check still applies. */
export function proxyOwnerApi(
  req: IncomingMessage,
  res: ServerResponse,
  target: string | undefined,
  origins: readonly string[],
  socketPath?: string
) {
  const fail = (status: number, error: string) => {
    if (res.headersSent) res.destroy()
    else
      res
        .writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        .end(JSON.stringify({ error }))
  }
  if (!target && !socketPath) return fail(503, 'owner_service_unconfigured')
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname.slice('/owner-api/'.length)
  if (!/^[a-z_]+(?:\/[a-z_]+)*$/.test(path) || url.searchParams.has('token')) return fail(400, 'invalid_owner_route')
  if (!['GET', 'POST'].includes(req.method ?? '')) return fail(405, 'method_not_allowed')
  if (!hostAllowed(req.headers.host) || !originAllowed(req.headers.origin, origins, req.headers.host))
    return fail(403, 'origin_refused')
  const headers: Record<string, string> = {}
  for (const name of ['accept', 'content-type', 'content-length', 'x-tolongai-token']) {
    const value = req.headers[name]
    if (typeof value === 'string') headers[name] = value
  }
  const upstream = upstreamRequest(
    new URL('/api/' + path + url.search, target ?? 'http://owner.internal'),
    {
      method: req.method,
      headers,
      socketPath:
        socketPath && path === 'settings/models_probe' ? join(dirname(socketPath), 'model-probe.sock') : socketPath,
      signal: AbortSignal.timeout(120_000)
    },
    (reply) => {
      const outgoing: Record<string, string> = {
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer'
      }
      for (const name of ['content-type', 'content-length', 'content-disposition']) {
        const value = reply.headers[name]
        if (typeof value === 'string') outgoing[name] = value
      }
      outgoing['content-security-policy'] = "default-src 'none'; sandbox"
      res.writeHead(reply.statusCode ?? 502, outgoing)
      reply.on('error', () => res.destroy())
      reply.pipe(res)
    }
  )
  upstream.on('error', () => {
    if (!res.destroyed) fail(502, 'owner_service_unavailable')
  })
  res.on('close', () => upstream.destroy())
  req.pipe(upstream)
}
