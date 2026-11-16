import { readFileSync } from 'node:fs'
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type SimBackend, SimInputError } from './backend.js'
import { findPhoto, findSticker } from './stickers.js'

// The preview's HTTP side (docs/trd/harness.md#chat-preview): one page and a small JSON API over a backend. It binds
// the loopback address only, and refuses a request that did not come from a page it served.

export interface SimServer {
  url: string
  port: number
  close(): Promise<void>
}

const PAGE = fileURLToPath(new URL('./preview.html', import.meta.url))
const MAX_BODY_BYTES = 64 * 1024
const IMAGE_TYPES: Record<string, string> = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif'
}
const CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; " +
  "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

function json(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return
  response
    .writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    .end(JSON.stringify(body))
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json(\s*;|$)/i.test(request.headers['content-type'] ?? '')) {
    throw new SimInputError('send JSON with content-type application/json', 415)
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) throw new SimInputError('the request body is too large', 413)
    chunks.push(chunk as Buffer)
  }
  try {
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>
  } catch {
    // Falls through to the error below.
  }
  throw new SimInputError('the request body is not a JSON object')
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

export async function startSimServer(backend: SimBackend, options: { port?: number } = {}): Promise<SimServer> {
  const page = readFileSync(PAGE)
  let port = 0

  /** Only a page served from this address may call it: this stops another site from driving the sim. */
  const sameOrigin = (request: IncomingMessage): boolean => {
    const host = request.headers.host ?? ''
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false
    const origin = request.headers.origin
    return origin === undefined || origin === `http://${host}`
  }

  const image = (response: ServerResponse, path: string | undefined): void => {
    if (!path) {
      json(response, 404, { error: 'not found' })
      return
    }
    response.writeHead(200, {
      'content-type': IMAGE_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'max-age=60',
      'x-content-type-options': 'nosniff'
    })
    response.end(readFileSync(path))
  }

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const method = request.method ?? 'GET'
    const segments = url.pathname.split('/').filter((part) => part !== '')
    const decode = (value: string | undefined): string => {
      try {
        return decodeURIComponent(value ?? '')
      } catch {
        return ''
      }
    }

    if (method === 'GET' && url.pathname === '/') {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy': CSP
      })
      response.end(page)
      return
    }

    if (segments[0] === 'sticker' && segments.length === 3 && method === 'GET') {
      const roots = backend.stickerRoots
      return image(response, roots ? findSticker(roots, decode(segments[1]), decode(segments[2])) : undefined)
    }
    if (segments[0] === 'photo' && segments.length === 3 && method === 'GET' && backend.stickerRoots) {
      return image(response, findPhoto(backend.stickerRoots.dataDir, `${decode(segments[1])}/${decode(segments[2])}`))
    }
    if (segments[0] === 'file' && segments.length === 2 && method === 'GET' && backend.file) {
      const seq = Number(segments[1])
      const file = Number.isInteger(seq) ? await backend.file(seq) : undefined
      if (!file) return json(response, 404, { error: 'not found' })
      response.writeHead(200, { 'content-type': file.type, 'x-content-type-options': 'nosniff' })
      response.end(file.body)
      return
    }

    if (segments[0] !== 'api') return json(response, 404, { error: 'not found' })

    if (method === 'GET' && segments[1] === 'info' && segments.length === 2) return json(response, 200, backend.info())

    if (segments[1] === 'chats' && segments.length === 4) {
      const chatId = decode(segments[2])
      const action = segments[3]
      if (method === 'GET' && action === 'messages') {
        const after = Number(url.searchParams.get('after') ?? '0')
        return json(response, 200, await backend.messages(chatId, Number.isFinite(after) ? after : 0))
      }
      if (method === 'POST' && action === 'send') {
        const body = await readJson(request)
        const result = await backend.send(chatId, {
          sender: str(body['sender']),
          text: str(body['text']),
          mention: body['mention'] === true,
          ...(str(body['replyTo']) !== '' ? { replyTo: str(body['replyTo']) } : {})
        })
        // `wait` is for scripts and tests: answer after the turn, with everything it drew.
        if (body['wait'] === true) {
          await result.done
          const after = await backend.messages(chatId, result.message.rev - 1)
          return json(response, 200, { message: result.message, addressed: result.addressed, ...after })
        }
        return json(response, 200, { message: result.message, addressed: result.addressed })
      }
      if (method === 'POST' && action === 'reset') {
        if (!backend.reset) throw new SimInputError('this level cannot start a chat again', 404)
        return json(response, 200, { chat: backend.reset(chatId) })
      }
      if (method === 'POST' && action === 'free-response') {
        if (!backend.setFreeResponse) throw new SimInputError('this level does not own the setting', 404)
        const body = await readJson(request)
        backend.setFreeResponse(chatId, body['value'] === true)
        return json(response, 200, { ok: true })
      }
    }

    if (method === 'GET' && segments[1] === 'turn' && segments.length === 3 && backend.turn) {
      const panel = backend.turn(decode(segments[2]))
      return json(response, panel ? 200 : 404, panel ?? { error: 'no such turn' })
    }

    json(response, 404, { error: 'not found' })
  }

  const server: Server = createServer((request, response) => {
    if (!sameOrigin(request)) {
      json(response, 403, { error: 'this page answers requests from itself only' })
      return
    }
    route(request, response).catch((error: unknown) => {
      if (error instanceof SimInputError) return json(response, error.status, { error: error.message })
      json(response, 500, { error: error instanceof Error ? error.message : String(error) })
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, '127.0.0.1', () => resolve())
  })
  port = (server.address() as AddressInfo).port

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}
