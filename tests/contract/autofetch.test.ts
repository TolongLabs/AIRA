import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildChatFlags } from '../../src/gateway/chat-flags.js'
import { createGatewayServer } from '../../src/gateway/server.js'
import { type AutofetchMedia, createAutofetch } from '../../src/media/autofetch.js'
import { createLogger } from '../../src/records/logger.js'
import { createRedactor } from '../../src/records/redact.js'
import { ensureChat, setChatStatus } from '../../src/settings/chats.js'
import { setSetting } from '../../src/settings/settings.js'
import type { SocialPost, SocialPostLookup } from '../../src/social/types.js'
import type { SocialPostTarget } from '../../src/social/urls.js'
import type { Storage } from '../../src/storage/database.js'
import type { TurnService } from '../../src/turn/pipeline.js'
import { tmpDir, tmpStorage } from '../support/tmp.js'

const GROUP = '12345678901@g.us'
const DM = '1234567890@s.whatsapp.net'

function post(target: SocialPostTarget, overrides: Partial<SocialPost> = {}): SocialPost {
  return {
    platform: target.platform,
    id: target.id,
    canonicalUrl: target.canonicalUrl,
    target,
    authorHandle: 'poster_one',
    authorName: '',
    createdAt: null,
    text: 'a post',
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

function setup(options: { posts?: Record<string, Partial<SocialPost>>; on?: boolean; type?: 'group' | 'dm' } = {}) {
  const storage = tmpStorage()
  const waId = options.type === 'dm' ? DM : GROUP
  const chat = ensureChat(storage, { waId, type: options.type ?? 'group' })
  setChatStatus(storage, { chatId: chat.chatId, status: 'active', actor: 'test' })
  if (options.on !== false) {
    setSetting(storage, { level: 'chat', scope: chat.chatId, key: 'features.autofetch', value: true, actor: 'test' })
  }
  const lookups: string[] = []
  const viewer = {
    lookup: vi.fn(async (target: SocialPostTarget): Promise<SocialPostLookup> => {
      lookups.push(target.lookupKey)
      const found = options.posts?.[target.lookupKey]
      return found
        ? { status: 'found', post: post(target, found) }
        : { status: 'failed', platform: target.platform, reason: 'http_404' }
    })
  }
  const downloads: string[] = []
  const download = vi.fn(async (url: string, _signal: AbortSignal, maxBytes: number) => {
    downloads.push(url)
    if (url.includes('huge')) throw new Error(`body over ${maxBytes} bytes`)
    if (url.includes('page')) return { data: Buffer.from('<html>'), contentType: 'text/html' }
    if (url.endsWith('.mp4')) return { data: Buffer.from(`video ${url}`), contentType: 'video/mp4' }
    return { data: Buffer.from(`image ${url}`), contentType: url.endsWith('.png') ? 'image/png' : 'image/jpeg' }
  })
  const dataDir = tmpDir('aira-autofetch-')
  let clock = new Date('2026-11-18T08:00:00Z')
  const autofetch = createAutofetch({
    storage,
    viewer,
    download,
    cacheDir: join(dataDir, 'cache', 'autofetch'),
    hostCacheDir: '/host/aira/data/cache/autofetch',
    now: () => clock
  })
  return {
    storage,
    chat,
    waId,
    autofetch,
    viewer,
    lookups,
    download,
    downloads,
    dataDir,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms)
    }
  }
}

