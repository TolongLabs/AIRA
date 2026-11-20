import { describe, expect, it, vi } from 'vitest'
import { parseFacebookPage } from '../../src/social/facebook.js'
import { parseSocialPostUrl } from '../../src/social/urls.js'
import { createSocialPostViewer as buildViewer } from '../../src/social/viewer.js'

const settings = { timeoutMs: 1000, maxTextChars: 1500, cacheTtlMs: 0, maxCacheEntries: 2, ytDlpPath: 'yt-dlp' }

const photo = (id: string) => ({
  media: {
    __typename: 'Photo',
    id,
    image: { uri: `https://cdn.example/${id}-small.jpg`, width: 332, height: 590 },
    viewer_image: { uri: `https://cdn.example/${id}.jpg`, width: 1152, height: 2048 }
  }
})

function story(postId: string, attachment: Record<string, unknown>, text = 'I solved the RAM crisis.') {
  return {
    __typename: 'Story',
    post_id: postId,
    creation_time: 1794769142,
    actors: [{ __typename: 'User', name: 'Poster One', id: '1' }],
    attachments: [{ styles: { attachment } }],
    comet_sections: { content: { story: { comet_sections: { message: { story: { message: { text } } } } } } }
  }
}

// As measured on a public group post: the story is the query's `node`, its photos under all_subattachments.
function pageWith(...stories: Record<string, unknown>[]): string {
  const blocks = stories.map((node) => ({
    require: [['ScheduledServerJS', 'handle', null, [{ __bbox: { result: { data: { node } } } }]]]
  }))
  return `<html>${blocks
    .map((block) => `<script type="application/json" data-sjs>${JSON.stringify(block)}</script>`)
    .join('')}</html>`
}

const permalink = parseSocialPostUrl('https://www.facebook.com/groups/12345/permalink/2921750018/')!
const album = story('2921750018', { all_subattachments: { count: 2, nodes: [photo('p1'), photo('p2')] } })
const photoPost = story('1234567890', { media: photo('ph1').media }, 'A photo from the lab.')

describe('Facebook post links', () => {
  it.each([
    ['a post share link', 'https://www.facebook.com/share/p/1FrDwJtBqj/', 'facebook:post-share:1FrDwJtBqj'],
    [
      'a group permalink',
      'https://www.facebook.com/groups/12345/permalink/2921750018/?rdid=x',
      'facebook:post:2921750018'
    ],
    ['a group post', 'https://m.facebook.com/groups/12345/posts/2921750018/', 'facebook:post:2921750018'],
    ['a page post', 'https://www.facebook.com/example.page/posts/pfbid02AbC', 'facebook:post:pfbid02AbC'],
    [
      'a permalink.php link',
      'https://www.facebook.com/permalink.php?story_fbid=2921750018&id=4',
      'facebook:post:2921750018'
    ]
  ])('reads %s', (_name, url, lookupKey) => {
    expect(parseSocialPostUrl(url)).toMatchObject({ platform: 'facebook', lookupKey })
  })

  it('keeps a group permalink without its tracking parameters', () => {
    expect(
      parseSocialPostUrl('https://www.facebook.com/groups/12345/permalink/2921750018/?rdid=x&share_url=y')
    ).toMatchObject({ canonicalUrl: 'https://www.facebook.com/groups/12345/permalink/2921750018/', id: '2921750018' })
  })
})

