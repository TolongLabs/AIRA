import { describe, expect, it, vi } from 'vitest'
import { loadPack } from '../../src/character/loader.js'
import { ensureChat, setChatStatus } from '../../src/settings/chats.js'
import { resolveSettings } from '../../src/settings/settings.js'
import { findSocialPostTargets, parseSocialPostUrl, recognitionOnlyName } from '../../src/social/urls.js'
import type { Storage } from '../../src/storage/database.js'
import { openTurn, receiveInbound } from '../../src/storage/turns.js'
import { readPageTool, readPostTool } from '../../src/tools/core/web.js'
import type { ToolContext } from '../../src/tools/types.js'
import { createTurnSources } from '../../src/turn/sources.js'
import type { TurnContext } from '../../src/turn/types.js'
import { tmpDir, tmpStorage } from '../support/tmp.js'

const pack = loadPack('characters/example', 'repository')

const NOTE_ID = '0123456789abcdef01234567'
const DIRECT_XHS_EXPLORE = `https://www.xiaohongshu.com/explore/${NOTE_ID}`
const DIRECT_XHS_APEX_ITEM = `https://xiaohongshu.com/discovery/item/${NOTE_ID}`
const DIRECT_REDNOTE_EXPLORE = `https://www.rednote.com/explore/${NOTE_ID}`
const DIRECT_REDNOTE_APEX_ITEM = `https://rednote.com/discovery/item/${NOTE_ID}`
const SHORT_CODE = 'AbC123xYz09'
const SHORT_XHSLINK = `https://xhslink.com/${SHORT_CODE}`
const SHORT_XHSLINK_O = `https://xhslink.com/o/${SHORT_CODE}`
const SHORT_XHSLINK_CN_O = `https://xhslink.cn/o/${SHORT_CODE}`
const MIRROR_URL = 'https://www.xiaohongshu.com/example/status/1234567890123456789'
const X_URL = 'https://x.com/example/status/1234567890123456789'

let seq = 0

function makeTurnContext(storage: Storage): TurnContext {
  seq += 1
  const chat = ensureChat(storage, { waId: `fake-chat-rednote-${seq}`, type: 'group' })
  setChatStatus(storage, { chatId: chat.chatId, status: 'active', actor: 'test' })
  const senderId = `subj-rednote-${seq}`
  const mid = `mid-rednote-${seq}`
  const turnId = `turn-rednote-${seq}`
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
    now: () => new Date('2026-11-18T00:00:00.000Z'),
    commit: () => {
      throw new Error('commit must not be called')
    }
  }
}

function expectRefusedRednote(result: { ok: boolean; kind?: string; reason?: string }): void {
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('expected a refusal')
  expect(result.kind).toBe('refused')
  expect(result.reason).toContain('Rednote')
  expect(result.reason).not.toContain('LinkedIn')
}

describe('rednote recognition', () => {
  it('read_page refuses a recognised direct note by URL and source without dispatch', async () => {
    const storage = tmpStorage()
    const turn = makeTurnContext(storage)
    const seen = turn.sources.add(DIRECT_XHS_EXPLORE, 'message')
    if (seen === undefined) throw new Error('source was not registered')
    const pageRead = vi.fn(async () => ({ title: 'page', text: 'body' }))
    const download = vi.fn(async () => {
      throw new Error('download must not be called')
    })
    const tool = readPageTool({ filesDir: tmpDir(), page: { read: pageRead, download } })
    const context = makeToolContext(turn, `${turn.turnId}-page`)

    expectRefusedRednote(await tool.handler({ url: DIRECT_XHS_EXPLORE }, context))
    expectRefusedRednote(await tool.handler({ source: seen.id }, context))
    expect(pageRead).not.toHaveBeenCalled()
    expect(download).not.toHaveBeenCalled()
  })

  it('read_post refuses recognised short links by URL and source without dispatch', async () => {
    const storage = tmpStorage()
    const turn = makeTurnContext(storage)
    const seenBare = turn.sources.add(SHORT_XHSLINK, 'message')
    const seen = turn.sources.add(SHORT_XHSLINK_O, 'message')
    const seenCn = turn.sources.add(SHORT_XHSLINK_CN_O, 'message')
    if (seen === undefined || seenCn === undefined || seenBare === undefined)
      throw new Error('source was not registered')
    const postRead = vi.fn(async () => {
      throw new Error('post reader must not be called')
    })
    const tool = readPostTool({ filesDir: tmpDir(), post: { read: postRead } })
    const context = makeToolContext(turn, `${turn.turnId}-post`)

    expectRefusedRednote(await tool.handler({ url: SHORT_XHSLINK }, context))
    expectRefusedRednote(await tool.handler({ source: seen.id }, context))
    expectRefusedRednote(await tool.handler({ source: seenCn.id }, context))
    expect(postRead).not.toHaveBeenCalled()
  })

  it('recognises direct domain and path families, rejecting nearby non-posts', () => {
    expect(recognitionOnlyName(DIRECT_XHS_EXPLORE)).toBe('Rednote')
    expect(recognitionOnlyName(DIRECT_XHS_APEX_ITEM)).toBe('Rednote')
    expect(recognitionOnlyName(DIRECT_REDNOTE_EXPLORE)).toBe('Rednote')
    expect(recognitionOnlyName(DIRECT_REDNOTE_APEX_ITEM)).toBe('Rednote')

    expect(recognitionOnlyName('https://www.xiaohongshu.com/user/profile/synthetic123')).toBeNull()
    expect(recognitionOnlyName('https://www.xiaohongshu.com/explore/abc123')).toBeNull()
    expect(recognitionOnlyName(`https://www.xiaohongshu.com/explore/${'z'.repeat(24)}`)).toBeNull()
    expect(recognitionOnlyName('https://www.rednote.com/posts/synthetic123')).toBeNull()
  })

  it('recognises verified short shapes, rejecting bare short roots', () => {
    expect(recognitionOnlyName(SHORT_XHSLINK)).toBe('Rednote')
    expect(recognitionOnlyName(SHORT_XHSLINK_O)).toBe('Rednote')
    expect(recognitionOnlyName(SHORT_XHSLINK_CN_O)).toBe('Rednote')

    expect(recognitionOnlyName('https://xhslink.com/')).toBeNull()
    expect(recognitionOnlyName('https://xhslink.cn/')).toBeNull()
    expect(recognitionOnlyName('https://www.xiaohongshu.com/explore/')).toBeNull()
  })

  it('an owned-host path shaped like another platform selects nothing; a following valid post still does', () => {
    expect(recognitionOnlyName(DIRECT_XHS_EXPLORE)).toBe('Rednote')

    expect(recognitionOnlyName(MIRROR_URL)).toBeNull()
    expect(parseSocialPostUrl(MIRROR_URL)).toBeNull()
    const targets = findSocialPostTargets(`${MIRROR_URL} ${X_URL}`)
    expect(targets.map((target) => target.platform)).toEqual(['x'])
    expect(findSocialPostTargets(DIRECT_XHS_EXPLORE)).toEqual([])
    expect(findSocialPostTargets(SHORT_XHSLINK_O)).toEqual([])
  })
})
