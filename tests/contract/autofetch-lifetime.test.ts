import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGatewayServer } from '../../src/gateway/server.js'
import {
  type Autofetch,
  type AutofetchMedia,
  type AutofetchOptions,
  createAutofetch
} from '../../src/media/autofetch.js'
import { createLogger } from '../../src/records/logger.js'
import { createRedactor } from '../../src/records/redact.js'
import { ensureChat, setChatStatus } from '../../src/settings/chats.js'
import { setSetting } from '../../src/settings/settings.js'
import type { SocialPost, SocialPostLookup } from '../../src/social/types.js'
import type { SocialPostTarget } from '../../src/social/urls.js'
import type { Storage } from '../../src/storage/database.js'
import type { TurnService } from '../../src/turn/pipeline.js'
import { tmpDir, tmpStorage } from '../support/tmp.js'

// Delivery file lifetime (docs/trd/system.md#autofetch, commit 4bf9938): files belong
// exclusively to one delivery, completion removes them, expiry removes them while idle,
// startup clears leftovers including the previous hash-named cache, and bytes never
// reach persistent stores.

const GROUP_A = 'test-group-a'
const GROUP_B = 'test-group-b'

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

function testMediaBytes(kind: 'jpg' | 'png', url: string): Buffer {
  const signature = { jpg: 'ffd8ff', png: '89504e470d0a1a0a' }[kind]
  return Buffer.concat([Buffer.from(signature, 'hex'), Buffer.from(url)])
}

function setup(options: { posts?: Record<string, Partial<SocialPost>> } = {}) {
  const storage = tmpStorage()
  const dataDir = tmpDir('aira-autofetch-life-')
  const cacheDir = join(dataDir, 'cache', 'autofetch')
  const hostCacheDir = '/host/aira/data/cache/autofetch'
  let clock = new Date('2026-11-18T08:00:00Z')
  const now = () => clock
  const viewer = {
    lookup: vi.fn(async (target: SocialPostTarget): Promise<SocialPostLookup> => {
      const found = options.posts?.[target.lookupKey]
      return found
        ? { status: 'found', post: post(target, found) }
        : { status: 'failed', platform: target.platform, reason: 'http_404' }
    })
  }
  const download = vi.fn(async (url: string) => {
    if (url.endsWith('.png')) return { data: testMediaBytes('png', url), contentType: 'image/png' }
    return { data: testMediaBytes('jpg', url), contentType: 'image/jpeg' }
  })
  const logger = createLogger({ level: 'error', module: 'autofetch-life', sink: () => {} })
  const autofetchOptions: AutofetchOptions = {
    storage,
    viewer,
    download,
    cacheDir,
    hostCacheDir,
    logger,
    now
  }
  const addGroup = (waId: string) => {
    const chat = ensureChat(storage, { waId, type: 'group' })
    setChatStatus(storage, { chatId: chat.chatId, status: 'active', actor: 'test' })
    setSetting(storage, { level: 'chat', scope: chat.chatId, key: 'features.autofetch', value: true, actor: 'test' })
    return chat
  }
  addGroup(GROUP_A)
  const autofetch = createAutofetch(autofetchOptions)
  return {
    storage,
    dataDir,
    cacheDir,
    hostCacheDir,
    now,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms)
    },
    restart: () => createAutofetch(autofetchOptions),
    batch: (input: { chat: string; text: string }) => autofetch.fetch(input),
    live: autofetch,
    addGroup,
    lookups: viewer.lookup,
    localPath: (item: AutofetchMedia) => join(cacheDir, basename(item.path)),
    filesInCache: () => (existsSync(cacheDir) ? readdirSync(cacheDir) : [])
  }
}

function allFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      const path = join(current, entry)
      if (statSync(path).isDirectory()) walk(path)
      else out.push(path)
    }
  }
  walk(dir)
  return out
}

