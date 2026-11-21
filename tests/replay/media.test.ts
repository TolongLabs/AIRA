import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { App } from '../../src/app.js'
import { createReplyCleaner } from '../../src/format/clean.js'
import type { MediaWatcher } from '../../src/media/gemini-watcher.js'
import { DEFAULT_MEDIA_LIMITS } from '../../src/media/limits.js'
import { createLinkReader, type LinkReader } from '../../src/media/link-intake.js'
import { createTurnMedia } from '../../src/media/turn-media.js'
import { ModelError, type ModelRequest } from '../../src/models/types.js'
import { MEDIA_NOTE } from '../../src/prompt/builder.js'
import { setSetting } from '../../src/settings/settings.js'
import type { SocialPost } from '../../src/social/types.js'
import { findSocialPostTarget } from '../../src/social/urls.js'
import type { GatewayMessage } from '../harness/gateway.js'
import { CHAT, lastTurn, msg, queueModel, startApp } from '../support/app.js'
import { addPack, scriptedRunner, startTestCore, testConfig } from '../support/core.js'
import { tmpDir } from '../support/tmp.js'

// Media watching through the whole service (docs/trd/models.md#media-watching): the gateway names a saved file in a
// note, the core reads it through its mount, the media model describes it, and the description reaches the main
// model in prompt block 4. The media model is a fake: no network call is made. Host paths and ids are invented.

const HOST_CACHE = '/home/user/.hermes/cache'
const UNREADABLE_LINE = 'I could not read that file. Could you send it again or describe it?'

function gatewayFolder() {
  const cache = join(tmpDir('aira-gateway-'), 'cache')
  mkdirSync(join(cache, 'images'), { recursive: true })
  mkdirSync(join(cache, 'audio'), { recursive: true })
  writeFileSync(join(cache, 'images', 'img_a1b2.jpg'), 'jpeg-bytes')
  writeFileSync(join(cache, 'audio', 'aud_c3.ogg'), 'ogg-bytes')
  return cache
}

type Seen = { contentType: string; size: number }
function fakeWatcher(
  answer: (seen: Seen, call: number) => { description: string; transcript?: string } | ModelError
): MediaWatcher & { seen: Seen[] } {
  const seen: Seen[] = []
  return {
    seen,
    async watch(file) {
      const entry = { contentType: file.contentType, size: file.data.byteLength }
      seen.push(entry)
      const result = answer(entry, seen.length)
      if (result instanceof ModelError) throw result
      return {
        reading: result,
        usage: { inputTokens: 300, outputTokens: 20, cachedTokens: 0 },
        costUsd: 0,
        model: 'fake-media-model'
      }
    }
  }
}

const rows = <T>(app: App, sql: string, ...args: unknown[]) =>
  app.storage.read((db) => db.prepare(sql).all(...args) as T[])

const contextOf = (request: ModelRequest | undefined) =>
  request?.system.find((block) => block.name === 'context')?.text ?? ''
const withMedia = (mid: string, text: string, media: GatewayMessage['media']): GatewayMessage => ({
  ...msg(mid, text),
  media
})

async function start(
  options: {
    watcher?: MediaWatcher
    answers?: Parameters<typeof queueModel>[0]
    gatewayDirs?: boolean
    env?: NodeJS.ProcessEnv
  } = {}
) {
  const cache = gatewayFolder()
  const model = queueModel(options.answers ?? [{ text: 'Example: Nice one!' }])
  const started = await startApp(model, {
    ...(options.watcher ? { mediaWatcher: options.watcher } : {}),
    ...(options.env ? { env: options.env } : {}),
    config: (config) => {
      if (options.gatewayDirs !== false) config.media.gatewayDirs = [{ host: HOST_CACHE, container: cache }]
      config.turn.batchMs = 250
    }
  })
  return { ...started, model, cache }
}

