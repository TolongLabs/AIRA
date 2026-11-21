import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseManifest, summarize } from '../../scripts/bakeoff-identify.js'
import { loadPack } from '../../src/character/loader.js'
import { parseConfig } from '../../src/config/loader.js'
import { configSchema } from '../../src/config/schema.js'
import type { GatewayDir } from '../../src/media/files.js'
import { createLogger } from '../../src/records/logger.js'
import { createRedactor } from '../../src/records/redact.js'
import { ensureChat, setChatStatus } from '../../src/settings/chats.js'
import { resolveSettings, setSetting } from '../../src/settings/settings.js'
import { openTurn, receiveInbound } from '../../src/storage/turns.js'
import { identifyImageTool } from '../../src/tools/core/identify.js'
import { registerCoreTools } from '../../src/tools/core/index.js'
import { createSerpApiIdentify } from '../../src/tools/identify.js'
import { createToolRegistry } from '../../src/tools/registry.js'
import { createTurnSources } from '../../src/turn/sources.js'
import type { TurnContext, TurnImage } from '../../src/turn/types.js'
import { tmpDir, tmpStorage } from '../support/tmp.js'

// identify_image through the registry, with SerpApi replaced by a fake fetch. No network call is made.

const pack = loadPack('characters/example', 'repository')

type Call = { method: string; url: URL }

function fakeFetch(respond: (call: Call, signal?: AbortSignal) => Promise<Response> | Response) {
  const calls: Call[] = []
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const call: Call = { method: init?.method ?? 'GET', url }
    calls.push(call)
    return respond(call, init?.signal ?? undefined)
  }) as typeof fetch
  return { fetch: fetchFn, calls }
}

/** SerpApi answers the upload with an image id and the search with the given visual matches. */
function serpApi(visualMatches: unknown[]) {
  return fakeFetch((call) =>
    call.url.pathname === '/image'
      ? Response.json({ image_id: 'img-1' })
      : Response.json({ visual_matches: visualMatches })
  )
}

const LAMP = {
  title: 'Example Lamp 200',
  link: 'https://www.shop.example.test/lamp-200',
  source: 'Example Shop',
  price: { value: '$19.00', extracted_value: 19, currency: 'USD' }
}

let seq = 0

function setup(fake?: ReturnType<typeof fakeFetch>, overrides: { timeoutMs?: number; maxUploadBytes?: number } = {}) {
  const storage = tmpStorage()
  const dir = tmpDir('aira-identify-')
  const gatewayDirs: GatewayDir[] = [{ host: dir, container: dir }]
  const registry = createToolRegistry({
    storage,
    config: { tools: { defaultTimeoutMs: 500 } },
    logger: createLogger({ level: 'error', module: 'identify-test', sink: () => {} }),
    redactor: createRedactor()
  })
  registerCoreTools(
    registry,
    { filesDir: tmpDir('aira-identify-files-') },
    {
      feedback: { formUrl: '', referenceEntryId: '', refTtlHours: 168 },
      ...(fake
        ? {
            identify: {
              port: createSerpApiIdentify({ apiKey: 'test-key', fetch: fake.fetch }),
              gatewayDirs,
              maxUploadBytes: overrides.maxUploadBytes ?? 500_000,
              timeoutMs: overrides.timeoutMs ?? 6000
            }
          }
        : {})
    }
  )
  const makeCtx = (images: TurnImage[], featureOn = true): TurnContext => {
    seq++
    const chat = ensureChat(storage, { waId: `fake-chat-${seq}`, type: 'group' })
    setChatStatus(storage, { chatId: chat.chatId, status: 'active', actor: 'test' })
    setSetting(storage, {
      level: 'chat',
      scope: chat.chatId,
      key: 'features.identify',
      value: featureOn,
      actor: 'test'
    })
    const senderId = `member-${seq}`
    const mid = `mid-${seq}`
    const turnId = `turn-${seq}`
    receiveInbound(storage, { chatId: chat.chatId, mid, senderId })
    openTurn(storage, { turnId, chatId: chat.chatId, senderId, kind: 'reply', mids: [mid] })
    return {
      turnId,
      chat,
      senderId,
      character: pack,
      settings: resolveSettings(storage, chat),
      kind: 'reply',
      delivery: { kind: 'reply' },
      deadline: Date.now() + 10_000,
      sources: createTurnSources(),
      images
    }
  }
  const call = (args: unknown, context: TurnContext, callId: string) =>
    registry.call('identify_image', args, context, { callId, source: 'model' })
  return { registry, dir, makeCtx, call }
}

