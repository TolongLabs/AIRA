import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadPack } from '../../src/character/loader.js'
import { createLogger } from '../../src/records/logger.js'
import { createRedactor } from '../../src/records/redact.js'
import { ensureChat, setChatStatus } from '../../src/settings/chats.js'
import { definitionFor } from '../../src/settings/keys.js'
import { resolveSetting, resolveSettings, setSetting, unsetSetting } from '../../src/settings/settings.js'
import { socialCapabilities } from '../../src/social/readers.js'
import { openTurn, receiveInbound } from '../../src/storage/turns.js'
import { registerCoreTools } from '../../src/tools/core/index.js'
import type { PostPort } from '../../src/tools/ports.js'
import { createToolRegistry } from '../../src/tools/registry.js'
import { createTurnSources } from '../../src/turn/sources.js'
import type { TurnContext } from '../../src/turn/types.js'
import { queueModel, startApp } from '../support/app.js'
import { tmpDir, tmpStorage } from '../support/tmp.js'

const pack = loadPack('characters/example', 'repository')

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('platform sub-toggles in the settings registry', () => {
  it('defines boolean social.platforms.<id> and autofetch.platforms.<id> switches defaulting to true', () => {
    const available = socialCapabilities(true, { reddit: 'read_and_group', tiktok: 'read_and_group' })
    const storage = tmpStorage()
    const chat = ensureChat(storage, { waId: 'fake-platform-default', type: 'group' })
    for (const feature of ['social', 'autofetch'] as const) {
      for (const { id } of available[`features.${feature}`]) {
        expect(resolveSetting(storage, chat, `${feature}.platforms.${id}`)).toEqual({ value: true, level: 'default' })
      }
    }
    expect(definitionFor('autofetch.platforms.youtube')).toBeUndefined()
    expect(definitionFor('social.platforms.linkedin')).toBeUndefined()
  })

  it('resolves global, type and chat inheritance and restores the inherited value on clear', () => {
    const storage = tmpStorage()
    const dm = ensureChat(storage, { waId: 'fake-platform-dm', type: 'dm' })
    const group = ensureChat(storage, { waId: 'fake-platform-group', type: 'group' })

    setSetting(storage, { level: 'global', scope: '', key: 'social.platforms.x', value: false, actor: 'test' })
    expect(resolveSetting(storage, dm, 'social.platforms.x')).toEqual({ value: false, level: 'global' })
    expect(resolveSetting(storage, group, 'social.platforms.x')).toEqual({ value: false, level: 'global' })

    setSetting(storage, { level: 'type', scope: 'dm', key: 'social.platforms.x', value: true, actor: 'test' })
    expect(resolveSetting(storage, dm, 'social.platforms.x')).toEqual({ value: true, level: 'type' })
    expect(resolveSetting(storage, group, 'social.platforms.x')).toEqual({ value: false, level: 'global' })

    setSetting(storage, { level: 'chat', scope: dm.chatId, key: 'social.platforms.x', value: false, actor: 'test' })
    expect(resolveSetting(storage, dm, 'social.platforms.x')).toEqual({ value: false, level: 'chat' })

    expect(resolveSettings(storage, dm)['social.platforms.x']).toEqual({ value: false, level: 'chat' })

    expect(unsetSetting(storage, { level: 'chat', scope: dm.chatId, key: 'social.platforms.x', actor: 'test' })).toBe(
      true
    )
    expect(resolveSetting(storage, dm, 'social.platforms.x')).toEqual({ value: true, level: 'type' })
    expect(unsetSetting(storage, { level: 'type', scope: 'dm', key: 'social.platforms.x', actor: 'test' })).toBe(true)
    expect(resolveSetting(storage, dm, 'social.platforms.x')).toEqual({ value: false, level: 'global' })
  })

  it('leaves another chat unaffected and keeps social and autofetch switches independent', () => {
    const storage = tmpStorage()
    const first = ensureChat(storage, { waId: 'fake-platform-a', type: 'group' })
    const second = ensureChat(storage, { waId: 'fake-platform-b', type: 'group' })

    setSetting(storage, { level: 'chat', scope: first.chatId, key: 'social.platforms.x', value: false, actor: 'test' })
    expect(resolveSetting(storage, second, 'social.platforms.x')).toEqual({ value: true, level: 'default' })
    expect(resolveSetting(storage, second, 'autofetch.platforms.x')).toEqual({ value: true, level: 'default' })
    expect(resolveSetting(storage, first, 'autofetch.platforms.x')).toEqual({ value: true, level: 'default' })

    setSetting(storage, {
      level: 'chat',
      scope: first.chatId,
      key: 'autofetch.platforms.x',
      value: false,
      actor: 'test'
    })
    setSetting(storage, { level: 'chat', scope: first.chatId, key: 'social.platforms.x', value: true, actor: 'test' })
    expect(resolveSetting(storage, first, 'social.platforms.x')).toEqual({ value: true, level: 'chat' })
    expect(resolveSetting(storage, first, 'autofetch.platforms.x')).toEqual({ value: false, level: 'chat' })
  })

  it('rejects non-boolean platform values without writing anything', () => {
    const storage = tmpStorage()
    const chat = ensureChat(storage, { waId: 'fake-platform-bad', type: 'group' })
    expect(definitionFor('social.platforms.x')).toBeDefined()
    for (const value of ['false', 0, 1, null, {}]) {
      expect(() =>
        setSetting(storage, { level: 'chat', scope: chat.chatId, key: 'social.platforms.x', value, actor: 'test' })
      ).toThrow()
    }
    expect(storage.read((db) => db.prepare('SELECT count(*) FROM setting').pluck().get())).toBe(0)
    expect(storage.read((db) => db.prepare('SELECT count(*) FROM setting_change').pluck().get())).toBe(0)
  })
})

