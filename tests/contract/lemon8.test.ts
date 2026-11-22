import { describe, expect, it, vi } from 'vitest'
import { socialCapabilities, switchablePlatforms } from '../../src/social/readers.js'
import { resolveShareLink } from '../../src/social/share.js'
import { findSocialPostTargets, parseSocialPostUrl } from '../../src/social/urls.js'
import { SocialPostViewer } from '../../src/social/viewer.js'

const ID = '7234567890123456789'
const HANDLE = 'sample'
const DIRECT = `https://www.lemon8-app.com/@${HANDLE}/${ID}`
const ENCODED = `https://www.lemon8-app.com/%40${HANDLE}/${ID}`
const SHORT_S = 'https://s.lemon8-app.com/s/AbC123xYz'
const SHORT_V = 'https://v.lemon8-app.com/al/AbC123xYz'

const IMG_A = 'https://p16-lemon8-cross-sign.tiktokcdn.com/tos-maliva-i-avgv0qqbbk-jp/abc123.webp'
const IMG_B = 'https://p16-lemon8-cross-sign.tiktokcdn.com/tos-maliva-i-avgv0qqbbk-jp/def456.webp'
const COVER = 'https://p16-lemon8-cross-sign.tiktokcdn.com/tos-maliva-i-avgv0qqbbk-jp/cover789.webp'
const CLIP = 'https://v16-lemon8.tiktokcdn.com/tos-maliva-v-avgv0qqbbk-jp/clip012.mp4'
const AVATAR = 'https://p16-lemon8-cross-sign.tiktokcdn.com/tos-maliva-i-avgv0qqbbk-jp/avatar999.webp'
const SHARE_CARD = 'https://p16-lemon8-cross-sign.tiktokcdn.com/tos-maliva-i-avgv0qqbbk-jp/sharecard000.webp'
const RECO = 'https://p16-lemon8-cross-sign.tiktokcdn.com/tos-maliva-i-avgv0qqbbk-jp/reco111.webp'

// Build the approved first-party article detail payload, then inline it as an
// encodeURIComponent(JSON.stringify(...)) blob inside one script tag.
function lemon8Html(
  overrides: {
    id?: string
    linkName?: string
    nickName?: string
    articleClass?: 'Gallery' | 'Video'
    title?: string
    content?: string
    images?: string[]
    videoUrl?: string
    videoDuration?: number
    cover?: string
    withDecoys?: boolean
  } = {}
): string {
  const id = overrides.id ?? ID
  const linkName = overrides.linkName ?? HANDLE
  const articleClass = overrides.articleClass ?? 'Gallery'
  const images = overrides.images ?? [IMG_A, IMG_B]
  const videoUrl = overrides.videoUrl ?? CLIP
  const videoDuration = overrides.videoDuration ?? 48
  const cover = overrides.cover ?? COVER
  const detail: Record<string, unknown> = {
    groupId: id,
    author: { linkName, avatar: AVATAR, nickName: overrides.nickName ?? 'Sample' },
    articleClass,
    title: overrides.title ?? 'A quiet morning',
    content: overrides.content ?? '<p>nice</p>',
    imageList: images.map((url) => ({ url, shareCardCoverImage: SHARE_CARD, width: 1080, height: 1440 })),
    largeImage: { url: cover },
    ...(articleClass === 'Video'
      ? { video: { url: videoUrl, width: 720, height: 1280, duration: videoDuration, muteStatus: 0 } }
      : {})
  }
  const loader: Record<string, unknown> = {
    'routes/$user_link_name_.$article_id': {
      [`$ArticleDetail+${id}`]: detail,
      // Decoy recommendations share the page but never name the requested post.
      ...(overrides.withDecoys === false
        ? {}
        : {
            '$ArticleDetail+0000000000000000001': {
              groupId: '0000000000000000001',
              author: { linkName: 'other', nickName: 'Other' },
              articleClass: 'Gallery',
              title: 'Someone else',
              imageList: [{ url: RECO, shareCardCoverImage: RECO, width: 100, height: 100 }]
            },
            summary: 'recommended for you',
            comments: [{ text: 'nice post' }]
          })
    }
  }
  const payload = { state: { loaderData: loader } }
  const blob = encodeURIComponent(JSON.stringify(payload))
  return `<html><body><script id="__remix">${blob}</script></body></html>`
}