describe('identify_image', () => {
  it('is registered only with a provider, and offered only while the chat switch is on', () => {
    expect(setup().registry.toolNames()).not.toContain('identify_image')

    const { registry, makeCtx } = setup(serpApi([]))
    expect(registry.toolNames()).toContain('identify_image')
    expect(registry.offered(makeCtx([], false)).map((tool) => tool.schema.name)).not.toContain('identify_image')
    expect(registry.offered(makeCtx([], true)).map((tool) => tool.schema.name)).toContain('identify_image')
  })

  it('refuses an index with no picture in this turn, and makes no provider call', async () => {
    const fake = serpApi([LAMP])
    const { makeCtx, call } = setup(fake)

    expect(await call({ attachment: 0 }, makeCtx([]), 'c-none')).toMatchObject({ ok: false, kind: 'refused' })
    expect(fake.calls).toEqual([])
  })

  it('uploads a local picture, then searches Google Lens by the image id it returns', async () => {
    const fake = serpApi([LAMP])
    const { dir, makeCtx, call } = setup(fake)
    const path = join(dir, 'photo.jpg')
    writeFileSync(path, 'jpeg-bytes')
    const ctx = makeCtx([{ kind: 'file', attachment: { kind: 'image', path } }])

    const result = await call({ attachment: 0 }, ctx, 'c-file')

    expect(fake.calls.map((entry) => `${entry.method} ${entry.url.pathname}`)).toEqual(['POST /image', 'GET /search'])
    expect(fake.calls[1]?.url.searchParams.get('engine')).toBe('google_lens')
    expect(fake.calls[1]?.url.searchParams.get('image_id')).toBe('img-1')
    expect(result).toEqual({
      ok: true,
      data: {
        untrusted: true,
        hints: 'unverified',
        outcome: 'matches',
        matches: [
          {
            title: 'Example Lamp 200',
            domain: 'shop.example.test',
            link: 'https://www.shop.example.test/lamp-200',
            price: '$19.00'
          }
        ]
      }
    })
  })

  it('searches a photo URL directly, with no upload', async () => {
    const fake = serpApi([LAMP])
    const { makeCtx, call } = setup(fake)
    const ctx = makeCtx([{ kind: 'url', url: 'https://img.example.test/post/1.jpg' }])

    const result = await call({ attachment: 0 }, ctx, 'c-url')

    expect(fake.calls.map((entry) => `${entry.method} ${entry.url.pathname}`)).toEqual(['GET /search'])
    expect(fake.calls[0]?.url.searchParams.get('url')).toBe('https://img.example.test/post/1.jpg')
    expect(result).toMatchObject({ ok: true, data: { hints: 'unverified', untrusted: true } })
  })

  it('refuses a photo URL that is not a public https address, with no call', async () => {
    const fake = serpApi([LAMP])
    const { makeCtx, call } = setup(fake)

    for (const url of ['http://img.example.test/a.jpg', 'https://127.0.0.1/a.jpg']) {
      expect(await call({ attachment: 0 }, makeCtx([{ kind: 'url', url }]), `c-${url}`)).toMatchObject({
        ok: false,
        kind: 'refused'
      })
    }
    expect(fake.calls).toEqual([])
  })

  it('does not upload a local picture over the limit, and says so', async () => {
    const fake = serpApi([LAMP])
    const { dir, makeCtx, call } = setup(fake, { maxUploadBytes: 500_000 })
    const path = join(dir, 'large.jpg')
    writeFileSync(path, Buffer.alloc(500_001))
    const ctx = makeCtx([{ kind: 'file', attachment: { kind: 'image', path } }])

    expect(await call({ attachment: 0 }, ctx, 'c-large')).toEqual({
      ok: true,
      data: {
        untrusted: true,
        hints: 'unverified',
        outcome: 'The picture was too large to look up closely.',
        matches: []
      }
    })
    expect(fake.calls).toEqual([])
  })

  it('never uploads a 500001-byte picture, even when the caller allows more', async () => {
    const fake = serpApi([LAMP])
    const { dir, makeCtx, call } = setup(fake, { maxUploadBytes: 600_000 })
    const path = join(dir, 'over-cap.jpg')
    writeFileSync(path, Buffer.alloc(500_001))
    const ctx = makeCtx([{ kind: 'file', attachment: { kind: 'image', path } }])

    expect(await call({ attachment: 0 }, ctx, 'c-cap')).toMatchObject({
      ok: true,
      data: { outcome: 'The picture was too large to look up closely.', matches: [] }
    })
    expect(fake.calls).toEqual([])
  })

  it.each(['photo.gif', 'photo.heic'])('refuses %s before any upload, with the plain failure', async (name) => {
    const fake = serpApi([LAMP])
    const { dir, makeCtx, call } = setup(fake)
    const path = join(dir, name)
    writeFileSync(path, 'bytes')
    const ctx = makeCtx([{ kind: 'file', attachment: { kind: 'image', path } }])

    expect(await call({ attachment: 0 }, ctx, `c-${name}`)).toMatchObject({
      ok: false,
      kind: 'unavailable',
      reason: 'picture could not be read'
    })
    expect(fake.calls).toEqual([])
  })

  it.each(['photo.jpg', 'photo.png', 'photo.webp'])('uploads %s, a type the Image API accepts', async (name) => {
    const fake = serpApi([LAMP])
    const { dir, makeCtx, call } = setup(fake)
    const path = join(dir, name)
    writeFileSync(path, 'bytes')
    const ctx = makeCtx([{ kind: 'file', attachment: { kind: 'image', path } }])

    await call({ attachment: 0 }, ctx, `c-${name}`)
    expect(fake.calls.map((entry) => `${entry.method} ${entry.url.pathname}`)).toEqual(['POST /image', 'GET /search'])
  })

  it('caps the timeout at the hard maximum whatever the caller passes', () => {
    const tool = identifyImageTool({
      port: { byFile: async () => [], byUrl: async () => [] },
      gatewayDirs: [],
      maxUploadBytes: 500_000,
      timeoutMs: 60_000
    })
    expect(tool.timeoutMs).toBe(6000)
  })

  it('returns a timeout when the upload and search pass the limit', async () => {
    const hanging = fakeFetch(
      (_call, signal) =>
        new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
    )
    const { makeCtx, call } = setup(hanging, { timeoutMs: 50 })
    const ctx = makeCtx([{ kind: 'url', url: 'https://img.example.test/a.jpg' }])

    expect(await call({ attachment: 0 }, ctx, 'c-slow')).toMatchObject({ ok: false, kind: 'timeout' })
  })

  it('keeps the first five matches and drops any whose link is not https', async () => {
    const visual = [
      { title: 'Plain link', link: 'http://insecure.example.test/item' },
      ...Array.from({ length: 7 }, (_, index) => ({
        title: `Match ${index + 1}`,
        link: `https://shop${index}.example.test/item`
      }))
    ]
    const { makeCtx, call } = setup(serpApi(visual))
    const ctx = makeCtx([{ kind: 'url', url: 'https://img.example.test/a.jpg' }])

    const result = await call({ attachment: 0 }, ctx, 'c-many')

    expect(result).toMatchObject({ ok: true })
    const matches = (result as { ok: true; data: { matches: { title: string }[] } }).data.matches
    expect(matches.map((match) => match.title)).toEqual(['Match 1', 'Match 2', 'Match 3', 'Match 4', 'Match 5'])
  })
})

