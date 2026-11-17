import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadPack } from '../../src/character/loader.js'
import { createLogger } from '../../src/records/logger.js'
import { createRedactor } from '../../src/records/redact.js'
import { RenderError } from '../../src/render/render.js'
import { type NoteDocument, noteDocumentSchema } from '../../src/render/types.js'
import { ensureChat, setChatStatus } from '../../src/settings/chats.js'
import { resolveSettings, setSetting } from '../../src/settings/settings.js'
import { openTurn, receiveInbound } from '../../src/storage/turns.js'
import { CORE_TOOL_NAMES, registerCoreTools } from '../../src/tools/core/index.js'
import { INTAKE_REFUSAL } from '../../src/tools/core/web.js'
import {
  createFetchPagePort,
  isForbiddenUrl,
  type MemoryPort,
  type PagePort,
  type PostPort,
  type SchedulePort,
  type SearchPort,
  type ToolPorts
} from '../../src/tools/ports.js'
import { createToolRegistry } from '../../src/tools/registry.js'
import type { TurnContext } from '../../src/turn/types.js'
import { tmpDir, tmpStorage } from '../support/tmp.js'

const pack = loadPack('characters/example', 'repository')

afterEach(() => {
  vi.unstubAllGlobals()
})

let seq = 0
function setup(ports: Partial<ToolPorts> = {}, options: { now?: () => Date } = {}) {
  const storage = tmpStorage()
  const filesDir = ports.filesDir ?? tmpDir('aira-files-')
  const registry = createToolRegistry({
    storage,
    config: { tools: { defaultTimeoutMs: 500 } },
    logger: createLogger({ level: 'error', module: 'core-tools-test', sink: () => {} }),
    redactor: createRedactor(),
    now: options.now
  })
  registerCoreTools(registry, { ...ports, filesDir })
  const makeCtx = (overrides: { waId?: string; senderId?: string } = {}): TurnContext => {
    seq++
    const chat = ensureChat(storage, { waId: overrides.waId ?? `fake-chat-${seq}`, type: 'group' })
    setChatStatus(storage, { chatId: chat.chatId, status: 'active', actor: 'test' })
    const senderId = overrides.senderId ?? `member-${seq}`
    const mid = `mid-${seq}`
    const turnId = `turn-${seq}`
    receiveInbound(storage, { chatId: chat.chatId, mid, senderId })
    openTurn(storage, { turnId, chatId: chat.chatId, senderId, kind: 'reply', mids: [mid] })
    return {
      turnId,
      chat,
      senderId,
      character: pack,
      settings: resolveSettings(storage, chat),
      kind: 'reply',
      delivery: { kind: 'reply' },
      deadline: Date.now() + 10_000
    }
  }
  return { storage, filesDir, registry, makeCtx }
}

function makeFakePorts() {
  const recalledChats: string[] = []
  const historyChats: string[] = []
  const forgetCalls: { chatId: string; itemId: string }[] = []
  const facts = new Map<string, { chatId: string; text: string }>()

  const memory: MemoryPort = {
    recall(chatId, query) {
      recalledChats.push(chatId)
      return [...facts.entries()]
        .filter(([, f]) => f.chatId === chatId && f.text.includes(query))
        .map(([itemId, f]) => ({ itemId, text: f.text }))
    },
    history(chatId, query) {
      historyChats.push(chatId)
      return [{ at: '2026-11-16T00:00:00.000Z', senderId: 'member-1', text: `match for ${query}` }]
    },
    async checkNote() {
      return { ok: true as const }
    },
    note(_db, input) {
      const id = `fact_${facts.size + 1}`
      facts.set(id, { chatId: input.chatId, text: input.text })
      return { itemId: id, effect: 'added' }
    },
    forget(_db, input) {
      forgetCalls.push(input)
      const existing = facts.get(input.itemId)
      if (!existing || existing.chatId !== input.chatId) return false
      facts.delete(input.itemId)
      return true
    },
    forgetPending() {},
    lingo(_db, input) {
      return `lingo_${input.word}`
    }
  }

  const search: SearchPort = {
    async search(query) {
      return [{ title: `Result for ${query}`, url: 'https://example.com/1', snippet: 'snippet' }]
    },
    async images() {
      return [{ url: 'https://example.com/photo.png' }]
    }
  }

  const page: PagePort = {
    async read(url) {
      return { title: `Title of ${url}`, text: 'Body text' }
    },
    async download() {
      return { data: Buffer.from([0x89, 0x50, 0x4e, 0x47]), contentType: 'image/png' }
    }
  }

  const post: PostPort = {
    async read(url) {
      return { author: 'author1', text: `Post from ${url}`, media: ['https://example.com/m.jpg'] }
    }
  }

  const syncs = { count: 0 }
  const schedule: SchedulePort = {
    sync() {
      syncs.count++
    }
  }

  return { memory, search, page, post, schedule, recalledChats, historyChats, forgetCalls, facts, syncs }
}