describe('a photo, a voice note and a document', () => {
  it('reaches the main model as a labelled description in block 4, and is recorded', async () => {
    const watcher = fakeWatcher(() => ({ description: 'A red bicycle against a brick wall.' }))
    const { app, gateway, model, chatId } = await start({ watcher })

    const delivery = await gateway.send(
      withMedia('m-1', 'what do you think?', [{ kind: 'image', path: `${HOST_CACHE}/images/img_a1b2.jpg` }])
    )

    expect(delivery.content).toBe('Nice one!\n\n_🛠️ looked at an image_')
    expect(watcher.seen).toEqual([{ contentType: 'image/jpeg', size: 'jpeg-bytes'.length }])
    const context = contextOf(model.requests[0])
    expect(context).toContain('<media untrusted="true">\n- image: A red bicycle against a brick wall.\n</media>')
    expect(context).not.toContain('<media-unreadable>')
    // The file itself and its path never reach the model.
    expect(JSON.stringify(model.requests[0])).not.toContain('img_a1b2')
    expect(JSON.stringify(model.requests[0])).not.toContain('jpeg-bytes')
    expect(model.requests[0]?.messages).toEqual([
      { role: 'user', content: `[member 1] ${MEDIA_NOTE}\nwhat do you think?` }
    ])

    expect(lastTurn(app)).toMatchObject({ chat_id: chatId, state: 'delivered', outcome: 'delivered' })
    expect(lastTurn(app)['failure_kind']).toBeNull()
    expect(rows(app, "SELECT role, model, input_tokens, failure_kind FROM model_call WHERE role = 'media'")).toEqual([
      { role: 'media', model: 'fake-media-model', input_tokens: 300, failure_kind: null }
    ])
    expect(rows(app, 'SELECT * FROM failure')).toEqual([])
  })

  it('answers a photo sent with no caption: the model sees a message with no text and the description', async () => {
    const watcher = fakeWatcher(() => ({ description: 'A cat on a windowsill.' }))
    const { gateway, model } = await start({ watcher })

    const delivery = await gateway.send(
      withMedia('m-1', '', [{ kind: 'image', path: `${HOST_CACHE}/images/img_a1b2.jpg` }])
    )

    expect(delivery.content).toBe('Nice one!\n\n_🛠️ looked at an image_')
    expect(model.requests[0]?.messages).toEqual([
      { role: 'user', content: `[member 1] ${MEDIA_NOTE}\n(no text, only a file)` }
    ])
    expect(contextOf(model.requests[0])).toContain('- image: A cat on a windowsill.')
  })

  it('carries the transcript of a voice note', async () => {
    const watcher = fakeWatcher(() => ({
      description: 'A person speaking in a quiet room.',
      transcript: 'Can you pick up some milk on the way home?'
    }))
    const { gateway, model } = await start({ watcher })

    await gateway.send(withMedia('m-1', 'hear this', [{ kind: 'voice', path: `${HOST_CACHE}/audio/aud_c3.ogg` }]))

    expect(watcher.seen[0]?.contentType).toBe('audio/ogg')
    expect(contextOf(model.requests[0])).toContain(
      '- audio: A person speaking in a quiet room.\n  transcript: Can you pick up some milk on the way home?'
    )
  })

  it('reads the files of every message a turn answers, so a photo and its caption sent apart both count', async () => {
    const watcher = fakeWatcher(() => ({ description: 'A red bicycle against a brick wall.' }))
    const { gateway, model } = await start({ watcher })

    const [photo, caption] = await Promise.all([
      gateway.send(withMedia('m-1', '', [{ kind: 'image', path: `${HOST_CACHE}/images/img_a1b2.jpg` }])),
      new Promise((resolve) => setTimeout(resolve, 30)).then(() => gateway.send(msg('m-2', 'is this bike ok?')))
    ])

    expect(model.requests).toHaveLength(1)
    expect(watcher.seen).toHaveLength(1)
    expect(contextOf(model.requests[0])).toContain('- image: A red bicycle against a brick wall.')
    expect(photo.content).toBe('NO_REPLY')
    expect(caption.content).toBe('Nice one!\n\n_🛠️ looked at an image_')
  })
})

