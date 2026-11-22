import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { fetchThreadsReplies } from '../../src/social/replies/threads.js'
import type { ReplyFetchContext } from '../../src/social/replies/types.js'
import { parseThreadsPage } from '../../src/social/threads.js'
import { findSocialPostTargets, parseOfficialSocialPostUrl, parseSocialPostUrl } from '../../src/social/urls.js'
import { createSocialPostViewer as buildViewer } from '../../src/social/viewer.js'

const PAGE = readFileSync(new URL('../fixtures/social/threads-post.html', import.meta.url), 'utf8')
const target = parseSocialPostUrl('https://www.threads.com/@poster_one/post/DFixtur3abc')!

const createSocialPostViewer = (
  settings: Parameters<typeof buildViewer>[0],
  dependencies: Parameters<typeof buildViewer>[1] = {}
) =>
  buildViewer(settings, {
    fetcher: vi.fn(async () => {
      throw new Error('unexpected fetch')
    }),
    runExtractor: vi.fn(async () => ({ reason: 'unused' })),
    lookup: async () => ['8.8.8.8'],
    ...dependencies
  })

const settings = {
  timeoutMs: 1000,
  maxTextChars: 1500,
  cacheTtlMs: 900_000,
  maxCacheEntries: 2,
  ytDlpPath: 'yt-dlp'
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } })
}

