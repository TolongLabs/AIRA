import { describe, expect, it } from 'vitest'
import { loadPack } from '../../src/character/loader.js'
import { fourthWallBreak } from '../../src/format/fourth-wall.js'
import { createLogger } from '../../src/records/logger.js'
import { createRedactor } from '../../src/records/redact.js'
import { ensureChat, setChatStatus } from '../../src/settings/chats.js'
import { resolveSettings, setSetting } from '../../src/settings/settings.js'
import type { Storage } from '../../src/storage/database.js'
import { openTurn, receiveInbound } from '../../src/storage/turns.js'
import { registerCoreTools } from '../../src/tools/core/index.js'
import { registerLessonTools } from '../../src/tools/lessons/index.js'
import { outcomeOf } from '../../src/tools/outcomes.js'
import { registerOwnerTools } from '../../src/tools/owner/index.js'
import type { MemoryPort, PagePort, PostPort, SearchPort, ToolPorts } from '../../src/tools/ports.js'
import { createToolRegistry, type ToolRegistry } from '../../src/tools/registry.js'
import { createTurnSources } from '../../src/turn/sources.js'
import type { TurnContext } from '../../src/turn/types.js'
import { tmpDir, tmpStorage } from '../support/tmp.js'

// The turn's sources and the state-change rule, through the registry with the core tools and mock ports
// (docs/trd/tools.md#turn-sources).

const pack = loadPack('characters/example', 'repository')
const CANNOT_CHANGE = 'You will not change anything based on that page.'
const NOT_SEEN = 'You only open links that came up in this chat or in your own search.'

interface Fakes {
  pages: string[]
  posts: string[]
  notes: string[]
  reminders: number
}

function setup(overrides: Partial<ToolPorts> = {}, allTools = false) {
  const storage = tmpStorage()
  const fakes: Fakes = { pages: [], posts: [], notes: [], reminders: 0 }
  const memory: MemoryPort = {
    recall: () => [],
    history: () => [],
    async checkNote() {
      return { ok: true as const }
    },
    note(_db, input) {
      fakes.notes.push(input.text)
      return { itemId: `fact_${fakes.notes.length}`, effect: 'added' }
    },
    forget: () => false,
    forgetPending() {},
    lingo: () => 'lingo_1'
  }
  const search: SearchPort = {
    async search() {
      return [{ title: 'Found', url: 'https://example.com/found', snippet: 'snippet' }]
    },
    async images() {
      return []
    }
  }
  const page: PagePort = {
    async read(url) {
      fakes.pages.push(url)
      return { title: 'Title', text: 'Body' }
    },
    async download() {
      return { data: Buffer.from(''), contentType: 'text/plain' }
    }
  }
  const post: PostPort = {
    async read(url) {
      fakes.posts.push(url)
      return { author: 'author', text: 'Post', media: [], canonicalUrl: 'https://x.com/author/status/9' }
    }
  }
  const registry = createToolRegistry({
    storage,
    config: { tools: { defaultTimeoutMs: 500 } },
    logger: createLogger({ level: 'error', module: 'turn-sources-test', sink: () => {} }),
    redactor: createRedactor()
  })
  const ports: ToolPorts = {
    memory,
    search,
    page,
    post,
    schedule: {
      sync() {
        fakes.reminders += 1
      }
    },
    filesDir: tmpDir('aira-files-'),
    ...overrides
  }
  registerCoreTools(
    registry,
    ports,
    allTools
      ? {
          feedback: { formUrl: '', referenceEntryId: '', refTtlHours: 168 },
          identify: {
            port: {
              async byFile() {
                return []
              },
              async byUrl() {
                return []
              }
            },
            gatewayDirs: [],
            maxUploadBytes: 500_000,
            timeoutMs: 500
          }
        }
      : undefined
  )
  if (allTools) {
    registerLessonTools(registry, ports)
    registerOwnerTools(registry, {
      marketsConfig: 'markets.yml',
      claudeProjectsDir: 'projects',
      noticeRoutesFile: 'routes.json',
      timeoutMs: 500
    })
  }
  return { storage, registry, fakes, makeCtx: () => makeContext(storage) }
}