describe('the configured media model', () => {
  it('is called with the key from the environment and the file, and its answer reaches the main model', async () => {
    const calls: { url: string; key: string | undefined; mime: string; data: string }[] = []
    const guarded = globalThis.fetch
    const gemini = JSON.stringify({
      candidates: [{ content: { parts: [{ text: '{"description": "A red bicycle against a brick wall."}' }] } }],
      usageMetadata: { promptTokenCount: 310, candidatesTokenCount: 18 }
    })
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      if (!url.startsWith('https://generativelanguage.googleapis.com/')) return guarded(input, init)
      const body = JSON.parse(String(init?.body)) as {
        contents: { parts: { inline_data?: { mime_type: string; data: string } }[] }[]
      }
      const part = body.contents[0]?.parts[0]?.inline_data
      calls.push({
        url,
        key: (init!.headers as Record<string, string>)['x-goog-api-key'],
        mime: part?.mime_type ?? '',
        data: part?.data ?? ''
      })
      return new Response(gemini, { status: 200 })
    }) as typeof fetch
    // The service takes the global fetch when it starts, so the stub is in place first.
    const { gateway, model, app } = await start({ env: { MEDIA_WATCHER_API_KEY: 'test-media-key-000' } })

    await gateway.send(withMedia('m-1', 'look', [{ kind: 'image', path: `${HOST_CACHE}/images/img_a1b2.jpg` }]))

    expect(calls).toEqual([
      {
        url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent',
        key: 'test-media-key-000',
        mime: 'image/jpeg',
        data: Buffer.from('jpeg-bytes').toString('base64')
      }
    ])
    expect(contextOf(model.requests[0])).toContain('- image: A red bicycle against a brick wall.')
    expect(rows(app, "SELECT model, input_tokens FROM model_call WHERE role = 'media'")).toEqual([
      { model: 'gemini-3.5-flash-lite', input_tokens: 310 }
    ])
  })
})

