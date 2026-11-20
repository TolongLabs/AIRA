import { describe, expect, it, vi } from 'vitest'
import { parseInstagramPage } from '../../src/social/instagram.js'
import { ReplyReader } from '../../src/social/replies/service.js'
import { parseSocialPostUrl } from '../../src/social/urls.js'
import { createSocialPostViewer as buildViewer } from '../../src/social/viewer.js'

const settings = {
  timeoutMs: 1000,
  maxTextChars: 1500,
  cacheTtlMs: 0,
  maxCacheEntries: 2,
  ytDlpPath: 'yt-dlp'
}

const photo = (url: string) => ({
  media_type: 1,
  image_versions2: { candidates: [{ url, width: 1080, height: 1350 }] }
})
const clip = (url: string, cover: string) => ({
  media_type: 2,
  has_audio: true,
  image_versions2: { candidates: [{ url: cover }] },
  video_versions: [{ type: 101, url }]
})

// As measured on public post pages: the post sits under xig_polaris_media, null when the page gates it.
function pageWith(media: Record<string, unknown> | null): string {
  const block = {
    require: [
      [
        'ScheduledServerJS',
        'handle',
        null,
        [
          {
            __bbox: {
              require: [
                [
                  'RelayPrefetchedStreamCache',
                  'next',
                  [],
                  [
                    'adp_PolarisPostRootQueryRelayPreloader_0',
                    {
                      __bbox: {
                        result: {
                          data: { xig_polaris_media: { code: 'DPost00001', if_not_gated_logged_out: media } }
                        }
                      }
                    }
                  ]
                ]
              ]
            }
          }
        ]
      ]
    ]
  }
  return `<html><body><script type="application/json" data-sjs>${JSON.stringify(block)}</script></body></html>`
}

const carousel = {
  code: 'DPost00001',
  media_type: 8,
  taken_at: 1763424000,
  comment_count: 12,
  caption: { text: 'A day out, in three parts' },
  user: { username: 'poster_one', full_name: 'Poster One', profile_pic_url: 'https://cdn.example/t51.2885-19/me.jpg' },
  image_versions2: { candidates: [{ url: 'https://cdn.example/one.jpg' }] },
  carousel_media: [
    photo('https://cdn.example/one.jpg'),
    clip('https://cdn.example/clip.mp4', 'https://cdn.example/clip-cover.jpg'),
    photo('https://cdn.example/three.jpg')
  ]
}

const post = parseSocialPostUrl('https://www.instagram.com/p/DPost00001/')!

describe('Instagram and Facebook links', () => {
  it.each([
    ['a reels link', 'https://www.instagram.com/reels/DPost00001/', 'https://www.instagram.com/reel/DPost00001/'],
    [
      'an account before /p/',
      'https://www.instagram.com/poster.one/p/DPost00001/',
      'https://www.instagram.com/p/DPost00001/'
    ],
    [
      'an account before /reel/',
      'https://www.instagram.com/poster_one/reel/DPost00001/?igsh=abc',
      'https://www.instagram.com/reel/DPost00001/'
    ]
  ])('reads Instagram %s', (_name, url, canonicalUrl) => {
    expect(parseSocialPostUrl(url)).toMatchObject({ platform: 'instagram', id: 'DPost00001', canonicalUrl })
  })

  it.each([
    ['a video share link', 'https://www.facebook.com/share/v/1AbCdEf9x/?mibextid=wwXIfr', 'facebook:share:1AbCdEf9x'],
    ['a reel share link', 'https://m.facebook.com/share/r/1AbCdEf9x/', 'facebook:share:1AbCdEf9x'],
    ['a reel', 'https://www.facebook.com/reel/1234567890', 'facebook:1234567890'],
    ['a watch link', 'https://www.facebook.com/watch/?v=1234567890', 'facebook:1234567890'],
    ['a watch link with no slash', 'https://web.facebook.com/watch?v=1234567890', 'facebook:1234567890'],
    ['a page video', 'https://www.facebook.com/example.page/videos/1234567890/', 'facebook:1234567890'],
    [
      'a page video with a slug',
      'https://www.facebook.com/example.page/videos/a-title/1234567890',
      'facebook:1234567890'
    ],
    ['a short watch link', 'https://fb.watch/AbC12dEf/', 'facebook:watch:AbC12dEf']
  ])('reads Facebook %s', (_name, url, lookupKey) => {
    expect(parseSocialPostUrl(url)).toMatchObject({ platform: 'facebook', lookupKey })
  })

  it('keeps the shared Facebook link for the extractor, which follows its redirect', () => {
    expect(parseSocialPostUrl('https://www.facebook.com/share/v/1AbCdEf9x/?mibextid=wwXIfr')).toMatchObject({
      canonicalUrl: 'https://www.facebook.com/share/v/1AbCdEf9x/',
      extractorUrl: 'https://www.facebook.com/share/v/1AbCdEf9x/'
    })
  })

  it.each(['https://www.facebook.com/example.page', 'https://facebook.com.evil.com/reel/1234567890'])(
    'leaves %s to read_page',
    (url) => {
      expect(parseSocialPostUrl(url)).toBeNull()
    }
  )
})