describe('parseFacebookPage', () => {
  it('reads the text, author, date and every photo at full size', () => {
    expect(parseFacebookPage(pageWith(album), permalink, 1500)).toMatchObject({
      platform: 'facebook',
      authorName: 'Poster One',
      createdAt: '2026-11-15',
      text: 'I solved the RAM crisis.',
      photoCount: 2,
      photoUrls: ['https://cdn.example/p1.jpg', 'https://cdn.example/p2.jpg'],
      imageUrl: 'https://cdn.example/p1.jpg',
      video: null
    })
  })

  it('reads a single photo post', () => {
    const single = story('2921750018', { media: photo('p9').media })
    expect(parseFacebookPage(pageWith(single), permalink, 1500)?.photoUrls).toEqual(['https://cdn.example/p9.jpg'])
  })

  it('prefers the story with the linked post id over others on the page', () => {
    const other = story('777', { all_subattachments: { nodes: [photo('x1')] } }, 'Another post')
    expect(parseFacebookPage(pageWith(other, album), permalink, 1500)?.text).toBe('I solved the RAM crisis.')
  })

  it('leaves a video post, or a page with no story, to yt-dlp', () => {
    const video = story('2921750018', { media: { __typename: 'Video', id: 'v1' } })
    expect(parseFacebookPage(pageWith(video), permalink, 1500)).toBeNull()
    expect(parseFacebookPage('<html></html>', permalink, 1500)).toBeNull()
  })
})

