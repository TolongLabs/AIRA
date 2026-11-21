import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createGatewayServer } from '../../src/gateway/server.js'
import { type AutofetchBatch, createAutofetch } from '../../src/media/autofetch.js'
import type { MediaWatcher } from '../../src/media/gemini-watcher.js'
import { DEFAULT_MEDIA_LIMITS } from '../../src/media/limits.js'
import { createLinkReader } from '../../src/media/link-intake.js'
import { createLogger } from '../../src/records/logger.js'
import { createRedactor } from '../../src/records/redact.js'
import { ensureChat, setChatStatus } from '../../src/settings/chats.js'
import { setSetting } from '../../src/settings/settings.js'
import { type SocialMirrorSettings, socialCapabilities } from '../../src/social/readers.js'
import { parseOfficialSocialPostUrl } from '../../src/social/urls.js'
import { SocialPostViewer } from '../../src/social/viewer.js'
import { createFetchPagePort } from '../../src/tools/ports.js'
import type { TurnService } from '../../src/turn/pipeline.js'
import { tmpDir, tmpStorage } from '../support/tmp.js'

const tikTokLink = 'https://vt.tiktok.com/Fixture1/'
const nativeTikTok = 'https://www.tiktok.com/@example/video/1234567890'
const redditLink = 'https://www.reddit.com/r/example/s/Fixture2/'
const nativeReddit = 'https://www.reddit.com/r/example/comments/abc123/sample/'
const tikTokAsset = 'https://v16m.tiktokcdn-us.com/sample.mp4'
const redditAsset = 'https://v.redd.it/fixture/DASH_720.mp4'
const redditPhoto = 'https://i.redd.it/fixture.png'
const redditPreview = 'https://preview.redd.it/fixture.png'
const mp4 = Buffer.from('00000010667479706d70343200000000', 'hex')
const largeMp4 = Buffer.concat([mp4, Buffer.alloc(8_000_001 - mp4.length, 0x42)])
const lookup = async () => ['8.8.8.8']
const logger = createLogger({ level: 'error', module: 'test', sink: () => {} })

function stack(
  mirrors: SocialMirrorSettings,
  options: {
    wrongId?: boolean
    foreignAsset?: boolean
    redditRefusal?: number
    redditPhoto?: 'native' | 'preview' | 'crosspost'
    redditFeed?: 'photo' | 'video'
    archiveRefusal?: number
    ranges?: 'valid' | 'invalid' | 'stall' | 'drop'
  } = {}
) {
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.href === tikTokLink || url.href === redditLink) {
      return new Response(null, {
        status: 301,
        headers: { location: url.href === tikTokLink ? nativeTikTok : nativeReddit }
      })
    }
    if (url.hostname === 'www.tikwm.com') {
      expect(url.searchParams.get('url')).toBe(nativeTikTok)
      return Response.json({
        code: 0,
        data: {
          id: options.wrongId ? '999' : '1234567890',
          title: 'A short video',
          author: { unique_id: 'example' },
          duration: 12,
          ...(options.ranges ? { wm_size: largeMp4.length } : {}),
          wmplay: options.foreignAsset ? 'https://unrelated.example/test.mp4' : tikTokAsset
        }
      })
    }
    if (options.redditRefusal && url.pathname.endsWith('/.rss')) {
      return new Response(null, { status: options.redditRefusal })
    }
    if (options.redditFeed && url.pathname.endsWith('/.rss')) {
      return new Response(
        `<feed><entry><author><name>/u/example</name></author><category term="example"/>` +
          `<content type="html">&lt;span&gt;&lt;a href=&quot;${options.redditFeed === 'video' ? 'https://v.redd.it/fixture' : redditPhoto}&quot;&gt;[link]&lt;/a&gt;&lt;/span&gt;</content>` +
          `<id>t3_abc123</id><media:thumbnail url="${redditPreview}" /><title>A photo</title></entry></feed>`
      )
    }
    if (url.hostname === 'arctic-shift.photon-reddit.com' && options.archiveRefusal) {
      return new Response(null, { status: options.archiveRefusal })
    }
    if (url.hostname === 'arctic-shift.photon-reddit.com') {
      expect(url.searchParams.get('ids')).toBe('abc123')
      return Response.json({
        data: [
          {
            id: options.wrongId ? 'otherid' : 'abc123',
            permalink: '/r/example/comments/abc123/sample/',
            title: 'A video',
            selftext: 'The body of the post.',
            author: 'example',
            ...(options.redditPhoto
              ? {
                  post_hint: 'image',
                  is_video: false,
                  is_gallery: false,
                  url: options.redditPhoto === 'preview' ? 'https://image.example/fixture.png' : redditPhoto,
                  thumbnail: redditPreview,
                  ...(options.redditPhoto === 'crosspost' ? { crosspost_parent: 't3_aaaaaa' } : {})
                }
              : {
                  is_video: true,
                  url: 'https://v.redd.it/fixture',
                  secure_media: {
                    reddit_video: {
                      fallback_url: options.foreignAsset ? 'https://v.redd.it/other/DASH_720.mp4' : redditAsset,
                      duration: 12
                    }
                  }
                })
          }
        ]
      })
    }
    if (url.href === tikTokAsset && options.ranges) {
      const range = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get('range') ?? '')
      if (!range) return new Response(null, { status: 403 })
      const start = Number(range[1])
      const end = Number(range[2])
      const headers = { 'content-type': 'video/mp4', 'content-range': `bytes ${start}-${end}/${largeMp4.length}` }
      const second = Math.floor(largeMp4.length / 4)
      if ((options.ranges === 'stall' || options.ranges === 'drop') && start === second) {
        // The first request for the second part sends half of it, then stalls or drops.
        const half = largeMp4.subarray(start, start + Math.floor((end - start) / 2))
        const drop = options.ranges === 'drop'
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(half))
            },
            pull(controller) {
              if (drop) controller.error(new TypeError('terminated'))
              return new Promise(() => {})
            }
          }),
          { status: 206, headers: { ...headers, 'content-range': `bytes ${start}-${end}/${largeMp4.length}` } }
        )
      }
      return new Response(new Uint8Array(largeMp4.subarray(start, end + 1)), {
        status: 206,
        headers: {
          'content-type': 'video/mp4',
          'content-range': options.ranges === 'invalid' ? 'bytes 0-1/2' : `bytes ${start}-${end}/${largeMp4.length}`
        }
      })
    }
    if (url.href === tikTokAsset || url.href === redditAsset) {
      return new Response(new Uint8Array(mp4), { headers: { 'content-type': 'video/mp4' } })
    }
    return new Response(null, { status: 404 })
  })
  const viewer = new SocialPostViewer(
    { mirrors, timeoutMs: 6000, cacheTtlMs: 1000, maxCacheEntries: 4, maxTextChars: 1500, ytDlpPath: 'yt-dlp' },
    { fetcher, lookup, logger }
  )
  viewer.setYtDlpAvailable(false)
  return {
    viewer,
    fetcher,
    download: createFetchPagePort({ fetch: fetcher, lookup, sameOriginCookieless: true }).download
  }
}

