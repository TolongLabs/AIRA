import { describe, expect, it, vi } from 'vitest'
import { loadPack } from '../../src/character/loader.js'
import { createLogger } from '../../src/records/logger.js'
import { createRedactor } from '../../src/records/redact.js'
import { ensureChat, setChatStatus } from '../../src/settings/chats.js'
import { resolveSettings } from '../../src/settings/settings.js'
import { findSocialPostTargets, parseSocialPostUrl, recognitionOnlyName } from '../../src/social/urls.js'
import type { Storage } from '../../src/storage/database.js'
import { openTurn, receiveInbound } from '../../src/storage/turns.js'
import { readPageTool, readPostTool } from '../../src/tools/core/web.js'
import { createToolRegistry } from '../../src/tools/registry.js'
import type { ToolContext } from '../../src/tools/types.js'
import { createTurnSources } from '../../src/turn/sources.js'
import type { TurnContext } from '../../src/turn/types.js'
import { tmpDir, tmpStorage } from '../support/tmp.js'

const pack = loadPack('characters/example', 'repository')

const VIDEO_ID = '1234567890123456789'
const SHARE_VIDEO_ID = '9876543210987654321'
const DIRECT_VIDEO = `https://www.douyin.com/video/${VIDEO_ID}`
const DIRECT_SHARE_VIDEO = `https://www.iesdouyin.com/share/video/${SHARE_VIDEO_ID}`
const SHORT_CODE = 'AbC123xYz09'
const SHORT_URL = `https://v.douyin.com/${SHORT_CODE}`
const MIRROR_URL = 'https://www.douyin.com/example/status/1234567890123456789'
const X_URL = 'https://x.com/example/status/1234567890123456789'

let seq = 0

