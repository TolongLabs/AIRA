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
import { createTurnSources } from '../../src/turn/sources.js'
import type { TurnContext } from '../../src/turn/types.js'
import { tmpDir, tmpStorage } from '../support/tmp.js'

const pack = loadPack('characters/example', 'repository')

const POST_URL = 'https://www.linkedin.com/posts/synthetic-update-activity-1234567890123456789'
const UGC_POST_URL = 'https://www.linkedin.com/posts/example-update-ugcPost-1234567890123456789-abCd/'
const FEED_URL = 'https://www.linkedin.com/feed/update/urn:li:activity:1234567890123456789'
const SHORT_URL = 'https://lnkd.in/synthetic01'
const SHORT_WWW_URL = 'https://www.lnkd.in/synthetic01'
const SHORT_POST_URL = 'https://lnkd.in/p/synthetic01'
const MIRROR_URL = 'https://www.linkedin.com/synthetic/status/1234567890123456789'
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

describe('excluded source hosts', () => {
  it.each([
    POST_URL,
    FEED_URL,
    SHORT_URL,
    SHORT_WWW_URL,
    SHORT_POST_URL,
    UGC_POST_URL,
    'https://de.linkedin.com./in/example'
  ])('refuses a seen %s with the generic outcome before calling either reader', async (share) => {
    const storage = tmpStorage()
    const turn = makeTurnContext(storage)
    const seen = turn.sources.add(share, 'message')
    if (seen === undefined) throw new Error('source was not registered')
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
    for (const tool of offered) {
      const response = await tool.call({ source: seen.id }, tool.schema.name, new AbortController().signal)
      expect(JSON.parse(response.content)).toMatchObject({ ok: false, outcome: 'You cannot do that here.' })
    }
    expect(postRead).not.toHaveBeenCalled()
    expect(pageRead).not.toHaveBeenCalled()
    expect(download).not.toHaveBeenCalled()
  })

  it('prevents excluded hosts from matching another platform', () => {
    expect(recognitionOnlyName(MIRROR_URL)).toBeNull()
    expect(parseSocialPostUrl(MIRROR_URL)).toBeNull()
    const targets = findSocialPostTargets(`${MIRROR_URL} ${X_URL}`)
    expect(targets.map((target) => target.platform)).toEqual(['x'])
  })
})