describe('a file that cannot be read', () => {
  it('reaches the model as a note with the pack line, when the media model fails, and the turn still answers', async () => {
    const watcher = fakeWatcher(() => new ModelError('rate_limit', 'free tier limit'))
    const { app, gateway, model } = await start({ watcher })

    const delivery = await gateway.send(
      withMedia('m-1', 'look', [{ kind: 'image', path: `${HOST_CACHE}/images/img_a1b2.jpg` }])
    )

    expect(delivery.content).toBe('Nice one!')
    const context = contextOf(model.requests[0])
    expect(context).toContain(
      `<media-unreadable>\n(The image could not be opened.)\nTell the sender so in your own voice, in the sense of: "${UNREADABLE_LINE}"\n</media-unreadable>`
    )
    expect(context).not.toContain('<media untrusted')
    expect(lastTurn(app)).toMatchObject({ state: 'delivered', outcome: 'delivered' })
    expect(rows(app, "SELECT failure_kind FROM model_call WHERE role = 'media'")).toEqual([
      { failure_kind: 'rate_limit' }
    ])
    expect(rows(app, 'SELECT stage, kind, handled_by, message FROM failure')).toEqual([
      expect.objectContaining({ stage: 'media', kind: 'media_unreadable', handled_by: 'line:unreadableMedia' })
    ])
  })

  it('refuses a path outside the gateway folders without calling the media model, and keeps the path from the model', async () => {
    const watcher = fakeWatcher(() => ({ description: 'must not be read' }))
    const { app, gateway, model } = await start({ watcher })

    const delivery = await gateway.send(
      withMedia('m-1', 'look', [
        { kind: 'image', path: '/home/user/.ssh/id_ed25519.jpg' },
        { kind: 'image', path: `${HOST_CACHE}/images/../../.env.jpg` }
      ])
    )

    expect(delivery.content).toBe('Nice one!')
    expect(watcher.seen).toEqual([])
    const context = contextOf(model.requests[0])
    expect(context).toContain('(The image could not be opened.)')
    expect(JSON.stringify(model.requests[0])).not.toContain('id_ed25519')
    expect(rows(app, "SELECT * FROM model_call WHERE role = 'media'")).toEqual([])
    expect(rows(app, 'SELECT kind FROM failure')).toEqual([{ kind: 'media_unreadable' }, { kind: 'media_unreadable' }])
  })

  it('reads one file and notes another in the same message', async () => {
    const watcher = fakeWatcher(() => ({ description: 'A red bicycle against a brick wall.' }))
    const { gateway, model } = await start({ watcher })

    await gateway.send(
      withMedia('m-1', 'two things', [
        { kind: 'image', path: `${HOST_CACHE}/images/img_a1b2.jpg` },
        { kind: 'document', path: `${HOST_CACHE}/documents/gone.pdf` }
      ])
    )

    const context = contextOf(model.requests[0])
    expect(context).toContain('- image: A red bicycle against a brick wall.')
    expect(context).toContain('(The document could not be opened.)')
    expect(watcher.seen).toHaveLength(1)
  })

  it('alerts the operator when the media key is refused', async () => {
    const watcher = fakeWatcher(() => new ModelError('auth', 'HTTP 403'))
    const { gateway, logs } = await start({ watcher })

    await gateway.send(withMedia('m-1', 'look', [{ kind: 'image', path: `${HOST_CACHE}/images/img_a1b2.jpg` }]))

    expect(logs.filter((line) => line['event'] === 'alert')).toEqual([
      expect.objectContaining({ kind: 'model_auth', role: 'media' })
    ])
  })

  it('a media watcher error is stored in the media_unreadable row', async () => {
    const watcher = fakeWatcher(() => new ModelError('transient', 'watcher socket reset'))
    const { app, gateway, model } = await start({ watcher })

    const delivery = await gateway.send(
      withMedia('m-1', 'look', [{ kind: 'image', path: `${HOST_CACHE}/images/img_a1b2.jpg` }])
    )

    expect(delivery.content).toBe('Nice one!')
    expect(contextOf(model.requests[0])).not.toContain('watcher socket reset')
    expect(rows(app, 'SELECT stage, kind, handled_by, message, stack FROM failure')).toEqual([
      {
        stage: 'media',
        kind: 'media_unreadable',
        handled_by: 'line:unreadableMedia',
        message: 'watcher socket reset',
        stack: expect.stringContaining('ModelError')
      }
    ])
  })
})

describe('a direct command', () => {
  it('reads no file: no model runs, so no description is needed', async () => {
    const watcher = fakeWatcher(() => ({ description: 'must not be read' }))
    const { gateway, model } = await start({ watcher })

    const delivery = await gateway.send(
      withMedia('m-1', '/help', [{ kind: 'image', path: `${HOST_CACHE}/images/img_a1b2.jpg` }])
    )

    expect(delivery.content).toContain('/help')
    expect(watcher.seen).toEqual([])
    expect(model.requests).toEqual([])
  })
})

describe('media is off', () => {
  it('still answers, tells the model the file was not read, and logs media.off once at start-up', async () => {
    const { app, gateway, model, logs } = await start({ gatewayDirs: false })

    const delivery = await gateway.send(
      withMedia('m-1', 'look', [{ kind: 'image', path: `${HOST_CACHE}/images/img_a1b2.jpg` }])
    )

    expect(delivery.content).toBe('Nice one!')
    expect(logs.filter((line) => line['event'] === 'media.off')).toEqual([
      expect.objectContaining({ reason: 'no_key' })
    ])
    expect(contextOf(model.requests[0])).toContain('(The image could not be opened.)')
    expect(lastTurn(app)).toMatchObject({ state: 'delivered' })
    expect(rows(app, "SELECT * FROM model_call WHERE role = 'media'")).toEqual([])
    expect(rows(app, 'SELECT kind FROM failure')).toEqual([{ kind: 'media_unreadable' }])
  })

  it('answers a message with no files exactly as before: no media text in block 4', async () => {
    const { gateway, model } = await start()

    expect((await gateway.send(msg('m-1', 'just text'))).content).toBe('Nice one!')

    expect(contextOf(model.requests[0])).not.toContain('media')
  })
})