describe('approved mirror readers', () => {
  it('keeps the mirror off by default and does not contact it', async () => {
    const { viewer, fetcher } = stack({})
    expect((await viewer.lookup(parseOfficialSocialPostUrl(tikTokLink)!)).status).toBe('failed')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each([403, 429])('stops Reddit lookup on a first-party HTTP %s', async (redditRefusal) => {
    const { viewer, fetcher } = stack({ reddit: 'read_and_group' }, { redditRefusal })
    expect((await viewer.lookup(parseOfficialSocialPostUrl(redditLink)!)).status).toBe('failed')
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).hostname)).toEqual([
      'www.reddit.com',
      'www.reddit.com'
    ])
  })

  it('reports only configured group video capabilities and still excludes YouTube', () => {
    const caps = socialCapabilities(false, { tiktok: 'read', reddit: 'read_and_group' })
    expect(caps['features.social']).toContainEqual({
      id: 'tiktok',
      name: 'TikTok',
      operations: ['text', 'preview', 'video']
    })
    expect(caps['features.autofetch']).toContainEqual({ id: 'reddit', name: 'Reddit', operations: ['photos', 'video'] })
    expect(caps['features.autofetch'].map((entry) => entry.id)).not.toContain('tiktok')
    expect(caps['features.autofetch'].map((entry) => entry.id)).not.toContain('youtube')
    const noRedditGroups = socialCapabilities(false, { reddit: 'read_and_group', redditGroupChatIds: [] })
    expect(noRedditGroups['features.autofetch'].map((entry) => entry.id)).not.toContain('reddit')
    expect(noRedditGroups['features.social'].map((entry) => entry.id)).toContain('reddit')
  })

  it.each([tikTokLink, redditLink])('watches the verified video from %s with no extractor', async (link) => {
    const { viewer, download } = stack({ tiktok: 'read', reddit: 'read' })
    const watch = vi.fn<MediaWatcher['watch']>(async (file) => {
      expect(file.data).toEqual(mp4)
      return {
        reading: { description: 'Watched fixture' },
        usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
        costUsd: 0,
        model: 'fixture'
      }
    })
    const reader = createLinkReader({
      viewer,
      download,
      findTarget: parseOfficialSocialPostUrl,
      watcher: { watch },
      model: 'fixture',
      limits: { ...DEFAULT_MEDIA_LIMITS, maxVideoSeconds: 180 }
    })
    const result = await reader.read([link], 12000, { media: true, social: true })
    expect(result.links?.[0]?.reading?.description).toBe('Watched fixture')
    expect(result.links?.[0]?.post.attachments ?? []).toEqual([])
    if (link === redditLink) expect(result.links?.[0]?.post.text).toContain('The body of the post.')
    expect(watch).toHaveBeenCalledOnce()
  })

  it.each(['valid', 'invalid'] as const)('only watches a complete TikTok byte-range batch (%s)', async (ranges) => {
    const { viewer, download, fetcher } = stack({ tiktok: 'read' }, { ranges })
    const watch = vi.fn<MediaWatcher['watch']>(async (file) => {
      expect(file.data.equals(largeMp4)).toBe(true)
      return {
        reading: { description: 'Watched complete clip' },
        usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
        costUsd: 0,
        model: 'fixture'
      }
    })
    const reader = createLinkReader({
      viewer,
      download,
      findTarget: parseOfficialSocialPostUrl,
      watcher: { watch },
      model: 'fixture',
      limits: { ...DEFAULT_MEDIA_LIMITS, maxVideoSeconds: 180 }
    })
    const result = await reader.read([tikTokLink], 12000, { media: true, social: true })
    expect(result.links?.[0]?.reading?.description).toBe(ranges === 'valid' ? 'Watched complete clip' : undefined)
    expect(fetcher.mock.calls.filter(([url]) => url === tikTokAsset)).toHaveLength(4)
    expect(watch).toHaveBeenCalledTimes(ranges === 'valid' ? 1 : 0)
  })

  it.each([
    ['drop', 0],
    ['stall', 4_100]
  ] as const)(
    'resumes a TikTok byte range after a %s from its last byte',
    async (ranges, waitMs) => {
      const { viewer, download, fetcher } = stack({ tiktok: 'read' }, { ranges })
      const watch = vi.fn<MediaWatcher['watch']>(async (file) => {
        expect(file.data.equals(largeMp4)).toBe(true)
        return {
          reading: { description: 'Watched complete clip' },
          usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
          costUsd: 0,
          model: 'fixture'
        }
      })
      const reader = createLinkReader({
        viewer,
        download,
        findTarget: parseOfficialSocialPostUrl,
        watcher: { watch },
        model: 'fixture',
        limits: { ...DEFAULT_MEDIA_LIMITS, maxVideoSeconds: 180 }
      })
      const result = await reader.read([tikTokLink], 12000 + waitMs, { media: true, social: true })
      expect(result.links?.[0]?.reading?.description).toBe('Watched complete clip')
      const ranges_ = fetcher.mock.calls
        .filter(([url]) => url === tikTokAsset)
        .map(([, init]) => new Headers(init?.headers).get('range'))
      expect(ranges_).toHaveLength(5)
      const second = Math.floor(largeMp4.length / 4)
      const secondEnd = Math.floor(largeMp4.length / 2) - 1
      const resumedAt = second + Math.floor((secondEnd - second) / 2)
      expect(ranges_).toContain(`bytes=${resumedAt}-${secondEnd}`)
    },
    15_000
  )

  it.each([tikTokLink, redditLink])('discards mismatched IDs and non-native assets for %s', async (link) => {
    const target = parseOfficialSocialPostUrl(link)!
    const mode = { tiktok: 'read_and_group', reddit: 'read_and_group' } as const
    const { viewer: wrong } = stack(mode, { wrongId: true })
    expect((await wrong.lookup(target)).status).toBe('failed')
    const { viewer: foreign } = stack(mode, { foreignAsset: true })
    const result = await foreign.lookup(target)
    expect(result.status).toBe('found')
    if (result.status === 'found') {
      expect(result.post.video).toBeNull()
      expect(result.post.attachments ?? []).toEqual([])
    }
  })

  it.each(['native', 'preview', 'crosspost'] as const)(
    'attaches only the original native Reddit photo (%s)',
    async (sample) => {
      const { viewer } = stack({ reddit: 'read_and_group' }, { redditPhoto: sample })
      const result = await viewer.lookup(parseOfficialSocialPostUrl(redditLink)!)
      expect(result.status).toBe('found')
      if (result.status !== 'found') return
      expect(result.post.photoUrls).toEqual(sample === 'native' ? [redditPhoto] : [])
      expect(result.post.attachments ?? []).toEqual(
        sample === 'native' ? [{ kind: 'image', url: redditPhoto, owner: 'reddit:abc123' }] : []
      )
    }
  )

  it('asks the mirror for the original when the Reddit feed has only a thumbnail', async () => {
    const { viewer, fetcher } = stack({ reddit: 'read_and_group' }, { redditPhoto: 'native', redditFeed: 'photo' })
    const result = await viewer.lookup(parseOfficialSocialPostUrl(nativeReddit)!)
    expect(result.status).toBe('found')
    if (result.status !== 'found') return
    expect(result.post.text).toContain('A photo')
    expect(result.post.photoUrls).toEqual([redditPhoto])
    expect(result.post.attachments).toEqual([{ kind: 'image', url: redditPhoto, owner: 'reddit:abc123' }])
    expect(
      fetcher.mock.calls.some(([input]) => new URL(String(input)).hostname === 'arctic-shift.photon-reddit.com')
    ).toBe(true)
  })

  it('keeps the Reddit feed thumbnail when the mirror is off', async () => {
    const { viewer, fetcher } = stack({}, { redditFeed: 'photo' })
    const result = await viewer.lookup(parseOfficialSocialPostUrl(nativeReddit)!)
    expect(result.status).toBe('found')
    if (result.status !== 'found') return
    expect(result.post.imageUrl).toBe(redditPreview)
    expect(result.post.attachments ?? []).toEqual([])
    expect(
      fetcher.mock.calls.some(([input]) => new URL(String(input)).hostname === 'arctic-shift.photon-reddit.com')
    ).toBe(false)
  })

  it('does not treat an archive rate limit as a Reddit refusal', async () => {
    const { viewer } = stack({ reddit: 'read_and_group' }, { redditFeed: 'video', archiveRefusal: 429 })
    viewer.setYtDlpAvailable(true)
    const readers: string[] = []
    const result = await viewer.lookup(parseOfficialSocialPostUrl(nativeReddit)!, undefined, (trace) => {
      readers.push(...trace.attempts.map((attempt) => attempt.readerId))
    })
    expect(result.status).toBe('found')
    expect(readers).toEqual(['reddit.feed', 'reddit.arctic_shift', 'yt_dlp'])
  })

  it('hands verified clips to the gateway and records the gateway’s confirmation separately', async () => {
    const storage = tmpStorage()
    const chat = ensureChat(storage, { waId: '12345678901@g.us', type: 'group' })
    const other = ensureChat(storage, { waId: '00000000000@g.us', type: 'group' })
    for (const group of [chat, other]) {
      setChatStatus(storage, { chatId: group.chatId, status: 'active', actor: 'test' })
      setSetting(storage, { level: 'chat', scope: group.chatId, key: 'features.autofetch', value: true, actor: 'test' })
    }
    const mirrors = { tiktok: 'read_and_group', reddit: 'read_and_group', redditGroupChatIds: [chat.chatId] } as const
    const { viewer, download, fetcher } = stack(mirrors)
    const cache = tmpDir('aira-mirror-gateway-')
    const autofetch = createAutofetch({ storage, viewer, download, mirrors, cacheDir: cache, hostCacheDir: cache })
    const downloadTimeout = vi.spyOn(AbortSignal, 'timeout')
    const server = createGatewayServer({
      turns: {} as TurnService,
      storage,
      autofetch,
      logger,
      redactor: createRedactor(),
      ready: () => true
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/aira/autofetch`
      const post = async (path: string, body: object) =>
        (
          await fetch(endpoint + path, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body)
          })
        ).json()
      const outside = (await post('', { chat: other.waId, text: redditLink })) as AutofetchBatch
      expect(outside.media).toEqual([])
      expect(fetcher).not.toHaveBeenCalled()
      const result = (await post('', { chat: chat.waId, text: `${tikTokLink} ${redditLink}` })) as AutofetchBatch
      expect(result.media).toHaveLength(2)
      expect(downloadTimeout).toHaveBeenCalledWith(10000)
      expect(downloadTimeout).toHaveBeenCalledWith(25000)
      for (const item of result.media) {
        expect(item.kind).toBe('video')
        expect(readFileSync(join(cache, item.path.split('/').at(-1)!))).toEqual(mp4)
      }
      const outcome = () => storage.read((db) => db.prepare('SELECT outcomes FROM autofetch_delivery').get())
      expect(outcome()).toEqual({ outcomes: null })
      expect(await post('/claim', { key: result.deliveryKey })).toEqual({ accepted: true })
      expect(await post('/complete', { key: result.deliveryKey, outcomes: [true, false] })).toEqual({ accepted: true })
      expect(outcome()).toEqual({ outcomes: '[true,false]' })
    } finally {
      server.close()
      downloadTimeout.mockRestore()
    }
  })
})