// The page embeds each GraphQL result in this wrapper; a post with no photos or replies needs only the one block.
function pageWith(media: Record<string, unknown>): string {
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
                    'adp_BarcelonaPostPageTargetQueryRelayPreloader_0',
                    { __bbox: { complete: true, result: { data: { media } } } }
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

describe('Threads links', () => {
  it.each([
    ['threads.com', 'https://www.threads.com/@poster_one/post/DFixtur3abc'],
    ['threads.net', 'https://www.threads.net/@poster_one/post/DFixtur3abc'],
    ['a media tab and query', 'https://threads.com/@poster_one/post/DFixtur3abc/media?xmt=abc'],
    ['a dotted username', 'https://www.threads.com/@poster.one/post/DFixtur3abc']
  ])('recognizes %s', (_name, url) => {
    expect(parseSocialPostUrl(url)).toMatchObject({ platform: 'threads', id: 'DFixtur3abc' })
  })

  it('keeps the profile in the canonical address', () => {
    expect(parseSocialPostUrl('https://www.threads.net/@poster_one/post/DFixtur3abc')).toMatchObject({
      lookupKey: 'threads:DFixtur3abc',
      canonicalUrl: 'https://www.threads.com/@poster_one/post/DFixtur3abc',
      profile: 'poster_one'
    })
  })

  it('reads a short /t/ link, which Threads redirects to the full post', () => {
    expect(parseSocialPostUrl('https://www.threads.com/t/DFixtur3abc')).toMatchObject({
      platform: 'threads',
      canonicalUrl: 'https://www.threads.com/t/DFixtur3abc'
    })
  })

  it('reads a share link, which Threads redirects to the full post', () => {
    expect(parseSocialPostUrl('https://www.threads.com/share/BShare12x')).toMatchObject({
      platform: 'threads',
      id: 'BShare12x',
      lookupKey: 'threads:share:BShare12x',
      canonicalUrl: 'https://www.threads.com/share/BShare12x'
    })
  })

  it.each(['https://www.threads.com/@poster_one', 'https://www.threads.com/@poster_one/post/'])('rejects %s', (url) => {
    expect(parseSocialPostUrl(url)).toBeNull()
  })

  it('matches a strict shape on an unknown host and excludes it from official redirects', () => {
    const link = 'https://threads.com.example.test/@poster_one/post/DFixtur3abc'
    expect(parseSocialPostUrl(link)).toMatchObject({ canonicalUrl: target.canonicalUrl, platform: 'threads' })
    expect(parseOfficialSocialPostUrl(link)).toBeNull()
  })

  it('yields a canonical platform target and logs the hostname for a strict shape on an unknown host', () => {
    const onUnknownHost = vi.fn()
    const found = findSocialPostTargets('https://mirror.example/@poster_one/post/DFixtur3abc', onUnknownHost)
    expect(found).toMatchObject([
      { platform: 'threads', canonicalUrl: 'https://www.threads.com/@poster_one/post/DFixtur3abc' }
    ])
    expect(onUnknownHost).toHaveBeenCalledExactlyOnceWith({ platform: 'threads', hostname: 'mirror.example' })
  })
})

describe('parseThreadsPage', () => {
  it('reads the linked post, counting every photo and video in a carousel', () => {
    expect(parseThreadsPage(PAGE, target, 1500)?.post).toMatchObject({
      platform: 'threads',
      id: 'DFixtur3abc',
      authorHandle: 'poster_one',
      authorName: 'Poster One',
      createdAt: '2025-10-03',
      text: 'A day at the research lab. Three photos and a clip.',
      photoCount: 2,
      videoCount: 1,
      imageUrl: 'https://scontent.cdninstagram.com/v/fixture-one.jpg',
      // The second item is the clip; its cover is not a photo.
      photoUrls: [
        'https://scontent.cdninstagram.com/v/fixture-one.jpg',
        'https://scontent.cdninstagram.com/v/fixture-three.jpg'
      ],
      thread: [],
      replyCount: 897,
      video: {
        url: 'https://instagram.fkul4-3.fna.fbcdn.net/o1/v/fixture-clip.mp4',
        bytes: null,
        headers: null,
        hasAudio: true
      }
    })
  })

  it('reads a quoted post and a link card', () => {
    const page = pageWith({
      code: 'DFixtur3abc',
      media_type: 19,
      taken_at: 1759505661,
      caption: { text: 'Worth a read' },
      user: { username: 'poster_one', full_name: '' },
      text_post_app_info: {
        direct_reply_count: 0,
        link_preview_attachment: {
          url: 'https://example.com/a',
          title: 'An article',
          image_url: 'https://example.com/a.jpg'
        },
        share_info: { quoted_post: { caption: { text: 'The original take' }, user: { username: 'quoted_one' } } }
      }
    })

    expect(parseThreadsPage(page, target, 1500)?.post).toMatchObject({
      text: 'Worth a read',
      quotedText: 'The original take',
      quotedAuthorHandle: 'quoted_one',
      externalTitle: 'An article',
      imageUrl: 'https://example.com/a.jpg',
      photoCount: 0,
      videoCount: 0,
      replyCount: 0,
      video: null
    })
  })

  it('never takes the profile picture for a post with no image of its own', () => {
    const page = pageWith({
      code: 'DFixtur3abc',
      media_type: 19,
      caption: { text: 'A text reply' },
      image_versions2: { candidates: [] },
      carousel_media: null,
      user: { username: 'poster_one', profile_pic_url: 'https://scontent.cdninstagram.com/v/t51.2885-19/avatar.jpg' },
      text_post_app_info: {
        reply_to_author: { profile_pic_url: 'https://scontent.cdninstagram.com/v/t51.2885-19/avatar.jpg' }
      }
    })

    expect(parseThreadsPage(page, target, 1500)?.post).toMatchObject({ photoUrls: [], imageUrl: null, photoCount: 0 })
  })

  it('keeps a photo post as one photo and caps a carousel at 20 photos', () => {
    const single = pageWith({
      code: 'DFixtur3abc',
      media_type: 1,
      caption: { text: 'One photo' },
      image_versions2: { candidates: [{ url: 'https://scontent.cdninstagram.com/v/single.jpg' }] },
      user: { username: 'poster_one' }
    })
    const many = pageWith({
      code: 'DFixtur3abc',
      media_type: 8,
      caption: { text: 'Many photos' },
      carousel_media: Array.from({ length: 22 }, (_, index) => ({
        media_type: 1,
        image_versions2: { candidates: [{ url: `https://scontent.cdninstagram.com/v/p${index}.jpg` }] }
      })),
      user: { username: 'poster_one' }
    })

    expect(parseThreadsPage(single, target, 1500)?.post).toMatchObject({
      photoCount: 1,
      photoUrls: ['https://scontent.cdninstagram.com/v/single.jpg']
    })
    const capped = parseThreadsPage(many, target, 1500)?.post
    expect(capped?.photoCount).toBe(22)
    expect(capped?.photoUrls).toHaveLength(20)
    expect(capped?.photoUrls[19]).toBe('https://scontent.cdninstagram.com/v/p19.jpg')
  })

  it('carries the earlier posts of the thread, oldest first, with their photos', () => {
    const node = (code: string, text: string, photos: string[]) => ({
      node: {
        code,
        caption: { text },
        user: { username: 'poster_one' },
        carousel_media: photos.map((url) => ({ media_type: 1, image_versions2: { candidates: [{ url }] } }))
      }
    })
    // As measured on a live page: the post comes in one result, its thread in another that names it by id only.
    const page = `${pageWith({
      id: '1801_77',
      code: 'DFixtur3abc',
      media_type: 19,
      caption: { text: 'The full conclusion, with the original and its replies' },
      user: { username: 'poster_one' },
      text_post_app_info: { is_reply: true }
    })}${pageWith({
      id: '1801_77',
      text_post_app_info: {
        containing_thread: {
          posts: {
            edges: [
              node('DRoot00001', 'Has anyone tried this? I saw a test of 300 runs', [
                'https://scontent.cdninstagram.com/v/table-1.jpg',
                'https://scontent.cdninstagram.com/v/table-2.jpg'
              ]),
              node('DFixtur3abc', 'The linked post itself', [])
            ]
          }
        }
      }
    })}`

    expect(parseThreadsPage(page, target, 1500)?.post.thread).toEqual([
      {
        authorHandle: 'poster_one',
        text: 'Has anyone tried this? I saw a test of 300 runs',
        photoUrls: [
          'https://scontent.cdninstagram.com/v/table-1.jpg',
          'https://scontent.cdninstagram.com/v/table-2.jpg'
        ]
      }
    ])
  })

  it('ignores related posts and returns null when the page carries no post data', () => {
    expect(parseThreadsPage(PAGE, parseSocialPostUrl('https://www.threads.com/@x/post/DOtherPost2')!, 1500)).toBeNull()
    expect(parseThreadsPage('<html><title>Threads</title></html>', target, 1500)).toBeNull()
  })
})

describe('SocialPostViewer on Threads', () => {
  it('requests the post page as a browser navigation and reads the post from it', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => htmlResponse(PAGE))
    const viewer = createSocialPostViewer(settings, { fetcher })

    const result = await viewer.lookup(target)

    expect(result).toMatchObject({ status: 'found', post: { platform: 'threads', authorHandle: 'poster_one' } })
    const [url, init] = fetcher.mock.calls[0]!
    expect(String(url)).toBe('https://www.threads.com/@poster_one/post/DFixtur3abc')
    const headers = new Headers(init?.headers)
    // Without these Threads serves an empty app shell instead of the rendered post.
    expect(headers.get('accept')).toContain('text/html')
    expect(headers.get('sec-fetch-mode')).toBe('navigate')
    expect(headers.get('sec-fetch-dest')).toBe('document')
  })

  it('follows a share link to its post and reads it there', async () => {
    const share = parseSocialPostUrl('https://www.threads.com/share/BShare12x')!
    const fetcher = vi.fn(async (input: string | URL | Request) =>
      String(input).includes('/share/')
        ? new Response(null, {
            status: 302,
            headers: { location: 'https://www.threads.com/@poster_one/post/DFixtur3abc?xmt=abc&slof=1' }
          })
        : htmlResponse(PAGE)
    )
    const viewer = createSocialPostViewer(settings, { fetcher })

    const result = await viewer.lookup(share)

    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      'https://www.threads.com/share/BShare12x',
      'https://www.threads.com/@poster_one/post/DFixtur3abc'
    ])
    expect(result).toMatchObject({
      status: 'found',
      post: {
        id: 'DFixtur3abc',
        canonicalUrl: 'https://www.threads.com/@poster_one/post/DFixtur3abc',
        target: { lookupKey: 'threads:share:BShare12x' },
        photoCount: 2
      }
    })
  })

  it('follows a short link that answers 301', async () => {
    const short = parseSocialPostUrl('https://www.threads.com/t/DFixtur3abc')!
    const fetcher = vi.fn(async (input: string | URL | Request) =>
      String(input).includes('/t/')
        ? new Response(null, { status: 301, headers: { location: '/@poster_one/post/DFixtur3abc' } })
        : htmlResponse(PAGE)
    )

    expect(await createSocialPostViewer(settings, { fetcher }).lookup(short)).toMatchObject({
      status: 'found',
      post: { authorHandle: 'poster_one' }
    })
  })

  it.each([
    ['another host', 'https://evil.example/@poster_one/post/DFixtur3abc'],
    ['another share link', 'https://www.threads.com/share/BOther123'],
    ['no location', '']
  ])('refuses a redirect to %s', async (_name, location) => {
    const share = parseSocialPostUrl('https://www.threads.com/share/BShare12x')!
    const fetcher = vi.fn(async () => new Response(null, { status: 302, headers: location ? { location } : {} }))

    expect(await createSocialPostViewer(settings, { fetcher }).lookup(share)).toEqual({
      status: 'failed',
      platform: 'threads',
      reason: 'redirect'
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('reports a page without post data as unopened', async () => {
    const viewer = createSocialPostViewer(settings, { fetcher: vi.fn(async () => htmlResponse('<html></html>')) })

    expect(await viewer.lookup(target)).toEqual({ status: 'failed', platform: 'threads', reason: 'no_post_data' })
  })

  it('reports an HTTP failure', async () => {
    const viewer = createSocialPostViewer(settings, { fetcher: vi.fn(async () => htmlResponse('', 429)) })

    expect(await viewer.lookup(target)).toEqual({ status: 'failed', platform: 'threads', reason: 'http_429' })
  })
})

describe('fetchThreadsReplies', () => {
  it('ranks the replies the page carries by likes, once each, skipping ones without text', async () => {
    const context = replyContext({ fetcher: vi.fn(async () => htmlResponse(PAGE)) as unknown as typeof fetch })

    expect(await fetchThreadsReplies(target, context)).toEqual({
      status: 'found',
      platform: 'threads',
      total: 897,
      replies: [
        { author: 'critic_one', text: 'Not convinced', likes: 17 },
        { author: 'fan_three', text: 'When does it ship?', likes: 13 },
        { author: 'fan_one', text: 'Looks great', likes: 7 },
        { author: 'fan_two', text: 'Count me in', likes: 4 },
        { author: 'fan_five', text: 'Nice', likes: 0 }
      ]
    })
  })

  it('reads the replies of a share link from the post it redirects to', async () => {
    const share = parseSocialPostUrl('https://www.threads.com/share/BShare12x')!
    const fetcher = vi.fn(async (input: string | URL | Request) =>
      String(input).includes('/share/')
        ? new Response(null, {
            status: 302,
            headers: { location: 'https://www.threads.com/@poster_one/post/DFixtur3abc' }
          })
        : htmlResponse(PAGE)
    )

    expect(
      await fetchThreadsReplies(share, replyContext({ fetcher: fetcher as unknown as typeof fetch }))
    ).toMatchObject({
      status: 'found',
      total: 897
    })
  })

  it('fails when the page carries no post data', async () => {
    const context = replyContext({
      fetcher: vi.fn(async () => htmlResponse('<html></html>')) as unknown as typeof fetch
    })

    expect(await fetchThreadsReplies(target, context)).toEqual({
      status: 'failed',
      platform: 'threads',
      reason: 'no_post_data'
    })
  })
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function replyContext(overrides: Partial<ReplyFetchContext> = {}): ReplyFetchContext {
  return {
    fetcher: vi.fn(async () => jsonResponse({})) as unknown as typeof fetch,
    runExtractor: vi.fn(async () => ({ reason: 'unused' })),
    ytDlpPath: 'yt-dlp',
    signal: new AbortController().signal,
    maxReplies: 5,
    maxReplyChars: 280,
    youtubeApiKey: 'test-youtube-key',
    timeoutMs: 6000,
    ...overrides
  }
}

it('attaches only the typed carousel video for duration probing', () => {
  const parsed = parseThreadsPage(PAGE, target, 1500)!
  expect(parsed.post.attachments?.filter((item) => item.kind === 'video')).toEqual([
    {
      kind: 'video',
      owner: target.lookupKey,
      durationSec: null,
      video: expect.objectContaining({
        url: 'https://instagram.fkul4-3.fna.fbcdn.net/o1/v/fixture-clip.mp4'
      })
    }
  ])
})