const settings = { timeoutMs: 1000, maxTextChars: 1500, cacheTtlMs: 1000, maxCacheEntries: 2, ytDlpPath: 'unused' }
function viewer(fetcher: typeof fetch) {
  return new SocialPostViewer(settings, { fetcher, lookup: async () => ['8.8.8.8'] })
}
async function readHtml(html: string) {
  const target = parseSocialPostUrl(DIRECT)
  if (!target) throw new Error('Lemon8 target missing')
  const result = await viewer(async () => new Response(html)).lookup(target)
  return result.status === 'found' ? result.post : null
}

describe('lemon8 post operations', () => {
  it('recognises the verified direct article address', () => {
    const target = parseSocialPostUrl(DIRECT)
    expect(target).toMatchObject({ platform: 'lemon8', id: ID, lookupKey: `lemon8:${HANDLE}:${ID}` })
    expect(target?.canonicalUrl).toBe(DIRECT)
  })

  it('recognises the encoded at-sign direct address as the same post', () => {
    const target = parseSocialPostUrl(ENCODED)
    expect(target).toMatchObject({ platform: 'lemon8', id: ID, lookupKey: `lemon8:${HANDLE}:${ID}` })
    expect(target?.canonicalUrl).toBe(DIRECT)
  })

  it('marks both short shares for the bounded resolver without naming a post', () => {
    for (const short of [SHORT_S, SHORT_V]) {
      const target = parseSocialPostUrl(short)
      expect(target).toMatchObject({ platform: 'lemon8', needsRedirect: true })
      expect(target?.id).not.toBe(ID)
    }
  })

  it('leaves profiles, campaigns, wrong ids and cross-host shapes to read_page', () => {
    for (const url of [
      'https://www.lemon8-app.com/@sample',
      'https://www.lemon8-app.com/sample',
      'https://www.lemon8-app.com/campaign/spring',
      `https://www.lemon8-app.com/@${HANDLE}/123`,
      `https://www.lemon8-app.com/@${HANDLE}/12345678901234567890123`,
      `https://www.lemon8-app.com/@${HANDLE}/notanid00000000000`,
      `https://www.lemon8-app.com/@${HANDLE}/${ID}/extra`,
      'https://mobile.lemon8-app.com/example/status/1234567890123456789',
      `https://lemon8.example.test/@${HANDLE}/${ID}`,
      `https://www.lemon8-app.com.evil.test/@${HANDLE}/${ID}`,
      'https://s.lemon8-app.com/',
      'https://v.lemon8-app.com/al/'
    ]) {
      expect(parseSocialPostUrl(url), url).toBeNull()
    }
  })

  it('finds direct and short lemon8 links in text while keeping existing platforms', () => {
    const targets = findSocialPostTargets(
      `see ${DIRECT} and ${SHORT_S} plus https://x.com/example/status/1234567890123456789`
    )
    expect(targets.map((target) => target.platform)).toEqual(['lemon8', 'lemon8', 'x'])
    expect(findSocialPostTargets(DIRECT)).toHaveLength(1)
    expect(findSocialPostTargets(SHORT_V)).toHaveLength(1)
  })

  it('parses a gallery: own ordered photos, never the avatar, share card or recs', async () => {
    const target = parseSocialPostUrl(DIRECT)!
    const post = await readHtml(lemon8Html({}))
    expect(post).toMatchObject({
      platform: 'lemon8',
      id: ID,
      authorHandle: HANDLE,
      authorName: 'Sample',
      photoCount: 2,
      photoUrls: [IMG_A, IMG_B],
      imageUrl: IMG_A,
      videoCount: 0,
      video: null
    })
    expect(JSON.stringify(post)).not.toContain('avatar999')
    expect(JSON.stringify(post)).not.toContain('sharecard000')
    expect(JSON.stringify(post)).not.toContain('reco111')
    expect(post?.attachments).toEqual([
      { kind: 'image', owner: target.lookupKey, url: IMG_A },
      { kind: 'image', owner: target.lookupKey, url: IMG_B }
    ])
  })

  it('parses a video: playable url with cover preview and native ownership', async () => {
    const target = parseSocialPostUrl(DIRECT)!
    const post = await readHtml(lemon8Html({ articleClass: 'Video' }))
    expect(post).toMatchObject({
      platform: 'lemon8',
      id: ID,
      videoCount: 1,
      photoCount: 0,
      photoUrls: [],
      imageUrl: COVER,
      video: expect.objectContaining({ url: CLIP }),
      durationSec: 48
    })
    expect(post?.attachments).toEqual([
      {
        kind: 'video',
        owner: target.lookupKey,
        video: expect.objectContaining({ url: CLIP }),
        durationSec: 48
      }
    ])
  })

  it('rejects pages missing the requested article or author', async () => {
    expect(await readHtml(lemon8Html({ id: '0000000000000000001' }))).toBeNull()
    expect(await readHtml(lemon8Html({ linkName: 'other' }))).toBeNull()
    expect(await readHtml('<html></html>')).toBeNull()
  })

  it('reads the article page with no cookies and follows a same-identity region redirect', async () => {
    const target = parseSocialPostUrl(DIRECT)!
    const region = `${DIRECT}?region=sg`
    const cookieFree = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).has('cookie')).toBe(false)
      return new Response(lemon8Html({}))
    })
    const direct = viewer(cookieFree)
    expect(await direct.lookup(target)).toMatchObject({ status: 'found', post: { platform: 'lemon8', id: ID } })
    expect(String(cookieFree.mock.calls[0]![0])).toBe(DIRECT)

    const redirecting = vi.fn(async (input: string | URL | Request) =>
      String(input) === DIRECT
        ? new Response(null, { status: 302, headers: { location: region } })
        : new Response(lemon8Html({}))
    )
    const viaRegion = viewer(redirecting)
    expect(await viaRegion.lookup(target)).toMatchObject({ status: 'found', post: { platform: 'lemon8', id: ID } })
  })

  it('lists lemon8 read and fetch operations with per-chat switches', () => {
    const capabilities = socialCapabilities(true, { tiktok: 'read_and_group', reddit: 'read_and_group' })
    expect(capabilities['features.social'].find((entry) => entry.id === 'lemon8')).toMatchObject({
      id: 'lemon8',
      operations: ['text', 'preview', 'photos', 'video']
    })
    expect(capabilities['features.autofetch'].find((entry) => entry.id === 'lemon8')).toMatchObject({
      id: 'lemon8',
      operations: ['photos', 'video']
    })
    const switches = switchablePlatforms()
    expect(switches.read).toContain('lemon8')
    expect(switches.fetch).toContain('lemon8')
  })

  it('resolves both short shares through at most two same-platform redirects', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url === 'https://s.lemon8-app.com/s/AbC123xYz') {
        return new Response(null, { status: 302, headers: { location: DIRECT } })
      }
      if (url === 'https://v.lemon8-app.com/al/AbC123xYz') {
        return new Response(null, { status: 302, headers: { location: 'https://s.lemon8-app.com/s/AbC123xYz' } })
      }
      throw new Error(`unexpected address ${url}`)
    })
    expect(await resolveShareLink(parseSocialPostUrl(SHORT_S)!, fetcher)).toMatchObject({
      platform: 'lemon8',
      id: ID
    })
    const twoHop = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url === 'https://v.lemon8-app.com/al/AbC123xYz') {
        return new Response(null, { status: 302, headers: { location: 'https://s.lemon8-app.com/s/AbC123xYz' } })
      }
      if (url === 'https://s.lemon8-app.com/s/AbC123xYz') {
        return new Response(null, { status: 302, headers: { location: DIRECT } })
      }
      throw new Error(`unexpected address ${url}`)
    })
    expect(await resolveShareLink(parseSocialPostUrl(SHORT_V)!, twoHop)).toMatchObject({
      platform: 'lemon8',
      id: ID
    })
  })

  it('requests measurement at the rounded video boundary and preserves precise durations', async () => {
    for (const [reported, expected] of [
      [179, 179],
      [180, null],
      [180.1, 180.1]
    ] as const) {
      const post = await readHtml(lemon8Html({ articleClass: 'Video', videoDuration: reported }))
      expect(post?.attachments?.[0]).toMatchObject({ kind: 'video', durationSec: expected })
    }
  })

  it('keeps an unrelated media URL out of a verified native gallery', async () => {
    const post = await readHtml(lemon8Html({ images: ['https://unrelated.example/image.webp', IMG_A] }))
    expect(post?.photoUrls).toEqual([IMG_A])
    expect(post?.text).toBe('A quiet morning nice')
  })
})
