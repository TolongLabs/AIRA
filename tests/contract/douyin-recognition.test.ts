import { describe, expect, it, vi } from 'vitest'
import { enabledMirrorAsset, mirrorAssetPlatform } from '../../src/social/mirror-readers.js'
import { groupOperations, socialCapabilities, switchablePlatforms } from '../../src/social/readers.js'
import { resolveShareLink } from '../../src/social/share.js'
import { findSocialPostTargets, parseSocialPostUrl, recognitionOnlyName } from '../../src/social/urls.js'
import { SocialPostViewer } from '../../src/social/viewer.js'
import { createFetchPagePort } from '../../src/tools/ports.js'

const VIDEO_ID = '7569981400569833915'
const TIKTOK_ID = '7693184538704416031'
const DIRECT_DOUYIN = `https://www.douyin.com/video/${VIDEO_ID}`
const SHARE_IESDOUYIN = `https://www.iesdouyin.com/share/video/${VIDEO_ID}`
const SHORT_V_DOUYIN = 'https://v.douyin.com/D5NaytY'
const TIKTOK_URL = `https://www.tiktok.com/@tiktok/video/${TIKTOK_ID}`
const X_URL = 'https://x.com/example/status/1234567890123456789'

const publicLookup = async () => ['93.184.216.34']

const DOUYIN_FIXTURE = [
  {
    id: VIDEO_ID,
    text: 'Sample Douyin caption #topic',
    createTime: 1762523644,
    url: DIRECT_DOUYIN,
    authorMeta: { name: 'Douyin Author', username: '' },
    thumb: 'https://p26-sign.douyinpic.com/tos-cn-p/cover.jpeg',
    videoMeta: {
      originCover: 'https://p26-sign.douyinpic.com/tos-cn-p/origin-cover.jpeg',
      duration: 43242,
      playUrl: 'https://api-play.amemv.com/aweme/v1/play/?video_id=sample'
    }
  }
]

const TIKTOK_APIFY_FIXTURE = [
  {
    id: TIKTOK_ID,
    desc: 'Sample TikTok caption',
    createTime: 1791209149,
    duration: 68,
    thumbnail: 'https://p16-common-sign.tiktokcdn-us.com/thumb.image',
    videoDownloadUrl: `https://api.apify.com/v2/key-value-stores/store123/records/video_${TIKTOK_ID}`,
    author: { uniqueId: 'tiktok' }
  }
]

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