const SITE_TOKEN = 'test-site-token-0123456789abcdefghijklmn'

function sitePut(siteUrl: string, body: unknown) {
  return fetch(`${siteUrl}/api/settings`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${SITE_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
}

describe('platform switches through PUT /api/settings', () => {
  it('sets, repeats and clears one platform key with setting_change rows by the site', async () => {
    const { app, chatId } = await startApp(queueModel([{ text: 'ok' }]), { env: { SITE_TOKEN } })
    const address = await app.listenSite(0, '127.0.0.1')
    if (!address) throw new Error('site failed to listen')
    const siteUrl = `http://127.0.0.1:${address.port}`
    const other = ensureChat(app.storage, { waId: 'test-platform-other', type: 'group' })
    setChatStatus(app.storage, { chatId: other.chatId, status: 'active', actor: 'test' })

    const set = await sitePut(siteUrl, { level: 'global', scope: '', key: 'social.platforms.x', value: false })
    expect(set.status).toBe(200)
    expect(await set.json()).toEqual({
      level: 'global',
      scope: '',
      key: 'social.platforms.x',
      value: false,
      changed: true
    })

    const repeat = await sitePut(siteUrl, { level: 'global', scope: '', key: 'social.platforms.x', value: false })
    expect(await repeat.json()).toMatchObject({ changed: false })

    const chatSet = await sitePut(siteUrl, {
      level: 'chat',
      scope: chatId,
      key: 'social.platforms.x',
      value: true
    })
    expect(chatSet.status).toBe(200)

    const chats = (await (
      await fetch(`${siteUrl}/api/chats`, { headers: { authorization: `Bearer ${SITE_TOKEN}` } })
    ).json()) as {
      chats: { chatId: string; settings: Record<string, { value: unknown; level: string }> }[]
    }
    const first = chats.chats.find((entry) => entry.chatId === chatId)?.settings['social.platforms.x']
    const second = chats.chats.find((entry) => entry.chatId === other.chatId)?.settings['social.platforms.x']
    expect(first).toEqual({ value: true, level: 'chat' })
    expect(second).toEqual({ value: false, level: 'global' })

    const cleared = await sitePut(siteUrl, { level: 'chat', scope: chatId, key: 'social.platforms.x', value: null })
    expect(await cleared.json()).toMatchObject({ value: null, changed: true })

    const actors = app.storage.read((db) =>
      db.prepare("SELECT actor FROM setting_change WHERE key = 'social.platforms.x' ORDER BY rowid").pluck().all()
    )
    expect(actors).toEqual(['site', 'site', 'site'])

    const bad = await sitePut(siteUrl, { level: 'global', scope: '', key: 'social.platforms.x', value: 'yes' })
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ error: 'invalid_setting' })
  })
})