describe('identify limits in config.yml', () => {
  const config = parseConfig(readFileSync('config.yml', 'utf8'))
  const withIdentify = (identify: unknown) => configSchema.safeParse({ ...config, identify })

  it('defaults to the values in config.yml', () => {
    expect(withIdentify(undefined).data?.identify).toEqual(config.identify)
  })

  it('refuses a limit above the hard maximum, and accepts the maximum', () => {
    expect(withIdentify({ timeoutMs: 6000, maxUploadBytes: 500_000 }).success).toBe(true)
    expect(withIdentify({ timeoutMs: 6001, maxUploadBytes: 500_000 }).success).toBe(false)
    expect(withIdentify({ timeoutMs: 6000, maxUploadBytes: 500_001 }).success).toBe(false)
  })
})

describe('bake-off labels and scoring', () => {
  const manifest = (photos: unknown[]) => JSON.stringify({ photos })
  const photo = (photoClass: string, expected: string) => ({
    id: 'x1',
    class: photoClass,
    url: 'https://upload.example.test/x1.jpg',
    license: 'CC0',
    source: 'https://commons.example.test/x1',
    expected
  })

  it('loads the shipped manifest as 4 known, 3 lookalike and 3 unknown photos', () => {
    const photos = parseManifest(readFileSync(new URL('../fixtures/identify/set.json', import.meta.url), 'utf8'))
    const count = (photoClass: string) => photos.filter((entry) => entry.class === photoClass).length
    expect([count('known'), count('lookalike'), count('unknown')]).toEqual([4, 3, 3])
  })

  it('refuses a lookalike labelled unknown, and an unknown photo that names a product', () => {
    expect(() => parseManifest(manifest([photo('lookalike', 'unknown')]))).toThrow(/unknown photos expect unknown/)
    expect(() => parseManifest(manifest([photo('unknown', 'Red Apple')]))).toThrow(/unknown photos expect unknown/)
    expect(parseManifest(manifest([photo('lookalike', 'Watara Supervision')]))).toHaveLength(1)
  })

  it('scores a correct product name on a lookalike as correct, not as a false positive', () => {
    const summary = summarize([
      { expected: 'Watara Supervision', answer: 'Watara Supervision', ms: 10 },
      { expected: 'unknown', answer: 'Coffee mug', ms: 10 },
      { expected: 'unknown', answer: 'unknown', ms: 10 }
    ])
    expect(summary).toMatchObject({ correct: 2, named: 2, namedCorrect: 1, abstentions: 1 })
  })
})