function jobRuns(storage: Storage) {
  return storage.read((db) =>
    db.prepare("SELECT chat_id, outcome, counts FROM job_run WHERE kind = 'autofetch' ORDER BY id").all()
  ) as { chat_id: string; outcome: string; counts: string }[]
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex')

describe('autofetch', () => {
  it('sends every photo of a post in order, as files in the cache the gateway reads by host path', async () => {
    const env = setup({
      posts: {
        'x:111': {
          photoCount: 2,
          imageUrl: 'https://img.example/a.jpg',
          photoUrls: ['https://img.example/a.jpg', 'https://img.example/b.png']
        }
      }
    })

    const media = await env.autofetch.fetch({ chat: env.waId, text: 'look https://x.com/someone/status/111 lol' })

    expect(media).toEqual([
      { kind: 'image', path: `/host/aira/data/cache/autofetch/${sha('image https://img.example/a.jpg')}.jpg` },
      { kind: 'image', path: `/host/aira/data/cache/autofetch/${sha('image https://img.example/b.png')}.png` }
    ])
    const local = join(env.dataDir, 'cache', 'autofetch', `${sha('image https://img.example/a.jpg')}.jpg`)
    expect(readFileSync(local, 'utf8')).toBe('image https://img.example/a.jpg')
    expect(jobRuns(env.storage)).toEqual([
      {
        chat_id: env.chat.chatId,
        outcome: 'sent',
        counts: JSON.stringify({ links: 1, images: 2, videos: 0, failed: 0 })
      }
    ])
  })

  it('sends a video first, then the photos, at most 10 files a post', async () => {
    const photoUrls = Array.from({ length: 12 }, (_, index) => `https://img.example/p${index}.jpg`)
    const env = setup({
      posts: {
        'x:222': {
          videoCount: 1,
          photoCount: 12,
          photoUrls,
          video: { url: 'https://video.example/clip.mp4', bytes: null, headers: null, hasAudio: true }
        }
      }
    })

    const media = await env.autofetch.fetch({ chat: env.waId, text: 'https://x.com/someone/status/222' })

    expect(media).toHaveLength(10)
    expect(media[0]?.kind).toBe('video')
    expect(media.slice(1).every((item) => item.kind === 'image')).toBe(true)
    expect(env.downloads).toEqual(['https://video.example/clip.mp4', ...photoUrls.slice(0, 9)])
  })

  it('never sends the one picture: a thumbnail, link card or avatar is not the post', async () => {
    const env = setup({ posts: { 'x:333': { imageUrl: 'https://img.example/avatar.jpg' } } })

    expect(await env.autofetch.fetch({ chat: env.waId, text: 'https://x.com/someone/status/333' })).toEqual([])
    expect(env.downloads).toEqual([])
    expect(jobRuns(env.storage)[0]?.outcome).toBe('nothing')
  })

  it('skips a file over its limit or of the wrong type, and keeps the rest', async () => {
    const env = setup({
      posts: {
        'x:444': {
          photoCount: 3,
          photoUrls: ['https://img.example/huge.jpg', 'https://img.example/page.jpg', 'https://img.example/ok.jpg'],
          video: { url: 'https://video.example/huge.mp4', bytes: null, headers: null, hasAudio: true }
        }
      }
    })

    const media = await env.autofetch.fetch({ chat: env.waId, text: 'https://x.com/someone/status/444' })

    expect(media.map((item) => item.kind)).toEqual(['image'])
    const [video] = env.download.mock.calls
    expect(video?.[2]).toBe(16_000_000)
    expect(env.download.mock.calls[1]?.[2]).toBe(8_000_000)
    expect(JSON.parse(jobRuns(env.storage)[0]!.counts)).toEqual({ links: 1, images: 1, videos: 0, failed: 3 })
  })

  it('reads up to 3 post links, skips YouTube, and sends a link again only after 10 minutes', async () => {
    const posts = Object.fromEntries(
      ['1', '2', '3', '4'].map((id) => [`x:${id}`, { photoCount: 1, photoUrls: [`https://img.example/${id}.jpg`] }])
    )
    const env = setup({ posts })
    const text = [
      'https://youtu.be/abc_123',
      ...['1', '2', '3', '4'].map((id) => `https://x.com/someone/status/${id}`),
      'https://x.com/someone/status/1'
    ].join(' ')

    expect(await env.autofetch.fetch({ chat: env.waId, text })).toHaveLength(3)
    expect(env.lookups).toEqual(['x:1', 'x:2', 'x:3'])

    expect(await env.autofetch.fetch({ chat: env.waId, text: 'again https://x.com/someone/status/1' })).toEqual([])
    expect(env.lookups).toHaveLength(3)

    env.advance(10 * 60_000 + 1)
    expect(await env.autofetch.fetch({ chat: env.waId, text: 'again https://x.com/someone/status/1' })).toHaveLength(1)
  })

  it.each([
    ['the switch is off', { on: false }],
    ['the chat is a DM', { type: 'dm' as const }]
  ])('does nothing when %s', async (_name, options) => {
    const env = setup({ ...options, posts: { 'x:1': { photoCount: 1, photoUrls: ['https://img.example/1.jpg'] } } })

    expect(await env.autofetch.fetch({ chat: env.waId, text: 'https://x.com/someone/status/1' })).toEqual([])
    expect(env.viewer.lookup).not.toHaveBeenCalled()
    expect(jobRuns(env.storage)).toEqual([])
  })

  it('does nothing in a muted group, a pending chat or an unknown chat', async () => {
    const env = setup({ posts: { 'x:1': { photoCount: 1, photoUrls: ['https://img.example/1.jpg'] } } })
    setSetting(env.storage, {
      level: 'chat',
      scope: env.chat.chatId,
      key: 'muted',
      value: { by: 'someone', at: '2026-11-18T07:00:00.000Z' },
      actor: 'test'
    })
    const pending = ensureChat(env.storage, { waId: '123456789012@g.us', type: 'group' })
    setSetting(env.storage, {
      level: 'chat',
      scope: pending.chatId,
      key: 'features.autofetch',
      value: true,
      actor: 'test'
    })

    for (const chat of [env.waId, pending.waId, '1234567890123@g.us']) {
      expect(await env.autofetch.fetch({ chat, text: 'https://x.com/someone/status/1' })).toEqual([])
    }
    expect(env.viewer.lookup).not.toHaveBeenCalled()
  })

  it('sends nothing for a post it cannot read, and records it', async () => {
    const env = setup()

    expect(await env.autofetch.fetch({ chat: env.waId, text: 'https://x.com/someone/status/9' })).toEqual([])
    expect(jobRuns(env.storage)).toEqual([
      {
        chat_id: env.chat.chatId,
        outcome: 'nothing',
        counts: JSON.stringify({ links: 1, images: 0, videos: 0, failed: 0 })
      }
    ])
    expect(existsSync(join(env.dataDir, 'cache', 'autofetch'))).toBe(false)
  })
})

describe('chat flags for autofetch', () => {
  it('declares autofetch for an active group with the switch on, and not while it is muted', () => {
    const env = setup()
    expect(buildChatFlags(env.storage).chats[GROUP]).toEqual({ autofetch: true })

    setSetting(env.storage, {
      level: 'chat',
      scope: env.chat.chatId,
      key: 'muted',
      value: { by: 'someone', at: '2026-11-18T07:00:00.000Z' },
      actor: 'test'
    })
    expect(buildChatFlags(env.storage).chats[GROUP]).toBeUndefined()
  })

  it('never declares autofetch for a DM', () => {
    const env = setup({ type: 'dm' })
    expect(buildChatFlags(env.storage).chats[DM]).toBeUndefined()
  })
})

describe('POST /v1/aira/autofetch', () => {
  const servers: { close: () => void }[] = []
  afterEach(() => {
    for (const server of servers.splice(0)) server.close()
  })

  async function serve(options: {
    ready?: boolean
    fetch?: (input: { chat: string; text: string }) => Promise<AutofetchMedia[]>
  }) {
    const storage = tmpStorage()
    const server = createGatewayServer({
      turns: {} as TurnService,
      storage,
      logger: createLogger({ level: 'error', module: 'test', sink: () => {} }),
      redactor: createRedactor(),
      ready: () => options.ready ?? true,
      autofetch: { fetch: options.fetch ?? (async () => []) }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    servers.push(server)
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/aira/autofetch`
    return (body: unknown) =>
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body)
      })
  }

  it('answers the media the core found for the chat and text', async () => {
    const fetchMedia = vi.fn(async () => [{ kind: 'image' as const, path: '/host/a.jpg' }])
    const post = await serve({ fetch: fetchMedia })

    const response = await post({ chat: GROUP, text: 'https://x.com/someone/status/1' })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ media: [{ kind: 'image', path: '/host/a.jpg' }] })
    expect(fetchMedia).toHaveBeenCalledWith({ chat: GROUP, text: 'https://x.com/someone/status/1' })
  })

  it.each([
    ['not JSON', 'nope'],
    ['no chat', { text: 'x' }],
    ['a text that is not a string', { chat: GROUP, text: 1 }],
    ['a body over 64 KiB', { chat: GROUP, text: 'a'.repeat(70_000) }]
  ])('refuses %s with 400', async (_name, body) => {
    const post = await serve({})
    expect((await post(body)).status).toBe(400)
  })

  it('answers 503 while the core is not ready', async () => {
    const post = await serve({ ready: false })
    expect((await post({ chat: GROUP, text: '' })).status).toBe(503)
  })

  it('answers an empty list when the work fails', async () => {
    const post = await serve({
      fetch: async () => {
        throw new Error('boom')
      }
    })
    const response = await post({ chat: GROUP, text: 'https://x.com/someone/status/1' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ media: [] })
  })
})
