import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { parseConfig } from '../../src/config/loader.js'
import { createGeminiWatcher, type MediaWatcher, toGenerateContentUrlBody } from '../../src/media/gemini-watcher.js'
import { readMediaUrl } from '../../src/media/intake.js'
import { DEFAULT_MEDIA_LIMITS } from '../../src/media/limits.js'
import { createLinkReader, type LinkPostViewer, type LinkTarget } from '../../src/media/link-intake.js'
import { createTurnMedia, mediaPromptText } from '../../src/media/turn-media.js'
import { ModelError } from '../../src/models/types.js'
import { createLogger } from '../../src/records/logger.js'
import { createRedactor } from '../../src/records/redact.js'
import { setSetting } from '../../src/settings/settings.js'
import { enabledMirrorAsset } from '../../src/social/mirror-readers.js'
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
    photoUrls: [],
    thread: [],
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

  it('media link segment keys default to 12000, 180, 60 and 4 in schema and config.yml', () => {
    const source = readFileSync('config.yml', 'utf8')
    const parsed = parseConfig(source)
    expect(parsed.media.linkWatchMs).toBe(12000)
    expect(parsed.media.linkSegmentSeconds).toBe(180)
    expect(parsed.media.linkFirstSegmentSeconds).toBe(60)
    expect(parsed.media.maxLinkSegments).toBe(4)
    expect(parsed.media.linkFps).toBe(0.25)

    const withoutKeys = source
      .replace(/\n\s*linkWatchMs:[^\n]*/, '')
      .replace(/\n\s*linkSegmentSeconds:[^\n]*/, '')
      .replace(/\n\s*linkFirstSegmentSeconds:[^\n]*/, '')
      .replace(/\n\s*maxLinkSegments:[^\n]*/, '')
      .replace(/\n\s*linkFps:[^\n]*/, '')
    const defaults = parseConfig(withoutKeys).media
    expect(defaults.linkWatchMs).toBe(12000)
    expect(defaults.linkSegmentSeconds).toBe(180)
    expect(defaults.linkFirstSegmentSeconds).toBe(60)
    expect(defaults.maxLinkSegments).toBe(4)
    expect(defaults.linkFps).toBe(0.25)
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

    const withFps = toGenerateContentUrlBody({
      url: 'https://www.youtube.com/watch?v=vid12345678',
      startSec: 0,
      endSec: 60,
      fps: 0.25
    })
    const fpsPart = (withFps['contents'] as { parts: Record<string, unknown>[] }[])[0]?.parts[0]
    expect(fpsPart).toEqual({
      file_data: {
        file_uri: 'https://www.youtube.com/watch?v=vid12345678',
        mime_type: 'video/mp4'
      },
      video_metadata: {
        start_offset: '0s',
        end_offset: '60s',
        fps: 0.25
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

  it('watches verified Short bytes when the URL watcher fails', async () => {
    const target = { ...makeTarget('youtube', 'fixture1234'), youtubeShort: true as const }
    const post = makePost({
      id: target.id,
      platform: 'youtube',
      target,
      canonicalUrl: 'https://www.youtube.com/watch?v=fixture1234',
      durationSec: 35
    })
    const watcher: MediaWatcher = {
      watchUrl: async () => {
        throw new ModelError('transient', 'fixture')
      },
      watch: async () => ({
        reading: { description: 'Verified frames.' },
        usage: { inputTokens: 10, outputTokens: 3, cachedTokens: 0 },
        costUsd: 0,
        model: 'test'
      })
    }
    const reader = createLinkReader({
      viewer: { lookup: async () => ({ status: 'found', post }) },
      findTarget: () => target,
      watcher,
      model: 'test',
      limits: baseLimits,
      downloadShort: async () => ({ data: Buffer.from('fixture-video'), contentType: 'video/mp4' })
    })
    const result = await reader.read(['https://www.youtube.com/shorts/fixture1234'], 1000, {
      media: true,
      social: true
    })
    expect(result.links?.[0]).toMatchObject({ mediaKind: 'video', reading: { description: 'Verified frames.' } })
    expect(result.calls).toHaveLength(2)
  })

  it('clips longer YouTube videos at maxLinkVideoSeconds from t= start and labels the description', async () => {
    const watchUrlCalls: { url: string; startSec?: number; endSec?: number; fps?: number }[] = []
    const watcher: MediaWatcher = {
      async watch() {
        throw new Error('watch should not be called for YouTube')
      },
      async watchUrl(source) {
        watchUrlCalls.push({ url: source.url, startSec: source.startSec, endSec: source.endSec, fps: source.fps })
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
    expect(watchUrlCalls.slice(0, 4)).toEqual([
      { url: 'https://www.youtube.com/watch?v=long0', startSec: 0, endSec: 60, fps: 0.25 },
      { url: 'https://www.youtube.com/watch?v=long0', startSec: 60, endSec: 240, fps: 0.25 },
      { url: 'https://www.youtube.com/watch?v=long0', startSec: 240, endSec: 420, fps: 0.25 },
      { url: 'https://www.youtube.com/watch?v=long0', startSec: 420, endSec: 600, fps: 0.25 }
    ])
    expect(longRes.links?.[0]?.reading?.description).toContain('Covers only the first part (0:00–10:00 of 25:00):')
    expect(longRes.links?.[0]?.reading?.description).toContain('[0:00–1:00] Someone builds a clock.')
    expect(longRes.unreadable).toEqual([])

    const longTRes = await reader.read(['https://www.youtube.com/watch?v=longT&t=90'], 5000, {
      media: true,
      social: true
    })
    expect(watchUrlCalls.slice(4, 8)).toEqual([
      { url: 'https://www.youtube.com/watch?v=longT', startSec: 90, endSec: 150, fps: 0.25 },
      { url: 'https://www.youtube.com/watch?v=longT', startSec: 150, endSec: 330, fps: 0.25 },
      { url: 'https://www.youtube.com/watch?v=longT', startSec: 330, endSec: 510, fps: 0.25 },
      { url: 'https://www.youtube.com/watch?v=longT', startSec: 510, endSec: 690, fps: 0.25 }
    ])
    expect(longTRes.links?.[0]?.reading?.description).toContain('Covers only the first part')
    expect(longTRes.links?.[0]?.reading?.description).toContain('1:30–11:30 of 25:00')

    const shortRes = await reader.read(['https://www.youtube.com/watch?v=short'], 5000, { media: true, social: true })
    expect(watchUrlCalls[8]).toEqual({
      url: 'https://www.youtube.com/watch?v=short',
      startSec: undefined,
      endSec: undefined,
      fps: 0.25
    })
    expect(shortRes.links?.[0]?.reading?.description).toBe('Someone builds a clock.')

    const unknownRes = await reader.read(['https://www.youtube.com/watch?v=unknown&t=30'], 5000, {
      media: true,
      social: true
    })
    expect(watchUrlCalls[9]).toEqual({
      url: 'https://www.youtube.com/watch?v=unknown',
      startSec: 30,
      endSec: 210,
      fps: 0.25
    })
    expect(unknownRes.links?.[0]?.reading?.description).toContain(
      "Covers only 0:30–3:30; the video's length is unknown:"
    )
    expect(unknownRes.links?.[0]?.reading?.description).toContain('Someone builds a clock.')
  })

  it('watches a 10-minute YouTube video as 4 segments at once', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const seenSources: { startSec?: number; endSec?: number; fps?: number }[] = []
    let releaseAll!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseAll = resolve
    })

    const watcher: MediaWatcher = {
      async watch() {
        throw new Error('watch should not be called')
      },
      async watchUrl(source) {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        seenSources.push({ startSec: source.startSec, endSec: source.endSec, fps: source.fps })
        if (inFlight === 4) releaseAll()
        await gate
        inFlight--
        return {
          reading: { description: `Part ${source.startSec}-${source.endSec}.` },
          usage: { inputTokens: 300, outputTokens: 20, cachedTokens: 0 },
          costUsd: 0,
          model: 'fake-media-model'
        }
      }
    }

    const post = makePost({
      platform: 'youtube',
      id: 'tenmin',
      canonicalUrl: 'https://www.youtube.com/watch?v=tenmin',
      target: makeTarget('youtube', 'tenmin'),
      durationSec: 600
    })
    const reader = createLinkReader({
      viewer: { lookup: async () => ({ status: 'found', post }) },
      findTarget: fakeFindTarget,
      watcher,
      model: 'fake-media-model',
      limits: baseLimits
    })

    const res = await reader.read(['https://www.youtube.com/watch?v=tenmin'], 5000, { media: true, social: true })
    expect(maxInFlight).toBe(4)
    expect(seenSources).toEqual([
      { startSec: 0, endSec: 60, fps: 0.25 },
      { startSec: 60, endSec: 240, fps: 0.25 },
      { startSec: 240, endSec: 420, fps: 0.25 },
      { startSec: 420, endSec: 600, fps: 0.25 }
    ])
    expect(res.calls).toHaveLength(4)
    expect(res.unreadable).toEqual([])
    expect(res.partial).toBeUndefined()
    expect(res.links?.[0]?.reading?.description).toBe(
      '[0:00–1:00] Part 0-60. [1:00–4:00] Part 60-240. [4:00–7:00] Part 240-420. [7:00–10:00] Part 420-600.'
    )
  })

  it('keeps the segments that answered and names the parts not watched', async () => {
    const watcher: MediaWatcher = {
      async watch() {
        throw new Error('watch should not be called')
      },
      async watchUrl(source) {
        if (source.startSec === 240) throw new ModelError('rate_limit', 'HTTP 429')
        return {
          reading: { description: `Seg ${source.startSec}.` },
          usage: { inputTokens: 200, outputTokens: 15, cachedTokens: 0 },
          costUsd: 0,
          model: 'fake-media-model'
        }
      }
    }

    const post = makePost({
      platform: 'youtube',
      id: 'partial1',
      canonicalUrl: 'https://www.youtube.com/watch?v=partial1',
      target: makeTarget('youtube', 'partial1'),
      durationSec: 600
    })
    const reader = createLinkReader({
      viewer: { lookup: async () => ({ status: 'found', post }) },
      findTarget: fakeFindTarget,
      watcher,
      model: 'fake-media-model',
      limits: baseLimits
    })

    const res = await reader.read(['https://www.youtube.com/watch?v=partial1'], 5000, { media: true, social: true })
    expect(res.unreadable).toEqual([])
    expect(res.partial).toEqual([{ kind: 'YouTube video part 3 (4:00–7:00)', reason: 'unreadable' }])
    expect(res.links?.[0]?.reading?.description).toBe(
      'Not watched: 4:00–7:00. [0:00–1:00] Seg 0. [1:00–4:00] Seg 60. [7:00–10:00] Seg 420.'
    )
  })

  it('aborts unfinished segments at media.linkWatchMs', async () => {
    const started = Date.now()
    let segment4AbortedAt = 0
    const watcher: MediaWatcher = {
      async watch() {
        throw new Error('watch should not be called')
      },
      watchUrl(source, signal) {
        if (source.startSec !== 420) {
          return Promise.resolve({
            reading: { description: `Seg ${source.startSec}.` },
            usage: { inputTokens: 200, outputTokens: 10, cachedTokens: 0 },
            costUsd: 0,
            model: 'fake-media-model'
          })
        }
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              segment4AbortedAt = Date.now() - started
              reject(new ModelError('transient', 'aborted'))
            },
            { once: true }
          )
        })
      }
    }

    const post = makePost({
      platform: 'youtube',
      id: 'watchcap',
      canonicalUrl: 'https://www.youtube.com/watch?v=watchcap',
      target: makeTarget('youtube', 'watchcap'),
      durationSec: 600
    })
    const reader = createLinkReader({
      viewer: { lookup: async () => ({ status: 'found', post }) },
      findTarget: fakeFindTarget,
      watcher,
      model: 'fake-media-model',
      limits: { ...baseLimits, linkWatchMs: 50 }
    })

    const res = await reader.read(['https://www.youtube.com/watch?v=watchcap'], 5000, { media: true, social: true })
    expect(segment4AbortedAt).toBeGreaterThanOrEqual(35)
    expect(segment4AbortedAt).toBeLessThan(200)
    expect(res.partial).toEqual([{ kind: 'YouTube video part 4 (7:00–10:00)', reason: 'unreadable' }])
    expect(res.calls[3]).toMatchObject({ role: 'media', failureKind: 'transient' })
    expect(res.links?.[0]?.reading?.description).toContain('Not watched: 7:00–10:00.')
  })

  it('never waits past the link reader timeout', async () => {
    const started = Date.now()
    let abortedAt = 0
    const watcher: MediaWatcher = {
      async watch() {
        throw new Error('watch should not be called')
      },
      watchUrl(_source, signal) {
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              abortedAt = Date.now() - started
              reject(new ModelError('transient', 'aborted'))
            },
            { once: true }
          )
        })
      }
    }

    const post = makePost({
      platform: 'youtube',
      id: 'readercap',
      canonicalUrl: 'https://www.youtube.com/watch?v=readercap',
      target: makeTarget('youtube', 'readercap'),
      durationSec: 600
    })
    const reader = createLinkReader({
      viewer: { lookup: async () => ({ status: 'found', post }) },
      findTarget: fakeFindTarget,
      watcher,
      model: 'fake-media-model',
      limits: { ...baseLimits, linkWatchMs: 12000 }
    })

    const res = await reader.read(['https://www.youtube.com/watch?v=readercap'], 40, { media: true, social: true })
    expect(abortedAt).toBeGreaterThanOrEqual(25)
    expect(abortedAt).toBeLessThan(200)
    expect(res.unreadable).toEqual([{ kind: 'YouTube video', reason: 'unreadable' }])
  })

  it('gives one unreadable note when every segment fails, unavailable when one was unavailable', async () => {
    const post = makePost({
      platform: 'youtube',
      id: 'allfail',
      canonicalUrl: 'https://www.youtube.com/watch?v=allfail',
      target: makeTarget('youtube', 'allfail'),
      externalTitle: 'All Fail Video',
      authorName: 'Channel',
      durationSec: 600
    })

    const unreadableReader = createLinkReader({
      viewer: { lookup: async () => ({ status: 'found', post }) },
      findTarget: fakeFindTarget,
      watcher: {
        async watch() {
          throw new Error('watch should not be called')
        },
        async watchUrl() {
          throw new ModelError('rate_limit', 'HTTP 429')
        }
      },
      model: 'fake-media-model',
      limits: baseLimits
    })
    const r1 = await unreadableReader.read(['https://www.youtube.com/watch?v=allfail'], 5000, {
      media: true,
      social: true
    })
    expect(r1.unreadable).toEqual([{ kind: 'YouTube video', reason: 'unreadable' }])
    expect(r1.partial).toBeUndefined()
    expect(r1.links).toEqual([expect.objectContaining({ post })])
    expect(r1.calls).toHaveLength(4)

    const mixedReader = createLinkReader({
      viewer: { lookup: async () => ({ status: 'found', post }) },
      findTarget: fakeFindTarget,
      watcher: {
        async watch() {
          throw new Error('watch should not be called')
        },
        async watchUrl(source) {
          if (source.startSec === 60) {
            throw new ModelError('malformed', 'HTTP 400: cannot fetch content')
          }
          throw new ModelError('transient', 'HTTP 503')
        }
      },
      model: 'fake-media-model',
      limits: baseLimits
    })
    const r2 = await mixedReader.read(['https://www.youtube.com/watch?v=allfail'], 5000, {
      media: true,
      social: true
    })
    expect(r2.unreadable).toEqual([{ kind: 'YouTube video', reason: 'unavailable' }])
    expect(r2.partial).toBeUndefined()
    expect(r2.links).toEqual([expect.objectContaining({ post })])
    expect(r2.calls).toHaveLength(4)
  })

  it('sends a short video with no offsets, as before', async () => {
    const seenSources: { url: string; mimeType?: string; startSec?: number; endSec?: number; fps?: number }[] = []
    const reader = createLinkReader({
      viewer: {
        lookup: async () => ({
          status: 'found',
          post: makePost({
            platform: 'youtube',
            id: 'short1',
            canonicalUrl: 'https://www.youtube.com/watch?v=short1',
            target: makeTarget('youtube', 'short1'),
            durationSec: 120
          })
        })
      },
      findTarget: fakeFindTarget,
      watcher: {
        async watch() {
          throw new Error('watch should not be called')
        },
        async watchUrl(source) {
          seenSources.push(source)
          return {
            reading: { description: 'A short video.' },
            usage: { inputTokens: 100, outputTokens: 10, cachedTokens: 0 },
            costUsd: 0,
            model: 'fake-media-model'
          }
        }
      },
      model: 'fake-media-model',
      limits: baseLimits
    })

    const res = await reader.read(['https://www.youtube.com/watch?v=short1'], 5000, { media: true, social: true })
    expect(seenSources).toEqual([{ url: 'https://www.youtube.com/watch?v=short1', mimeType: 'video/mp4', fps: 0.25 }])
    expect(seenSources[0]?.startSec).toBeUndefined()
    expect(seenSources[0]?.endSec).toBeUndefined()
    expect(res.links?.[0]?.reading).toEqual({ description: 'A short video.' })
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

  it('retries a transient video watch using the same bytes before trying the preview', async () => {
    const watch = vi
      .fn<MediaWatcher['watch']>()
      .mockRejectedValueOnce(new ModelError('transient', 'temporary outage'))
      .mockResolvedValueOnce({
        reading: { description: 'A train is moving.' },
        usage: { inputTokens: 12, outputTokens: 4, cachedTokens: 0 },
        model: 'test',
        costUsd: 0
      })
    const download = vi.fn(async () => ({ data: Buffer.from('clip'), contentType: 'video/mp4' }))
    const post = makePost({
      videoCount: 1,
      durationSec: 270,
      video: { url: 'https://video.example/clip.mp4', bytes: 4, headers: null, hasAudio: true },
      imageUrl: 'https://img.example/preview.jpg'
    })
    const reader = createLinkReader({
      findTarget: fakeFindTarget,
      viewer: { lookup: async () => ({ status: 'found', post }) },
      watcher: { watch },
      download,
      model: 'test',
      limits: { ...baseLimits, maxVideoSeconds: 300 }
    })
    const result = await reader.read(['https://x.com/testuser/status/7'], 5000, { media: true, social: true })
    expect(download).toHaveBeenCalledTimes(1)
    expect(result.links?.[0]).toMatchObject({ mediaKind: 'video', reading: { description: 'A train is moving.' } })
    expect(result.calls.map((c) => [c.attempt, c.failureKind])).toEqual([
      [1, 'transient'],
      [2, undefined]
    ])
  })

  it('watches every photo of a post at once, up to 4, and names the rest', async () => {
    let running = 0
    let maxRunning = 0
    const watched: string[] = []
    const watcher: MediaWatcher = {
      async watch(file) {
        running++
        maxRunning = Math.max(maxRunning, running)
        await new Promise((resolve) => setTimeout(resolve, 5))
        running--
        const name = file.data.toString()
        watched.push(name)
        if (name === 'p3') throw new ModelError('transient', 'boom')
        return {
          reading: { description: `Shows ${name}` },
          usage: { inputTokens: 10, outputTokens: 5, cachedTokens: 0 },
          costUsd: 0,
          model: 'fake-media-model'
        }
      }
    }
    const photoUrls = Array.from({ length: 6 }, (_, index) => `https://img.example/p${index + 1}.jpg`)
    const reader = createLinkReader({
      viewer: {
        lookup: async () => ({
          status: 'found',
          post: makePost({ photoCount: 6, photoUrls, imageUrl: photoUrls[0]! })
        })
      },
      findTarget: fakeFindTarget,
      watcher,
      download: async (url) => ({
        data: Buffer.from(/\/(p\d)\.jpg$/.exec(url)?.[1] ?? '?'),
        contentType: 'image/jpeg'
      }),
      model: 'fake-media-model',
      limits: baseLimits
    })

    const result = await reader.read(['https://x.com/testuser/status/7'], 5000, { media: true, social: true })

    expect(maxRunning).toBe(4)
    expect(watched.sort()).toEqual(['p1', 'p2', 'p3', 'p3', 'p4'])
    expect(result.links?.[0]?.mediaKind).toBe('image')
    expect(result.links?.[0]?.reading?.description).toBe(
      [
        'photo 1: Shows p1',
        'photo 2: Shows p2',
        'photo 4: Shows p4',
        '(1 photo could not be read; 2 more not watched)'
      ].join(' | ')
    )
    expect(result.calls).toHaveLength(5)
    expect(result.calls.filter((call) => call.failureKind).map((call) => call.attempt)).toEqual([1, 2])
  })

  it('watches the photos of the earlier posts in a thread after the linked post, and a video with them', async () => {
    const watcher: MediaWatcher = {
      async watch(file) {
        return {
          reading: { description: `Shows ${file.data.toString()}` },
          usage: { inputTokens: 10, outputTokens: 5, cachedTokens: 0 },
          costUsd: 0,
          model: 'fake-media-model'
        }
      }
    }
    const post = makePost({
      platform: 'threads',
      videoCount: 1,
      durationSec: 10,
      video: { url: 'https://video.example/clip.mp4', bytes: 1000, headers: null, hasAudio: true },
      imageUrl: 'https://img.example/card.jpg',
      thread: [
        {
          authorHandle: 'testuser',
          text: 'The original post',
          photoUrls: ['https://img.example/t1.jpg', 'https://img.example/t2.jpg']
        }
      ]
    })
    const downloaded: string[] = []
    const reader = createLinkReader({
      viewer: { lookup: async () => ({ status: 'found', post }) },
      findTarget: fakeFindTarget,
      watcher,
      download: async (url) => {
        downloaded.push(url)
        return url.includes('video.')
          ? { data: Buffer.from('clip'), contentType: 'video/mp4' }
          : { data: Buffer.from(/\/(\w+)\.jpg$/.exec(url)?.[1] ?? '?'), contentType: 'image/jpeg' }
      },
      model: 'fake-media-model',
      limits: baseLimits
    })

    const result = await reader.read(['https://x.com/testuser/status/8'], 5000, { media: true, social: true })

    expect(downloaded).not.toContain('https://img.example/card.jpg')
    expect(result.links?.[0]?.mediaKind).toBe('video')
    expect(result.links?.[0]?.reading?.description).toBe(
      ['video: Shows clip', 'earlier post, photo 1: Shows t1', 'earlier post, photo 2: Shows t2'].join(' | ')
    )
  })

  it('falls back to the one picture when no photo or video could be read', async () => {
    const watcher: MediaWatcher = {
      async watch(file) {
        return {
          reading: { description: `Shows ${file.data.toString()}` },
          usage: { inputTokens: 10, outputTokens: 5, cachedTokens: 0 },
          costUsd: 0,
          model: 'fake-media-model'
        }
      }
    }
    const reader = createLinkReader({
      viewer: {
        lookup: async () => ({
          status: 'found',
          post: makePost({ photoUrls: ['https://img.example/gone.jpg'], imageUrl: 'https://img.example/card.jpg' })
        })
      },
      findTarget: fakeFindTarget,
      watcher,
      download: async (url) => {
        if (url.includes('gone')) throw new Error('404')
        return { data: Buffer.from('card'), contentType: 'image/jpeg' }
      },
      model: 'fake-media-model',
      limits: baseLimits
    })

    const result = await reader.read(['https://x.com/testuser/status/9'], 5000, { media: true, social: true })

    expect(result.links?.[0]?.reading?.description).toBe('Shows card')
  })

  it('labels a video thumbnail and suppresses any transcript after a media download refusal', async () => {
    const logLines: Record<string, unknown>[] = []
    const reader = createLinkReader({
      viewer: {
        lookup: async () => ({
          status: 'found',
          post: makePost({
            videoCount: 1,
            imageUrl: 'https://img.example/cover.jpg',
            video: {
              url: 'https://video.example/clip.mp4?signature=fixture',
              bytes: 100,
              headers: null,
              hasAudio: true
            }
          })
        })
      },
      findTarget: fakeFindTarget,
      watcher: {
        async watch() {
          return {
            reading: { description: 'A still frame', transcript: 'Imagined audio' },
            usage: { inputTokens: 10, outputTokens: 5, cachedTokens: 0 },
            costUsd: 0,
            model: 'fake-media-model'
          }
        }
      },
      async download(url) {
        if (url.includes('video.example')) throw new Error('http status 403')
        return { data: Buffer.from('image'), contentType: 'image/jpeg' }
      },
      model: 'fake-media-model',
      limits: baseLimits,
      logger: createLogger({ level: 'warn', module: 'link-test', sink: (line) => logLines.push(JSON.parse(line)) })
    })
    const result = await reader.read(['https://x.com/testuser/status/9'], 5000, { media: true, social: true })
    const prompt = mediaPromptText(result, 'Could not read the media.')
    expect(result.links?.[0]?.mediaKind).toBe('image')
    expect(result.calls).toHaveLength(1)
    expect(prompt).toContain('preview image: A still frame')
    expect(prompt).toContain('No video or audio was observed.')
    expect(prompt).not.toContain('Imagined audio')
    expect(logLines).toContainEqual(
      expect.objectContaining({
        event: 'media.link_download_failed',
        platform: 'x',
        mediaKind: 'video',
        reason: 'http_403'
      })
    )
    expect(JSON.stringify(logLines)).not.toContain('signature=fixture')
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
    watchUrl?: (
      source: { url: string; startSec?: number; endSec?: number; fps?: number },
      signal: AbortSignal
    ) => Promise<{ description: string; transcript?: string }> | never
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
      async watchUrl(source, signal) {
        seenWatchUrls.push(source.url)
        const res = options.watchUrl ? await options.watchUrl(source, signal) : { description: 'A YouTube video.' }
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
            return {
              untrusted: true,
              author: 'testuser',
              text: `Tool post ${url}`,
              media: [],
              platform: 'x',
              handle: 'testuser',
              createdAt: null,
              quotedText: '',
              replyCount: null,
              canonicalUrl: url,
              thread: [],
              replies: [],
              durationSec: null
            }
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

  it('reads the link of a /read message at intake, as /read is no longer a command', async () => {
    const { core, seenLookups, capturedMedia } = await startPipelineTest({ withReadCommand: true })

    await core.gateway.send(msg('m-1', '/read https://x.com/testuser/status/555'))

    expect(seenLookups.map((target) => target.id)).toEqual(['555'])
    expect(capturedMedia[0]).toBeDefined()
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
    expect(capturedMedia[0]).toContain('(The image could not be opened.)')
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
    expect(capturedMedia[0]).toContain('(The X post could not be opened.)')
    expect(capturedMedia[0]).not.toContain(failedUrl)

    const r2 = await core.gateway.send(msg('m-2', `watch ${privateYtUrl}`))
    expect(r2.content).toBe('okay!')
    expect(capturedMedia[1]).toContain('(The YouTube video could not be opened.)')
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

  it('writes one model_call row per segment, with the failure kind on the failed one', async () => {
    const { core } = await startPipelineTest({
      lookup: async (target) => ({
        status: 'found',
        post: makePost({
          platform: 'youtube',
          id: target.id,
          target,
          canonicalUrl: `https://www.youtube.com/watch?v=${target.id}`,
          durationSec: 600
        })
      }),
      watchUrl: async (source) => {
        if (source.startSec === 240) throw new ModelError('rate_limit', 'HTTP 429')
        return { description: `Watched ${source.startSec}-${source.endSec}.` }
      }
    })

    await core.gateway.send(msg('m-1', 'https://www.youtube.com/watch?v=callsSeg1'))
    const calls = core.storage.read(
      (db) =>
        db
          .prepare(
            "SELECT role, model, attempt, input_tokens, cost_usd, failure_kind FROM model_call WHERE role = 'media' ORDER BY id"
          )
          .all() as Record<string, unknown>[]
    )
    expect(calls).toEqual([
      { role: 'media', model: 'fake-media-model', attempt: 1, input_tokens: 500, cost_usd: 0, failure_kind: null },
      { role: 'media', model: 'fake-media-model', attempt: 1, input_tokens: 500, cost_usd: 0, failure_kind: null },
      {
        role: 'media',
        model: 'fake-media-model',
        attempt: 1,
        input_tokens: null,
        cost_usd: null,
        failure_kind: 'rate_limit'
      },
      { role: 'media', model: 'fake-media-model', attempt: 1, input_tokens: 500, cost_usd: 0, failure_kind: null }
    ])
  })

  it('turns a partial reading into media_unreadable failures handled by coverage:partial, with no note in block 4', async () => {
    const partialUrl = 'https://www.youtube.com/watch?v=partialPipe1'
    const { core, capturedMedia, logs } = await startPipelineTest({
      lookup: async (target) => ({
        status: 'found',
        post: makePost({
          platform: 'youtube',
          id: target.id,
          target,
          canonicalUrl: partialUrl,
          durationSec: 600
        })
      }),
      watchUrl: async (source) => {
        if (source.startSec === 240) throw new ModelError('rate_limit', 'HTTP 429')
        return { description: `Segment ${source.startSec}.` }
      }
    })

    const reply = await core.gateway.send(msg('m-1', `watch ${partialUrl}`))
    expect(reply.content).toBe('okay!')
    expect(capturedMedia[0]).toContain('<media untrusted="true">')
    expect(capturedMedia[0]).toContain('Not watched: 4:00–7:00.')
    expect(capturedMedia[0]).not.toContain('<media-unreadable>')

    const failures = core.storage.read(
      (db) =>
        db.prepare('SELECT stage, kind, handled_by, message FROM failure ORDER BY id').all() as Record<
          string,
          unknown
        >[]
    )
    expect(failures).toEqual([
      {
        stage: 'media',
        kind: 'media_unreadable',
        handled_by: 'coverage:partial',
        message: 'YouTube video part 3 (4:00–7:00): unreadable'
      }
    ])
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: 'media.link_segments',
        segments: 4,
        answered: 3,
        failed: 1,
        watchMs: expect.any(Number)
      })
    )
    expect(JSON.stringify(logs)).not.toContain(partialUrl)
  })
})

it('watches a compressed linked MP4 that exceeds the watcher budget', async () => {
  const input = Buffer.concat([Buffer.from('00000010667479706d70343200000000', 'hex'), Buffer.alloc(100)])
  const output = input.subarray(0, 32)
  const post = makePost({
    durationSec: 20,
    video: { url: 'https://video.example/large.mp4', bytes: input.length, headers: null, hasAudio: true }
  })
  const reader = createLinkReader({
    viewer: { lookup: async () => ({ status: 'found', post }) },
    findTarget: fakeFindTarget,
    watcher: {
      async watch(file) {
        expect(file.data).toEqual(output)
        return {
          reading: { description: 'Compressed video' },
          usage: { inputTokens: 10, outputTokens: 2, cachedTokens: 0 },
          costUsd: 0,
          model: 'test'
        }
      }
    },
    download: async (_url, _signal, maxBytes) => {
      if (maxBytes < input.length) throw new Error('response exceeds size limit')
      return { data: input, contentType: 'video/mp4' }
    },
    compressVideo: async (data) => {
      expect(data).toEqual(input)
      return output
    },
    model: 'test',
    limits: { ...DEFAULT_MEDIA_LIMITS, maxVideoSeconds: 180, maxBytes: 64 }
  })
  const result = await reader.read(['https://x.com/testuser/status/99'], 5000, { media: true, social: true })
  expect(result.links?.[0]?.reading?.description).toBe('Compressed video')
})

it('does not download a compression-sized file for a video of unknown length, and logs a failed compression', async () => {
  const caps: number[] = []
  const logs: Record<string, unknown>[] = []
  const input = Buffer.concat([Buffer.from('00000010667479706d70343200000000', 'hex'), Buffer.alloc(100)])
  const reader = (durationSec: number | null) =>
    createLinkReader({
      viewer: {
        lookup: async () => ({
          status: 'found',
          post: makePost({
            durationSec,
            video: { url: 'https://video.example/large.mp4', bytes: null, headers: null, hasAudio: true }
          })
        })
      },
      findTarget: fakeFindTarget,
      watcher: {
        async watch() {
          throw new Error('not watched')
        }
      },
      download: async (_url, _signal, maxBytes) => {
        caps.push(maxBytes)
        return { data: input, contentType: 'video/mp4' }
      },
      compressVideo: async () => undefined,
      logger: createLogger({ level: 'warn', module: 'test', sink: (line) => logs.push(JSON.parse(line)) }),
      model: 'test',
      limits: { ...DEFAULT_MEDIA_LIMITS, maxVideoSeconds: 180, maxBytes: 64 }
    })
  await reader(null).read(['https://x.com/testuser/status/99'], 5000, { media: true, social: true })
  await reader(20).read(['https://x.com/testuser/status/99'], 5000, { media: true, social: true })
  expect(caps[0]).toBe(64)
  expect(caps.at(-1)).toBeGreaterThan(64)
  expect(logs).toContainEqual(expect.objectContaining({ event: 'media.link_compress_failed', reason: 'no_output' }))
})

it('keeps the attempts of a lookup that ran out of time', async () => {
  let seen: unknown
  const reader = createLinkReader({
    viewer: {
      lookup: (_target, signal, trace) =>
        new Promise((resolve) => {
          // Like the real chain, the aborted lookup reports its attempts a moment after the abort.
          signal?.addEventListener('abort', () => {
            setTimeout(() => {
              trace?.({ attempts: [{ readerId: 'x.fxtwitter', ok: false, reason: 'timeout', ms: 50 }] })
              resolve({ status: 'failed', platform: 'x', reason: 'timeout' })
            }, 20)
          })
        })
    },
    findTarget: fakeFindTarget,
    model: 'test',
    limits: { ...DEFAULT_MEDIA_LIMITS, maxVideoSeconds: 180 }
  })
  await reader.read(['https://x.com/testuser/status/99'], 50, { media: true, social: true }, undefined, (event) => {
    seen = event.trace
  })
  expect(seen).toEqual({ attempts: [{ readerId: 'x.fxtwitter', ok: false, reason: 'timeout', ms: 50 }] })
})

describe('lemon8 intake download policy', () => {
  const LEMON8_IMG = 'https://p16-lemon8-cross-sign.tiktokcdn.com/tos-maliva-i-avgv0qqbbk-jp/abc123.webp'
  const LEMON8_CLIP = 'https://v16-lemon8.tiktokcdn.com/tos-maliva-v-avgv0qqbbk-jp/clip012.mp4'

  it('does not classify Lemon8 CDN bytes as a TikTok mirror asset', () => {
    for (const url of [LEMON8_IMG, LEMON8_CLIP]) {
      expect(enabledMirrorAsset(url, 'lemon8', { tiktok: 'read_and_group' })).toBe(false)
      expect(enabledMirrorAsset(url, 'tiktok', { tiktok: 'read_and_group' })).toBe(true)
      expect(enabledMirrorAsset(url, 'tiktok', { tiktok: 'off' })).toBe(false)
    }
  })

  it('passes the source platform into the intake downloader', async () => {
    const download = vi.fn(async () => ({ data: Buffer.from('image-bytes'), contentType: 'image/jpeg' }))
    const post = makePost({
      platform: 'lemon8',
      id: '7234567890123456789',
      canonicalUrl: 'https://www.lemon8-app.com/@sample/7234567890123456789',
      target: makeTarget('lemon8', '7234567890123456789'),
      photoCount: 1,
      photoUrls: [LEMON8_IMG],
      imageUrl: LEMON8_IMG
    })
    const watcher: MediaWatcher = {
      async watch(file) {
        return {
          reading: { description: `Shows ${file.contentType}` },
          usage: { inputTokens: 10, outputTokens: 5, cachedTokens: 0 },
          costUsd: 0,
          model: 'fake-media-model'
        }
      }
    }
    const reader = createLinkReader({
      viewer: { lookup: async () => ({ status: 'found', post }) },
      findTarget: fakeFindTarget,
      watcher,
      download,
      model: 'fake-media-model',
      limits: { ...DEFAULT_MEDIA_LIMITS, maxVideoSeconds: 180, maxLinkVideoSeconds: 600 }
    })
    const result = await reader.read(['https://x.com/testuser/status/99'], 5000, { media: true, social: true })
    expect(result.links?.[0]?.reading?.description).toContain('Shows image/jpeg')
    expect(download).toHaveBeenCalledWith(
      LEMON8_IMG,
      expect.any(AbortSignal),
      expect.any(Number),
      undefined,
      undefined,
      'lemon8'
    )
  })
})