function makeReadPostEnv() {
  const storage = tmpStorage()
  const chat = ensureChat(storage, { waId: 'fake-platform-read', type: 'group' })
  setChatStatus(storage, { chatId: chat.chatId, status: 'active', actor: 'test' })
  setSetting(storage, { level: 'chat', scope: chat.chatId, key: 'features.social', value: true, actor: 'test' })
  setSetting(storage, { level: 'chat', scope: chat.chatId, key: 'social.platforms.x', value: false, actor: 'test' })

  const read = vi.fn(async (url: string) => ({
    untrusted: true as const,
    author: 'Poster',
    text: `post at ${url}`,
    media: [],
    platform: 'bluesky',
    handle: 'poster',
    createdAt: null,
    quotedText: '',
    replyCount: null,
    canonicalUrl: url,
    thread: [],
    replies: [],
    durationSec: null
  }))
  const registry = createToolRegistry({
    storage,
    config: { tools: { defaultTimeoutMs: 500 } },
    logger: createLogger({ level: 'error', module: 'platform-test', sink: () => {} }),
    redactor: createRedactor()
  })
  registerCoreTools(
    registry,
    { filesDir: tmpDir('aira-platform-files-'), post: { read } as unknown as PostPort },
    { feedback: { formUrl: '', referenceEntryId: '', refTtlHours: 168 } }
  )

  const senderId = 'member-platform'
  const turnId = 'turn-platform-1'
  receiveInbound(storage, { chatId: chat.chatId, mid: 'mid-platform-1', senderId })
  openTurn(storage, { turnId, chatId: chat.chatId, senderId, kind: 'reply', mids: ['mid-platform-1'] })
  const sources = createTurnSources()
  const disabledUrl = 'https://x.com/someone/status/1234567890123456789'
  const validUrl = 'https://bsky.app/profile/someone/post/abc123'
  sources.add(disabledUrl, 'message')
  sources.add(validUrl, 'message')
  const context: TurnContext = {
    turnId,
    chat,
    senderId,
    character: pack,
    settings: resolveSettings(storage, chat),
    kind: 'reply',
    delivery: { kind: 'reply' },
    deadline: Date.now() + 10_000,
    sources
  }
  return { storage, chat, registry, context, read, disabledUrl, validUrl }
}

describe('read_post with a disabled platform', () => {
  it('refuses the disabled link before any network and still reads a later valid link', async () => {
    const { storage, registry, context, read, disabledUrl, validUrl } = makeReadPostEnv()

    const refused = await registry.call('read_post', { url: disabledUrl }, context, {
      callId: 'c-platform-disabled',
      source: 'model'
    })
    expect(refused).toMatchObject({ ok: false, kind: 'refused' })
    expect(read).not.toHaveBeenCalled()

    const valid = await registry.call('read_post', { url: validUrl }, context, {
      callId: 'c-platform-valid',
      source: 'model'
    })
    expect(valid).toMatchObject({ ok: true })
    expect(read).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledWith(validUrl, expect.anything(), expect.anything())

    const rows = storage.read(
      (db) =>
        db.prepare('SELECT platform, outcome, reason, attempts FROM social_turn_lookup ORDER BY ordinal').all() as {
          platform: string
          outcome: string
          reason: string | null
          attempts: string
        }[]
    )
    expect(rows).toContainEqual({
      platform: 'x',
      outcome: 'skipped',
      reason: 'platform_disabled',
      attempts: '[]'
    })
  })
})

describe('intake with a disabled platform', () => {
  it('never fetches the disabled URL and still reads the later valid link', async () => {
    const realFetch = globalThis.fetch
    const fetched: string[] = []
    const stub = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) {
        return realFetch(input, init)
      }
      fetched.push(url)
      if (url.includes('api.fxtwitter.com')) {
        return Response.json({ tweet: { id: '1', text: 'x post', author: { screen_name: 'a' } } })
      }
      if (url.includes('youtube.com/oembed')) {
        return Response.json({
          title: 'A short film',
          author_name: 'Chan',
          author_url: 'https://www.youtube.com/@chan',
          thumbnail_url: 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg'
        })
      }
      return new Response('not found', { status: 404 })
    }) as typeof fetch
    vi.stubGlobal('fetch', stub)

    const { app, gateway } = await startApp(queueModel([{ text: 'noted' }]), { env: { SITE_TOKEN } })

    const target = app.storage.read((db) => db.prepare('SELECT chat_id FROM chat LIMIT 1').pluck().get()) as string
    setSetting(app.storage, { level: 'chat', scope: target, key: 'social.platforms.x', value: false, actor: 'test' })

    await gateway.send({
      chat: { waId: 'test-chat-g1', kind: 'group' },
      sender: 'test-member-alice',
      mid: 'mid-platform-intake-1',
      text: 'see https://x.com/a/status/1 and https://www.youtube.com/watch?v=abcdefghijk'
    })
    expect(
      app.storage.read((db) =>
        db
          .prepare(
            'SELECT platform, outcome, reason, attempts FROM social_turn_lookup WHERE turn_id IS NOT NULL ORDER BY ordinal'
          )
          .all()
      )
    ).toEqual([
      { platform: 'x', outcome: 'skipped', reason: 'platform_disabled', attempts: '[]' },
      expect.objectContaining({ platform: 'youtube' })
    ])
    expect(fetched.some((url) => url.includes('api.fxtwitter.com'))).toBe(false)
    expect(fetched.some((url) => url.includes('youtube.com/oembed'))).toBe(true)
  })
})