let seq = 0
function makeContext(storage: Storage): TurnContext {
  seq += 1
  const chat = ensureChat(storage, { waId: `turn-sources-chat-${seq}`, type: 'group' })
  setChatStatus(storage, { chatId: chat.chatId, status: 'active', actor: 'test' })
  const senderId = `member-${seq}`
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
    deadline: Date.now() + 10_000,
    sources: createTurnSources()
  }
}

function enable(storage: Storage, context: TurnContext, key: string): void {
  setSetting(storage, { level: 'chat', scope: context.chat.chatId, key, value: true, actor: 'test' })
  context.settings = resolveSettings(storage, context.chat)
}

const call = (registry: ToolRegistry, name: string, args: unknown, context: TurnContext, callId: string) =>
  registry.call(name, args, context, { callId, source: 'model' })

const FUTURE_REMINDER = { text: 'call back', dueAt: '2099-01-01T00:00:00Z' }

describe('reads open only what the turn has seen', () => {
  it('opens a link the member sent, and the page is fetched once', async () => {
    const { registry, fakes, makeCtx } = setup()
    const ctx = makeCtx()
    ctx.sources.addText('look at https://example.com/article', 'message')
    const result = await call(registry, 'read_page', { url: 'https://example.com/article' }, ctx, 'c1')
    expect(result).toEqual({ ok: true, data: { title: 'Title', text: 'Body' } })
    expect(fakes.pages).toEqual(['https://example.com/article'])
  })

  it('refuses a link the turn never saw before any fetch, with the plain outcome', async () => {
    const { registry, fakes, makeCtx, storage } = setup()
    const ctx = makeCtx()
    const offered = registry.offered(ctx).find((tool) => tool.schema.name === 'read_page')
    const result = await offered?.call({ url: 'https://example.com/never-shown' }, 'c2', new AbortController().signal)
    expect(result).toEqual({
      ok: false,
      content: JSON.stringify({ ok: false, outcome: NOT_SEEN })
    })
    expect(fakes.pages).toEqual([])
    expect(
      storage.read((db) => db.prepare('SELECT outcome FROM tool_call WHERE turn_id = ?').pluck().get(ctx.turnId))
    ).toBe('refused')
  })

  it('opens a link by the source id the turn gave it, and refuses an id it never gave', async () => {
    const { registry, fakes, makeCtx } = setup()
    const ctx = makeCtx()
    ctx.sources.addText('https://example.com/a https://example.com/b', 'message')
    expect(await call(registry, 'read_page', { source: 's2' }, ctx, 'c3')).toMatchObject({ ok: true })
    expect(fakes.pages).toEqual(['https://example.com/b'])
    expect(await call(registry, 'read_page', { source: 's9' }, ctx, 'c4')).toEqual({
      ok: false,
      kind: 'refused',
      reason: 'address not seen in this turn',
      code: 'unseen_link'
    })
    expect(fakes.pages).toEqual(['https://example.com/b'])
  })

  it('keeps a trimmed source id read in takeSources when the raw argument has surrounding spaces', async () => {
    const { registry, fakes, makeCtx } = setup()
    const ctx = makeCtx()
    ctx.sources.addText('https://example.com/a', 'message')
    expect(await call(registry, 'read_page', { source: ' s1 ' }, ctx, 'c-trim')).toMatchObject({ ok: true })
    expect(fakes.pages).toEqual(['https://example.com/a'])
    expect(registry.takeSources(ctx.turnId)).toEqual([
      { url: 'https://example.com/a', lookup: 'message', kind: 'read' }
    ])
  })

  it('needs exactly one of url or source', async () => {
    const { registry, fakes, makeCtx } = setup()
    const ctx = makeCtx()
    ctx.sources.addText('https://example.com/a', 'message')
    for (const args of [{}, { url: 'https://example.com/a', source: 's1' }]) {
      const result = await call(registry, 'read_page', args, ctx, `c-${JSON.stringify(args)}`)
      expect(result).toMatchObject({ ok: false, kind: 'invalid', code: 'schema' })
    }
    expect(fakes.pages).toEqual([])
  })

  it('opens a link a web search returned, and the footer names it as found and read', async () => {
    const { registry, fakes, makeCtx } = setup()
    const ctx = makeCtx()
    expect(await call(registry, 'read_page', { url: 'https://example.com/found' }, ctx, 'c5')).toMatchObject({
      ok: false,
      code: 'unseen_link'
    })
    await call(registry, 'web_search', { query: 'something' }, ctx, 'c6')
    expect(await call(registry, 'read_page', { url: 'https://example.com/found' }, ctx, 'c7')).toMatchObject({
      ok: true
    })
    expect(fakes.pages).toEqual(['https://example.com/found'])
    expect(registry.takeSources(ctx.turnId)).toEqual([
      { url: 'https://example.com/found', lookup: 'search:c6', kind: 'read' },
      { url: 'https://example.com/found', lookup: 'search:c6', kind: 'found' }
    ])
  })

  it('gives each successful search a distinct lookup id, keeps first producers, and keeps per-search call ids on footer uses', async () => {
    let round = 0
    const { registry, makeCtx } = setup({
      search: {
        async search() {
          round += 1
          if (round === 1) {
            return [
              { title: 'One', url: 'https://one.example/a', snippet: 's1' },
              { title: 'Two', url: 'https://two.example/b', snippet: 's2' }
            ]
          }
          if (round === 2) {
            return [
              { title: 'One Again', url: 'https://ONE.example/a?utm_source=dup', snippet: 'dup' },
              { title: 'Msg', url: 'https://msg.example/seen', snippet: 'seen' },
              { title: 'Three', url: 'https://three.example/c', snippet: 's3' }
            ]
          }
          throw new Error('upstream down')
        }
      }
    })
    const ctx = makeCtx()
    ctx.sources.addText('https://msg.example/seen', 'message')

    expect(await call(registry, 'web_search', { query: 'first' }, ctx, 'c-s1')).toMatchObject({ ok: true })
    expect(await call(registry, 'web_search', { query: 'second' }, ctx, 'c-s2')).toMatchObject({ ok: true })
    expect(await call(registry, 'web_search', { query: 'third' }, ctx, 'c-s3')).toMatchObject({ ok: false })

    const fromFirst = ctx.sources.find({ url: 'https://one.example/a' })
    const fromMsg = ctx.sources.find({ url: 'https://msg.example/seen' })
    const fromSecond = ctx.sources.find({ url: 'https://three.example/c' })
    expect(fromFirst?.lookup).toBe('search:c-s1')
    expect(fromMsg?.lookup).toBe('message')
    expect(fromSecond?.lookup).toBe('search:c-s2')
    expect(fromFirst?.lookup).not.toBe(fromSecond?.lookup)

    expect(await call(registry, 'read_page', { source: fromSecond?.id }, ctx, 'c-read')).toMatchObject({ ok: true })
    expect(registry.takeSources(ctx.turnId)).toEqual([
      { url: 'https://three.example/c', lookup: 'search:c-s2', kind: 'read' },
      { url: 'https://one.example/a', lookup: 'search:c-s1', kind: 'found' },
      { url: 'https://two.example/b', lookup: 'search:c-s1', kind: 'found' },
      { url: 'https://ONE.example/a?utm_source=dup', lookup: 'search:c-s2', kind: 'found' },
      { url: 'https://msg.example/seen', lookup: 'search:c-s2', kind: 'found' },
      { url: 'https://three.example/c', lookup: 'search:c-s2', kind: 'found' }
    ])
  })

  it('registers the canonical URL of a resolved share link, so the turn may open it', async () => {
    const { registry, fakes, makeCtx } = setup()
    const ctx = makeCtx()
    ctx.sources.addText('https://x.com/share/abc', 'message')
    expect(await call(registry, 'read_post', { url: 'https://x.com/share/abc' }, ctx, 'c8')).toMatchObject({ ok: true })
    expect(await call(registry, 'read_page', { url: 'https://x.com/author/status/9' }, ctx, 'c9')).toMatchObject({
      ok: true
    })
    expect(fakes.posts).toEqual(['https://x.com/share/abc'])
    expect(fakes.pages).toEqual(['https://x.com/author/status/9'])
  })
})