describe('core tools', () => {
  it('registerCoreTools registers the exact eighteen tools in CORE_TOOL_NAMES', () => {
    const { registry } = setup()
    expect(registry.toolNames()).toEqual([...CORE_TOOL_NAMES])
    expect(CORE_TOOL_NAMES).toHaveLength(18)
  })

  it('memory tools: note, recall, forget, history_search, lingo_note and chat isolation', async () => {
    const fakes = makeFakePorts()
    const { registry, makeCtx } = setup({ memory: fakes.memory })
    const ctx1 = makeCtx()
    const ctx2 = makeCtx()

    const noteRes = await registry.call('note', { text: 'likes jasmine tea' }, ctx1, {
      callId: 'c-note',
      source: 'model'
    })
    expect(noteRes).toMatchObject({
      ok: true,
      data: { itemId: 'fact_1' },
      receipt: { kind: 'memory.noted', target: 'fact_1', state: { effect: 'added' } }
    })

    const recallRes = await registry.call('recall', { query: 'jasmine' }, ctx1, {
      callId: 'c-recall',
      source: 'model'
    })
    expect(recallRes).toEqual({ ok: true, data: { items: [{ itemId: 'fact_1', text: 'likes jasmine tea' }] } })

    const otherChatForget = await registry.call('forget', { itemId: 'fact_1' }, ctx2, {
      callId: 'c-forget-other',
      source: 'model'
    })
    expect(otherChatForget).toMatchObject({
      ok: true,
      data: { forgotten: false, candidates: [] },
      receipt: { kind: 'memory.forget_barrier' }
    })

    const forgetSearchRes = await registry.call('forget', { query: 'jasmine' }, ctx1, {
      callId: 'c-forget-search',
      source: 'model'
    })
    expect(forgetSearchRes).toMatchObject({
      ok: true,
      data: { forgotten: false, candidates: [{ itemId: 'fact_1', text: 'likes jasmine tea' }] },
      receipt: { kind: 'memory.forget_barrier' }
    })

    const forgetRes = await registry.call('forget', { itemId: 'fact_1' }, ctx1, {
      callId: 'c-forget-ok',
      source: 'model'
    })
    expect(forgetRes).toMatchObject({
      ok: true,
      data: { forgotten: true, candidates: [] },
      receipt: { kind: 'memory.forgotten', target: 'fact_1' }
    })

    const histRes = await registry.call('history_search', { query: 'hello' }, ctx1, {
      callId: 'c-hist',
      source: 'model'
    })
    expect(histRes).toMatchObject({ ok: true, data: { matches: [{ text: 'match for hello' }] } })

    const lingoRes = await registry.call('lingo_note', { word: 'brb', meaning: 'be right back' }, ctx1, {
      callId: 'c-lingo',
      source: 'model'
    })
    expect(lingoRes).toMatchObject({
      ok: true,
      data: { itemId: 'lingo_brb' },
      receipt: { kind: 'lingo.noted', target: 'lingo_brb' }
    })

    expect(fakes.recalledChats).toEqual([ctx1.chat.chatId, ctx1.chat.chatId])
    expect(fakes.historyChats).toEqual([ctx1.chat.chatId])
    expect(fakes.forgetCalls).toEqual([
      { chatId: ctx2.chat.chatId, itemId: 'fact_1' },
      { chatId: ctx1.chat.chatId, itemId: 'fact_1' }
    ])
  })

  it('hides and refuses note and recall while off, but keeps help and forget usable', async () => {
    const fakes = makeFakePorts()
    const { storage, registry, makeCtx } = setup({ memory: fakes.memory })
    const ctx = makeCtx({ waId: '0000000000@g.us', senderId: 'member' })
    fakes.facts.set('kept', { chatId: ctx.chat.chatId, text: 'likes green tea' })
    setSetting(storage, { level: 'chat', scope: ctx.chat.chatId, key: 'features.memory', value: false, actor: 'test' })
    ctx.settings = resolveSettings(storage, ctx.chat)
    const offered = registry.offered(ctx).map((tool) => tool.schema.name)
    expect(offered).not.toContain('note')
    expect(offered).not.toContain('recall')
    expect(offered).toContain('forget')
    const help = await registry.call('help', {}, ctx, { callId: 'off-help', source: 'command' })
    expect(JSON.stringify(help)).not.toContain('/remember')
    expect(JSON.stringify(help)).not.toContain('/recall')
    expect(JSON.stringify(help)).toContain('/forget')
    for (const source of ['command', 'model'] as const) {
      for (const tool of ['note', 'recall']) {
        expect(
          await registry.call(tool, { text: 'new fact', query: 'tea' }, ctx, {
            callId: `off-${source}-${tool}`,
            source
          })
        ).toMatchObject({ ok: false, kind: 'refused' })
      }
    }
    expect(
      await registry.call('forget', { query: 'tea' }, ctx, { callId: 'off-find', source: 'command' })
    ).toMatchObject({ ok: true, data: { candidates: [{ itemId: 'kept' }] } })
    expect(
      await registry.call('forget', { itemId: 'kept' }, ctx, { callId: 'off-forget', source: 'command' })
    ).toMatchObject({ ok: true, data: { forgotten: true } })
    expect(fakes.facts.size).toBe(0)
  })

  it('web tools: web_search, read_page, read_post, send_photo, routing and failures', async () => {
    const fakes = makeFakePorts()
    const { storage, filesDir, registry, makeCtx } = setup({
      search: fakes.search,
      page: fakes.page,
      post: fakes.post
    })
    const ctx = makeCtx()

    expect(await registry.call('web_search', { query: 'vitest' }, ctx, { callId: 'c-ws', source: 'model' })).toEqual({
      ok: true,
      data: { results: [{ title: 'Result for vitest', url: 'https://example.com/1', snippet: 'snippet' }] }
    })

    expect(
      await registry.call('read_page', { url: 'https://example.com/page' }, ctx, { callId: 'c-rp', source: 'model' })
    ).toEqual({ ok: true, data: { title: 'Title of https://example.com/page', text: 'Body text' } })

    expect(
      await registry.call('read_post', { url: 'https://x.com/user/status/1' }, ctx, {
        callId: 'c-rpost',
        source: 'model'
      })
    ).toEqual({
      ok: true,
      data: { author: 'author1', text: 'Post from https://x.com/user/status/1', media: ['https://example.com/m.jpg'] }
    })

    const readDef = registry.get('read_page')
    expect(readDef?.command?.route?.('https://x.com/user/status/1')).toBe('read_post')
    expect(readDef?.command?.route?.('https://sub.reddit.com/r/test')).toBeUndefined()
    expect(readDef?.command?.route?.('https://x.com/home')).toBeUndefined()
    expect(readDef?.command?.route?.('https://facebook.com/example_user/posts/1')).toBeUndefined()
    expect(readDef?.command?.route?.('https://threads.com/@example_user/post/Example123')).toBe('read_post')
    expect(readDef?.command?.route?.('https://example.com/article')).toBeUndefined()

    for (const badUrl of ['http://127.0.0.1/', 'http://192.168.1.10/admin', 'file:///etc/passwd']) {
      expect(
        await registry.call('read_page', { url: badUrl }, ctx, { callId: `c-bad-${badUrl}`, source: 'model' })
      ).toMatchObject({
        ok: false,
        kind: 'refused'
      })
    }

    const photoRes = await registry.call('send_photo', { query: 'cat' }, ctx, {
      callId: 'c-photo',
      source: 'model'
    })
    expect(photoRes).toMatchObject({
      ok: true,
      data: { attached: true },
      receipt: { kind: 'photo.found' }
    })
    if (photoRes.ok) {
      const attachment = photoRes.receipt?.state?.attachment as string
      expect(attachment).toMatch(/\.png$/)
      expect(existsSync(join(filesDir, attachment))).toBe(true)
      expect(storage.read((db) => db.prepare('SELECT kind FROM file WHERE path = ?').pluck().get(attachment))).toBe(
        'photo'
      )
    }

    const nonImageSetup = setup({
      search: fakes.search,
      page: {
        ...fakes.page,
        async download() {
          return { data: Buffer.from('not image'), contentType: 'text/html' }
        }
      }
    })
    const badPhoto = await nonImageSetup.registry.call('send_photo', { query: 'cat' }, nonImageSetup.makeCtx(), {
      callId: 'c-bad-img',
      source: 'model'
    })
    expect(badPhoto).toMatchObject({ ok: false, kind: 'invalid' })
  })

  it('send_photo tries the next candidate when the first is not an image', async () => {
    const fakes = makeFakePorts()
    const downloaded: string[] = []
    const { filesDir, registry, makeCtx } = setup({
      search: {
        ...fakes.search,
        async images() {
          return [{ url: 'https://example.com/page.html' }, { url: 'https://example.com/photo.webp' }]
        }
      },
      page: {
        ...fakes.page,
        async download(url) {
          downloaded.push(url)
          if (url.endsWith('.html')) {
            return { data: Buffer.from('<html></html>'), contentType: 'text/html; charset=utf-8' }
          }
          return { data: Buffer.from('webp-bytes'), contentType: 'image/webp' }
        }
      }
    })

    const res = await registry.call('send_photo', { query: 'cat' }, makeCtx(), {
      callId: 'c-photo-fallback',
      source: 'model'
    })
    expect(downloaded).toEqual(['https://example.com/page.html', 'https://example.com/photo.webp'])
    expect(res).toMatchObject({
      ok: true,
      data: { attached: true },
      receipt: { kind: 'photo.found' }
    })
    if (res.ok) {
      const attachment = res.receipt?.state?.attachment as string
      expect(attachment).toMatch(/\.webp$/)
      expect(existsSync(join(filesDir, attachment))).toBe(true)
    }
  })

  it('send_photo answers unavailable when the search has no images', async () => {
    const fakes = makeFakePorts()
    const downloadSpy = vi.fn(fakes.page.download)
    const { registry, makeCtx } = setup({
      search: {
        ...fakes.search,
        async images() {
          return []
        }
      },
      page: {
        ...fakes.page,
        download: downloadSpy
      }
    })

    const res = await registry.call('send_photo', { query: 'nothing' }, makeCtx(), {
      callId: 'c-photo-empty',
      source: 'model'
    })
    expect(res).toEqual({ ok: false, kind: 'unavailable', reason: 'no photo found' })
    expect(downloadSpy).not.toHaveBeenCalled()
  })

  it('send_photo tries at most 3 candidates, enforces image types and size, and keeps refusals', async () => {
    const fakes = makeFakePorts()
    const attempted: string[] = []
    const capped = setup({
      search: {
        ...fakes.search,
        async images() {
          return [
            { url: 'https://example.com/1.svg' },
            { url: 'https://example.com/2.jpg' },
            { url: 'https://example.com/3.html' },
            { url: 'https://example.com/4.png' }
          ]
        }
      },
      page: {
        ...fakes.page,
        async download(url) {
          attempted.push(url)
          if (url.endsWith('1.svg')) return { data: Buffer.from('<svg/>'), contentType: 'image/svg+xml' }
          if (url.endsWith('2.jpg')) throw new Error('404')
          if (url.endsWith('3.html')) return { data: Buffer.from('nope'), contentType: 'text/html' }
          return { data: Buffer.from('ok'), contentType: 'image/png' }
        }
      }
    })
    const cappedRes = await capped.registry.call('send_photo', { query: 'cap' }, capped.makeCtx(), {
      callId: 'c-photo-cap3',
      source: 'model'
    })
    expect(attempted).toEqual(['https://example.com/1.svg', 'https://example.com/2.jpg', 'https://example.com/3.html'])
    expect(cappedRes).toMatchObject({ ok: false, kind: 'invalid' })

    const downloadRefusedSpy = vi.fn(fakes.page.download)
    const refused = setup({
      search: {
        ...fakes.search,
        async images() {
          return [{ url: 'http://127.0.0.1/secret.png' }]
        }
      },
      page: {
        ...fakes.page,
        download: downloadRefusedSpy
      }
    })
    const refusedRes = await refused.registry.call('send_photo', { query: 'local' }, refused.makeCtx(), {
      callId: 'c-photo-refused',
      source: 'model'
    })
    expect(refusedRes).toEqual({ ok: false, kind: 'refused', reason: 'forbidden address' })
    expect(downloadRefusedSpy).not.toHaveBeenCalled()

    const oversized = setup({
      search: {
        ...fakes.search,
        async images() {
          return [{ url: 'https://example.com/huge.jpg' }, { url: 'https://example.com/small.gif' }]
        }
      },
      page: {
        ...fakes.page,
        async download(url) {
          if (url.endsWith('huge.jpg')) return { data: Buffer.alloc(5_000_001), contentType: 'image/jpeg' }
          return { data: Buffer.from('GIF89a'), contentType: 'image/gif' }
        }
      }
    })
    const oversizedRes = await oversized.registry.call('send_photo', { query: 'gif' }, oversized.makeCtx(), {
      callId: 'c-photo-size',
      source: 'model'
    })
    expect(oversizedRes).toMatchObject({ ok: true, data: { attached: true }, receipt: { kind: 'photo.found' } })
  })

  it('read_page: a post intake read as text only stays open, so its replies and media can be fetched', async () => {
    const seenPages: string[] = []
    const { registry, makeCtx } = setup({
      page: {
        async read(url) {
          seenPages.push(url)
          return { title: `Title of ${url}`, text: 'Body' }
        },
        async download() {
          return { data: Buffer.from(''), contentType: 'text/plain' }
        }
      }
    })
    const ctx = makeCtx()
    ctx.intakeUrls = ['https://x.com/i/status/7']
    ctx.intakeWatchedUrls = []
    const read = await registry.call('read_page', { url: 'https://x.com/someone/status/7' }, ctx, {
      callId: 'c-rp-text-only',
      source: 'model'
    })
    expect(read.ok).toBe(true)
    expect(seenPages).toHaveLength(1)
  })

  it('read_page: refuses a URL read at intake as "already read at intake"; works when intake did not read it', async () => {
    const seenPages: string[] = []
    const { storage, registry, makeCtx } = setup({
      page: {
        async read(url) {
          seenPages.push(url)
          return { title: `Title of ${url}`, text: 'Body' }
        },
        async download() {
          return { data: Buffer.from(''), contentType: 'text/plain' }
        }
      }
    })
    const ctx = makeCtx()
    ctx.intakeWatchedUrls = ['https://x.com/i/status/1']

    const refused = await registry.call('read_page', { url: 'https://twitter.com/user/status/1' }, ctx, {
      callId: 'c-rp-refused',
      source: 'model'
    })
    expect(refused).toEqual({ ok: false, kind: 'refused', reason: INTAKE_REFUSAL })
    expect(seenPages).toEqual([])
    expect(registry.takeSources(ctx.turnId)).toEqual([])
    expect(
      storage.read((db) => db.prepare('SELECT outcome FROM tool_call WHERE turn_id = ?').pluck().get(ctx.turnId))
    ).toBe('refused')

    const allowed = await registry.call('read_page', { url: 'https://example.com/article' }, ctx, {
      callId: 'c-rp-ok',
      source: 'model'
    })
    expect(allowed).toEqual({ ok: true, data: { title: 'Title of https://example.com/article', text: 'Body' } })
    expect(seenPages).toEqual(['https://example.com/article'])
    expect(registry.takeSources(ctx.turnId)).toEqual(['https://example.com/article'])
  })

  it('read_post: refuses a YouTube short link whose canonical URL was read at intake', async () => {
    const seenPosts: string[] = []
    const { registry, makeCtx } = setup({
      post: {
        async read(url) {
          seenPosts.push(url)
          return { author: 'chan', text: `Post ${url}`, media: [] }
        }
      }
    })
    const ctx = makeCtx()
    ctx.intakeWatchedUrls = ['https://www.youtube.com/watch?v=dQw4w9WgXcQ']

    const shortRefused = await registry.call('read_post', { url: 'https://youtu.be/dQw4w9WgXcQ?t=15' }, ctx, {
      callId: 'c-rpost-yt-short',
      source: 'model'
    })
    expect(shortRefused).toEqual({ ok: false, kind: 'refused', reason: INTAKE_REFUSAL })

    const shortsRefused = await registry.call('read_post', { url: 'https://www.youtube.com/shorts/dQw4w9WgXcQ' }, ctx, {
      callId: 'c-rpost-yt-shorts',
      source: 'model'
    })
    expect(shortsRefused).toEqual({ ok: false, kind: 'refused', reason: INTAKE_REFUSAL })
    expect(seenPosts).toEqual([])
    expect(registry.takeSources(ctx.turnId)).toEqual([])

    const otherOk = await registry.call('read_post', { url: 'https://youtu.be/otherVideo99' }, ctx, {
      callId: 'c-rpost-other',
      source: 'model'
    })
    expect(otherOk).toMatchObject({ ok: true })
    expect(seenPosts).toEqual(['https://youtu.be/otherVideo99'])
  })

  it('reminders: set, list, cancel, isolation and failure cases', async () => {
    const fakes = makeFakePorts()
    const now = () => new Date('2026-11-16T00:00:00.000Z')
    const { storage, registry, makeCtx } = setup({ schedule: fakes.schedule }, { now })
    const ctx1 = makeCtx({ senderId: 'owner-1' })
    const ctxOtherMember = makeCtx({ waId: ctx1.chat.waId, senderId: 'member-2' })
    const ctxOtherChat = makeCtx({ senderId: 'owner-1' })

    const pastRes = await registry.call('reminder_set', { text: 'too late', dueAt: '2026-11-15T00:00:00Z' }, ctx1, {
      callId: 'c-past',
      source: 'model'
    })
    expect(pastRes).toMatchObject({ ok: false, kind: 'invalid' })

    const setRes = await registry.call(
      'reminder_set',
      { text: 'take medicine', dueAt: '2026-11-17T08:00:00Z', repeat: 'daily' },
      ctx1,
      { callId: 'c-set', source: 'model' }
    )
    expect(setRes).toMatchObject({
      ok: true,
      receipt: { kind: 'reminder.created', state: { dueAt: '2026-11-17T08:00:00.000Z', repeat: 'daily' } }
    })
    const reminderId = setRes.ok ? (setRes.data as { reminderId: string }).reminderId : ''
    // The wanted-jobs file is written again after the commit.
    expect(fakes.syncs.count).toBe(1)

    const list1 = await registry.call('reminder_list', {}, ctx1, { callId: 'c-list-1', source: 'command' })
    expect(list1).toEqual({
      ok: true,
      data: {
        reminders: [
          { reminderId, dueAt: '2026-11-17T08:00:00.000Z', repeat: 'daily', text: 'take medicine', mine: true }
        ]
      }
    })

    const listOtherChat = await registry.call('reminder_list', {}, ctxOtherChat, {
      callId: 'c-list-2',
      source: 'command'
    })
    expect(listOtherChat).toEqual({ ok: true, data: { reminders: [] } })

    expect(
      await registry.call('reminder_cancel', { reminderId }, ctxOtherMember, {
        callId: 'c-canc-member',
        source: 'model'
      })
    ).toMatchObject({ ok: false, kind: 'refused' })

    expect(
      await registry.call('reminder_cancel', { reminderId }, ctxOtherChat, {
        callId: 'c-canc-chat',
        source: 'model'
      })
    ).toMatchObject({ ok: false, kind: 'refused' })

    const cancelOk = await registry.call('reminder_cancel', { reminderId }, ctx1, {
      callId: 'c-canc-ok',
      source: 'model'
    })
    expect(cancelOk).toMatchObject({ ok: true, receipt: { kind: 'reminder.cancelled', target: reminderId } })
    expect(fakes.syncs.count).toBe(2)
    expect(
      storage.read((db) => db.prepare('SELECT state FROM reminder WHERE reminder_id = ?').pluck().get(reminderId))
    ).toBe('cancelled')

    expect(
      await registry.call('reminder_cancel', { reminderId }, ctx1, {
        callId: 'c-canc-again',
        source: 'model'
      })
    ).toMatchObject({ ok: false, kind: 'refused' })
  })

  it('mute, report, help and list tools', async () => {
    const now = () => new Date('2026-11-16T00:00:00.000Z')
    const { storage, filesDir, registry, makeCtx } = setup({}, { now })
    const ctx = makeCtx({ senderId: 'admin-1' })

    const muteOn = await registry.call('set_mute', { muted: true }, ctx, { callId: 'c-mute', source: 'command' })
    expect(muteOn).toMatchObject({ ok: true, data: { muted: true }, receipt: { kind: 'mute.on' } })
    const mutedRow = storage.read(
      (db) =>
        db
          .prepare("SELECT value FROM setting WHERE level = 'chat' AND scope = ? AND key = 'muted'")
          .pluck()
          .get(ctx.chat.chatId) as string
    )
    expect(JSON.parse(mutedRow)).toEqual({ by: 'admin-1', at: '2026-11-16T00:00:00.000Z' })

    const muteOff = await registry.call('set_mute', { muted: false }, ctx, { callId: 'c-unmute', source: 'command' })
    expect(muteOff).toMatchObject({ ok: true, data: { muted: false }, receipt: { kind: 'mute.off' } })

    const mdCtx: TurnContext = { ...ctx, messageText: '/doc weekly md' }
    const reportRes = await registry.call(
      'make_report',
      { title: 'Weekly', sections: [{ heading: 'Status', body: 'All good.' }] },
      mdCtx,
      {
        callId: 'c-report',
        source: 'model'
      }
    )
    expect(reportRes).toMatchObject({ ok: true, data: { created: true }, receipt: { kind: 'report.created' } })
    if (reportRes.ok) {
      const attachment = reportRes.receipt?.state?.attachment as string
      expect(readFileSync(join(filesDir, attachment), 'utf8')).toBe('# Weekly\n\n## Status\n\nAll good.')
    }

    const helpRes = await registry.call('help', {}, ctx, { callId: 'c-help', source: 'command' })
    expect(helpRes.ok).toBe(true)
    if (helpRes.ok) {
      const data = helpRes.data as { commands: { command: string }[]; think?: boolean }
      const cmds = data.commands.map((c) => c.command)
      expect(cmds).toContain('/help')
      expect(cmds).toContain('/mute')
      expect(cmds).toContain('/unmute')
      expect(cmds).toContain('/doc')
      expect(cmds).not.toContain('/report')
      expect(cmds).not.toContain('/think')
      expect(data.think).toBe(true)
    }

    const listRes = await registry.call('list', {}, ctx, { callId: 'c-list-tools', source: 'command' })
    expect(listRes.ok).toBe(true)
    if (listRes.ok) {
      const data = listRes.data as { tools: string[]; features: Record<string, boolean> }
      expect(data.tools).toContain('recall')
      expect(data.tools).not.toContain('help')
      expect(data.features['features.reminders']).toBe(true)
      expect(data.features['features.lessons']).toBe(false)
    }
  })

  it('unavailable when port is missing and error when port rejects', async () => {
    const { registry, makeCtx } = setup()
    const ctx = makeCtx()

    expect(await registry.call('recall', { query: 'x' }, ctx, { callId: 'c-u1', source: 'model' })).toMatchObject({
      ok: false,
      kind: 'unavailable'
    })
    expect(await registry.call('web_search', { query: 'x' }, ctx, { callId: 'c-u2', source: 'model' })).toMatchObject({
      ok: false,
      kind: 'unavailable'
    })
    expect(
      await registry.call('read_page', { url: 'https://example.com' }, ctx, { callId: 'c-u3', source: 'model' })
    ).toMatchObject({ ok: false, kind: 'unavailable' })
    expect(
      await registry.call('read_post', { url: 'https://x.com/a/status/1' }, ctx, { callId: 'c-u4', source: 'model' })
    ).toMatchObject({ ok: false, kind: 'unavailable' })
    expect(await registry.call('send_photo', { query: 'x' }, ctx, { callId: 'c-u5', source: 'model' })).toMatchObject({
      ok: false,
      kind: 'unavailable'
    })

    const throwingSetup = setup({
      search: {
        async search() {
          throw new Error('upstream 500')
        }
      },
      page: {
        async read() {
          throw new Error('read 500')
        },
        async download() {
          throw new Error('dl 500')
        }
      },
      post: {
        async read() {
          throw new Error('post 500')
        }
      }
    })
    const errCtx = throwingSetup.makeCtx()
    expect(
      await throwingSetup.registry.call('web_search', { query: 'x' }, errCtx, { callId: 'c-e1', source: 'model' })
    ).toMatchObject({ ok: false, kind: 'error' })
    expect(
      await throwingSetup.registry.call('read_page', { url: 'https://example.com' }, errCtx, {
        callId: 'c-e2',
        source: 'model'
      })
    ).toMatchObject({ ok: false, kind: 'error' })
    expect(
      await throwingSetup.registry.call('read_post', { url: 'https://x.com/a/status/1' }, errCtx, {
        callId: 'c-e3',
        source: 'model'
      })
    ).toMatchObject({ ok: false, kind: 'error' })
  })

  it('the model cannot pick the format', async () => {
    const noteRenderer = vi.fn(async () => ({ pdf: Buffer.from('%PDF-note'), pages: 1 }))
    const { storage, registry, makeCtx } = setup({ noteRenderer })
    const ctx = makeCtx()

    const offered = registry.offered(ctx).find((tool) => tool.schema.name === 'make_report')
    expect(offered).toBeDefined()
    const params = offered?.schema.parameters as {
      additionalProperties?: unknown
      properties?: Record<string, unknown>
    }
    expect(params.additionalProperties).toBe(false)
    expect(params.properties).not.toHaveProperty('format')

    const res = await registry.call(
      'make_report',
      { title: 'Weekly Plan', sections: [{ heading: 'Tasks', body: 'Ship tests.' }], format: 'markdown' },
      ctx,
      { callId: 'c-fmt-refuse', source: 'model' }
    )
    expect(res).toMatchObject({ ok: false, kind: 'invalid' })
    expect(noteRenderer).not.toHaveBeenCalled()
    expect(storage.read((db) => db.prepare('SELECT count(*) FROM file').pluck().get())).toBe(0)
  })

  it('a NoteDocument over its limits is refused', async () => {
    const noteRenderer = vi.fn(async () => ({ pdf: Buffer.from('%PDF-note'), pages: 1 }))
    const { storage, registry, makeCtx } = setup({ noteRenderer })
    const ctx = makeCtx()

    const invalidDocs: unknown[] = [
      { title: 'abc', sections: [{ heading: 'One', body: 'Body text.' }] },
      { title: 't'.repeat(121), sections: [{ heading: 'One', body: 'Body text.' }] },
      { title: 'Valid Title', sections: [] },
      {
        title: 'Valid Title',
        sections: Array.from({ length: 9 }, (_, i) => ({ heading: `Section ${i + 1}`, body: 'Body text.' }))
      },
      { title: 'Valid Title', sections: [{ heading: '   ', body: 'Body text.' }] },
      { title: 'Valid Title', sections: [{ heading: 'h'.repeat(81), body: 'Body text.' }] },
      { title: 'Valid Title', sections: [{ heading: 'One', body: '   ' }] },
      { title: 'Valid Title', sections: [{ heading: 'One', body: 'b'.repeat(4001) }] }
    ]

    for (let i = 0; i < invalidDocs.length; i += 1) {
      expect(noteDocumentSchema.safeParse(invalidDocs[i]).success).toBe(false)
      const res = await registry.call('make_report', invalidDocs[i], ctx, {
        callId: `c-limit-${i}`,
        source: 'model'
      })
      expect(res).toMatchObject({ ok: false, kind: 'invalid' })
    }
    expect(noteRenderer).not.toHaveBeenCalled()
    expect(storage.read((db) => db.prepare('SELECT count(*) FROM file').pluck().get())).toBe(0)
  })

  it('passes chat report.format profile to noteRenderer, ignores partial words like amd, and maps render errors', async () => {
    const noteRenderer = vi.fn(async () => ({ pdf: Buffer.from('%PDF-1.4\n'), pages: 1 }))
    const { storage, filesDir, registry, makeCtx } = setup({ noteRenderer })
    const ctx = makeCtx()
    setSetting(storage, {
      level: 'chat',
      scope: ctx.chat.chatId,
      key: 'report.format',
      value: {
        pageSize: 'Letter',
        accent: '#1f4e79',
        fontSize: 11,
        cover: false,
        sourcesAppendix: false,
        header: 'Team'
      },
      actor: 'test'
    })
    ctx.settings = resolveSettings(storage, ctx.chat)
    ctx.messageText = '/doc amd and markdowns'

    const doc: NoteDocument = {
      title: 'Chip Notes',
      sections: [{ heading: 'Summary', body: 'Whole-word matching only.' }]
    }
    const okRes = await registry.call('make_report', doc, ctx, { callId: 'c-prof', source: 'command' })
    expect(okRes).toMatchObject({
      ok: true,
      data: { created: true, format: 'pdf' },
      receipt: { kind: 'report.created' }
    })
    expect(noteRenderer).toHaveBeenCalledWith(doc, {
      pageSize: 'Letter',
      accent: '#1f4e79',
      fontSize: 11,
      cover: false,
      sourcesAppendix: false,
      header: 'Team'
    })
    if (okRes.ok) {
      const attachment = okRes.receipt?.state?.attachment as string
      expect(attachment).toMatch(/\.pdf$/)
      expect(readFileSync(join(filesDir, attachment)).toString('ascii')).toBe('%PDF-1.4\n')
    }

    noteRenderer.mockRejectedValueOnce(new RenderError('timeout', 'typst render timed out'))
    expect(await registry.call('make_report', doc, ctx, { callId: 'c-timeout', source: 'command' })).toMatchObject({
      ok: false,
      kind: 'timeout'
    })

    noteRenderer.mockRejectedValueOnce(new RenderError('too_large', 'rendered pdf exceeds maxPages'))
    expect(await registry.call('make_report', doc, ctx, { callId: 'c-large', source: 'command' })).toMatchObject({
      ok: false,
      kind: 'error'
    })
  })
})

