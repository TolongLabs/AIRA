import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { basename, extname, join, sep } from 'node:path'

export interface RecordedCall {
  seq: number
  at: string
  method: string
  route: string
  payload: unknown
  file?: { name: string; contentType: string; bytes: number; path: string }
  /** The id the bridge gave a sent message. Only `/send` and `/send-media` have one. */
  messageId?: string
}

export interface InboundMessage {
  chat: string
  sender: string
  senderName?: string
  text: string
  isGroup: boolean
  quoted?: { id: string; text: string; fromMe: boolean }
  mentionsBot?: boolean
  media?: { path: string; contentType: string }
}

export interface ChatInfo {
  id: string
  name: string
  isGroup: boolean
  members: { id: string; name: string }[]
}

export interface FakeBridgeOptions {
  chats?: ChatInfo[]
  /** Where copies of sent files are kept. */
  filesDir: string
  /**
   * Folders a `/send-media` file path may lie in, as the gateway's own media and the core's data folder. A path
   * outside them is recorded but never read, so a request cannot make the bridge copy and serve any file.
   */
  mediaRoots?: string[]
  now?: () => Date
}

export interface FakeBridge {
  /** Starts on 127.0.0.1 only. Port 0 picks a free port. Returns the base URL. */
  start(port?: number): Promise<string>
  stop(): Promise<void>
  /** Queues a message for the gateway's next poll. Returns the message id it was given. */
  inject(message: InboundMessage): string
  /** Every call the gateway made, in order. */
  calls(): RecordedCall[]
  /** The calls of one route. */
  callsTo(route: string): RecordedCall[]
  /** Forgets the recorded calls and the queued messages. */
  reset(): void
}

/** Image types the control file route serves under their own type. Any other file is served as plain bytes. */
const IMAGE_TYPES = new Set(['image/webp', 'image/png', 'image/jpeg', 'image/gif'])

interface QueuedInboundMessage {
  id: string
  chatId: string
  senderId: string
  senderName?: string
  body: string
  isGroup: boolean
  timestamp: number
  fromMe: false
  quotedMessage?: { id: string; body: string; fromMe: boolean }
  mentionsBot?: boolean
  media?: { path: string; mimetype: string }
}

const MIME_BY_EXT: Record<string, string> = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain'
}

function guessContentType(filePath: string): string {
  return MIME_BY_EXT[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function parseMultipart(
  req: IncomingMessage,
  rawBuffer: Buffer,
  filesDir: string,
  seq: number
): Promise<{ payload: Record<string, unknown>; file?: RecordedCall['file'] }> {
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(key, value)
    else if (Array.isArray(value)) headers.set(key, value.join(', '))
  }

  const webReq = new Request('http://127.0.0.1/send-media', {
    method: 'POST',
    headers,
    body: new Uint8Array(rawBuffer)
  })
  const form = await webReq.formData()
  const payload: Record<string, unknown> = {}
  let file: RecordedCall['file'] | undefined

  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') {
      payload[key] = value
    } else {
      const name = basename(value.name || 'upload')
      payload[key] = name
      const bytes = Buffer.from(await value.arrayBuffer())
      mkdirSync(filesDir, { recursive: true })
      const destPath = join(filesDir, `${seq}-${name}`)
      writeFileSync(destPath, bytes)
      file = {
        name,
        contentType: value.type || guessContentType(name),
        bytes: bytes.byteLength,
        path: destPath
      }
    }
  }

  return file ? { payload, file } : { payload }
}

/** The real path of a file under one of the roots, or undefined. Symlinks are resolved before the check. */
export function insideRoots(filePath: string, roots: readonly string[]): string | undefined {
  let real: string
  try {
    real = realpathSync(filePath)
  } catch {
    return undefined
  }
  for (const root of roots) {
    let base: string
    try {
      base = realpathSync(root)
    } catch {
      continue
    }
    if (real.startsWith(base.endsWith(sep) ? base : `${base}${sep}`)) return real
  }
  return undefined
}

