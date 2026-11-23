import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  handleStudioExpressions,
  type StudioExpressionStore,
  StudioExpressionStoreError
} from '../../src/api/studio-expression-routes.js'
import { readWebpInfo } from '../../src/character/webp.js'

// Contract tests for the already-authorized studio expression routes (issue #368).
// No live services, no shared files, no filesystem: the store is an in-memory fake.
// Image bytes are synthetic PNGs built below, the same approach as studio-expression.test.ts.

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c % 2 === 0 ? c >>> 1 : 0xedb88320 ^ (c >>> 1)
  return c >>> 0
})

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typeBytes = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])))
  return Buffer.concat([length, typeBytes, data, crc])
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function ihdr(width: number, height: number): Buffer {
  const data = Buffer.alloc(13)
  data.writeUInt32BE(width, 0)
  data.writeUInt32BE(height, 4)
  data[8] = 8
  data[9] = 6
  return pngChunk('IHDR', data)
}

function makePng(width: number, height: number): Buffer {
  const stride = width * 4 + 1
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0
    for (let x = 0; x < width; x++) {
      const at = y * stride + 1 + x * 4
      raw[at] = 200
      raw[at + 1] = 40
      raw[at + 2] = 40
      raw[at + 3] = 255
    }
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    ihdr(width, height),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

interface Captured {
  status: number
  headers: Record<string, unknown>
  body: Buffer
}

function mockResponse(): { res: ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, headers: {}, body: Buffer.alloc(0) }
  let sent = false
  const res = {
    get headersSent() {
      return sent
    },
    get destroyed() {
      return false
    },
    writeHead(status: number, headers: Record<string, unknown>) {
      captured.status = status
      captured.headers = headers
      sent = true
      return res
    },
    end(data?: unknown) {
      if (data !== undefined) captured.body = Buffer.isBuffer(data) ? data : Buffer.from(String(data))
      return res
    }
  } as unknown as ServerResponse
  return { res, captured }
}

function mockRequest(method: string, bodyText?: string, contentType = 'application/json'): IncomingMessage {
  const stream = new Readable({ read() {} })
  if (bodyText !== undefined) stream.push(Buffer.from(bodyText, 'utf8'))
  stream.push(null)
  ;(stream as unknown as Record<string, unknown>)['headers'] = { 'content-type': contentType }
  ;(stream as unknown as Record<string, unknown>)['method'] = method
  return stream as unknown as IncomingMessage
}

function truncatedRequest(): IncomingMessage {
  const stream = new Readable({
    read(this: Readable) {
      this.push(Buffer.from('{"expectedRevision":', 'utf8'))
      this.destroy(new Error('client aborted mid-body'))
    }
  })
  ;(stream as unknown as Record<string, unknown>)['headers'] = { 'content-type': 'application/json' }
  ;(stream as unknown as Record<string, unknown>)['method'] = 'POST'
  return stream as unknown as IncomingMessage
}

function jsonBody(value: unknown): string {
  return JSON.stringify(value)
}

function parsedBody(captured: Captured): unknown {
  return JSON.parse(captured.body.toString('utf8')) as unknown
}

interface Fake {
  store: StudioExpressionStore
  files: Map<string, { description: string; data: Buffer }>
  publishCalls: () => number
  revision: () => string
}

function createFake(): Fake {
  const files = new Map<string, { description: string; data: Buffer }>()
  let revision = 'a'.repeat(64)
  let calls = 0
  const store: StudioExpressionStore = {
    list: () => {
      const expressions = [...files.entries()].map(([name, entry]) => ({ name, description: entry.description }))
      return { revision, expressions }
    },
    read: (id: string, name: string) => {
      const entry = files.get(name)
      if (!entry) throw new StudioExpressionStoreError('not_found', 404, `/data/characters/${id}/stickers/${name}.webp`)
      return entry.data
    },
    publish: (id: string, expectedRevision: string, name: string, description: string, convertedWebp: Buffer) => {
      calls += 1
      if (expectedRevision !== revision) {
        throw new StudioExpressionStoreError('stale_revision', 409, `stale write at /data/characters/${id}`)
      }
      files.set(name, { description, data: convertedWebp })
      revision = 'b'.repeat(64)
      return { revision }
    }
  }
  return { store, files, publishCalls: () => calls, revision: () => revision }
}

