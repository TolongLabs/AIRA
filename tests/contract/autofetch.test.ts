import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildChatFlags } from '../../src/gateway/chat-flags.js'
import { createGatewayServer } from '../../src/gateway/server.js'
import {
  type Autofetch,
  type AutofetchMedia,
  type AutofetchOptions,
  createAutofetch
} from '../../src/media/autofetch.js'
import { claimAutofetchDelivery } from '../../src/records/autofetch.js'
import { createLogger } from '../../src/records/logger.js'
import { createRedactor } from '../../src/records/redact.js'
import { pruneRecords } from '../../src/records/retention.js'
import { ensureChat, setChatStatus } from '../../src/settings/chats.js'
import { setSetting } from '../../src/settings/settings.js'
import { parseFxTwitterResponse } from '../../src/social/parsers.js'
import type { SocialPost, SocialPostLookup } from '../../src/social/types.js'
import { parseOfficialSocialPostUrl, type SocialPostTarget } from '../../src/social/urls.js'
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
    attachments: [
      ...(overrides.photoUrls ?? []).map((url) => ({ kind: 'image' as const, owner: target.lookupKey, url })),
      ...(overrides.video
        ? [{ kind: 'video' as const, owner: target.lookupKey, video: overrides.video, durationSec: 42 }]
        : [])
    ],
    ...overrides
  }
}

