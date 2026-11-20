import { describe, expect, it, vi } from 'vitest'
import { resolveShareLink } from '../../src/social/share.js'
import { parseSocialPostUrl } from '../../src/social/urls.js'
import { SocialPostViewer } from '../../src/social/viewer.js'

const settings = { timeoutMs: 1000, maxTextChars: 1500, cacheTtlMs: 60_000, maxCacheEntries: 8, ytDlpPath: 'yt-dlp' }
const REDDIT_SHARE = parseSocialPostUrl('https://www.reddit.com/r/example_sub/s/AbC123xyz')!
const TIKTOK_SHORT = parseSocialPostUrl('https://vm.tiktok.com/ZMexample/')!

const redirect = (location: string, status = 302) => new Response(null, { status, headers: { location } })

/** A fetcher that answers each address with its own response, and throws for an address it was not given. */
function routes(answers: Record<string, () => Response>) {
  return vi.fn(async (input: string | URL | Request) => {
    const answer = answers[String(input)]
    if (!answer) throw new Error(`unexpected address ${String(input)}`)
    return answer()
  })
}

describe('resolveShareLink', () => {
  it('resolves a Reddit share to the comment page it redirects to', async () => {
    const fetcher = routes({
      'https://www.reddit.com/r/example_sub/s/AbC123xyz/': () =>
        redirect('https://www.reddit.com/r/example_sub/comments/abc123/a_post/?share_id=x')
    })
    expect(await resolveShareLink(REDDIT_SHARE, fetcher)).toMatchObject({
      platform: 'reddit',
      id: 'abc123',
      canonicalUrl: 'https://www.reddit.com/comments/abc123/'
    })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher).toHaveBeenCalledWith(
      'https://www.reddit.com/r/example_sub/s/AbC123xyz/',
      expect.objectContaining({ redirect: 'manual' })
    )
  })

  it('follows a TikTok short link through its /t/ share to the video, two redirects in all', async () => {
    const fetcher = routes({
      'https://vm.tiktok.com/ZMexample/': () => redirect('https://www.tiktok.com/t/ZTexample/'),
      'https://www.tiktok.com/t/ZTexample/': () =>
        redirect('https://www.tiktok.com/@example_user/video/1234567890', 301)
    })
    expect(await resolveShareLink(TIKTOK_SHORT, fetcher)).toMatchObject({ platform: 'tiktok', id: '1234567890' })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('refuses a third redirect hop without requesting it', async () => {
    const fetcher = routes({
      'https://vm.tiktok.com/ZMexample/': () => redirect('https://www.tiktok.com/t/ZTexample/'),
      'https://www.tiktok.com/t/ZTexample/': () => redirect('https://www.tiktok.com/t/ZTother/')
    })
    expect(await resolveShareLink(TIKTOK_SHORT, fetcher)).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('refuses a redirect to another host, even one that parses as the same platform', async () => {
    const fetcher = routes({
      'https://www.reddit.com/r/example_sub/s/AbC123xyz/': () =>
        redirect('https://evil.example/r/example_sub/comments/abc123/a_post/')
    })
    expect(await resolveShareLink(REDDIT_SHARE, fetcher)).toBeNull()
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('refuses a redirect that parses as another platform', async () => {
    const fetcher = routes({
      'https://www.reddit.com/r/example_sub/s/AbC123xyz/': () =>
        redirect('https://bsky.app/profile/example_user.test/post/abc123')
    })
    expect(await resolveShareLink(REDDIT_SHARE, fetcher)).toBeNull()
  })

  it.each([
    ['a page with no redirect', () => new Response('<html></html>')],
    ['a redirect with no Location', () => new Response(null, { status: 302 })]
  ])('refuses %s', async (_name, answer) => {
    expect(
      await resolveShareLink(REDDIT_SHARE, routes({ 'https://www.reddit.com/r/example_sub/s/AbC123xyz/': answer }))
    ).toBeNull()
  })

  it('refuses a share whose request is refused or fails', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('forbidden address')
    })
    expect(await resolveShareLink(REDDIT_SHARE, fetcher)).toBeNull()
  })

  it('follows one hop on the platform domain that names no post, then reads the post it redirects to', async () => {
    const share = parseSocialPostUrl('https://www.facebook.com/share/AbCdEf9x/')!
    const fetcher = routes({
      'https://www.facebook.com/share/AbCdEf9x/': () =>
        redirect('https://www.facebook.com/someone/unrecognised/?ref=share'),
      'https://www.facebook.com/someone/unrecognised/?ref=share': () =>
        redirect('https://www.facebook.com/example_page/posts/pfbid0AbCdEf123')
    })
    expect(await resolveShareLink(share, fetcher)).toMatchObject({
      platform: 'facebook',
      id: 'pfbid0AbCdEf123',
      canonicalUrl: 'https://www.facebook.com/example_page/posts/pfbid0AbCdEf123'
    })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('refuses a hop that names no post as the second and last allowed hop', async () => {
    const share = parseSocialPostUrl('https://www.facebook.com/share/AbCdEf9x/')!
    const fetcher = routes({
      'https://www.facebook.com/share/AbCdEf9x/': () => redirect('https://www.facebook.com/share/v/1AbCdEf9x/'),
      'https://www.facebook.com/share/v/1AbCdEf9x/': () => redirect('https://www.facebook.com/someone/unrecognised/')
    })
    expect(await resolveShareLink(share, fetcher)).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})

describe('SocialPostViewer on share links', () => {
  it('refuses a stalled share redirect within the wall-time budget, with no second fetch', async () => {
    const fetcher = vi.fn(async () => new Promise<Response>(() => {}))
    const viewer = new SocialPostViewer(
      { ...settings, timeoutMs: 5000 },
      { fetcher, lookup: async () => ['8.8.8.8'], warn: vi.fn() }
    )

    expect(await viewer.lookup(REDDIT_SHARE)).toEqual({ status: 'failed', platform: 'reddit', reason: 'redirect' })
    expect(fetcher).toHaveBeenCalledOnce()
  }, 10000)

  it('resolves a share before the platform lookup, and the post keeps the link it was asked for', async () => {
    const fetcher = routes({
      'https://vm.tiktok.com/ZMexample/': () => redirect('https://www.tiktok.com/@example_user/video/1234567890')
    })
    const runExtractor = vi.fn(async () => ({ metadata: { title: 'A clip', uploader: 'example_user' } }))
    const viewer = new SocialPostViewer(settings, {
      fetcher,
      runExtractor,
      lookup: async () => ['8.8.8.8'],
      warn: vi.fn()
    })

    expect(await viewer.lookup(TIKTOK_SHORT)).toMatchObject({
      status: 'found',
      post: { target: { lookupKey: 'tiktok:share:ZMexample' } }
    })
    expect(runExtractor).toHaveBeenCalledWith('yt-dlp', 'https://www.tiktok.com/@example_user/video/1234567890', 1000)
  })

  it('caches a resolved share, so a post that then fails is not resolved again', async () => {
    const fetcher = routes({
      'https://vm.tiktok.com/ZMexample/': () => redirect('https://www.tiktok.com/@example_user/video/1234567890')
    })
    const runExtractor = vi.fn(async () => ({ reason: 'http_404' }))
    const viewer = new SocialPostViewer(settings, {
      fetcher,
      runExtractor,
      lookup: async () => ['8.8.8.8'],
      warn: vi.fn()
    })

    expect(await viewer.lookup(TIKTOK_SHORT)).toMatchObject({ status: 'failed', reason: 'http_404' })
    expect(await viewer.lookup(TIKTOK_SHORT)).toMatchObject({ status: 'failed', reason: 'http_404' })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(runExtractor).toHaveBeenCalledTimes(2)
  })

  it('fails a share that does not resolve, without reading the post', async () => {
    const fetcher = routes({ 'https://vm.tiktok.com/ZMexample/': () => new Response('<html></html>') })
    const runExtractor = vi.fn(async () => ({ reason: 'unused' }))
    const viewer = new SocialPostViewer(settings, {
      fetcher,
      runExtractor,
      lookup: async () => ['8.8.8.8'],
      warn: vi.fn()
    })

    expect(await viewer.lookup(TIKTOK_SHORT)).toEqual({ status: 'failed', platform: 'tiktok', reason: 'redirect' })
    expect(runExtractor).not.toHaveBeenCalled()
  })
})

describe('SocialPostViewer on Facebook share links', () => {
  it.each([
    ['a short watch link', 'https://fb.watch/AbC12dEf/'],
    ['a video share', 'https://www.facebook.com/share/v/1AbCdEf9x/'],
    ['a reel share', 'https://www.facebook.com/share/r/1AbCdEf9x/'],
    ['a post share', 'https://www.facebook.com/share/p/1FrDwJtBqj/']
  ])('never hands the extractor the address of %s when its redirect is refused', async (_name, link) => {
    const share = parseSocialPostUrl(link)!
    const fetcher = routes({ [share.canonicalUrl]: () => redirect('https://evil.example/x') })
    const runExtractor = vi.fn(async () => ({ reason: 'unused' }))
    const viewer = new SocialPostViewer(settings, {
      fetcher,
      runExtractor,
      lookup: async () => ['8.8.8.8'],
      warn: vi.fn()
    })

    expect(await viewer.lookup(share)).toEqual({ status: 'failed', platform: 'facebook', reason: 'redirect' })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(runExtractor).not.toHaveBeenCalled()
  })

  it('extracts a watch share from the address its redirect names, not from the share', async () => {
    const share = parseSocialPostUrl('https://fb.watch/AbC12dEf/')!
    const fetcher = routes({
      'https://fb.watch/AbC12dEf/': () => redirect('https://www.facebook.com/watch/?v=1234567890')
    })
    const runExtractor = vi.fn(async () => ({ metadata: { title: 'A clip', uploader: 'Example Page' } }))
    const viewer = new SocialPostViewer(settings, {
      fetcher,
      runExtractor,
      lookup: async () => ['8.8.8.8'],
      warn: vi.fn()
    })

    expect(await viewer.lookup(share)).toMatchObject({
      status: 'found',
      post: { target: { lookupKey: 'facebook:watch:AbC12dEf' } }
    })
    expect(runExtractor).toHaveBeenCalledWith('yt-dlp', 'https://www.facebook.com/watch/?v=1234567890', 1000)
  })
})
