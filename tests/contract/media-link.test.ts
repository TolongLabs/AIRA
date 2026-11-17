import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { parseConfig } from '../../src/config/loader.js'
import { type MediaWatcher, createGeminiWatcher, toGenerateContentUrlBody } from '../../src/media/gemini-watcher.js'
import { readMediaUrl } from '../../src/media/intake.js'
import { DEFAULT_MEDIA_LIMITS } from '../../src/media/limits.js'
import { type LinkPostViewer, type LinkTarget, createLinkReader } from '../../src/media/link-intake.js'
import { createTurnMedia } from '../../src/media/turn-media.js'
import { ModelError } from '../../src/models/types.js'
import { createLogger } from '../../src/records/logger.js'
import { createRedactor } from '../../src/records/redact.js'
import { setSetting } from '../../src/settings/settings.js'
import type { SocialPost, SocialPostLookup } from '../../src/social/types.js'
import { createCommandRouter } from '../../src/tools/commands.js'
import { registerCoreTools } from '../../src/tools/core/index.js'
import { createToolRegistry } from '../../src/tools/registry.js'
import { basicPromptBuilder } from '../../src/turn/defaults.js'
import type { PromptBuilder } from '../../src/turn/types.js'
import type { GatewayMessage } from '../harness/gateway.js'
import { scriptedRunner, startTestCore, testConfig } from '../support/core.js'
import { tmpDir, tmpStorage } from '../support/tmp.js'

const fakeKey = 'test-gemini-secret-key-000'
const HOST_CACHE = '/home/user/.hermes/cache'

const OK_GEMINI_BODY = JSON.stringify({
  candidates: [
    { content: { parts: [{ text: '{"description":"A presenter demos a gadget.","transcript":"Hello there."}' }] } }
  ],
  usageMetadata: { promptTokenCount: 410, candidatesTokenCount: 25 }
})

function makeTarget(platform: SocialPost['platform'], id: string, startSec?: number): LinkTarget {
  return { platform, id, ...(startSec !== undefined ? { startSec } : {}) } as LinkTarget
}

function makePost(overrides: Partial<SocialPost> = {}): SocialPost {
  const platform = overrides.platform ?? 'x'
  const id = overrides.id ?? '12345'
  const target = overrides.target ?? makeTarget(platform, id)
  return {
    platform,
    id,
    canonicalUrl: overrides.canonicalUrl ?? `https://x.com/testuser/status/${id}`,
    target,
    authorHandle: 'testuser',
    authorName: 'Test User',
    createdAt: '2026-11-01T00:00:00Z',
    text: 'Check this out',
    quotedText: '',
    quotedAuthorHandle: '',
    photoCount: 0,
    videoCount: 0,
    imageUrl: null,
    externalTitle: '',
    replyCount: null,
    durationSec: null,
    video: null,
    ...overrides
  }
}

/** Minimal fake URL matcher for tests; Order A provides the full URL parser in src/social/urls.ts. */
function fakeFindTarget(text: string): LinkTarget | null {
  const match = /https:\/\/([^\s/]+)(\/\S*)?/i.exec(text)
  if (!match) return null
  const host = (match[1] ?? '').toLowerCase()
  const rest = match[2] ?? ''
  if (host.includes('youtube.com') || host === 'youtu.be') {
    const tMatch = /[?&]t=(\d+)/.exec(rest)
    const idMatch = /[?&]v=([A-Za-z0-9_-]+)/.exec(rest) ?? /\/([A-Za-z0-9_-]{6,})/.exec(rest)
    return makeTarget('youtube', idMatch?.[1] ?? 'yt12345', tMatch ? Number(tMatch[1]) : undefined)
  }
  if (host === 'x.com' || host === 'twitter.com') {
    const idMatch = /\/status\/(\d+)/.exec(rest)
    if (!idMatch?.[1]) return null
    return makeTarget('x', idMatch[1])
  }
  if (host === 'bsky.app') {
    return makeTarget('bluesky', 'bsky1')
  }
  return null
}

beforeAll(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('global fetch must not be called in media-link tests')
  })
})

afterAll(() => {
  vi.unstubAllGlobals()
})