describe('isForbiddenUrl and createFetchPagePort', () => {
  it('forbids localhost, private/link-local/CGNAT IPv4 and IPv6, credentials and non-http protocols', () => {
    const forbidden = [
      'not a url',
      'file:///etc/passwd',
      'ftp://example.com/a',
      'https://user:pass@example.com/',
      'http://localhost/',
      'http://app.localhost/',
      'http://printer.local/',
      'http://metadata.internal/',
      'http://0.0.0.0/',
      'http://10.1.2.3/',
      'http://100.64.0.1/',
      'http://127.0.0.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://172.16.0.1/',
      'http://192.168.1.1/',
      'http://[::]/',
      'http://[::1]/',
      'http://[fc00::1]/',
      'http://[fd12:3456::1]/',
      'http://[fe80::1]/',
      'http://[::ffff:127.0.0.1]/',
      'http://[::ffff:10.0.0.1]/'
    ]
    for (const url of forbidden) {
      expect(isForbiddenUrl(url), url).toBe(true)
    }

    const allowed = ['https://example.com/', 'http://93.184.216.34/', 'https://[2606:4700:4700::1111]/']
    for (const url of allowed) {
      expect(isForbiddenUrl(url), url).toBe(false)
    }
  })

  it('createFetchPagePort converts HTML to text, enforces size limit, and refuses forbidden DNS or redirects', async () => {
    const html =
      '<html><head><title>Hello &amp; World</title><style>body{color:red}</style></head>' +
      '<body><script>alert(1)</script><noscript>no</noscript><svg><path/></svg><p>First &lt;line&gt;</p><p>Second</p></body></html>'

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }))
    )

    const port = createFetchPagePort({ lookup: async () => ['93.184.216.34'] })
    const res = await port.read('https://example.com/', new AbortController().signal)
    expect(res).toEqual({ title: 'Hello & World', text: 'First <line> Second' })

    const smallPort = createFetchPagePort({ maxBytes: 10, lookup: async () => ['93.184.216.34'] })
    await expect(smallPort.read('https://example.com/', new AbortController().signal)).rejects.toThrow(/size limit/)

    const privateDnsPort = createFetchPagePort({ lookup: async () => ['10.0.0.5'] })
    await expect(privateDnsPort.read('https://example.com/', new AbortController().signal)).rejects.toThrow(/forbidden/)

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret' } }))
    )
    await expect(port.read('https://example.com/redir', new AbortController().signal)).rejects.toThrow(/forbidden/)
  })
})