function setup(
  options: {
    posts?: Record<string, Partial<SocialPost>>
    on?: boolean
    type?: 'group' | 'dm'
    compressVideo?: AutofetchOptions['compressVideo']
    mirrors?: AutofetchOptions['mirrors']
  } = {}
) {
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
    if (url.endsWith('.mp4')) return { data: testMediaBytes('mp4', url), contentType: 'video/mp4' }
    if (url.endsWith('.png')) return { data: testMediaBytes('png', url), contentType: 'image/png' }
    return { data: testMediaBytes('jpg', url), contentType: 'image/jpeg' }
  })
  const dataDir = tmpDir('aira-autofetch-')
  let clock = new Date('2026-11-18T08:00:00Z')
  const logged: string[] = []
  const optionsForAutofetch = {
    storage,
    viewer,
    download,
    ...(options.compressVideo ? { compressVideo: options.compressVideo } : {}),
    ...(options.mirrors ? { mirrors: options.mirrors } : {}),
    cacheDir: join(dataDir, 'cache', 'autofetch'),
    hostCacheDir: '/host/aira/data/cache/autofetch',
    logger: createLogger({ level: 'info', module: 'autofetch', sink: (line) => logged.push(line) }),
    now: () => clock
  }
  const autofetch = createAutofetch(optionsForAutofetch)
  return {
    storage,
    chat,
    waId,
    now: () => clock,
    restart: () => createAutofetch(optionsForAutofetch),
    options: optionsForAutofetch,
    autofetch: {
      ...autofetch,
      fetch: async (input: { chat: string; text: string }) => (await autofetch.fetch(input)).media,
      batch: autofetch.fetch
    },
    viewer,
    lookups,
    download,
    downloads,
    logged,
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

function testMediaBytes(kind: 'jpg' | 'png' | 'mp4', url: string): Buffer {
  const signature = {
    jpg: 'ffd8ff',
    png: '89504e470d0a1a0a',
    mp4: '00000010667479706d70343200000000'
  }[kind]
  return Buffer.concat([Buffer.from(signature, 'hex'), Buffer.from(url)])
}

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

    expect(media).toHaveLength(2)
    expect(media.every((item) => item.kind === 'image')).toBe(true)
    for (const item of media) {
      expect(item.path.startsWith('/host/aira/data/cache/autofetch/')).toBe(true)
      expect(item.path).not.toContain('..')
    }
    expect(new Set(media.map((item) => item.path)).size).toBe(2)
    const local = media.map((item) => join(env.dataDir, 'cache', 'autofetch', basename(item.path)))
    expect(readFileSync(local[0]!)).toEqual(testMediaBytes('jpg', 'https://img.example/a.jpg'))
    expect(readFileSync(local[1]!)).toEqual(testMediaBytes('png', 'https://img.example/b.png'))
    expect(jobRuns(env.storage)).toEqual([
      {
        chat_id: env.chat.chatId,
        outcome: 'ready',
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

  it('skips an avatar listed as a photo when the reader supplied no native attachment evidence', async () => {
    const env = setup({ posts: { 'x:333': { photoUrls: ['https://img.example/avatar.jpg'], attachments: [] } } })

    expect(await env.autofetch.fetch({ chat: env.waId, text: 'https://x.com/someone/status/333' })).toEqual([])
    expect(env.downloads).toEqual([])
  })

  it('requires a matching raw post and native type before downloading an apparent photo', async () => {
    const env = setup()
    env.viewer.lookup.mockImplementation(async (target) => ({
      status: 'found',
      post: parseFxTwitterResponse(
        {
          tweet: {
            id: target.id === '1' ? 'foreign' : target.id,
            media: {
              photos: [
                { type: 'avatar', url: 'https://img.example/avatar.jpg' },
                { type: 'photo', url: 'https://img.example/native.jpg' }
              ]
            },
            quote: { media: { photos: [{ type: 'photo', url: 'https://img.example/quoted.jpg' }] } }
          }
        },
        target,
        1000
      )
    }))
    const text = 'https://x.com/example/status/1 https://x.com/example/status/2'
    expect(await env.autofetch.fetch({ chat: env.waId, text })).toHaveLength(1)
    expect(env.downloads).toEqual(['https://img.example/native.jpg'])
  })

  it('keeps three lookup slots after YouTube Shorts and records policy exclusions', async () => {
    const env = setup()
    const text =
      'https://youtube.com/shorts/abc_123 https://x.com/a/status/1 https://x.com/a/status/2 https://x.com/a/status/3'
    await env.autofetch.fetch({ chat: env.waId, text })
    expect(env.lookups).toEqual(['x:1', 'x:2', 'x:3'])
    expect(
      env.storage.read((db) =>
        db.prepare('SELECT platform, outcome, reason FROM social_lookup ORDER BY ordinal').all()
      )[0]
    ).toEqual({ platform: 'youtube', outcome: 'skipped', reason: 'platform_excluded' })
  })

  it.each([
    ['tiktok', 'https://www.tiktok.com/@example/video/1234567890'],
    ['tiktok', 'https://m.tiktok.com/@example/video/1234567890'],
    ['tiktok', 'https://vt.tiktok.com/Synthetic1/'],
    ['reddit', 'https://www.reddit.com/r/example/comments/abc123/a_post/'],
    ['reddit', 'https://m.reddit.com/r/example/comments/abc123/a_post/'],
    ['reddit', 'https://www.reddit.com/r/example/s/Synthetic2/']
  ])('applies the same group policy to %s links at %s', async (platform, text) => {
    const env = setup()

    expect(await env.autofetch.fetch({ chat: env.waId, text })).toEqual([])
    expect(env.viewer.lookup).not.toHaveBeenCalled()
    expect(env.download).not.toHaveBeenCalled()
    expect(env.storage.read((db) => db.prepare('SELECT platform, outcome, reason FROM social_lookup').all())).toEqual([
      { platform, outcome: 'skipped', reason: 'platform_excluded' }
    ])
  })

  it('keeps repeat reservations and disallows claiming an unclaimed batch after restart', async () => {
    const env = setup({ posts: { 'x:1': { photoUrls: ['https://img.example/a.jpg'] } } })
    const input = { chat: env.waId, text: 'https://x.com/example/status/1' }
    const batch = await env.autofetch.batch(input)
    const restarted = env.restart()
    expect(batch.deliveryKey).toBeTruthy()
    expect(claimAutofetchDelivery(env.storage, batch.deliveryKey!, env.now())).toBe(false)
    expect(await restarted.fetch(input)).toEqual({ media: [] })
    expect(env.lookups).toEqual(['x:1'])
  })

  it('records duration bands on both sides of the proposed cutoff without rounding', async () => {
    const env = setup()
    env.viewer.lookup.mockImplementation(async (target) => {
      const seconds = target.id === '1' ? 180 : target.id === '2' ? 180.1 : undefined
      return {
        status: 'found',
        post: parseFxTwitterResponse(
          {
            tweet: {
              id: target.id,
              media: {
                videos: [
                  { type: 'video', format: 'video/mp4', url: 'https://video.example/clip.mp4', duration: seconds }
                ]
              }
            }
          },
          target,
          1000
        )
      }
    })
    await env.autofetch.fetch({
      chat: env.waId,
      text: ['1', '2', '3'].map((id) => `https://x.com/demo/status/${id}`).join(' ')
    })
    expect(
      env.storage.read((db) =>
        db.prepare('SELECT video_duration_band FROM social_lookup ORDER BY ordinal').pluck().all()
      )
    ).toEqual(['le_180', 'gt_180', 'unknown'])
    expect(env.downloads).toHaveLength(2)
  })

  it('rejects an image MIME header without an image signature', async () => {
    const env = setup({ posts: { 'x:555': { photoUrls: ['https://img.example/wrong.jpg'] } } })
    env.download.mockResolvedValueOnce({ data: Buffer.from('<html>'), contentType: 'image/jpeg' })
    expect(await env.autofetch.fetch({ chat: env.waId, text: 'https://x.com/example/status/555' })).toEqual([])
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

  it('records the known duration band of a video its group mode does not send', async () => {
    const env = setup({
      posts: {
        'facebook:12345678901234567': {
          durationSec: 45,
          videoCount: 1,
          video: { url: 'https://video.example/clip.mp4', bytes: null, headers: null, hasAudio: null }
        }
      }
    })
    await env.autofetch.fetch({
      chat: env.waId,
      text: 'https://www.facebook.com/example_page/videos/12345678901234567/'
    })
    expect(env.storage.read((db) => db.prepare('SELECT video_duration_band FROM social_lookup').pluck().all())).toEqual(
      ['le_60']
    )
    expect(env.downloads).toEqual([])
  })

  it('downloads a large verified TikTok mirror video in byte ranges with the mirror time limit', async () => {
    const tiktok = 'https://www.tiktok.com/@example/video/1234567890'
    const video = {
      url: 'https://v16m.tiktokcdn-us.com/clip.mp4',
      bytes: 9_000_000,
      headers: null,
      hasAudio: true,
      mirror: 'tiktok' as const
    }
    const env = setup({
      mirrors: { tiktok: 'read_and_group' },
      posts: { 'tiktok:1234567890': { video, durationSec: 42 } }
    })
    await env.autofetch.fetch({ chat: env.waId, text: tiktok })
    expect(env.download).toHaveBeenCalledWith(video.url, expect.any(AbortSignal), expect.any(Number), null, 9_000_000)
  })

  it('takes the photos of the post a Threads share link resolves to, and reserves it', async () => {
    const env = setup()
    env.viewer.lookup.mockImplementation(async (target: SocialPostTarget) => {
      env.lookups.push(target.lookupKey)
      const resolved = parseOfficialSocialPostUrl('https://www.threads.com/@poster_one/post/DFixtur3abc')!
      return { status: 'found', post: post(resolved, { photoUrls: ['https://img.example/a.jpg'] }) }
    })
    const media = await env.autofetch.fetch({ chat: env.waId, text: 'https://www.threads.com/share/BShare12x' })
    expect(media.map((item) => item.kind)).toEqual(['image'])
    await env.autofetch.fetch({ chat: env.waId, text: 'https://www.threads.com/@poster_one/post/DFixtur3abc' })
    expect(env.lookups).toHaveLength(1)
  })

  it('takes nothing from a lookup whose canonical address is itself a share link', async () => {
    const env = setup()
    env.viewer.lookup.mockImplementation(async (target: SocialPostTarget) => {
      env.lookups.push(target.lookupKey)
      const share = parseOfficialSocialPostUrl('https://www.threads.com/share/BOther123')!
      return { status: 'found', post: post(share, { photoUrls: ['https://img.example/a.jpg'] }) }
    })
    const media = await env.autofetch.fetch({ chat: env.waId, text: 'https://www.threads.com/share/BShare12x' })
    expect(media).toEqual([])
    expect(env.storage.read((db) => db.prepare('SELECT count(*) FROM autofetch_repeat').pluck().get())).toBe(1)
  })

  it('reserves nothing for a direct link whose lookup names another post', async () => {
    const env = setup()
    env.viewer.lookup.mockImplementation(async (target: SocialPostTarget) => {
      env.lookups.push(target.lookupKey)
      const other = parseOfficialSocialPostUrl('https://x.com/other/status/2')!
      return { status: 'found', post: post(other, { attachments: [] }) }
    })
    await env.autofetch.fetch({ chat: env.waId, text: 'https://x.com/example/status/1' })
    await env.autofetch.fetch({ chat: env.waId, text: 'https://x.com/other/status/2' })
    expect(env.lookups).toEqual(['x:1', 'x:2'])
  })

  it('reserves the canonical post of a share link even when it has no media to send', async () => {
    const env = setup()
    env.viewer.lookup.mockImplementation(async (target: SocialPostTarget) => {
      env.lookups.push(target.lookupKey)
      const canonical = parseOfficialSocialPostUrl('https://www.reddit.com/r/example/comments/abc123/sample/')!
      return { status: 'found', post: post(canonical, { attachments: [] }) }
    })
    const scoped = createAutofetch({
      ...env.options,
      mirrors: { reddit: 'read_and_group', redditGroupChatIds: [env.chat.chatId] }
    })
    await scoped.fetch({ chat: env.waId, text: 'https://www.reddit.com/r/example/s/Fixture2/' })
    await scoped.fetch({ chat: env.waId, text: 'https://www.reddit.com/r/example/comments/abc123/sample/' })
    expect(env.lookups).toHaveLength(1)
    await scoped.fetch({ chat: env.waId, text: 'https://www.reddit.com/r/example/s/Fixture3/' })
    expect(
      env.storage.read((db) => db.prepare('SELECT outcome, reason FROM social_lookup ORDER BY rowid').all())
    ).toEqual([
      { outcome: 'readable', reason: 'no_verified_attachment' },
      { outcome: 'skipped', reason: 'repeat' },
      { outcome: 'skipped', reason: 'repeat' }
    ])
  })

  it('does not send a Facebook video while its group capability is disabled', async () => {
    const link = 'https://fbmirror.test/example_page/videos/12345678901234567'
    const failed = setup()
    expect(await failed.autofetch.fetch({ chat: failed.waId, text: link })).toEqual([])
    expect(failed.lookups).toEqual(['facebook:12345678901234567'])
    expect(failed.viewer.lookup).toHaveBeenCalledWith(
      expect.objectContaining({ canonicalUrl: 'https://www.facebook.com/example_page/videos/12345678901234567/' }),
      expect.anything(),
      expect.any(Function)
    )

    const found = setup({
      posts: {
        'facebook:12345678901234567': {
          video: { url: 'https://video.example/clip.mp4', bytes: null, headers: null, hasAudio: null }
        }
      }
    })
    const media = await found.autofetch.fetch({ chat: found.waId, text: link })
    expect(media).toEqual([])
    expect(found.downloads).toEqual([])
  })

  it('reports a link on an unknown host by platform and hostname only, to the logger it was given', async () => {
    const env = setup()
    await env.autofetch.fetch({ chat: env.waId, text: 'see https://ddinstagram.test/p/AbCdEfGhIjK?igsh=secret' })
    const reports = env.logged
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry['event'] === 'social.unknown_host')
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ module: 'autofetch', platform: 'instagram', hostname: 'ddinstagram.test' })
    expect(env.logged.join('\n')).not.toContain('AbCdEfGhIjK')
    expect(env.logged.join('\n')).not.toContain('secret')
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
    autofetch?: Autofetch
    storage?: Storage
    now?: () => Date
    fetch?: (input: { chat: string; text: string }) => Promise<AutofetchMedia[]>
  }) {
    const storage = options.storage ?? tmpStorage()
    const server = createGatewayServer({
      turns: {} as TurnService,
      storage,
      logger: createLogger({ level: 'error', module: 'test', sink: () => {} }),
      redactor: createRedactor(),
      ready: () => options.ready ?? true,
      now: options.now,
      autofetch: options.autofetch ?? {
        claim: () => false,
        complete: () => false,
        abandon: () => {},
        fetch: async (input) => ({ media: (await options.fetch?.(input)) ?? [] })
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    servers.push(server)
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/aira/autofetch`
    return (body: unknown, action = '') =>
      fetch(url + action, {
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

  it('counts only claimed adapter confirmations and exports telemetry without receipt keys', async () => {
    const env = setup({ posts: { 'x:1': { photoUrls: ['https://img.example/a.jpg', 'https://img.example/b.jpg'] } } })
    const post = await serve({
      autofetch: { ...env.autofetch, fetch: env.autofetch.batch },
      storage: env.storage,
      now: env.now
    })
    const batch = (await (
      await post({ chat: env.waId, text: 'https://x.com/example/status/1?secret=token' })
    ).json()) as {
      deliveryKey: string
      media: AutofetchMedia[]
    }
    const key = batch.deliveryKey
    const delivery = () => env.storage.read((db) => db.prepare('SELECT slots, outcomes FROM autofetch_delivery').get())
    const send = async (action: string, body: object) => (await post(body, action)).json()
    expect(batch.media).toHaveLength(2)
    expect(delivery()).toEqual({ slots: '["image","image"]', outcomes: null })
    expect(await send('/complete', { key, outcomes: [true, true] })).toEqual({ accepted: false })
    expect(await send('/claim', { key })).toEqual({ accepted: true })
    expect(await send('/claim', { key })).toEqual({ accepted: false })
    expect(await send('/complete', { key, outcomes: [true] })).toEqual({ accepted: false })
    const paths = batch.media.map((item) => join(env.options.cacheDir, basename(item.path)))
    expect(paths.every((path) => existsSync(path))).toBe(true)
    expect(await send('/complete', { key, outcomes: [true, false] })).toEqual({ accepted: true })
    expect(await send('/complete', { key, outcomes: [true, true] })).toEqual({ accepted: false })
    expect(paths.some((path) => existsSync(path))).toBe(false)
    expect(delivery()).toEqual({ slots: '["image","image"]', outcomes: '[true,false]' })
    expect(
      env.storage.read((db) => db.prepare('SELECT eligible_files, downloaded_files FROM social_lookup').get())
    ).toEqual({ eligible_files: 2, downloaded_files: 2 })

    const archived: Record<string, unknown> = {}
    const pruned = pruneRecords(
      env.storage,
      { retentionDays: 1, diagnosticsHours: 72, windowDays: 7 },
      {
        now: () => new Date('2026-12-01T00:00:00Z'),
        beforeDelete: (table, rows) => {
          archived[table] = rows
        }
      }
    )
    expect(Object.keys(archived)).toEqual(['social_lookup', 'autofetch_delivery', 'job_run'])
    expect(pruned.counts).toMatchObject({ social_lookup: 1, autofetch_delivery: 1 })
    expect(JSON.stringify(archived)).not.toMatch(/http|secret|token|digest|expires_at|example/)
    expect(delivery()).toBeUndefined()
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

  it('closes the connection on a body over 1 MiB without reading it all', async () => {
    const post = await serve({})
    await expect(post({ chat: GROUP, text: 'a'.repeat(1_100_000) })).rejects.toThrow()
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

it('caches the bounded compressed MP4 and keeps gateway delivery pending', async () => {
  const clipUrl = 'https://video.example/oversized.mp4'
  const output = testMediaBytes('mp4', clipUrl)
  const input = Buffer.alloc(16_000_001)
  output.copy(input)
  const compressVideo = vi.fn<NonNullable<AutofetchOptions['compressVideo']>>(async () => output)
  const env = setup({
    posts: { 'x:1': { video: { url: clipUrl, bytes: input.length, headers: null, hasAudio: false } } },
    compressVideo
  })
  env.download.mockResolvedValueOnce({ data: input, contentType: 'video/mp4' })
  const result = await env.autofetch.batch({ chat: env.waId, text: 'https://x.com/example/status/1' })
  expect(env.download).toHaveBeenCalledWith(clipUrl, expect.any(AbortSignal), 48_000_000, null)
  expect(compressVideo).toHaveBeenCalledTimes(1)
  const args = compressVideo.mock.calls[0]!
  expect(args[0] === input).toBe(true)
  expect(args.slice(1)).toEqual([16_000_000, 180, expect.any(AbortSignal)])
  expect(result.deliveryKey).toBeTruthy()
  expect(result.media).toHaveLength(1)
  const delivered = result.media[0]!
  expect(delivered.kind).toBe('video')
  expect(delivered.path.startsWith('/host/aira/data/cache/autofetch/')).toBe(true)
  expect(delivered.path).not.toContain('..')
  expect(readFileSync(join(env.dataDir, 'cache', 'autofetch', basename(delivered.path)))).toEqual(output)
  expect(env.storage.read((db) => db.prepare('SELECT downloaded_files FROM social_lookup').get())).toEqual({
    downloaded_files: 1
  })
  expect(env.storage.read((db) => db.prepare('SELECT outcomes FROM autofetch_delivery').get())).toEqual({
    outcomes: null
  })
})

it('skips a disabled platform before lookup and preserves its repeat eligibility', async () => {
  const env = setup({
    posts: {
      'x:1': { photoUrls: ['https://img.example/x.jpg'] },
      'bluesky:a:abc123': { photoUrls: ['https://img.example/b.jpg'] }
    }
  })
  const settings = { level: 'chat' as const, scope: env.chat.chatId, key: 'autofetch.platforms.x', actor: 'test' }
  setSetting(env.storage, { ...settings, value: false })
  const xUrl = 'https://x.com/demo/status/1'
  await env.autofetch.fetch({ chat: env.waId, text: xUrl + ' https://bsky.app/profile/a/post/abc123' })
  expect(env.lookups).toEqual(['bluesky:a:abc123'])
  expect(env.downloads).toEqual(['https://img.example/b.jpg'])
  expect(
    env.storage.read((db) =>
      db.prepare('SELECT platform,outcome,reason,attempts FROM social_lookup ORDER BY ordinal').all()
    )[0]
  ).toEqual({ platform: 'x', outcome: 'skipped', reason: 'platform_disabled', attempts: '[]' })
  setSetting(env.storage, { ...settings, value: true })
  await env.autofetch.fetch({ chat: env.waId, text: xUrl })
  expect(env.lookups.at(-1)).toBe('x:1')
})

it('skips a disabled platform share before lookup and preserves slots and repeat eligibility', async () => {
  const ids = [1, 2, 3]
  const photos = ids.map((id) => 'https://img.example/' + id + '.jpg')
  const env = setup({ posts: Object.fromEntries(ids.map((id, i) => ['x:' + id, { photoUrls: [photos[i]!] }])) })
  setSetting(env.storage, {
    level: 'type',
    scope: 'group',
    key: 'autofetch.platforms.threads',
    value: false,
    actor: 'test'
  })
  const media = await env.autofetch.fetch({
    chat: env.waId,
    text: [
      'https://www.threads.com/share/BShare12x',
      'https://youtu.be/dQw4w9WgXcQ',
      ...ids.map((id) => 'https://x.com/someone/status/' + id)
    ].join(' ')
  })
  expect(media).toHaveLength(3)
  expect(env.lookups).toEqual(['x:1', 'x:2', 'x:3'])
  expect(env.downloads).toEqual(photos)
  expect(
    env.storage.read((db) =>
      db.prepare('SELECT platform,outcome,reason,attempts FROM social_lookup ORDER BY ordinal').all()
    )[0]
  ).toEqual({ platform: 'threads', outcome: 'skipped', reason: 'platform_disabled', attempts: '[]' })
  await env.autofetch.fetch({ chat: env.waId, text: 'https://www.threads.com/share/BShare12x' })
  expect(env.lookups).toEqual(['x:1', 'x:2', 'x:3'])
  expect(env.storage.read((db) => db.prepare('SELECT count(*) FROM autofetch_repeat').pluck().get())).toBe(3)
})

describe('delivery file lifetime', () => {
  const photo = { photoUrls: ['https://img.example/a.jpg'] }
  const textFor = (id: number) => 'https://x.com/example/status/' + id
  it('isolates identical files in concurrent deliveries', async () => {
    const env = setup({ posts: { 'x:1': photo, 'x:2': photo } })
    const [first, second] = await Promise.all(
      [1, 2].map((id) => env.autofetch.batch({ chat: env.waId, text: textFor(id) }))
    )
    const pathFor = (item: AutofetchMedia) => join(env.options.cacheDir, basename(item.path))
    const firstPath = pathFor(first!.media[0]!)
    const secondPath = pathFor(second!.media[0]!)
    expect(firstPath).not.toBe(secondPath)
    expect(readFileSync(firstPath)).toEqual(readFileSync(secondPath))
    expect(env.autofetch.claim(first!.deliveryKey!)).toBe(true)
    expect(env.autofetch.complete(first!.deliveryKey!, [true])).toBe(true)
    expect(existsSync(firstPath)).toBe(false)
    expect(existsSync(secondPath)).toBe(true)
    expect(existsSync(join(env.dataDir, 'files'))).toBe(false)
  })

  it('removes files at ten minutes while idle', async () => {
    vi.useFakeTimers()
    try {
      const env = setup({ posts: { 'x:1': photo } })
      const batch = await env.autofetch.batch({ chat: env.waId, text: textFor(1) })
      const path = join(env.options.cacheDir, basename(batch.media[0]!.path))
      env.advance(599999)
      await vi.advanceTimersByTimeAsync(599999)
      expect(existsSync(path)).toBe(true)
      env.advance(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(existsSync(path)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('removes outstanding and legacy files on startup', async () => {
    const env = setup({ posts: { 'x:1': photo } })
    const batch = await env.autofetch.batch({ chat: env.waId, text: textFor(1) })
    expect(batch.media).toHaveLength(1)
    writeFileSync(join(env.options.cacheDir, 'ab'.repeat(32) + '.jpg'), Buffer.from('legacy'))
    const restarted = env.restart()
    expect(readdirSync(env.options.cacheDir)).toEqual([])
    expect(restarted.claim(batch.deliveryKey!)).toBe(false)
  })
})