describe('media.maxLinkVideoSeconds configuration', () => {
  it('defaults to 600 in schema and is 600 in config.yml', () => {
    const source = readFileSync('config.yml', 'utf8')
    const parsed = parseConfig(source)
    expect(parsed.media.maxLinkVideoSeconds).toBe(600)

    const withoutKey = source.replace(/\n\s*maxLinkVideoSeconds:[^\n]*/, '')
    expect(parseConfig(withoutKey).media.maxLinkVideoSeconds).toBe(600)
  })
})

describe('gemini-watcher watchUrl and readMediaUrl', () => {
  it('builds a file_data request body with video_metadata offsets and low media resolution', () => {
    const withOffsets = toGenerateContentUrlBody({
      url: 'https://www.youtube.com/watch?v=vid12345678',
      startSec: 45,
      endSec: 645
    })
    expect(withOffsets).toEqual({
      contents: [
        {
          role: 'user',
          parts: [
            {
              file_data: {
                file_uri: 'https://www.youtube.com/watch?v=vid12345678',
                mime_type: 'video/mp4'
              },
              video_metadata: {
                start_offset: '45s',
                end_offset: '645s'
              }
            },
            {
              text: expect.stringContaining('120 words')
            }
          ]
        }
      ],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
        mediaResolution: 'MEDIA_RESOLUTION_LOW'
      }
    })

    const plain = toGenerateContentUrlBody({ url: 'https://www.youtube.com/watch?v=vid12345678' })
    const part = (plain['contents'] as { parts: Record<string, unknown>[] }[])[0]?.parts[0]
    expect(part).toEqual({
      file_data: {
        file_uri: 'https://www.youtube.com/watch?v=vid12345678',
        mime_type: 'video/mp4'
      }
    })
  })

  it('calls generateContent for watchUrl and maps 400 unavailable, 429 rate_limit, and 403 auth', async () => {
    let seenBody: unknown
    const watcher = createGeminiWatcher({
      apiKey: fakeKey,
      model: 'gemini-3.5-flash-lite',
      fetch: async (_input, init) => {
        seenBody = JSON.parse(String(init?.body))
        return new Response(OK_GEMINI_BODY, { status: 200 })
      }
    })

    const ok = await watcher.watchUrl!(
      { url: 'https://www.youtube.com/watch?v=vid12345678', startSec: 10, endSec: 610 },
      new AbortController().signal
    )
    expect(ok.reading.description).toBe('A presenter demos a gadget.')
    expect(ok.costUsd).toBe(0)
    expect(seenBody).toMatchObject({
      generationConfig: { mediaResolution: 'MEDIA_RESOLUTION_LOW' }
    })

    const unavailableWatcher = createGeminiWatcher({
      apiKey: fakeKey,
      model: 'gemini-3.5-flash-lite',
      fetch: async () => new Response('Cannot fetch content from the provided URL', { status: 400 })
    })
    const unavailableOutcome = await readMediaUrl(
      { url: 'https://www.youtube.com/watch?v=priv1234567' },
      { watcher: unavailableWatcher, timeoutMs: 1000 }
    )
    expect(unavailableOutcome).toMatchObject({
      ok: false,
      kind: 'video',
      reason: 'unavailable',
      failureKind: 'malformed'
    })

    const rateLimitedWatcher = createGeminiWatcher({
      apiKey: fakeKey,
      model: 'gemini-3.5-flash-lite',
      fetch: async () => new Response('Quota exceeded', { status: 429 })
    })
    const rateOutcome = await readMediaUrl(
      { url: 'https://www.youtube.com/watch?v=vid12345678' },
      { watcher: rateLimitedWatcher, timeoutMs: 1000 }
    )
    expect(rateOutcome).toMatchObject({
      ok: false,
      kind: 'video',
      reason: 'unreadable',
      failureKind: 'rate_limit'
    })
  })
})