describe('reverse-image hints for a turn picture', () => {
  const lookedUp = { visual_matches: [{ title: 'Example Lamp 200', link: 'https://shop.example.test/lamp' }] }

  it('offers identify_image and looks up the member picture by its index', async () => {
    const serpCalls: string[] = []
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.hostname !== 'serpapi.com') return realFetch(input, init)
      serpCalls.push(`${init?.method ?? 'GET'} ${url.pathname}`)
      return Promise.resolve(url.pathname === '/image' ? Response.json({ image_id: 'img-1' }) : Response.json(lookedUp))
    })
    try {
      const answers = [
        { toolCalls: [{ id: 'call-1', name: 'identify_image', args: { attachment: 0 } }] },
        { text: 'Example: Nice one!' }
      ]
      const watcher = fakeWatcher(() => ({ description: 'A desk lamp.' }))
      const { app, gateway, model, chatId } = await start({ watcher, answers, env: { SERPAPI_API_KEY: 'test-key' } })
      setSetting(app.storage, { level: 'chat', scope: chatId, key: 'features.identify', value: true, actor: 'test' })

      const photo = withMedia('m-1', 'what lamp is this?', [
        { kind: 'image', path: `${HOST_CACHE}/images/img_a1b2.jpg` }
      ])
      const reply = await gateway.send(photo)

      expect(reply.content).toContain('_🛠️ looked at an image · searched by image_')

      expect(model.requests[0]?.tools.map((tool) => tool.name)).toContain('identify_image')
      expect(serpCalls).toEqual(['POST /image', 'GET /search'])
      expect(model.requests[1]?.messages).toContainEqual(
        expect.objectContaining({
          role: 'tool',
          name: 'identify_image',
          content: expect.stringContaining('"hints":"unverified"')
        })
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('is not offered without SERPAPI_API_KEY', async () => {
    const watcher = fakeWatcher(() => ({ description: 'A desk lamp.' }))
    const { app, gateway, model, chatId } = await start({ watcher, env: {} })
    setSetting(app.storage, { level: 'chat', scope: chatId, key: 'features.identify', value: true, actor: 'test' })

    const photo = withMedia('m-1', 'what lamp is this?', [{ kind: 'image', path: `${HOST_CACHE}/images/img_a1b2.jpg` }])
    await gateway.send(photo)

    expect(model.requests[0]?.tools.map((tool) => tool.name)).not.toContain('identify_image')
  })

  // Answers SerpApi in place of the network, and returns the requests made, as "METHOD /path".
  function stubSerpApi(): string[] {
    const requests: string[] = []
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.hostname !== 'serpapi.com') return realFetch(input, init)
      requests.push(`${init?.method ?? 'GET'} ${url.pathname}`)
      return Promise.resolve(url.pathname === '/image' ? Response.json({ image_id: 'img-1' }) : Response.json(lookedUp))
    })
    return requests
  }

  const identifyAnswers = [
    { toolCalls: [{ id: 'call-1', name: 'identify_image', args: { attachment: 0 } }] },
    { text: 'Example: Nice one!' }
  ]

  it('looks up the valid picture when a missing file comes before it', async () => {
    const serpCalls = stubSerpApi()
    try {
      const watcher = fakeWatcher(() => ({ description: 'A desk lamp.' }))
      const { app, gateway, model, chatId } = await start({
        watcher,
        answers: identifyAnswers,
        env: { SERPAPI_API_KEY: 'test-key' }
      })
      setSetting(app.storage, { level: 'chat', scope: chatId, key: 'features.identify', value: true, actor: 'test' })
      await gateway.send(
        withMedia('m-1', 'what lamp is this?', [
          { kind: 'image', path: `${HOST_CACHE}/images/gone.jpg` },
          { kind: 'image', path: `${HOST_CACHE}/images/img_a1b2.jpg` }
        ])
      )

      expect(serpCalls).toEqual(['POST /image', 'GET /search'])
      expect(model.requests[1]?.messages).toContainEqual(
        expect.objectContaining({
          role: 'tool',
          name: 'identify_image',
          content: expect.stringContaining('"hints":"unverified"')
        })
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('needs only SERPAPI_API_KEY when no media watcher is set, since validation alone indexes the picture', async () => {
    const serpCalls = stubSerpApi()
    try {
      const { app, gateway, model, chatId } = await start({
        answers: identifyAnswers,
        env: { SERPAPI_API_KEY: 'test-key' }
      })
      setSetting(app.storage, { level: 'chat', scope: chatId, key: 'features.identify', value: true, actor: 'test' })
      const photo = withMedia('m-1', 'what lamp is this?', [
        { kind: 'image', path: `${HOST_CACHE}/images/img_a1b2.jpg` }
      ])
      await gateway.send(photo)

      expect(model.requests[0]?.tools.map((tool) => tool.name)).toContain('identify_image')
      expect(serpCalls).toEqual(['POST /image', 'GET /search'])
      expect(model.requests[1]?.messages).toContainEqual(
        expect.objectContaining({
          role: 'tool',
          name: 'identify_image',
          content: expect.stringContaining('"hints":"unverified"')
        })
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('finds no picture while media is off, and makes no provider call', async () => {
    const serpCalls = stubSerpApi()
    try {
      const watcher = fakeWatcher(() => ({ description: 'A desk lamp.' }))
      const { app, gateway, chatId } = await start({
        watcher,
        answers: identifyAnswers,
        env: { SERPAPI_API_KEY: 'test-key' }
      })
      setSetting(app.storage, { level: 'chat', scope: chatId, key: 'features.identify', value: true, actor: 'test' })
      setSetting(app.storage, { level: 'chat', scope: chatId, key: 'features.media', value: false, actor: 'test' })
      const photo = withMedia('m-1', 'what lamp is this?', [
        { kind: 'image', path: `${HOST_CACHE}/images/img_a1b2.jpg` }
      ])
      await gateway.send(photo)

      expect(serpCalls).toEqual([])
      expect(watcher.seen).toEqual([])
      expect(rows<{ outcome: string }>(app, "SELECT outcome FROM tool_call WHERE tool = 'identify_image'")).toEqual([
        { outcome: 'refused' }
      ])
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('pictures and post photos in one turn', () => {
  const POST = 'https://www.threads.com/@user/post/P1'
  const photos = ['https://img.example/1.jpg', 'https://img.example/2.jpg']
  const post: SocialPost = {
    platform: 'threads',
    id: 'P1',
    canonicalUrl: POST,
    target: { platform: 'threads', id: 'P1' } as SocialPost['target'],
    authorHandle: 'user',
    authorName: 'User',
    createdAt: null,
    text: 'a post',
    quotedText: '',
    quotedAuthorHandle: '',
    photoCount: photos.length,
    videoCount: 0,
    imageUrl: null,
    photoUrls: photos,
    thread: [],
    externalTitle: '',
    replyCount: null,
    durationSec: null,
    video: null
  }
  // Opens the post only when a text holds its link. Intake reads the quoted text too.
  const links: LinkReader = {
    async read(texts) {
      if (!texts.some((text) => text.includes(POST))) return { readings: [], unreadable: [], calls: [] }
      return { readings: [], links: [{ post, mediaKind: 'image' }], unreadable: [], calls: [] }
    }
  }

  // A reply that quotes the post and carries three pictures: one missing on disk, then two valid local ones.
  async function imagesOfQuotingReply(mediaOn: boolean) {
    const runner = scriptedRunner(() => 'Example: Nice one!')
    const cache = gatewayFolder()
    writeFileSync(join(cache, 'images', 'quoted_c3d4.jpg'), 'jpeg-bytes')
    const media = createTurnMedia({
      model: 'fake-media-model',
      limits: { ...DEFAULT_MEDIA_LIMITS, maxVideoSeconds: 180 },
      gatewayDirs: [{ host: HOST_CACHE, container: cache }],
      timeoutMs: 1000,
      links
    })
    const core = await startTestCore({ runner, deps: { media } })
    const chatId = core.activate(CHAT)
    setSetting(core.storage, { level: 'chat', scope: chatId, key: 'features.identify', value: true, actor: 'test' })
    setSetting(core.storage, { level: 'chat', scope: chatId, key: 'features.media', value: mediaOn, actor: 'test' })
    await core.gateway.send({
      ...msg('m-1', 'what are these?'),
      quote: { text: `look at ${POST}`, id: 'q-1' },
      media: [
        { kind: 'image', path: `${HOST_CACHE}/images/gone.jpg` },
        { kind: 'image', path: `${HOST_CACHE}/images/img_a1b2.jpg` },
        { kind: 'image', path: `${HOST_CACHE}/images/quoted_c3d4.jpg` }
      ]
    })
    return runner.inputs[0]?.context.images
  }

  it('records a failed intake lookup and its attempts on the turn that tried it', async () => {
    const links = createLinkReader({
      viewer: {
        async lookup(_target, _signal, trace) {
          trace?.({ attempts: [{ readerId: 'threads.page', ok: false, reason: 'http_429', ms: 4 }] })
          return { status: 'failed', platform: 'threads', reason: 'http_429' }
        }
      },
      limits: { ...DEFAULT_MEDIA_LIMITS, maxVideoSeconds: 180 },
      model: 'fake-media-model',
      findTarget: findSocialPostTarget
    })
    const media = createTurnMedia({
      model: 'fake-media-model',
      limits: { ...DEFAULT_MEDIA_LIMITS, maxVideoSeconds: 180 },
      gatewayDirs: [],
      timeoutMs: 1000,
      links
    })
    const core = await startTestCore({ runner: scriptedRunner(() => 'Example: I could not open it.'), deps: { media } })
    core.activate(CHAT)
    await core.gateway.send(msg('m-lookup', `${POST}?token=synthetic-intake-marker`))
    const row = core.storage.read((db) =>
      db
        .prepare(
          `
      SELECT lookup.*, turn.state FROM social_turn_lookup AS lookup JOIN turn USING (turn_id)
    `
        )
        .get()
    )
    expect(row).toMatchObject({
      tool_call_id: null,
      platform: 'threads',
      outcome: 'failed',
      reason: 'rate_limited',
      state: 'delivered',
      attempts: JSON.stringify([{ reader: 'threads.page', ok: false, reason: 'rate_limited', ms: 4 }])
    })
    expect(JSON.stringify(row)).not.toMatch(/https:|synthetic-intake-marker/)
  })

  it('keeps a server error, a parse error and a long attempt in the intake lookup record', async () => {
    const links = createLinkReader({
      viewer: {
        async lookup(_target, _signal, trace) {
          trace?.({
            attempts: [
              { readerId: 'threads.page', ok: false, reason: 'http_502', ms: 7_000 },
              { readerId: 'yt_dlp', ok: false, reason: 'invalid_json', ms: 5 }
            ]
          })
          return { status: 'failed', platform: 'threads', reason: 'http_502' }
        }
      },
      limits: { ...DEFAULT_MEDIA_LIMITS, maxVideoSeconds: 180 },
      model: 'fake-media-model',
      findTarget: findSocialPostTarget
    })
    const media = createTurnMedia({
      model: 'fake-media-model',
      limits: { ...DEFAULT_MEDIA_LIMITS, maxVideoSeconds: 180 },
      gatewayDirs: [],
      timeoutMs: 1000,
      links
    })
    const core = await startTestCore({ runner: scriptedRunner(() => 'Example: I could not open it.'), deps: { media } })
    core.activate(CHAT)
    await core.gateway.send(msg('m-lookup-2', POST))
    const row = core.storage.read((db) => db.prepare('SELECT reason, attempts FROM social_turn_lookup').get())
    expect(row).toEqual({
      reason: 'server_error',
      attempts: JSON.stringify([
        { reader: 'threads.page', ok: false, reason: 'server_error', ms: 7_000 },
        { reader: 'yt_dlp', ok: false, reason: 'invalid_json', ms: 5 }
      ])
    })
  })

  it('lists the valid local pictures in order, then the photos of the post named in the quoted text', async () => {
    expect(await imagesOfQuotingReply(true)).toEqual([
      { kind: 'file', attachment: { kind: 'image', path: `${HOST_CACHE}/images/img_a1b2.jpg` } },
      { kind: 'file', attachment: { kind: 'image', path: `${HOST_CACHE}/images/quoted_c3d4.jpg` } },
      { kind: 'url', url: photos[0] },
      { kind: 'url', url: photos[1] }
    ])
  })

  it('with media off, lists no local picture and keeps the post photos', async () => {
    expect(await imagesOfQuotingReply(false)).toEqual([
      { kind: 'url', url: photos[0] },
      { kind: 'url', url: photos[1] }
    ])
  })
})

describe('linked video reply labels', () => {
  it.each([
    { failure: false, type: 'video/mp4', labels: 'read the caption · watched the clip' },
    { failure: true, type: 'image/jpeg', labels: 'looked at an image' }
  ])('prints the configured labels for $type', async ({ failure, type, labels }) => {
    const url = 'https://www.tiktok.com/@example/video/1234567890'
    const target = findSocialPostTarget(url)!
    const post: SocialPost = {
      platform: 'tiktok',
      id: target.id,
      canonicalUrl: target.canonicalUrl,
      target,
      authorHandle: 'example',
      authorName: '',
      createdAt: null,
      text: 'A synthetic post',
      quotedText: '',
      quotedAuthorHandle: '',
      photoCount: 0,
      videoCount: 1,
      imageUrl: 'https://img.example/preview.jpg',
      photoUrls: [],
      durationSec: 12,
      thread: [],
      externalTitle: '',
      replyCount: null,
      video: { url: 'https://video.example/clip.mp4', bytes: null, headers: null, hasAudio: true }
    }
    const watcher = fakeWatcher(() => ({ description: 'A short clip or its preview.' }))
    const model = 'fake-media-model'
    const limits = { ...DEFAULT_MEDIA_LIMITS, maxVideoSeconds: 180 }
    const links = createLinkReader({
      viewer: { lookup: async () => ({ status: 'found', post }) },
      findTarget: findSocialPostTarget,
      watcher,
      limits,
      model,
      download: async (asset) => {
        if (asset === post.video?.url) {
          if (failure) throw new Error('http status 403')
          return { data: Buffer.from('00000010667479706d70343200000000', 'hex'), contentType: 'video/mp4' }
        }
        expect(asset).toBe(post.imageUrl)
        return { data: Buffer.from('ffd8ff', 'hex'), contentType: 'image/jpeg' }
      }
    })
    const media = createTurnMedia({ model, limits, timeoutMs: 1000, gatewayDirs: [], links })
    const config = testConfig()
    const dataDir = tmpDir('aira-linked-footer-')
    addPack(dataDir, 'custom')
    const cardPath = join(dataDir, 'characters', 'custom', 'card.yml')
    writeFileSync(
      cardPath,
      readFileSync(cardPath, 'utf8')
        .replace('media_post: read a post', 'media_post: read the caption')
        .replace('media_video: watched a video', 'media_video: watched the clip')
    )
    const core = await startTestCore({
      runner: scriptedRunner(() => 'Example: Nice clip.'),
      config,
      dataDir,
      defaultCharacter: 'custom',
      deps: { media, cleaner: createReplyCleaner(config) }
    })
    core.activate(CHAT)

    const delivery = await core.gateway.send(msg('m-1', url))

    expect(watcher.seen.map((asset) => asset.contentType)).toEqual([type])
    expect(delivery.content).toContain(`_🛠️ ${labels}_`)
  })
})