function makeTurnContext(storage: Storage): TurnContext {
  seq += 1
  const chat = ensureChat(storage, { waId: `fake-chat-douyin-${seq}`, type: 'group' })
  setChatStatus(storage, { chatId: chat.chatId, status: 'active', actor: 'test' })
  const senderId = `subj-douyin-${seq}`
  const mid = `mid-douyin-${seq}`
  const turnId = `turn-douyin-${seq}`
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

function makeToolContext(turn: TurnContext, callId: string): ToolContext {
  return {
    ...turn,
    callId,
    signal: new AbortController().signal,
    now: () => new Date('2026-11-22T00:00:00.000Z'),
    commit: () => {
      throw new Error('commit must not be called')
    }
  }
}

function expectRefusedDouyin(result: { ok: boolean; kind?: string; reason?: string }): void {
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('expected a refusal')
  expect(result.kind).toBe('refused')
  expect(result.reason).toContain('Douyin')
}

describe('douyin recognition', () => {
  it('read_page refuses a recognised video by URL and source without dispatch', async () => {
    const storage = tmpStorage()
    const turn = makeTurnContext(storage)
    const seen = turn.sources.add(DIRECT_VIDEO, 'message')
    if (seen === undefined) throw new Error('source was not registered')
    const pageRead = vi.fn(async () => ({ title: 'page', text: 'body' }))
    const download = vi.fn(async () => {
      throw new Error('download must not be called')
    })
    const tool = readPageTool({ filesDir: tmpDir(), page: { read: pageRead, download } })
    const context = makeToolContext(turn, `${turn.turnId}-page`)

    expectRefusedDouyin(await tool.handler({ url: DIRECT_VIDEO }, context))
    expectRefusedDouyin(await tool.handler({ source: seen.id }, context))
    expect(pageRead).not.toHaveBeenCalled()
    expect(download).not.toHaveBeenCalled()
  })

  it('read_post refuses recognised share-video and short links by URL and source without dispatch', async () => {
    const storage = tmpStorage()
    const turn = makeTurnContext(storage)
    const shareSeen = turn.sources.add(DIRECT_SHARE_VIDEO, 'message')
    const shortSeen = turn.sources.add(SHORT_URL, 'message')
    if (shareSeen === undefined || shortSeen === undefined) throw new Error('source was not registered')
    const postRead = vi.fn(async () => {
      throw new Error('post reader must not be called')
    })
    const tool = readPostTool({ filesDir: tmpDir(), post: { read: postRead } })
    const context = makeToolContext(turn, `${turn.turnId}-post`)

    expectRefusedDouyin(await tool.handler({ url: DIRECT_SHARE_VIDEO }, context))
    expectRefusedDouyin(await tool.handler({ source: shortSeen.id }, context))
    expect(postRead).not.toHaveBeenCalled()
  })

  it('recognises the two verified video routes, rejecting nearby non-posts', () => {
    expect(recognitionOnlyName(DIRECT_VIDEO)).toBe('Douyin')
    expect(recognitionOnlyName(DIRECT_SHARE_VIDEO)).toBe('Douyin')

    expect(recognitionOnlyName('https://www.douyin.com/video/123456789012345678')).toBeNull()
    expect(recognitionOnlyName('https://www.douyin.com/video/12345678901234567890')).toBeNull()
    expect(recognitionOnlyName('https://www.douyin.com/video/abc123')).toBeNull()
    expect(recognitionOnlyName('https://www.douyin.com/video/')).toBeNull()
    expect(recognitionOnlyName('https://www.douyin.com/user/synthetic123')).toBeNull()
    expect(recognitionOnlyName(`https://www.iesdouyin.com/share/video/${VIDEO_ID.slice(0, 18)}`)).toBeNull()
    expect(recognitionOnlyName('https://www.iesdouyin.com/share/video/abc123')).toBeNull()
  })

  it('recognises the single-code short shape, rejecting the bare short root', () => {
    expect(recognitionOnlyName(SHORT_URL)).toBe('Douyin')

    expect(recognitionOnlyName('https://v.douyin.com/')).toBeNull()
    expect(recognitionOnlyName('https://www.douyin.com/explore/')).toBeNull()
  })

  it('an owned-host path shaped like another platform selects nothing; a following valid post still does', () => {
    expect(recognitionOnlyName(DIRECT_VIDEO)).toBe('Douyin')

    expect(recognitionOnlyName(MIRROR_URL)).toBeNull()
    expect(parseSocialPostUrl(MIRROR_URL)).toBeNull()
    const targets = findSocialPostTargets(`${MIRROR_URL} ${X_URL}`)
    expect(targets.map((target) => target.platform)).toEqual(['x'])
    expect(findSocialPostTargets(DIRECT_VIDEO)).toEqual([])
    expect(findSocialPostTargets(SHORT_URL)).toEqual([])
  })

  it('keeps exact recognition on owned hosts; provider subdomains select no platform', () => {
    expect(recognitionOnlyName(DIRECT_VIDEO)).toBe('Douyin')
    expect(recognitionOnlyName(DIRECT_SHARE_VIDEO)).toBe('Douyin')
    expect(recognitionOnlyName(SHORT_URL)).toBe('Douyin')

    for (const host of ['m.douyin.com', 'm.iesdouyin.com', 'www.v.douyin.com']) {
      const url = `https://${host}/example/status/1234567890123456789`
      expect(recognitionOnlyName(url)).toBeNull()
      expect(parseSocialPostUrl(url)).toBeNull()
      expect(findSocialPostTargets(`${url} ${X_URL}`).map((target) => target.platform)).toEqual(['x'])
    }
  })

  it('registry refuses direct and source reads on both tools with a Douyin outcome and code-only rows', async () => {
    const storage = tmpStorage()
    const turn = makeTurnContext(storage)
    const videoSeen = turn.sources.add(DIRECT_VIDEO, 'message')
    const shareSeen = turn.sources.add(DIRECT_SHARE_VIDEO, 'message')
    const shortSeen = turn.sources.add(SHORT_URL, 'message')
    if (videoSeen === undefined || shareSeen === undefined || shortSeen === undefined)
      throw new Error('source was not registered')
    const pageRead = vi.fn(async () => ({ title: 'page', text: 'body' }))
    const download = vi.fn(async () => {
      throw new Error('download must not be called')
    })
    const postRead = vi.fn(async () => {
      throw new Error('post reader must not be called')
    })
    const pageTool = readPageTool({ filesDir: tmpDir(), page: { read: pageRead, download } })
    const postTool = readPostTool({ filesDir: tmpDir(), post: { read: postRead } })
    const registry = createToolRegistry({
      storage,
      config: { tools: { defaultTimeoutMs: 1000 } },
      logger: createLogger({ level: 'error', module: 'tools-test', sink: () => {} }),
      redactor: createRedactor()
    })
    registry.register(pageTool)
    registry.register(postTool)
    const offered = registry.offered(turn)
    expect(offered.map((tool) => tool.schema.name).sort()).toEqual(['read_page', 'read_post'])
    const calls: { tool: string; args: Record<string, string> }[] = [
      { tool: 'read_page', args: { url: DIRECT_VIDEO } },
      { tool: 'read_page', args: { source: shareSeen.id } },
      { tool: 'read_post', args: { url: SHORT_URL } },
      { tool: 'read_post', args: { source: shortSeen.id } }
    ]
    for (const [index, { tool, args }] of calls.entries()) {
      const offeredTool = offered.find((entry) => entry.schema.name === tool)
      if (!offeredTool) throw new Error(`${tool} was not offered`)
      const response = await offeredTool.call(args, `${turn.turnId}-${tool}-${index}`, new AbortController().signal)
      expect(JSON.parse(response.content)).toMatchObject({ ok: false, outcome: expect.stringContaining('Douyin') })
    }
    const messages = storage.read((db) =>
      db.prepare('SELECT message FROM failure WHERE turn_id = ? ORDER BY message').pluck().all(turn.turnId)
    )
    expect(messages).toEqual([
      'read_page refused (douyin_recognition_only)',
      'read_page refused (douyin_recognition_only)',
      'read_post refused (douyin_recognition_only)',
      'read_post refused (douyin_recognition_only)'
    ])
    expect(postRead).not.toHaveBeenCalled()
    expect(pageRead).not.toHaveBeenCalled()
    expect(download).not.toHaveBeenCalled()
  })
})