describe('douyin Apify mirror and tiktok Apify fallback', () => {
  it('parses Douyin direct, iesdouyin, and v.douyin short links and reserves subdomains', () => {
    for (const url of [DIRECT_DOUYIN, SHARE_IESDOUYIN]) {
      const parsed = parseSocialPostUrl(url)
      expect(parsed).toMatchObject({
        platform: 'douyin',
        id: VIDEO_ID,
        lookupKey: `douyin:${VIDEO_ID}`,
        canonicalUrl: DIRECT_DOUYIN
      })
      expect(parsed?.needsRedirect).toBeUndefined()
    }

    expect(parseSocialPostUrl(SHORT_V_DOUYIN)).toMatchObject({
      platform: 'douyin',
      id: 'D5NaytY',
      needsRedirect: true,
      canonicalUrl: SHORT_V_DOUYIN
    })

    expect(recognitionOnlyName(DIRECT_DOUYIN)).toBeNull()
    expect(parseSocialPostUrl('https://www.douyin.com/user/MS4wLjAB')).toBeNull()
    expect(parseSocialPostUrl('https://www.douyin.com/video/12345')).toBeNull()
    expect(parseSocialPostUrl('https://v.douyin.com/')).toBeNull()

    for (const host of ['m.douyin.com', 'open.douyin.com', 'm.iesdouyin.com']) {
      const url = `https://${host}/example/status/1234567890123456789`
      expect(parseSocialPostUrl(url)).toBeNull()
      expect(findSocialPostTargets(`${url} ${X_URL}`).map((t) => t.platform)).toEqual(['x'])
    }
  })

  it('resolves v.douyin.com short links to the canonical video target', async () => {
    const share = parseSocialPostUrl(SHORT_V_DOUYIN)!
    const resolved = await resolveShareLink(
      share,
      async () => new Response(null, { status: 302, headers: { location: `${SHARE_IESDOUYIN}/?foo=bar` } })
    )
    expect(resolved).toMatchObject({
      platform: 'douyin',
      id: VIDEO_ID,
      lookupKey: `douyin:${VIDEO_ID}`,
      canonicalUrl: DIRECT_DOUYIN
    })
  })

  it('reads Douyin video via Apify and gates group attachments', async () => {
    const playUrl = 'https://api-play.amemv.com/aweme/v1/play/?video_id=sample'
    const fetcher = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const href = String(input)
      if (href.includes('natanielsantos~douyin-scraper')) {
        expect(init?.method).toBe('POST')
        expect(JSON.parse(String(init?.body))).toEqual({
          postUrls: [DIRECT_DOUYIN],
          shouldDownloadVideos: false,
          shouldDownloadCovers: false
        })
        return jsonResponse(DOUYIN_FIXTURE)
      }
      throw new Error(`unexpected fetch ${href}`)
    })

    const viewer = new SocialPostViewer(
      {
        mirrors: { douyin: 'read_and_group', apifyToken: 'test-token' },
        timeoutMs: 12000,
        maxTextChars: 1500,
        cacheTtlMs: 0,
        maxCacheEntries: 16,
        ytDlpPath: 'yt-dlp'
      },
      { fetcher, lookup: publicLookup }
    )
    const result = await viewer.lookup(parseSocialPostUrl(DIRECT_DOUYIN)!)
    expect(result.status).toBe('found')
    if (result.status !== 'found') throw new Error('expected found')
    expect(result.post.text).toBe('Sample Douyin caption #topic')
    expect(result.post.authorName).toBe('Douyin Author')
    expect(result.post.durationSec).toBe(43.242)
    expect(result.post.imageUrl).toBe('https://p26-sign.douyinpic.com/tos-cn-p/origin-cover.jpeg')
    expect(result.post.video).toEqual({
      url: playUrl,
      mirror: 'douyin',
      bytes: null,
      hasAudio: null,
      headers: null
    })
    expect(result.post.attachments).toEqual([
      {
        kind: 'video',
        owner: `douyin:${VIDEO_ID}`,
        video: result.post.video,
        durationSec: 43.242
      }
    ])
  })

  it('falls back from failed TikWM to TikTok Apify watermark-free reader and locks Bearer auth to Apify KV store', async () => {
    const fetcher = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const href = String(input)
      if (href.includes('tikwm.com')) return new Response('rate limited', { status: 429 })
      if (href.includes('gentle_cloud~tiktok-videos-watermark-free-scraper')) {
        return jsonResponse(TIKTOK_APIFY_FIXTURE)
      }
      throw new Error(`unexpected fetch ${href}`)
    })

    const viewer = new SocialPostViewer(
      {
        mirrors: { tiktok: 'read_and_group', apifyToken: 'secret-apify-token' },
        timeoutMs: 12000,
        maxTextChars: 1500,
        cacheTtlMs: 0,
        maxCacheEntries: 16,
        ytDlpPath: 'yt-dlp'
      },
      { fetcher, lookup: publicLookup }
    )
    const result = await viewer.lookup(parseSocialPostUrl(TIKTOK_URL)!)
    expect(result.status).toBe('found')
    if (result.status !== 'found') throw new Error('expected found')
    expect(result.post.text).toBe('Sample TikTok caption')
    expect(result.post.authorHandle).toBe('tiktok')
    expect(result.post.durationSec).toBe(68)
    expect(result.post.video?.url).toBe(`https://api.apify.com/v2/key-value-stores/store123/records/video_${TIKTOK_ID}`)
    expect(result.post.attachments).toHaveLength(1)

    const seenAuth: Array<{ url: string; auth: string | null }> = []
    const port = createFetchPagePort({
      sameOriginCookieless: true,
      apifyToken: 'secret-apify-token',
      lookup: publicLookup,
      fetch: async (url, init) => {
        const headers = new Headers(init?.headers)
        seenAuth.push({ url: String(url), auth: headers.get('authorization') })
        return new Response(Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]), {
          status: 200,
          headers: { 'content-type': 'video/mp4' }
        })
      }
    })
    await port.download(
      `https://api.apify.com/v2/key-value-stores/store123/records/video_${TIKTOK_ID}`,
      new AbortController().signal,
      1_000_000
    )
    await port.download('https://v5-che.douyinvod.com/sample.mp4', new AbortController().signal, 1_000_000)
    expect(seenAuth).toEqual([
      {
        url: `https://api.apify.com/v2/key-value-stores/store123/records/video_${TIKTOK_ID}`,
        auth: 'Bearer secret-apify-token'
      },
      {
        url: 'https://v5-che.douyinvod.com/sample.mp4',
        auth: null
      }
    ])
  })

  it('gates Douyin capabilities, switches, and mirror asset policy on mirror mode and token', () => {
    expect(switchablePlatforms().read).toContain('douyin')
    expect(switchablePlatforms().fetch).toContain('douyin')

    const offCaps = socialCapabilities(true, { douyin: 'off', apifyToken: 'tok' })
    expect(offCaps['features.social'].some((e) => e.id === 'douyin')).toBe(false)
    expect(offCaps['features.autofetch'].some((e) => e.id === 'douyin')).toBe(false)

    const noKeyCaps = socialCapabilities(true, { douyin: 'read_and_group' })
    expect(noKeyCaps['features.social'].some((e) => e.id === 'douyin')).toBe(false)

    const onCaps = socialCapabilities(true, { douyin: 'read_and_group', apifyToken: 'tok' })
    expect(onCaps['features.social'].find((e) => e.id === 'douyin')?.operations).toEqual(['text', 'preview', 'video'])
    expect(onCaps['features.autofetch'].find((e) => e.id === 'douyin')?.operations).toEqual(['video'])
    expect(groupOperations('douyin', { douyin: 'read_and_group', apifyToken: 'tok' }, 'c_1', false)).toEqual([])

    const douyinCdn = 'https://v5-che.douyinvod.com/sample.mp4'
    const apifyKv = `https://api.apify.com/v2/key-value-stores/store123/records/video_${TIKTOK_ID}`
    expect(mirrorAssetPlatform(douyinCdn)).toBe('douyin')
    expect(mirrorAssetPlatform(apifyKv)).toBe('tiktok')
    expect(enabledMirrorAsset(douyinCdn, 'douyin', { douyin: 'read', apifyToken: 'tok' })).toBe(true)
    expect(enabledMirrorAsset(douyinCdn, 'douyin', { douyin: 'read' })).toBe(false)
    expect(enabledMirrorAsset(apifyKv, 'tiktok', { tiktok: 'read' })).toBe(true)
  })
})