describe('createLinkReader', () => {
  const baseLimits = { ...DEFAULT_MEDIA_LIMITS, maxVideoSeconds: 180, maxLinkVideoSeconds: 600 }

  it('clips longer YouTube videos at maxLinkVideoSeconds from t= start and labels the description', async () => {
    const watchUrlCalls: { url: string; startSec?: number; endSec?: number }[] = []
    const watcher: MediaWatcher = {
      async watch() {
        throw new Error('watch should not be called for YouTube')
      },
      async watchUrl(source) {
        watchUrlCalls.push({ url: source.url, startSec: source.startSec, endSec: source.endSec })
        return {
          reading: { description: 'Someone builds a clock.', transcript: 'Step one.' },
          usage: { inputTokens: 800, outputTokens: 30, cachedTokens: 0 },
          costUsd: 0,
          model: 'fake-media-model'
        }
      }
    }

    const posts = new Map<string, SocialPost>([
      [
        'long0',
        makePost({
          platform: 'youtube',
          id: 'long0',
          canonicalUrl: 'https://www.youtube.com/watch?v=long0',
          target: makeTarget('youtube', 'long0'),
          authorHandle: '',
          authorName: 'Clock Channel',
          externalTitle: 'Building a Clock',
          durationSec: 1500
        })
      ],
      [
        'longT',
        makePost({
          platform: 'youtube',
          id: 'longT',
          canonicalUrl: 'https://www.youtube.com/watch?v=longT',
          target: makeTarget('youtube', 'longT', 90),
          authorHandle: '',
          authorName: 'Clock Channel',
          externalTitle: 'Building a Clock',
          durationSec: 1500
        })
      ],
      [
        'short',
        makePost({
          platform: 'youtube',
          id: 'short',
          canonicalUrl: 'https://www.youtube.com/watch?v=short',
          target: makeTarget('youtube', 'short'),
          durationSec: 120
        })
      ],
      [
        'unknown',
        makePost({
          platform: 'youtube',
          id: 'unknown',
          canonicalUrl: 'https://www.youtube.com/watch?v=unknown',
          target: makeTarget('youtube', 'unknown', 30),
          durationSec: null
        })
      ]
    ])

    const viewer: LinkPostViewer = {
      async lookup(target) {
        const post = posts.get(target.id)
        return post ? { status: 'found', post } : { status: 'none' }
      }
    }

    const reader = createLinkReader({
      viewer,
      findTarget: fakeFindTarget,
      watcher,
      model: 'fake-media-model',
      limits: baseLimits
    })

    const longRes = await reader.read(['https://www.youtube.com/watch?v=long0'], 5000, { media: true, social: true })
    expect(watchUrlCalls[0]).toEqual({ url: 'https://www.youtube.com/watch?v=long0', startSec: 0, endSec: 600 })
    expect(longRes.links?.[0]?.reading?.description).toContain('Covers only the first part (0:00–10:00 of 25:00):')
    expect(longRes.unreadable).toEqual([])

    const longTRes = await reader.read(['https://www.youtube.com/watch?v=longT&t=90'], 5000, {
      media: true,
      social: true
    })
    expect(watchUrlCalls[1]).toEqual({ url: 'https://www.youtube.com/watch?v=longT', startSec: 90, endSec: 690 })
    expect(longTRes.links?.[0]?.reading?.description).toContain('Covers only the first part')
    expect(longTRes.links?.[0]?.reading?.description).toContain('1:30–11:30 of 25:00')

    const shortRes = await reader.read(['https://www.youtube.com/watch?v=short'], 5000, { media: true, social: true })
    expect(watchUrlCalls[2]).toEqual({
      url: 'https://www.youtube.com/watch?v=short',
      startSec: undefined,
      endSec: undefined
    })
    expect(shortRes.links?.[0]?.reading?.description).toBe('Someone builds a clock.')

    const unknownRes = await reader.read(['https://www.youtube.com/watch?v=unknown&t=30'], 5000, {
      media: true,
      social: true
    })
    expect(watchUrlCalls[3]).toEqual({ url: 'https://www.youtube.com/watch?v=unknown', startSec: 30, endSec: 630 })
    expect(unknownRes.links?.[0]?.reading?.description).toBe('Someone builds a clock.')
  })

  it('downloads social post video, falls back to imageUrl on failure, else text only', async () => {
    const watchedMimes: string[] = []
    const watcher: MediaWatcher = {
      async watch(file) {
        watchedMimes.push(file.contentType)
        return {
          reading: { description: `Watched ${file.contentType}` },
          usage: { inputTokens: 200, outputTokens: 15, cachedTokens: 0 },
          costUsd: 0,
          model: 'fake-media-model'
        }
      }
    }

    const postWithVideoAndImage = makePost({
      id: '99',
      videoCount: 1,
      photoCount: 1,
      durationSec: 20,
      video: { url: 'https://video.example/clip.mp4', bytes: 1000, headers: null, hasAudio: true },
      imageUrl: 'https://img.example/thumb.jpg'
    })

    const readerOk = createLinkReader({
      viewer: { lookup: async () => ({ status: 'found', post: postWithVideoAndImage }) },
      findTarget: fakeFindTarget,
      watcher,
      download: async (url) =>
        url.includes('video.')
          ? { data: Buffer.from('mp4-bytes'), contentType: 'video/mp4' }
          : { data: Buffer.from('jpg-bytes'), contentType: 'image/jpeg' },
      model: 'fake-media-model',
      limits: baseLimits
    })
    const videoRes = await readerOk.read(['https://x.com/testuser/status/99'], 5000, { media: true, social: true })
    expect(videoRes.links?.[0]?.mediaKind).toBe('video')
    expect(videoRes.links?.[0]?.reading?.description).toBe('Watched video/mp4')

    const readerFallback = createLinkReader({
      viewer: { lookup: async () => ({ status: 'found', post: postWithVideoAndImage }) },
      findTarget: fakeFindTarget,
      watcher,
      download: async (url) => {
        if (url.includes('video.')) throw new Error('403 forbidden')
        return { data: Buffer.from('jpg-bytes'), contentType: 'image/jpeg' }
      },
      model: 'fake-media-model',
      limits: baseLimits
    })
    const imgRes = await readerFallback.read(['https://x.com/testuser/status/99'], 5000, { media: true, social: true })
    expect(imgRes.links?.[0]?.mediaKind).toBe('image')
    expect(imgRes.links?.[0]?.reading?.description).toBe('Watched image/jpeg')

    const tooLongOrLarge = [
      makePost({
        id: '100',
        durationSec: 200,
        video: { url: 'https://video.example/long.mp4', bytes: 1000, headers: null, hasAudio: true },
        imageUrl: 'https://img.example/thumb.jpg'
      }),
      makePost({
        id: '101',
        durationSec: 20,
        video: { url: 'https://video.example/huge.mp4', bytes: baseLimits.maxBytes + 1, headers: null, hasAudio: true },
        imageUrl: 'https://img.example/thumb.jpg'
      })
    ]
    for (const post of tooLongOrLarge) {
      let downloadedVideo = false
      const readerLimitFallback = createLinkReader({
        viewer: { lookup: async () => ({ status: 'found', post }) },
        findTarget: fakeFindTarget,
        watcher,
        download: async (url) => {
          if (url.includes('video.')) downloadedVideo = true
          return { data: Buffer.from('jpg-bytes'), contentType: 'image/jpeg' }
        },
        model: 'fake-media-model',
        limits: baseLimits
      })
      const res = await readerLimitFallback.read(['https://x.com/testuser/status/100'], 5000, {
        media: true,
        social: true
      })
      expect(downloadedVideo).toBe(false)
      expect(res.links?.[0]?.mediaKind).toBe('image')
    }

    const readerTextOnly = createLinkReader({
      viewer: { lookup: async () => ({ status: 'found', post: postWithVideoAndImage }) },
      findTarget: fakeFindTarget,
      watcher,
      download: async () => {
        throw new Error('network error')
      },
      model: 'fake-media-model',
      limits: baseLimits
    })
    const textRes = await readerTextOnly.read(['https://x.com/testuser/status/99'], 5000, {
      media: true,
      social: true
    })
    expect(textRes.links?.[0]?.reading).toBeUndefined()
    expect(textRes.links?.[0]?.post.text).toBe('Check this out')
    expect(textRes.unreadable).toEqual([])
  })

  it('logs platform and reason without URL when a link lookup fails', async () => {
    const logLines: Record<string, unknown>[] = []
    const logger = createLogger({
      level: 'debug',
      module: 'link-test',
      sink: (line) => logLines.push(JSON.parse(line))
    })
    const secretUrl = 'https://x.com/testuser/status/987654321'
    const reader = createLinkReader({
      viewer: {
        async lookup() {
          return { status: 'failed', platform: 'x', reason: 'http_404' }
        }
      },
      findTarget: fakeFindTarget,
      model: 'fake-media-model',
      limits: baseLimits,
      logger
    })

    const res = await reader.read([secretUrl], 5000, { media: true, social: true })
    expect(res.unreadable).toEqual([{ kind: 'X link', reason: 'link' }])
    expect(logLines).toEqual([
      expect.objectContaining({ event: 'media.link_failed', platform: 'x', reason: 'http_404' })
    ])
    expect(JSON.stringify(logLines)).not.toContain(secretUrl)
    expect(JSON.stringify(res)).not.toContain(secretUrl)
  })
})