describe('autofetch delivery lifetime', () => {
  it('gives identical bytes independent files for distinct concurrent deliveries', async () => {
    const env = setup({ posts: { 'x:1': { photoUrls: ['https://img.example/same.jpg'] } } })
    env.addGroup(GROUP_B)

    const [first, second] = await Promise.all([
      env.batch({ chat: GROUP_A, text: 'https://x.com/example/status/1' }),
      env.batch({ chat: GROUP_B, text: 'https://x.com/example/status/1' })
    ])

    expect(first.media).toHaveLength(1)
    expect(second.media).toHaveLength(1)
    expect(first.deliveryKey).toBeTruthy()
    expect(second.deliveryKey).toBeTruthy()
    expect(first.deliveryKey).not.toBe(second.deliveryKey)
    const [a] = first.media as [AutofetchMedia]
    const [b] = second.media as [AutofetchMedia]
    expect(a!.path).not.toBe(b!.path)
    for (const item of [a!, b!]) {
      expect(item.path.startsWith(env.hostCacheDir + '/')).toBe(true)
    }
    const localA = env.localPath(a!)
    const localB = env.localPath(b!)
    expect(existsSync(localA)).toBe(true)
    expect(existsSync(localB)).toBe(true)
    expect(readFileSync(localA)).toEqual(testMediaBytes('jpg', 'https://img.example/same.jpg'))
    expect(readFileSync(localB)).toEqual(testMediaBytes('jpg', 'https://img.example/same.jpg'))
    expect(readFileSync(localA)).toEqual(readFileSync(localB))
    expect(new Set(allFilesUnder(env.dataDir))).toEqual(new Set([localA, localB]))
  })

  it('removes outstanding files at the ten-minute expiry while idle', async () => {
    vi.useFakeTimers()
    try {
      const env = setup({ posts: { 'x:1': { photoUrls: ['https://img.example/old.jpg'] } } })
      const batch = await env.batch({ chat: GROUP_A, text: 'https://x.com/example/status/1' })
      const path = env.localPath(batch.media[0]!)
      env.advance(599_999)
      await vi.advanceTimersByTimeAsync(599_999)
      expect(existsSync(path)).toBe(true)
      env.advance(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(existsSync(path)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears leftover delivery files on startup, including old hash-named cache', async () => {
    const env = setup({ posts: { 'x:1': { photoUrls: ['https://img.example/a.jpg'] } } })
    const batch = await env.batch({ chat: GROUP_A, text: 'https://x.com/example/status/1' })
    expect(batch.media).toHaveLength(1)
    const legacy = join(env.cacheDir, `${'ab'.repeat(32)}.jpg`)
    writeFileSync(legacy, testMediaBytes('jpg', 'https://img.example/legacy.jpg'))
    expect(existsSync(env.localPath(batch.media[0]!))).toBe(true)
    expect(existsSync(legacy)).toBe(true)

    env.restart()
    expect(env.filesInCache()).toEqual([])
  })
})

describe('autofetch gateway delivery', () => {
  const servers: { close: () => void }[] = []
  afterEach(() => {
    for (const server of servers.splice(0)) server.close()
  })

  async function serve(env: ReturnType<typeof setup>, autofetch: Autofetch) {
    const storage: Storage = env.storage
    const server = createGatewayServer({
      turns: {} as TurnService,
      storage,
      logger: createLogger({ level: 'error', module: 'test', sink: () => {} }),
      redactor: createRedactor(),
      now: env.now,
      autofetch: { fetch: (input) => autofetch.fetch(input) }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    servers.push(server)
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/aira/autofetch`
    return {
      fetch: (body: unknown) =>
        fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      claim: (key: string) =>
        fetch(base + '/claim', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key })
        }).then((response) => response.json() as Promise<{ accepted: boolean }>),
      complete: (key: string, outcomes: boolean[]) =>
        fetch(base + '/complete', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key, outcomes })
        }).then((response) => response.json() as Promise<{ accepted: boolean }>)
    }
  }

  it('completes one delivery through the gateway, deletes only its files and keeps the outcome', async () => {
    const env = setup({
      posts: {
        'x:1': { photoUrls: ['https://img.example/a1.jpg', 'https://img.example/a2.jpg'] },
        'x:2': { photoUrls: ['https://img.example/b1.jpg', 'https://img.example/b2.jpg'] }
      }
    })
    env.addGroup(GROUP_B)
    const api = await serve(env, env.live)

    const first = (await (await api.fetch({ chat: GROUP_A, text: 'https://x.com/example/status/1' })).json()) as {
      media: AutofetchMedia[]
      deliveryKey: string
    }
    const second = (await (await api.fetch({ chat: GROUP_B, text: 'https://x.com/example/status/2' })).json()) as {
      media: AutofetchMedia[]
      deliveryKey: string
    }
    expect(first.media).toHaveLength(2)
    expect(second.media).toHaveLength(2)
    const firstLocal = first.media.map((item) => env.localPath(item))
    const secondLocal = second.media.map((item) => env.localPath(item))
    for (const path of [...firstLocal, ...secondLocal]) expect(existsSync(path)).toBe(true)

    expect(await api.claim(first.deliveryKey)).toEqual({ accepted: true })
    expect(await api.claim(first.deliveryKey)).toEqual({ accepted: false })
    expect(firstLocal.some((path) => existsSync(path))).toBe(true)

    expect(await api.complete(first.deliveryKey, [true])).toEqual({ accepted: false })
    for (const path of firstLocal) expect(existsSync(path)).toBe(true)

    expect(await api.complete(first.deliveryKey, [true, false])).toEqual({ accepted: true })
    for (const path of firstLocal) expect(existsSync(path)).toBe(false)
    for (const path of secondLocal) expect(existsSync(path)).toBe(true)

    expect(await api.complete(first.deliveryKey, [true, false])).toEqual({ accepted: false })
    expect(await api.complete(randomUUID(), [true, false])).toEqual({ accepted: false })
    for (const path of secondLocal) expect(existsSync(path)).toBe(true)

    expect(await api.claim(second.deliveryKey)).toEqual({ accepted: true })
    expect(await api.complete(second.deliveryKey, [true, true])).toEqual({ accepted: true })
    for (const path of secondLocal) expect(existsSync(path)).toBe(false)
    expect(env.filesInCache()).toEqual([])
  })
})