function copyJsonMedia(
  payload: Record<string, unknown>,
  filesDir: string,
  seq: number,
  roots: readonly string[]
): RecordedCall['file'] | undefined {
  const raw = payload['filePath']
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  const filePath = insideRoots(raw, roots)
  if (filePath === undefined) return undefined
  const data = readFileSync(filePath)
  const name = basename(filePath)
  mkdirSync(filesDir, { recursive: true })
  const destPath = join(filesDir, `${seq}-${name}`)
  writeFileSync(destPath, data)
  const explicitType =
    typeof payload['contentType'] === 'string'
      ? payload['contentType']
      : typeof payload['mimetype'] === 'string'
        ? payload['mimetype']
        : undefined
  return {
    name,
    contentType: explicitType ?? guessContentType(filePath),
    bytes: data.byteLength,
    path: destPath
  }
}

export function createFakeBridge(options: FakeBridgeOptions): FakeBridge {
  const now = options.now ?? (() => new Date())
  const chats = options.chats ?? []
  const recorded: RecordedCall[] = []
  const queue: QueuedInboundMessage[] = []
  let server: Server | null = null
  let nextSeq = 0
  let inSeq = 0
  let outSeq = 0

  function inject(message: InboundMessage): string {
    const id = `sim-${++inSeq}`
    const item: QueuedInboundMessage = {
      id,
      chatId: message.chat,
      senderId: message.sender,
      ...(message.senderName !== undefined ? { senderName: message.senderName } : {}),
      body: message.text,
      isGroup: message.isGroup,
      timestamp: Math.floor(now().getTime() / 1000),
      fromMe: false,
      ...(message.quoted !== undefined
        ? {
            quotedMessage: {
              id: message.quoted.id,
              body: message.quoted.text,
              fromMe: message.quoted.fromMe
            }
          }
        : {}),
      ...(message.mentionsBot !== undefined ? { mentionsBot: message.mentionsBot } : {}),
      ...(message.media !== undefined
        ? {
            media: {
              path: message.media.path,
              mimetype: message.media.contentType
            }
          }
        : {})
    }
    queue.push(item)
    return id
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Loopback only, by name too: a page that rebinds its own name to 127.0.0.1 must not reach the control routes.
    if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d{1,5}$/.test(req.headers.host ?? '')) {
      sendJson(res, 403, { error: 'host_refused' })
      return
    }
    const method = (req.method ?? 'GET').toUpperCase()
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const route = url.pathname

    // The control reads (docs/trd/harness.md#fake-bridge) belong to the maintainer, not to the gateway: they are not
    // recorded, so a preview that polls them never shows up in the calls it is drawing.
    if (method === 'GET' && route === '/control/calls') {
      const after = Number(url.searchParams.get('after') ?? '0')
      const since = Number.isFinite(after) ? after : 0
      sendJson(res, 200, { calls: recorded.filter((call) => call.seq > since), last: nextSeq })
      return
    }
    if (method === 'GET' && route.startsWith('/control/file/')) {
      const wanted = Number(route.slice('/control/file/'.length))
      const file = recorded.find((call) => call.seq === wanted)?.file
      if (!file) {
        sendJson(res, 404, { error: 'no such file' })
        return
      }
      const type = IMAGE_TYPES.has(file.contentType) ? file.contentType : 'application/octet-stream'
      res.writeHead(200, { 'content-type': type, 'x-content-type-options': 'nosniff' })
      res.end(readFileSync(file.path))
      return
    }

    const seq = ++nextSeq
    const at = now().toISOString()
    const rawBuffer = await readBody(req)
    const contentType = (req.headers['content-type'] ?? '').toLowerCase()

    let payload: unknown
    let file: RecordedCall['file'] | undefined

    if (route === '/send-media' && method === 'POST' && contentType.includes('multipart/form-data')) {
      const parsed = await parseMultipart(req, rawBuffer, options.filesDir, seq)
      payload = parsed.payload
      file = parsed.file
    } else if (rawBuffer.length > 0) {
      const rawText = rawBuffer.toString('utf8')
      try {
        payload = JSON.parse(rawText)
      } catch {
        recorded.push({ seq, at, method, route, payload: rawText })
        sendJson(res, 400, { error: 'invalid JSON' })
        return
      }
      if (route === '/send-media' && method === 'POST' && payload && typeof payload === 'object') {
        file = copyJsonMedia(payload as Record<string, unknown>, options.filesDir, seq, options.mediaRoots ?? [])
      }
    }

    const sendsMessage = method === 'POST' && (route === '/send' || route === '/send-media')
    const messageId = sendsMessage ? `out-${++outSeq}` : undefined
    const call: RecordedCall = {
      seq,
      at,
      method,
      route,
      payload,
      ...(file ? { file } : {}),
      ...(messageId !== undefined ? { messageId } : {})
    }
    recorded.push(call)

    if (method === 'GET' && route === '/health') {
      sendJson(res, 200, { status: 'connected' })
      return
    }
    if (method === 'GET' && route === '/messages') {
      const drained = queue.splice(0, queue.length)
      sendJson(res, 200, drained)
      return
    }
    if (method === 'POST' && route === '/send') {
      sendJson(res, 200, { success: true, messageId })
      return
    }
    if (method === 'POST' && route === '/edit') {
      sendJson(res, 200, { success: true })
      return
    }
    if (method === 'POST' && route === '/send-media') {
      sendJson(res, 200, { success: true, messageId })
      return
    }
    if (method === 'POST' && (route === '/react' || route === '/typing' || route === '/read')) {
      sendJson(res, 200, { success: true })
      return
    }
    if (method === 'GET' && route.startsWith('/chat/')) {
      const chatId = decodeURIComponent(route.slice('/chat/'.length))
      const found = chats.find((c) => c.id === chatId)
      if (!found) {
        sendJson(res, 404, { error: 'chat not found' })
        return
      }
      sendJson(res, 200, {
        id: found.id,
        name: found.name,
        isGroup: found.isGroup,
        participants: found.members
      })
      return
    }
    if (method === 'GET' && route === '/groups') {
      sendJson(
        res,
        200,
        chats.filter((c) => c.isGroup)
      )
      return
    }
    if (method === 'GET' && route === '/presence') {
      sendJson(res, 200, { presence: 'available' })
      return
    }
    if (method === 'POST' && route === '/resolve-lid') {
      const lid = payload && typeof payload === 'object' ? (payload as Record<string, unknown>)['lid'] : undefined
      sendJson(res, 200, { id: lid })
      return
    }
    if (method === 'POST' && route === '/control/inject') {
      const id = inject(payload as InboundMessage)
      sendJson(res, 200, { id })
      return
    }

    sendJson(res, 404, { error: 'no such route' })
  }

  return {
    async start(port = 0): Promise<string> {
      if (server) throw new Error('fake bridge already started')
      server = createServer((req, res) => {
        void handleRequest(req, res).catch((err: unknown) => {
          sendJson(res, 500, { error: (err as Error).message })
        })
      })
      await new Promise<void>((resolve) => server!.listen(port, '127.0.0.1', () => resolve()))
      const addr = server.address()
      if (!addr || typeof addr === 'string') throw new Error('expected TCP address')
      return `http://127.0.0.1:${addr.port}`
    },

    async stop(): Promise<void> {
      if (!server) return
      const active = server
      server = null
      await new Promise<void>((resolve, reject) => {
        active.close((err) => (err ? reject(err) : resolve()))
      })
    },

    inject,

    calls(): RecordedCall[] {
      return [...recorded]
    },

    callsTo(route: string): RecordedCall[] {
      return recorded.filter((c) => c.route === route)
    },

    reset(): void {
      recorded.length = 0
      queue.length = 0
      nextSeq = 0
    }
  }
}