describe('parseInstagramPage', () => {
  it('reads a carousel: every photo, the clip, and never the avatar', () => {
    expect(parseInstagramPage(pageWith(carousel), post, 1500)).toMatchObject({
      platform: 'instagram',
      id: 'DPost00001',
      authorHandle: 'poster_one',
      authorName: 'Poster One',
      createdAt: '2025-11-18',
      text: 'A day out, in three parts',
      replyCount: 12,
      photoCount: 2,
      videoCount: 1,
      imageUrl: 'https://cdn.example/one.jpg',
      photoUrls: ['https://cdn.example/one.jpg', 'https://cdn.example/three.jpg'],
      video: { url: 'https://cdn.example/clip.mp4', bytes: null, headers: null, hasAudio: true },
      thread: []
    })
  })

  it('reads a reel as one video with its cover as the one picture', () => {
    const reel = {
      ...carousel,
      media_type: 2,
      carousel_media: null,
      has_audio: false,
      image_versions2: { candidates: [{ url: 'https://cdn.example/cover.jpg' }] },
      video_versions: [{ type: 101, url: 'https://cdn.example/reel.mp4' }]
    }

    expect(parseInstagramPage(pageWith(reel), post, 1500)).toMatchObject({
      photoCount: 0,
      videoCount: 1,
      photoUrls: [],
      imageUrl: 'https://cdn.example/cover.jpg',
      video: { url: 'https://cdn.example/reel.mp4', hasAudio: false }
    })
  })

  it('reads a single photo post as one photo', () => {
    const single = { ...carousel, media_type: 1, carousel_media: null }
    expect(parseInstagramPage(pageWith(single), post, 1500)).toMatchObject({
      photoCount: 1,
      photoUrls: ['https://cdn.example/one.jpg'],
      video: null
    })
  })

  it('returns null for a gated page, another post, or no data', () => {
    expect(parseInstagramPage(pageWith(null), post, 1500)).toBeNull()
    expect(parseInstagramPage(pageWith({ ...carousel, code: 'DOther0001' }), post, 1500)).toBeNull()
    expect(parseInstagramPage('<html></html>', post, 1500)).toBeNull()
  })
})

describe('SocialPostViewer on Instagram and Facebook', () => {
  it('reads an Instagram post from its page as a browser navigation, without yt-dlp', async () => {
    const fetcher = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) => new Response(pageWith(carousel))
    )
    const runExtractor = vi.fn(async () => ({ reason: 'unused' }))
    const viewer = buildViewer(settings, { fetcher, runExtractor, lookup: async () => ['8.8.8.8'] })

    expect(await viewer.lookup(post)).toMatchObject({ status: 'found', post: { photoCount: 2 } })
    expect(runExtractor).not.toHaveBeenCalled()
    const [url, init] = fetcher.mock.calls[0]!
    expect(String(url)).toBe('https://www.instagram.com/p/DPost00001/')
    expect(new Headers(init?.headers).get('sec-fetch-mode')).toBe('navigate')
  })

  it.each([
    ['a gated page', async () => new Response(pageWith(null))],
    ['a login redirect', async () => new Response(null, { status: 302, headers: { location: '/accounts/login/' } })],
    [
      'a failed fetch',
      async () => {
        throw new Error('reset')
      }
    ]
  ])('falls back to yt-dlp on %s', async (_name, fetcher) => {
    const runExtractor = vi.fn(async () => ({
      metadata: { title: 'From yt-dlp', channel: 'poster_one', thumbnail: 'https://cdn.example/t.jpg' }
    }))
    const viewer = buildViewer(settings, { fetcher: vi.fn(fetcher), runExtractor, lookup: async () => ['8.8.8.8'] })

    expect(await viewer.lookup(post)).toMatchObject({ status: 'found', post: { text: 'From yt-dlp' } })
    expect(runExtractor).toHaveBeenCalledWith('yt-dlp', 'https://www.instagram.com/p/DPost00001/', 1000)
  })

  it('still reads an Instagram page when yt-dlp is missing', async () => {
    const viewer = buildViewer(settings, {
      fetcher: vi.fn(async () => new Response(pageWith(carousel))),
      lookup: async () => ['8.8.8.8']
    })
    viewer.setYtDlpAvailable(false)

    expect(await viewer.lookup(post)).toMatchObject({ status: 'found', post: { photoCount: 2 } })
  })

  it('reads a Facebook video through yt-dlp from the resolved official video URL', async () => {
    const target = parseSocialPostUrl('https://www.facebook.com/share/v/1AbCdEf9x/?mibextid=wwXIfr')!
    const runExtractor = vi.fn(async () => ({
      metadata: {
        title: 'A clip',
        uploader: 'Example Page',
        duration: 11.3,
        formats: [{ format_id: 'sd', ext: 'mp4', url: 'https://video.example/sd.mp4' }]
      }
    }))
    const fetcher = vi.fn(async () => {
      return new Response(null, {
        status: 302,
        headers: { location: 'https://www.facebook.com/reel/1234567890' }
      })
    })
    const viewer = buildViewer(settings, {
      fetcher,
      runExtractor,
      lookup: async () => ['8.8.8.8']
    })

    expect(await viewer.lookup(target)).toMatchObject({
      status: 'found',
      post: { platform: 'facebook', text: 'A clip', videoCount: 1, video: { url: 'https://video.example/sd.mp4' } }
    })
    expect(runExtractor).toHaveBeenCalledWith('yt-dlp', 'https://www.facebook.com/reel/1234567890', 1000)
  })

  it('reports Facebook replies as unsupported', async () => {
    const replies = new ReplyReader(
      { ...settings, maxReplies: 5, maxReplyChars: 280 },
      { fetcher: vi.fn(), runExtractor: vi.fn(), warn: vi.fn(), youtubeApiKey: () => undefined }
    )
    expect(await replies.read(parseSocialPostUrl('https://www.facebook.com/reel/1234567890')!)).toEqual({
      status: 'failed',
      platform: 'facebook',
      reason: 'unsupported'
    })
  })
})
