import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { bilibiliAid } from '../../src/social/replies/bilibili.js'
import { ReplyReader } from '../../src/social/replies/service.js'
import { parseSocialPostUrl } from '../../src/social/urls.js'

const settings = {
  timeoutMs: 100,
  maxReplies: 5,
  maxReplyChars: 280,
  cacheTtlMs: 100,
  maxCacheEntries: 2,
  ytDlpPath: 'unused'
}

function fixture(name: string): string {
  return readFileSync(new URL(`../fixtures/social/replies/${name}`, import.meta.url), 'utf8')
}

function dependencies(body = '{}') {
  return {
    fetcher: vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) => new Response(body)),
    runExtractor: vi.fn(async () => ({ metadata: JSON.parse(fixture('instagram-comments.json')) as unknown })),
    lookup: vi.fn(async () => ['8.8.8.8']),
    youtubeApiKey: () => 'example-key',
    warn: vi.fn()
  }
}

describe('reply reader recordings', () => {
  it.each([
    ['https://x.com/example_user/status/123', 'x-conversation.json', 'fan_one', 205],
    ['https://bsky.app/profile/did:plc:example/post/abc123', 'bluesky-thread-replies.json', 'fan2.bsky.social', 9],
    ['https://youtu.be/example123', 'youtube-comment-threads.json', 'viewerA', null],
    ['https://tiktok.com/@example_user/video/123', 'tiktok-comment-list.json', 'collector_b', 6],
    ['https://reddit.com/comments/abc123/', 'reddit-comments.rss', 'commenter_one', null],
    ['https://bilibili.com/video/av123', 'bilibili-reply.json', '观众甲', 236883]
  ])('reads and ranks the recorded replies for %s', async (url, name, author, total) => {
    const deps = dependencies(fixture(name))
    const reader = new ReplyReader(settings, deps)
    const result = await reader.read(parseSocialPostUrl(url)!)
    expect(result).toMatchObject({ status: 'found', total })
    if (result.status !== 'found') throw new Error('expected replies')
    expect(result.replies[0]?.author).toBe(author)
    expect(result.replies.length).toBeLessThanOrEqual(5)
    expect(result.replies.every((reply) => reply.text && Array.from(reply.text).length <= 280)).toBe(true)
    expect(deps.fetcher).toHaveBeenCalledOnce()
    expect(deps.fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal) })
    expect(deps.lookup).toHaveBeenCalledOnce()
  })

  it('keeps only Instagram top-level comments and asks the extractor for comments', async () => {
    const deps = dependencies()
    const reader = new ReplyReader(settings, deps)
    const target = parseSocialPostUrl('https://instagram.com/reel/Example123/')!
    expect(await reader.read(target)).toMatchObject({
      status: 'found',
      total: 654,
      replies: [
        { author: 'fan_c', likes: 40 },
        { author: 'fan_a', likes: 12 },
        { author: 'fan_e', likes: 7 },
        { author: 'fan_d', likes: null }
      ]
    })
    expect(deps.runExtractor).toHaveBeenCalledWith('unused', target.extractorUrl, 100, ['--write-comments'])
    expect(deps.fetcher).not.toHaveBeenCalled()
  })

  it('requires an optional key only for YouTube replies', async () => {
    const deps = { ...dependencies(), youtubeApiKey: () => undefined }
    expect(await new ReplyReader(settings, deps).read(parseSocialPostUrl('https://youtu.be/example123')!)).toEqual({
      status: 'failed',
      platform: 'youtube',
      reason: 'not_configured'
    })
    expect(deps.fetcher).not.toHaveBeenCalled()
  })

  it('maps disabled YouTube comments without exposing the provider body or key', async () => {
    const deps = dependencies()
    deps.fetcher.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            error: { errors: [{ reason: 'commentsDisabled' }], message: 'private detail' }
          }),
          { status: 403 }
        )
    )
    expect(await new ReplyReader(settings, deps).read(parseSocialPostUrl('https://youtu.be/example123')!)).toEqual({
      status: 'failed',
      platform: 'youtube',
      reason: 'comments_disabled'
    })
    expect(deps.warn).toHaveBeenCalledWith('youtube', 'comments_disabled')
  })

  it('caches successes by requested count, expires entries and evicts the least recently read', async () => {
    let now = 0
    const deps = dependencies(fixture('x-conversation.json'))
    const reader = new ReplyReader(settings, { ...deps, now: () => now })
    const target = parseSocialPostUrl('https://x.com/example_user/status/123')!
    await reader.read(target, 1)
    await reader.read(target, 2)
    await reader.read(target, 1)
    await reader.read(target, 3)
    await reader.read(target, 2)
    expect(deps.fetcher).toHaveBeenCalledTimes(4)
    now = 101
    await reader.read(target, 2)
    expect(deps.fetcher).toHaveBeenCalledTimes(5)
  })

  it('caps requested replies at 50', async () => {
    const replies = Array.from({ length: 60 }, (_, i) => ({ text: `reply ${i}`, likes: i }))
    const reader = new ReplyReader(settings, dependencies(JSON.stringify({ replies })))
    const result = await reader.read(parseSocialPostUrl('https://x.com/example_user/status/123')!, 100)
    expect(result.status === 'found' && result.replies.length).toBe(50)
  })

  it('times out a fetch that never resolves and does not cache failures', async () => {
    const deps = dependencies()
    deps.fetcher.mockImplementation(async () => new Promise<Response>(() => {}))
    const reader = new ReplyReader({ ...settings, timeoutMs: 10 }, deps)
    const target = parseSocialPostUrl('https://x.com/example_user/status/123')!
    expect(await reader.read(target)).toMatchObject({ status: 'failed', reason: 'timeout' })
    expect(deps.fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
    deps.fetcher.mockImplementation(async () => new Response(fixture('x-conversation.json')))
    expect(await reader.read(target)).toMatchObject({ status: 'found' })
  })

  it('cancels promptly on the parent signal and refuses Instagram without a binary', async () => {
    const deps = dependencies()
    deps.fetcher.mockImplementation(async () => new Promise<Response>(() => {}))
    const reader = new ReplyReader(settings, deps)
    const controller = new AbortController()
    const pending = reader.read(parseSocialPostUrl('https://x.com/example_user/status/123')!, 5, controller.signal)
    controller.abort()
    expect(await pending).toMatchObject({ status: 'failed', reason: 'timeout' })
    reader.setYtDlpAvailable(false)
    expect(await reader.read(parseSocialPostUrl('https://instagram.com/reel/Example123/')!)).toMatchObject({
      status: 'failed',
      reason: 'binary_missing'
    })
    expect(deps.runExtractor).not.toHaveBeenCalled()
  })

  it('converts a Bilibili BV key to its numeric aid', () => {
    expect(bilibiliAid('BV1GJ411x7h7')).toBe('80433022')
    expect(bilibiliAid('av123')).toBe('123')
    expect(bilibiliAid('invalid')).toBeNull()
  })
})