describe('a page or post read withdraws state changes for the rest of the turn', () => {
  it('refuses note and reminder_set after a read, with the plain outcome, and writes nothing', async () => {
    const { registry, fakes, makeCtx, storage } = setup()
    const ctx = makeCtx()
    enable(storage, ctx, 'features.reminders')
    ctx.sources.addText('https://example.com/article', 'message')
    expect(await call(registry, 'read_page', { url: 'https://example.com/article' }, ctx, 'r1')).toMatchObject({
      ok: true
    })

    const note = await call(registry, 'note', { text: 'likes green tea' }, ctx, 'n1')
    expect(note).toEqual({ ok: false, kind: 'refused', reason: 'state change after a page read', code: 'after_read' })
    expect(outcomeOf(note as { kind: 'refused'; reason: string; code: 'after_read' })).toBe(CANNOT_CHANGE)
    const reminder = await call(registry, 'reminder_set', FUTURE_REMINDER, ctx, 'rm1')
    expect(reminder).toMatchObject({ ok: false, code: 'after_read' })

    expect(fakes.notes).toEqual([])
    expect(fakes.reminders).toBe(0)
  })

  it('still runs the tool a member named in a command, and only when kind is command and commandTool matches', async () => {
    const { registry, fakes, makeCtx, storage } = setup()
    const ctx = makeCtx()
    enable(storage, ctx, 'features.reminders')
    ctx.sources.addText('https://example.com/article', 'message')
    await call(registry, 'read_page', { url: 'https://example.com/article' }, ctx, 'r2')

    ctx.commandTool = 'note'
    const notCommandKind = await call(registry, 'note', { text: 'not a command turn' }, ctx, 'n-reply')
    expect(notCommandKind).toMatchObject({ ok: false, code: 'after_read' })

    ctx.kind = 'command'
    const remembered = await registry.call('note', { text: 'likes green tea' }, ctx, {
      callId: 'n2',
      source: 'command'
    })
    expect(remembered).toMatchObject({ ok: true })
    expect(fakes.notes).toEqual(['likes green tea'])

    const unnamed = await registry.call('reminder_set', FUTURE_REMINDER, ctx, { callId: 'rm2', source: 'command' })
    expect(unnamed).toMatchObject({ ok: false, code: 'after_read' })
    expect(fakes.reminders).toBe(0)
  })

  it('blocks a core mutating tool offered before the read when executed after it', async () => {
    const { registry, fakes, makeCtx, storage } = setup()
    const ctx = makeCtx()
    enable(storage, ctx, 'features.reminders')
    ctx.sources.addText('https://example.com/article', 'message')
    const offeredBefore = registry.offered(ctx)
    const noteOffer = offeredBefore.find((tool) => tool.schema.name === 'note')
    const reminderOffer = offeredBefore.find((tool) => tool.schema.name === 'reminder_set')

    await call(registry, 'read_page', { url: 'https://example.com/article' }, ctx, 'r-offer')

    const noteRes = await noteOffer?.call({ text: 'after read' }, 'n-offer', new AbortController().signal)
    expect(noteRes).toEqual({
      ok: false,
      content: JSON.stringify({ ok: false, outcome: CANNOT_CHANGE })
    })
    const remRes = await reminderOffer?.call(FUTURE_REMINDER, 'rm-offer', new AbortController().signal)
    expect(remRes).toEqual({
      ok: false,
      content: JSON.stringify({ ok: false, outcome: CANNOT_CHANGE })
    })
    expect(fakes.notes).toEqual([])
    expect(fakes.reminders).toBe(0)
  })

  it('does not restrict unclassified external tools after a page read', async () => {
    const { registry, makeCtx, storage } = setup()
    const ctx = makeCtx()
    registry.registerExternal({
      name: 'example.lookup',
      description: 'External lookup',
      parameters: { type: 'object' },
      feature: 'mcp.example',
      chats: [ctx.chat.chatId],
      timeoutMs: 500,
      invoke: async () => 'external result'
    })
    enable(storage, ctx, 'mcp.example')
    ctx.sources.addText('https://example.com/article', 'message')

    const offered = registry.offered(ctx)
    await call(registry, 'read_page', { url: 'https://example.com/article' }, ctx, 'r-ext')

    const extOffered = offered.find((tool) => tool.schema.name === 'example__lookup')
    expect(extOffered?.available?.()).not.toBe(false)
    expect(await call(registry, 'example.lookup', {}, ctx, 'ext-1')).toEqual({
      ok: true,
      data: { untrusted: true, source: 'example.lookup', text: 'external result' }
    })
  })

  it('makes a state change that starts while a read runs wait for it, then refuses it', async () => {
    const { registry, fakes, makeCtx, storage } = setup({
      page: {
        async read(url) {
          await new Promise((resolve) => setTimeout(resolve, 30))
          fakes.pages.push(url)
          return { title: 'Title', text: 'Body' }
        },
        async download() {
          return { data: Buffer.from(''), contentType: 'text/plain' }
        }
      }
    })
    const ctx = makeCtx()
    enable(storage, ctx, 'features.reminders')
    ctx.sources.addText('https://example.com/article', 'message')

    const [read, note] = await Promise.all([
      call(registry, 'read_page', { url: 'https://example.com/article' }, ctx, 'r3'),
      call(registry, 'note', { text: 'raced' }, ctx, 'n3')
    ])
    expect(read).toMatchObject({ ok: true })
    expect(note).toMatchObject({ ok: false, code: 'after_read' })
    expect(fakes.notes).toEqual([])
  })

  it('withdraws state-changing tools from later model steps, and keeps the readers offered', async () => {
    const { registry, makeCtx, storage } = setup()
    const ctx = makeCtx()
    enable(storage, ctx, 'features.reminders')
    ctx.sources.addText('https://example.com/article', 'message')
    const offered = registry.offered(ctx)
    const availability = (name: string) => offered.find((tool) => tool.schema.name === name)?.available?.()
    expect(availability('note')).toBe(true)

    await call(registry, 'read_page', { url: 'https://example.com/article' }, ctx, 'r4')
    expect(availability('note')).toBe(false)
    expect(availability('reminder_set')).toBe(false)
    expect(availability('read_page')).toBe(true)
    expect(availability('web_search')).toBe(true)
  })

  it('keeps a turn that has only searched free to change state', async () => {
    const { registry, fakes, makeCtx } = setup()
    const ctx = makeCtx()
    await call(registry, 'web_search', { query: 'tea' }, ctx, 's1')
    expect(await call(registry, 'note', { text: 'after a search' }, ctx, 'n4')).toMatchObject({ ok: true })
    expect(fakes.notes).toEqual(['after a search'])
  })

  it('keeps both F1 refusal payloads (unseen read and state change after read) clear of fourthWallBreak across current tool names', async () => {
    const { registry, makeCtx } = setup({}, true)
    const ctx = makeCtx()
    ctx.sources.addText('https://example.com/article', 'message')
    const offered = registry.offered(ctx)
    const readPage = offered.find((tool) => tool.schema.name === 'read_page')
    const note = offered.find((tool) => tool.schema.name === 'note')
    const signal = new AbortController().signal

    const unseen = await readPage?.call({ url: 'https://example.com/never-shown' }, 'c-fw-unseen', signal)
    expect(unseen).toEqual({
      ok: false,
      content: JSON.stringify({ ok: false, outcome: NOT_SEEN })
    })

    await readPage?.call({ url: 'https://example.com/article' }, 'c-fw-read', signal)
    const afterRead = await note?.call({ text: 'after read' }, 'c-fw-note', signal)
    expect(afterRead).toEqual({
      ok: false,
      content: JSON.stringify({ ok: false, outcome: CANNOT_CHANGE })
    })

    const toolNames = registry.toolNames()
    expect(toolNames).toEqual(
      expect.arrayContaining([
        'read_page',
        'read_post',
        'note',
        'identify_image',
        'lyrics_search',
        'market_quote',
        'claude_sessions'
      ])
    )
    for (const payload of [unseen!.content, afterRead!.content]) {
      const { outcome } = JSON.parse(payload) as { ok: false; outcome: string }
      expect(fourthWallBreak(payload, toolNames), payload).toBeUndefined()
      expect(fourthWallBreak(outcome, toolNames), outcome).toBeUndefined()
    }
  })
})
