import { describe, expect, it, vi } from 'vitest'
import { createSocialPostPort } from '../../src/social/port.js'
import { ReplyReader } from '../../src/social/replies/service.js'
import { SocialPostViewer } from '../../src/social/viewer.js'
import { readPostTool } from '../../src/tools/core/web.js'
import type { ToolContext } from '../../src/tools/types.js'

const settings = {
  timeoutMs: 100,
  maxTextChars: 1500,
  cacheTtlMs: 900000,
  maxCacheEntries: 2,
  maxReplies: 5,
  maxReplyChars: 280,
  ytDlpPath: 'unused'
}
const url = 'https://x.com/example_user/status/123'
const signal = () => new AbortController().signal
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

function readers(fetcher: typeof fetch, overrides: Partial<typeof settings> = {}) {
  const dependencies = {
    fetcher,
    runExtractor: vi.fn(async () => ({ reason: 'unused' })),
    lookup: vi.fn(async () => ['8.8.8.8']),
    warn: vi.fn(),
    youtubeApiKey: () => undefined
  }
  const config = { ...settings, ...overrides }
  const viewer = new SocialPostViewer(config, dependencies)
  const replies = new ReplyReader(config, dependencies)
  return { viewer, replies, port: createSocialPostPort(viewer, replies), dependencies }
}

describe('social tool port', () => {
  it('starts the post and reply requests in parallel and returns shaped, untrusted data', async () => {
    let release: (() => void) | undefined
    const postStarted = new Promise<void>((resolve) => {
      release = resolve
    })
    const requests: string[] = []
    const fetcher: typeof fetch = async (input) => {
      const address = String(input)
      requests.push(address)
      if (address.includes('/2/conversation/')) {
        release?.()
        return json({
          replies: Array.from({ length: 8 }, (_, i) => ({
            author: { screen_name: `example_reply_${i}` },
            text: 'a'.repeat(400),
            likes: i
          }))
        })
      }
      await postStarted
      return json({
        tweet: {
          text: 'Post text',
          author: { screen_name: 'example_user', name: 'Example Person' },
          replies: 8,
          media: {
            photos: [{ url: 'https://media.example/photo.jpg' }],
            videos: [{ url: 'https://media.example/video.mp4', format: 'video/mp4', duration: 12 }]
          }
        }
      })
    }
    const { port } = readers(fetcher)
    const result = await port.read(url, signal())
    expect(requests).toHaveLength(2)
    expect(result).toMatchObject({
      untrusted: true,
      platform: 'x',
      author: 'Example Person',
      handle: 'example_user',
      text: 'Post text',
      canonicalUrl: 'https://x.com/i/status/123',
      replyCount: 8,
      durationSec: 12,
      media: ['https://media.example/photo.jpg', 'https://media.example/video.mp4']
    })
    expect(result.replies).toHaveLength(5)
    expect(result.replies?.[0]).toEqual({ author: 'example_reply_7', text: 'a'.repeat(280), likes: 7 })
  })

  it('keeps a found post when replies fail', async () => {
    const { port } = readers(async (input) =>
      String(input).includes('/2/conversation/') ? json({}, 429) : json({ tweet: { text: 'Post text' } })
    )
    expect(await port.read(url, signal())).toMatchObject({ text: 'Post text', replies: [] })
  })

  it.each([
    [404, 'error', 'http_404'],
    [429, 'error', 'http_429'],
    [503, 'error', 'http_503']
  ])('maps HTTP %i to a bounded tool failure', async (status, kind, reason) => {
    const { port } = readers(async () => new Response('private response', { status }))
    const tool = readPostTool({ post: port, filesDir: '/tmp' })
    expect(await tool.handler({ url }, { signal: signal() } as ToolContext)).toEqual({ ok: false, kind, reason })
  })

  it('returns timeout even when an injected fetch ignores cancellation', async () => {
    const { port } = readers(async () => new Promise<Response>(() => {}), { timeoutMs: 10 })
    const tool = readPostTool({ post: port, filesDir: '/tmp' })
    expect(await tool.handler({ url }, { signal: signal() } as ToolContext)).toEqual({
      ok: false,
      kind: 'timeout',
      reason: 'timeout'
    })
  })

  it('maps a missing extractor to unavailable, while preserving other platforms', async () => {
    const { viewer, replies, port } = readers(async () => json({ tweet: { text: 'Still readable' } }))
    viewer.setYtDlpAvailable(false)
    replies.setYtDlpAvailable(false)
    const tool = readPostTool({ post: port, filesDir: '/tmp' })
    expect(await tool.handler({ url: 'https://youtu.be/example123' }, { signal: signal() } as ToolContext)).toEqual({
      ok: false,
      kind: 'unavailable',
      reason: 'binary_missing'
    })
    expect(await port.read(url, signal())).toMatchObject({ text: 'Still readable' })
  })

  it('rejects unsupported paths before starting I/O', async () => {
    const fetcher = vi.fn(async () => json({}))
    const { port } = readers(fetcher)
    await expect(port.read('https://x.com/home', signal())).rejects.toThrow('unsupported_url')
    expect(fetcher).not.toHaveBeenCalled()
  })
})