describe('SocialPostViewer on Facebook posts', () => {
  it('follows a post share link to its permalink and reads the page, without yt-dlp', async () => {
    const share = parseSocialPostUrl('https://www.facebook.com/share/p/1FrDwJtBqj/')!
    const fetcher = vi.fn(async (input: string | URL | Request) =>
      String(input).includes('/share/')
        ? new Response(null, {
            status: 302,
            headers: {
              location: 'https://www.facebook.com/groups/12345/permalink/2921750018/?rdid=x&share_url=y'
            }
          })
        : new Response(pageWith(album))
    )
    const runExtractor = vi.fn(async () => ({ reason: 'unused' }))
    const viewer = buildViewer(settings, { fetcher, runExtractor, lookup: async () => ['8.8.8.8'] })

    expect(await viewer.lookup(share)).toMatchObject({
      status: 'found',
      post: {
        canonicalUrl: 'https://www.facebook.com/groups/12345/permalink/2921750018/',
        target: { lookupKey: 'facebook:post-share:1FrDwJtBqj' },
        photoCount: 2
      }
    })
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      'https://www.facebook.com/share/p/1FrDwJtBqj/',
      'https://www.facebook.com/groups/12345/permalink/2921750018/'
    ])
    expect(runExtractor).not.toHaveBeenCalled()
  })

  it('refuses a share link that redirects to a foreign host, without calling the extractor', async () => {
    const share = parseSocialPostUrl('https://www.facebook.com/share/p/1FrDwJtBqj/')!
    const runExtractor = vi.fn(async () => ({ metadata: { title: 'From yt-dlp' } }))
    const viewer = buildViewer(settings, {
      fetcher: vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/x' } })),
      runExtractor,
      lookup: async () => ['8.8.8.8']
    })

    expect(await viewer.lookup(share)).toEqual({ status: 'failed', platform: 'facebook', reason: 'redirect' })
    expect(runExtractor).not.toHaveBeenCalled()
  })

  it('falls back to yt-dlp on the resolved official permalink when the resolved page has no story', async () => {
    const share = parseSocialPostUrl('https://www.facebook.com/share/p/1FrDwJtBqj/')!
    const runExtractor = vi.fn(async () => ({ metadata: { title: 'From yt-dlp', uploader: 'Example Page' } }))
    const fetcher = vi.fn(async (input: string | URL | Request) =>
      String(input).includes('/share/')
        ? new Response(null, {
            status: 302,
            headers: {
              location: 'https://www.facebook.com/groups/12345/permalink/2921750018/?rdid=x&share_url=y'
            }
          })
        : new Response('<html></html>')
    )
    const viewer = buildViewer(settings, { fetcher, runExtractor, lookup: async () => ['8.8.8.8'] })

    expect(await viewer.lookup(share)).toMatchObject({ status: 'found', post: { text: 'From yt-dlp' } })
    expect(runExtractor).toHaveBeenCalledWith(
      'yt-dlp',
      'https://www.facebook.com/groups/12345/permalink/2921750018/',
      1000
    )
  })

  it.each([
    ['a photo link', 'https://www.facebook.com/photo/?fbid=1234567890'],
    ['a photo.php link', 'https://www.facebook.com/photo.php?fbid=1234567890']
  ])('reads %s from its logged-out page, with no profile and no yt-dlp', async (_name, url) => {
    const fetcher = vi.fn(async (_input: string | URL | Request) => new Response(pageWith(photoPost)))
    const runExtractor = vi.fn(async () => ({ reason: 'unused' }))
    const viewer = buildViewer(settings, { fetcher, runExtractor, lookup: async () => ['8.8.8.8'] })

    expect(await viewer.lookup(parseSocialPostUrl(url)!)).toMatchObject({
      status: 'found',
      post: {
        photoUrls: ['https://cdn.example/ph1.jpg'],
        photoCount: 1,
        imageUrl: 'https://cdn.example/ph1.jpg',
        target: { lookupKey: 'facebook:photo:1234567890' }
      }
    })
    expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual([
      'https://www.facebook.com/photo/?fbid=1234567890'
    ])
    expect(runExtractor).not.toHaveBeenCalled()
  })

  it('reads a photo link when yt-dlp is not installed', async () => {
    const photoLink = parseSocialPostUrl('https://www.facebook.com/photo/?fbid=1234567890')!
    const runExtractor = vi.fn(async () => ({ reason: 'binary_missing' }))
    const viewer = buildViewer(settings, {
      fetcher: vi.fn(async (_input: string | URL | Request) => new Response(pageWith(photoPost))),
      runExtractor,
      lookup: async () => ['8.8.8.8']
    })
    viewer.setYtDlpAvailable(false)

    expect(await viewer.lookup(photoLink)).toMatchObject({ status: 'found', post: { photoCount: 1 } })
    expect(runExtractor).not.toHaveBeenCalled()
  })

  it('follows a share link that resolves to a photo, and reads the photo without yt-dlp', async () => {
    const share = parseSocialPostUrl('https://www.facebook.com/share/p/1FrDwJtBqj/')!
    const fetcher = vi.fn(async (input: string | URL | Request) =>
      String(input).includes('/share/')
        ? new Response(null, {
            status: 302,
            headers: { location: 'https://www.facebook.com/photo/?fbid=1234567890&set=a.1' }
          })
        : new Response(pageWith(photoPost))
    )
    const runExtractor = vi.fn(async () => ({ reason: 'unused' }))
    const viewer = buildViewer(settings, { fetcher, runExtractor, lookup: async () => ['8.8.8.8'] })

    expect(await viewer.lookup(share)).toMatchObject({
      status: 'found',
      post: {
        photoUrls: ['https://cdn.example/ph1.jpg'],
        target: { lookupKey: 'facebook:post-share:1FrDwJtBqj' }
      }
    })
    expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual([
      'https://www.facebook.com/share/p/1FrDwJtBqj/',
      'https://www.facebook.com/photo/?fbid=1234567890'
    ])
    expect(runExtractor).not.toHaveBeenCalled()
  })

  it('falls back to yt-dlp on the photo link when its page holds no post', async () => {
    const photoLink = parseSocialPostUrl('https://www.facebook.com/photo/?fbid=1234567890')!
    const runExtractor = vi.fn(async () => ({ metadata: { title: 'From yt-dlp' } }))
    const viewer = buildViewer(settings, {
      fetcher: vi.fn(async (_input: string | URL | Request) => new Response('<html></html>')),
      runExtractor,
      lookup: async () => ['8.8.8.8']
    })

    expect(await viewer.lookup(photoLink)).toMatchObject({ status: 'found', post: { text: 'From yt-dlp' } })
    expect(runExtractor).toHaveBeenCalledWith('yt-dlp', 'https://www.facebook.com/photo/?fbid=1234567890', 1000)
  })
})
