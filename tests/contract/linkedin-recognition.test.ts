import { describe, expect, it, vi } from 'vitest'
import { loadPack } from '../../src/character/loader.js'
import { ensureChat, setChatStatus } from '../../src/settings/chats.js'
import { resolveSettings } from '../../src/settings/settings.js'
import { findSocialPostTargets, recognitionOnlyName } from '../../src/social/urls.js'
import type { Storage } from '../../src/storage/database.js'
import { openTurn, receiveInbound } from '../../src/storage/turns.js'
import { readPageTool, readPostTool } from '../../src/tools/core/web.js'
import type { ToolContext } from '../../src/tools/types.js'
import { createTurnSources } from '../../src/turn/sources.js'
import type { TurnContext } from '../../src/turn/types.js'
import { tmpDir, tmpStorage } from '../support/tmp.js'

const pack = loadPack('characters/example', 'repository')

const POST_URL = 'https://www.linkedin.com/posts/synthetic-update-activity-1234567890123456789'
const FEED_URL = 'https://www.linkedin.com/feed/update/urn:li:activity:1234567890123456789'
const SHORT_URL = 'https://lnkd.in/synthetic01'
const X_URL = 'https://x.com/example/status/1234567890123456789'

let seq = 0

function makeTurnContext(storage: Storage): TurnContext {
  seq += 1
  const chat = ensureChat(storage, { waId: `fake-chat-linkedin-${seq}`, type: 'group' })
  setChatStatus(storage, { chatId: chat.chatId, status: 'active', actor: 'test' })
  const senderId = `subj-linkedin-${seq}`
  const mid = `mid-linkedin-${seq}`
  const turnId = `turn-linkedin-${seq}`
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

function expectRefusedLinkedIn(result: { ok: boolean; kind?: string; reason?: string }): void {
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('expected a refusal')
  expect(result.kind).toBe('refused')
  expect(result.reason).toContain('LinkedIn')
}

describe('linkedin recognition', () => {
  it('read_page refuses a recognised post by name without calling its reader', async () => {
    const storage = tmpStorage()
    const turn = makeTurnContext(storage)
    const seen = turn.sources.add(POST_URL, 'message')
    if (seen === undefined) throw new Error('source was not registered')
    const pageRead = vi.fn(async () => ({ title: 'page', text: 'body' }))
    const download = vi.fn(async () => {
      throw new Error('download must not be called')
    })
    const tool = readPageTool({ filesDir: tmpDir(), page: { read: pageRead, download } })
    const context = makeToolContext(turn, `${turn.turnId}-page`)

    expectRefusedLinkedIn(await tool.handler({ url: POST_URL }, context))
    expectRefusedLinkedIn(await tool.handler({ source: seen.id }, context))
    expect(pageRead).not.toHaveBeenCalled()
    expect(download).not.toHaveBeenCalled()
  })

  it('read_post refuses recognised feed and short links by name without calling its reader', async () => {
    const storage = tmpStorage()
    const turn = makeTurnContext(storage)
    const feedSeen = turn.sources.add(FEED_URL, 'message')
    const shortSeen = turn.sources.add(SHORT_URL, 'message')
    if (feedSeen === undefined || shortSeen === undefined) throw new Error('source was not registered')
    const postRead = vi.fn(async () => {
      throw new Error('post reader must not be called')
    })
    const tool = readPostTool({ filesDir: tmpDir(), post: { read: postRead } })
    const context = makeToolContext(turn, `${turn.turnId}-post`)

    expectRefusedLinkedIn(await tool.handler({ url: FEED_URL }, context))
    expectRefusedLinkedIn(await tool.handler({ source: shortSeen.id }, context))
    expect(postRead).not.toHaveBeenCalled()
  })

  it('keeps only the X post when LinkedIn links lead it', () => {
    expect(recognitionOnlyName(POST_URL)).toBe('LinkedIn')
    expect(recognitionOnlyName(FEED_URL)).toBe('LinkedIn')
    expect(recognitionOnlyName(SHORT_URL)).toBe('LinkedIn')

    const targets = findSocialPostTargets(`${POST_URL} ${FEED_URL} ${SHORT_URL} ${X_URL}`)
    expect(targets.map((target) => target.platform)).toEqual(['x'])
    expect(findSocialPostTargets(SHORT_URL)).toEqual([])
  })

  it('recognises only clean official LinkedIn post shapes', () => {
    expect(recognitionOnlyName(POST_URL)).toBe('LinkedIn')
    expect(
      recognitionOnlyName('https://www.linkedin.com:443/posts/synthetic-update-activity-1234567890123456789')
    ).toBe('LinkedIn')

    expect(
      recognitionOnlyName('http://www.linkedin.com/posts/synthetic-update-activity-1234567890123456789')
    ).toBeNull()
    expect(
      recognitionOnlyName('https://member:secret@www.linkedin.com/posts/synthetic-update-activity-1234567890123456789')
    ).toBeNull()
    expect(
      recognitionOnlyName('https://www.linkedin.com:8443/posts/synthetic-update-activity-1234567890123456789')
    ).toBeNull()
    expect(
      recognitionOnlyName('https://www.linkedin.com.evil.test/posts/synthetic-update-activity-1234567890123456789')
    ).toBeNull()
    expect(recognitionOnlyName('https://www.linkedin.com/in/synthetic-member')).toBeNull()
    expect(recognitionOnlyName('https://www.linkedin.com/pulse/synthetic-article-1234567890123456789')).toBeNull()
  })
})