describe('turn pipeline link intake and media switch', () => {
  async function startPipelineTest(options: {
    lookup?: (target: LinkTarget) => Promise<SocialPostLookup>
    watchUrl?: (url: string) => Promise<{ description: string }> | never
    watchFile?: () => Promise<{ description: string }>
    withReadCommand?: boolean
  }) {
    const cache = join(tmpDir('aira-link-cache-'), 'cache')
    mkdirSync(join(cache, 'images'), { recursive: true })
    writeFileSync(join(cache, 'images', 'photo.jpg'), 'jpeg-bytes')

    const seenLookups: LinkTarget[] = []
    const seenWatchFiles: string[] = []
    const seenWatchUrls: string[] = []
    const capturedMedia: (string | undefined)[] = []

    const watcher: MediaWatcher = {
      async watch(file) {
        seenWatchFiles.push(file.contentType)
        const res = options.watchFile ? await options.watchFile() : { description: 'A photo.' }
        return {
          reading: res,
          usage: { inputTokens: 100, outputTokens: 10, cachedTokens: 0 },
          costUsd: 0,
          model: 'fake-media-model'
        }
      },
      async watchUrl(source) {
        seenWatchUrls.push(source.url)
        const res = options.watchUrl ? await options.watchUrl(source.url) : { description: 'A YouTube video.' }
        return {
          reading: res,
          usage: { inputTokens: 500, outputTokens: 20, cachedTokens: 0 },
          costUsd: 0,
          model: 'fake-media-model'
        }
      }
    }

    const viewer: LinkPostViewer = {
      async lookup(target) {
        seenLookups.push(target)
        if (options.lookup) return options.lookup(target)
        return {
          status: 'found',
          post: makePost({
            platform: target.platform,
            id: target.id,
            target,
            canonicalUrl:
              target.platform === 'youtube'
                ? `https://www.youtube.com/watch?v=${target.id}`
                : `https://x.com/testuser/status/${target.id}`,
            text: `Text for ${target.id}`
          })
        }
      }
    }

    const limits = { ...DEFAULT_MEDIA_LIMITS, maxVideoSeconds: 180, maxLinkVideoSeconds: 600 }
    const loggerSink: Record<string, unknown>[] = []
    const logger = createLogger({
      level: 'debug',
      module: 'core',
      sink: (line) => loggerSink.push(JSON.parse(line))
    })

    const media = createTurnMedia({
      watcher,
      links: createLinkReader({
        viewer,
        findTarget: fakeFindTarget,
        watcher,
        model: 'fake-media-model',
        limits,
        logger
      }),
      model: 'fake-media-model',
      limits,
      gatewayDirs: [{ host: HOST_CACHE, container: cache }],
      timeoutMs: 5000
    })

    let commandRouter: ReturnType<typeof createCommandRouter> | undefined
    let toolRegistry: ReturnType<typeof createToolRegistry> | undefined
    if (options.withReadCommand) {
      const storage = tmpStorage()
      toolRegistry = createToolRegistry({
        storage,
        config: { tools: { defaultTimeoutMs: 500 } },
        logger,
        redactor: createRedactor()
      })
      registerCoreTools(toolRegistry, {
        filesDir: tmpDir('aira-files-'),
        page: {
          async read(url) {
            return { title: 'Page', text: `Body of ${url}` }
          },
          async download() {
            return { data: Buffer.from('bytes'), contentType: 'text/plain' }
          }
        },
        post: {
          async read(url) {
            return { author: 'testuser', text: `Tool post ${url}`, media: [] }
          }
        }
      })
      commandRouter = createCommandRouter(toolRegistry)
    }

    const prompt: PromptBuilder = {
      build(input) {
        capturedMedia.push(input.media)
        return basicPromptBuilder.build(input)
      }
    }

    const core = await startTestCore({
      config: testConfig((c) => {
        c.turn.batchMs = 80
      }),
      logger,
      runner: scriptedRunner(() => 'okay!'),
      deps: {
        media,
        prompt,
        ...(commandRouter ? { commands: commandRouter, tools: toolRegistry } : {})
      }
    })
    const chatId = core.activate('test-chat-links')
    return { core, chatId, seenLookups, seenWatchFiles, seenWatchUrls, capturedMedia, logs: loggerSink }
  }

  const msg = (mid: string, text: string, extra: Partial<GatewayMessage> = {}): GatewayMessage => ({
    chat: { waId: 'test-chat-links', kind: 'group' },
    sender: 'test-member-alice',
    mid,
    text,
    ...extra
  })

  it('picks newest message text first, falls back to quote, and opens at most one link per turn', async () => {
    const { core, seenLookups, capturedMedia } = await startPipelineTest({})

    // Two batched messages: newest text link wins over older text link and quote link.
    await Promise.all([
      core.gateway.send(
        msg('m-1', 'older https://x.com/testuser/status/111', {
          quote: { text: 'quoted https://x.com/testuser/status/000', id: 'q-1' }
        })
      ),
      new Promise((resolve) => setTimeout(resolve, 15)).then(() =>
        core.gateway.send(msg('m-2', 'newer https://x.com/testuser/status/222 and https://x.com/testuser/status/333'))
      )
    ])
    expect(seenLookups.map((t) => t.id)).toEqual(['222'])
    expect(capturedMedia[0]).toContain('Text for 222')
    expect(capturedMedia[0]).not.toContain('111')
    expect(capturedMedia[0]).not.toContain('333')

    // Message text without a link falls back to the quote.
    await core.gateway.send(
      msg('m-3', 'what do you think?', {
        quote: { text: 'look at https://x.com/testuser/status/444', id: 'q-2' }
      })
    )
    expect(seenLookups.map((t) => t.id)).toEqual(['222', '444'])
    expect(capturedMedia[1]).toContain('Text for 444')
  })

  it('skips link intake when /read routes to read_post or read_page', async () => {
    const { core, seenLookups, capturedMedia } = await startPipelineTest({ withReadCommand: true })

    await core.gateway.send(msg('m-1', '/read https://x.com/testuser/status/555'))
    await core.gateway.send(msg('m-2', '/read https://example.com/article https://x.com/testuser/status/666'))

    expect(seenLookups).toEqual([])
    expect(capturedMedia).toEqual([undefined, undefined])
  })

  it('honours features.media and features.social switches for files, YouTube links, and social post links', async () => {
    const { core, chatId, seenLookups, seenWatchFiles, seenWatchUrls, capturedMedia } = await startPipelineTest({})

    // Turn features.media off while features.social stays on: files are marked off, YouTube is skipped, X is read.
    setSetting(core.storage, { level: 'chat', scope: chatId, key: 'features.media', value: false, actor: 'test' })
    await core.gateway.send(
      msg('m-1', 'watch https://www.youtube.com/watch?v=ytNoMedia1', {
        media: [{ kind: 'image', path: `${HOST_CACHE}/images/photo.jpg` }]
      })
    )
    expect(seenWatchFiles).toEqual([])
    expect(seenWatchUrls).toEqual([])
    expect(seenLookups).toEqual([])
    expect(capturedMedia[0]).toContain('- image: could not be read (media reading is off)')
    expect(capturedMedia[0]).not.toContain('ytNoMedia1')

    await core.gateway.send(msg('m-2', 'https://www.youtube.com/watch?v=ytSkipped https://x.com/testuser/status/777'))
    expect(seenLookups.map((t) => t.id)).toEqual(['777'])
    expect(seenWatchUrls).toEqual([])

    // Turn both switches off: neither files nor links are read.
    setSetting(core.storage, { level: 'chat', scope: chatId, key: 'features.social', value: false, actor: 'test' })
    await core.gateway.send(msg('m-3', 'https://x.com/testuser/status/888 and https://www.youtube.com/watch?v=ytOff'))
    expect(seenLookups).toHaveLength(1)
    expect(capturedMedia[2]).toBeUndefined()

    // Turn features.media back on while features.social is off: YouTube is read, X post is skipped.
    setSetting(core.storage, { level: 'chat', scope: chatId, key: 'features.media', value: true, actor: 'test' })
    await core.gateway.send(msg('m-4', 'https://x.com/testuser/status/889'))
    expect(seenLookups).toHaveLength(1)

    await core.gateway.send(msg('m-5', 'https://www.youtube.com/watch?v=ytOn123'))
    expect(seenLookups.map((t) => t.id)).toEqual(['777', 'ytOn123'])
    expect(seenWatchUrls).toEqual(['https://www.youtube.com/watch?v=ytOn123'])
  })

  it('turns a failed link and an unavailable YouTube video into unreadable notes without logging the URL', async () => {
    const failedUrl = 'https://x.com/testuser/status/999000111'
    const privateYtUrl = 'https://www.youtube.com/watch?v=priv9990001'
    const { core, capturedMedia, logs } = await startPipelineTest({
      lookup: async (target) => {
        if (target.platform === 'x') return { status: 'failed', platform: 'x', reason: 'http_404' }
        return {
          status: 'found',
          post: makePost({
            platform: 'youtube',
            id: target.id,
            target,
            canonicalUrl: privateYtUrl,
            authorHandle: '',
            authorName: '',
            text: '',
            externalTitle: ''
          })
        }
      },
      watchUrl: async () => {
        throw new ModelError('malformed', `HTTP 400: cannot fetch content for ${privateYtUrl}`)
      }
    })

    const r1 = await core.gateway.send(msg('m-1', `see ${failedUrl}`))
    expect(r1.content).toBe('okay!')
    expect(capturedMedia[0]).toContain('<media-unreadable>')
    expect(capturedMedia[0]).toContain('- X link: could not be read (could not open link)')
    expect(capturedMedia[0]).not.toContain(failedUrl)

    const r2 = await core.gateway.send(msg('m-2', `watch ${privateYtUrl}`))
    expect(r2.content).toBe('okay!')
    expect(capturedMedia[1]).toContain('- YouTube video: could not be read (private or removed)')
    expect(capturedMedia[1]).not.toContain(privateYtUrl)

    const failures = core.storage.read(
      (db) =>
        db.prepare('SELECT stage, kind, handled_by, message FROM failure ORDER BY id').all() as Record<
          string,
          unknown
        >[]
    )
    expect(failures).toEqual([
      { stage: 'media', kind: 'media_unreadable', handled_by: 'line:unreadableMedia', message: 'X link: link' },
      {
        stage: 'media',
        kind: 'media_unreadable',
        handled_by: 'line:unreadableMedia',
        message: 'YouTube video: unavailable'
      }
    ])

    const allLogs = JSON.stringify(logs)
    expect(allLogs).not.toContain(failedUrl)
    expect(allLogs).not.toContain(privateYtUrl)
  })

  it('raises a model_auth alert when watching a link fails with auth', async () => {
    const { core } = await startPipelineTest({
      watchUrl: async () => {
        throw new ModelError('auth', 'HTTP 403')
      }
    })

    await core.gateway.send(msg('m-1', 'https://www.youtube.com/watch?v=authFail123'))
    expect(core.alerts).toEqual([expect.objectContaining({ kind: 'model_auth', detail: { role: 'media' } })])
  })
})