describe('studio-expression-routes', () => {
  it('lists the collection shape with no-store and nosniff and no request id', async () => {
    const fake = createFake()
    const { res, captured } = mockResponse()
    await handleStudioExpressions(mockRequest('GET'), res, fake.store, { id: 'fox-test' })
    expect(captured.status).toBe(200)
    expect(captured.headers['cache-control']).toBe('no-store')
    expect(captured.headers['x-content-type-options']).toBe('nosniff')
    expect(captured.headers).not.toHaveProperty('x-request-id')
    const body = parsedBody(captured) as { revision: string; expressions: unknown[] }
    expect(body.revision).toMatch(/^[0-9a-f]{64}$/)
    expect(body.expressions).toEqual([])
  })

  it('publishes a real valid image fixture and reads it back as webp', async () => {
    const fake = createFake()
    const before = fake.revision()
    const png = makePng(64, 32)
    const post = {
      expectedRevision: before,
      name: 'happy-test',
      description: 'A happy test face',
      mime: 'image/png',
      data: png.toString('base64')
    }
    const { res, captured } = mockResponse()
    await handleStudioExpressions(mockRequest('POST', jsonBody(post)), res, fake.store, { id: 'fox-test' })
    expect(captured.status).toBe(200)
    expect(fake.publishCalls()).toBe(1)
    const saved = parsedBody(captured) as { id: string; name: string; revision: string }
    expect(saved.name).toBe('happy-test')
    expect(saved.revision).toMatch(/^[0-9a-f]{64}$/)
    const stored = fake.files.get('happy-test')
    expect(stored).toBeDefined()
    const info = readWebpInfo(stored?.data ?? Buffer.alloc(0))
    expect(info?.width).toBe(512)
    expect(info?.height).toBe(512)
    expect(info?.animated).toBe(false)

    const { res: getRes, captured: got } = mockResponse()
    await handleStudioExpressions(mockRequest('GET'), getRes, fake.store, { id: 'fox-test', name: 'happy-test' })
    expect(got.status).toBe(200)
    expect(got.headers['content-type']).toBe('image/webp')
    expect(got.headers['cache-control']).toBe('no-store')
    expect(got.headers['x-content-type-options']).toBe('nosniff')
    expect(got.body.equals(stored?.data ?? Buffer.alloc(0))).toBe(true)
  })

  it('rejects an unsupported media type without publishing', async () => {
    const fake = createFake()
    const gif = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.alloc(32)])
    const post = {
      expectedRevision: fake.revision(),
      name: 'funny-test',
      description: 'A funny test face',
      mime: 'image/gif',
      data: gif.toString('base64')
    }
    const { res, captured } = mockResponse()
    await handleStudioExpressions(mockRequest('POST', jsonBody(post)), res, fake.store, { id: 'fox-test' })
    expect(captured.status).toBe(415)
    expect(parsedBody(captured)).toEqual({ error: 'unsupported_media' })
    expect(fake.publishCalls()).toBe(0)
  })

  it('rejects an oversized side without publishing', async () => {
    const fake = createFake()
    const wide = makePng(4100, 4)
    const post = {
      expectedRevision: fake.revision(),
      name: 'wide-test',
      description: 'A wide test face',
      mime: 'image/png',
      data: wide.toString('base64')
    }
    const { res, captured } = mockResponse()
    await handleStudioExpressions(mockRequest('POST', jsonBody(post)), res, fake.store, { id: 'fox-test' })
    expect(captured.status).toBe(413)
    expect(fake.publishCalls()).toBe(0)
  })

  it('rejects a stale revision without leaking file paths', async () => {
    const fake = createFake()
    const png = makePng(32, 32)
    const first = {
      expectedRevision: fake.revision(),
      name: 'calm-test',
      description: 'A calm test face',
      mime: 'image/png',
      data: png.toString('base64')
    }
    const { res: firstRes, captured: firstCaptured } = mockResponse()
    await handleStudioExpressions(mockRequest('POST', jsonBody(first)), firstRes, fake.store, { id: 'fox-test' })
    expect(firstCaptured.status).toBe(200)

    const retry = { ...first, expectedRevision: 'a'.repeat(64), description: 'A stale test face' }
    const { res, captured } = mockResponse()
    await handleStudioExpressions(mockRequest('POST', jsonBody(retry)), res, fake.store, { id: 'fox-test' })
    expect(captured.status).toBe(409)
    expect(parsedBody(captured)).toEqual({ error: 'stale_revision' })
    expect(captured.body.toString('utf8')).not.toContain('/data/')
  })

  it('handles a deadline abort and a mid-body abort without publishing', async () => {
    const first = createFake()
    const png = makePng(32, 32)
    const post = {
      expectedRevision: first.revision(),
      name: 'brave-test',
      description: 'A brave test face',
      mime: 'image/png',
      data: png.toString('base64')
    }
    const { res, captured } = mockResponse()
    const abortedSignal = AbortSignal.abort()
    const params = { id: 'fox-test' }
    await handleStudioExpressions(mockRequest('POST', jsonBody(post)), res, first.store, params, {
      signal: abortedSignal
    })
    expect(captured.status).toBe(400)
    expect(first.publishCalls()).toBe(0)

    const second = createFake()
    const { res: abortRes, captured: aborted } = mockResponse()
    await handleStudioExpressions(truncatedRequest(), abortRes, second.store, { id: 'fox-test' })
    expect([400, 413]).toContain(aborted.status)
    expect(second.publishCalls()).toBe(0)
  })

  it('maps synchronous and asynchronous store failures to internal without paths', async () => {
    const syncStore: StudioExpressionStore = {
      list: () => {
        throw new Error('ENOENT /secret/pack/card.yml')
      },
      read: () => Buffer.alloc(0),
      publish: () => ({ revision: 'c'.repeat(64) })
    }
    const { res, captured } = mockResponse()
    await handleStudioExpressions(mockRequest('GET'), res, syncStore, { id: 'fox-test' })
    expect(captured.status).toBe(500)
    expect(parsedBody(captured)).toEqual({ error: 'internal' })
    expect(captured.body.toString('utf8')).not.toContain('/secret/')

    const asyncStore: StudioExpressionStore = {
      list: () => ({ revision: 'a'.repeat(64), expressions: [] }),
      read: () => Promise.reject(new Error('EACCES /secret/pack/happy.webp')),
      publish: () => ({ revision: 'c'.repeat(64) })
    }
    const { res: itemRes, captured: item } = mockResponse()
    await handleStudioExpressions(mockRequest('GET'), itemRes, asyncStore, { id: 'fox-test', name: 'happy-test' })
    expect(item.status).toBe(500)
    expect(parsedBody(item)).toEqual({ error: 'internal' })
    expect(item.body.toString('utf8')).not.toContain('/secret/')
  })
})
