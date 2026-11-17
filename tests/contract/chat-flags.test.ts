import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeChatFlags } from '../../src/gateway/chat-flags.js'
import { ensureChat, setChatStatus } from '../../src/settings/chats.js'
import { setSetting } from '../../src/settings/settings.js'
import { queueModel, startApp } from '../support/app.js'

const TOKEN = 'test-site-token-0123456789abcdefghijklmn'

function readFlags(dataDir: string): { version: number; chats: Record<string, Record<string, unknown>> } {
  return JSON.parse(readFileSync(join(dataDir, 'gateway', 'chats.json'), 'utf8')) as {
    version: number
    chats: Record<string, Record<string, unknown>>
  }
}

async function startWithSite() {
  const started = await startApp(queueModel([{ text: 'ok' }]), { env: { SITE_TOKEN: TOKEN } })
  const address = await started.app.listenSite(0, '127.0.0.1')
  if (!address) throw new Error('expected site server to listen')
  return { ...started, siteUrl: `http://127.0.0.1:${address.port}` }
}

async function putSite(siteUrl: string, path: string, body: unknown) {
  return fetch(`${siteUrl}${path}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  })
}

function addAltPack(dataDir: string, unavailableLine: string): void {
  const altDir = join(dataDir, 'characters', 'alt')
  mkdirSync(altDir, { recursive: true })
  cpSync(join('characters', 'example', 'moods.yml'), join(altDir, 'moods.yml'))
  writeFileSync(
    join(altDir, 'card.yml'),
    [
      'id: alt',
      'displayName: Alt',
      'languages:',
      '  - en',
      'coreIdentity: You are Alt, a concise test assistant.',
      'speechRules:',
      '  - Keep replies short.',
      'defaultReplyLength: short'
    ].join('\n'),
    'utf8'
  )
  writeFileSync(
    join(altDir, 'lines.yml'),
    [
      "error: 'Error.'",
      "limit: 'Limit.'",
      "refusal: 'Refusal.'",
      "busy: 'Busy.'",
      "slow: 'Slow.'",
      "unreadableMedia: 'Unreadable.'",
      "fallback: 'Fallback.'",
      `unavailable: '${unavailableLine}'`
    ].join('\n'),
    'utf8'
  )
}

describe('chat flags file', () => {
  it('includes active chats with voice or reactions, omits both-off and inactive chats, and skips unchanged writes', async () => {
    const { app, dataDir } = await startApp(queueModel([{ text: 'ok' }]))

    expect(readFlags(dataDir)).toEqual({ version: 1, chats: {} })

    const voiceChat = ensureChat(app.storage, { waId: '1234567890@s.whatsapp.net', type: 'dm' })
    setChatStatus(app.storage, { chatId: voiceChat.chatId, status: 'active', actor: 'test' })
    setSetting(app.storage, {
      level: 'chat',
      scope: voiceChat.chatId,
      key: 'features.voice',
      value: true,
      actor: 'test'
    })

    const reactionsChat = ensureChat(app.storage, { waId: '0000000000@lid', type: 'group' })
    setChatStatus(app.storage, { chatId: reactionsChat.chatId, status: 'active', actor: 'test' })
    setSetting(app.storage, {
      level: 'chat',
      scope: reactionsChat.chatId,
      key: 'reactions',
      value: true,
      actor: 'test'
    })

    const offChat = ensureChat(app.storage, { waId: '12345678901@g.us', type: 'group' })
    setChatStatus(app.storage, { chatId: offChat.chatId, status: 'active', actor: 'test' })

    const pendingChat = ensureChat(app.storage, { waId: '123456789012@g.us', type: 'group' })
    setSetting(app.storage, {
      level: 'chat',
      scope: pendingChat.chatId,
      key: 'features.voice',
      value: true,
      actor: 'test'
    })
    setSetting(app.storage, {
      level: 'chat',
      scope: pendingChat.chatId,
      key: 'reactions',
      value: true,
      actor: 'test'
    })

    expect(writeChatFlags(app.storage, dataDir)).toBe(true)
    expect(readFlags(dataDir)).toEqual({
      version: 1,
      chats: {
        '1234567890@s.whatsapp.net': { voice: 'all' },
        '0000000000@lid': { reactions: true, reactionChance: 0.33 }
      }
    })

    expect(writeChatFlags(app.storage, dataDir)).toBe(false)
  })

  it('rewrites chats.json after site API setting and chat status writes', async () => {
    const { app, dataDir, siteUrl } = await startWithSite()
    const dm = ensureChat(app.storage, { waId: '1234567890@s.whatsapp.net', type: 'dm' })

    const voiceRes = await putSite(siteUrl, '/api/settings', {
      level: 'chat',
      scope: dm.chatId,
      key: 'features.voice',
      value: true
    })
    expect(voiceRes.status).toBe(200)
    expect(readFlags(dataDir).chats['1234567890@s.whatsapp.net']).toBeUndefined()

    const activateRes = await putSite(siteUrl, `/api/chats/${dm.chatId}/status`, { status: 'active' })
    expect(activateRes.status).toBe(200)
    expect(readFlags(dataDir)).toEqual({
      version: 1,
      chats: {
        '1234567890@s.whatsapp.net': { voice: 'all' }
      }
    })

    const reactRes = await putSite(siteUrl, '/api/settings', {
      level: 'chat',
      scope: dm.chatId,
      key: 'reactions',
      value: true
    })
    expect(reactRes.status).toBe(200)
    expect(readFlags(dataDir)).toEqual({
      version: 1,
      chats: {
        '1234567890@s.whatsapp.net': { voice: 'all', reactions: true, reactionChance: 0.33 }
      }
    })

    const deactivateRes = await putSite(siteUrl, `/api/chats/${dm.chatId}/status`, { status: 'pending' })
    expect(deactivateRes.status).toBe(200)
    expect(readFlags(dataDir)).toEqual({ version: 1, chats: {} })
  })

  it('rewrites unavailable.txt when the global character changes through the site API', async () => {
    const { dataDir, siteUrl } = await startWithSite()
    const altUnavailable = 'Alt is away right now.'
    addAltPack(dataDir, altUnavailable)

    const res = await putSite(siteUrl, '/api/settings', {
      level: 'global',
      scope: '',
      key: 'character',
      value: 'alt'
    })
    expect(res.status).toBe(200)
    expect(readFileSync(join(dataDir, 'gateway', 'unavailable.txt'), 'utf8')).toBe(`${altUnavailable}\n`)
  })

  it('includes names and free for active groups only, updates on writes, and omits inactive or disabled groups', async () => {
    const { app, dataDir, siteUrl } = await startWithSite()
    addAltPack(dataDir, 'Alt is away.')

    const nameGroup = ensureChat(app.storage, { waId: '0000000000@g.us', type: 'group' })
    setChatStatus(app.storage, { chatId: nameGroup.chatId, status: 'active', actor: 'test' })
    const freeGroup = ensureChat(app.storage, { waId: '12345678901@g.us', type: 'group' })
    setChatStatus(app.storage, { chatId: freeGroup.chatId, status: 'active', actor: 'test' })
    const dm = ensureChat(app.storage, { waId: '1234567890@s.whatsapp.net', type: 'dm' })
    setChatStatus(app.storage, { chatId: dm.chatId, status: 'active', actor: 'test' })
    const pendingGroup = ensureChat(app.storage, { waId: '123456789012@g.us', type: 'group' })

    // Pending group and DM never receive group flags (names / free).
    for (const scope of [pendingGroup.chatId, dm.chatId]) {
      expect(
        (await putSite(siteUrl, '/api/settings', { level: 'chat', scope, key: 'nameCall', value: true })).status
      ).toBe(200)
      expect(
        (await putSite(siteUrl, '/api/settings', { level: 'chat', scope, key: 'freeResponse', value: true })).status
      ).toBe(200)
    }
    expect(readFlags(dataDir)).toEqual({ version: 1, chats: {} })

    // Enabling nameCall on an active group writes the bound pack's names.
    expect(
      (
        await putSite(siteUrl, '/api/settings', {
          level: 'chat',
          scope: nameGroup.chatId,
          key: 'nameCall',
          value: true
        })
      ).status
    ).toBe(200)
    expect(readFlags(dataDir)).toEqual({
      version: 1,
      chats: {
        '0000000000@g.us': { names: ['Example'] }
      }
    })

    // Custom nameCall.names overrides the pack's names; enabling freeResponse adds free: true.
    expect(
      (
        await putSite(siteUrl, '/api/settings', {
          level: 'chat',
          scope: nameGroup.chatId,
          key: 'nameCall.names',
          value: ['Taiga']
        })
      ).status
    ).toBe(200)
    expect(
      (
        await putSite(siteUrl, '/api/settings', {
          level: 'chat',
          scope: freeGroup.chatId,
          key: 'freeResponse',
          value: true
        })
      ).status
    ).toBe(200)
    expect(readFlags(dataDir)).toEqual({
      version: 1,
      chats: {
        '0000000000@g.us': { names: ['Taiga'] },
        '12345678901@g.us': { free: true }
      }
    })

    // Clearing nameCall.names and switching character updates resolved names to the new pack.
    expect(
      (
        await putSite(siteUrl, '/api/settings', {
          level: 'chat',
          scope: nameGroup.chatId,
          key: 'nameCall.names',
          value: null
        })
      ).status
    ).toBe(200)
    expect(
      (
        await putSite(siteUrl, '/api/settings', {
          level: 'chat',
          scope: nameGroup.chatId,
          key: 'character',
          value: 'alt'
        })
      ).status
    ).toBe(200)
    expect(readFlags(dataDir).chats['0000000000@g.us']).toEqual({ names: ['Alt'] })

    // Turning nameCall off leaves the group out of chats.json.
    expect(
      (
        await putSite(siteUrl, '/api/settings', {
          level: 'chat',
          scope: nameGroup.chatId,
          key: 'nameCall',
          value: false
        })
      ).status
    ).toBe(200)
    expect(readFlags(dataDir)).toEqual({
      version: 1,
      chats: {
        '12345678901@g.us': { free: true }
      }
    })
  })

  it('writes reactionChance from reactions.chance and omits reactions while muted', async () => {
    const { app, dataDir, siteUrl } = await startWithSite()

    const groupA = ensureChat(app.storage, { waId: '0000000000@g.us', type: 'group' })
    setChatStatus(app.storage, { chatId: groupA.chatId, status: 'active', actor: 'test' })
    const groupB = ensureChat(app.storage, { waId: '12345678901@g.us', type: 'group' })
    setChatStatus(app.storage, { chatId: groupB.chatId, status: 'active', actor: 'test' })

    expect(
      (await putSite(siteUrl, '/api/settings', { level: 'chat', scope: groupA.chatId, key: 'reactions', value: true }))
        .status
    ).toBe(200)
    expect(
      (await putSite(siteUrl, '/api/settings', { level: 'chat', scope: groupB.chatId, key: 'reactions', value: true }))
        .status
    ).toBe(200)
    expect(
      (await putSite(siteUrl, '/api/settings', { level: 'type', scope: 'group', key: 'reactions.chance', value: 50 }))
        .status
    ).toBe(200)
    expect(
      (
        await putSite(siteUrl, '/api/settings', {
          level: 'chat',
          scope: groupA.chatId,
          key: 'reactions.chance',
          value: 75
        })
      ).status
    ).toBe(200)
    expect(
      (
        await putSite(siteUrl, '/api/settings', {
          level: 'chat',
          scope: groupB.chatId,
          key: 'features.voice',
          value: true
        })
      ).status
    ).toBe(200)

    expect(readFlags(dataDir)).toEqual({
      version: 1,
      chats: {
        '0000000000@g.us': { reactions: true, reactionChance: 0.75 },
        '12345678901@g.us': { voice: 'all', reactions: true, reactionChance: 0.5 }
      }
    })

    // Muting leaves reactions and reactionChance out, keeping other flags (e.g. voice).
    expect(
      (
        await putSite(siteUrl, '/api/settings', {
          level: 'chat',
          scope: groupA.chatId,
          key: 'muted',
          value: { by: 's_test', at: '2026-11-17T00:00:00.000Z' }
        })
      ).status
    ).toBe(200)
    expect(
      (
        await putSite(siteUrl, '/api/settings', {
          level: 'chat',
          scope: groupB.chatId,
          key: 'muted',
          value: { by: 's_test', at: '2026-11-17T00:00:00.000Z' }
        })
      ).status
    ).toBe(200)

    expect(readFlags(dataDir)).toEqual({
      version: 1,
      chats: {
        '12345678901@g.us': { voice: 'all' }
      }
    })

    // Unmuting and setting boundary chances (0 and 100) restores reactions with expected ratios.
    expect(
      (await putSite(siteUrl, '/api/settings', { level: 'chat', scope: groupA.chatId, key: 'muted', value: false }))
        .status
    ).toBe(200)
    expect(
      (
        await putSite(siteUrl, '/api/settings', {
          level: 'chat',
          scope: groupA.chatId,
          key: 'reactions.chance',
          value: 0
        })
      ).status
    ).toBe(200)
    expect(
      (await putSite(siteUrl, '/api/settings', { level: 'chat', scope: groupB.chatId, key: 'muted', value: false }))
        .status
    ).toBe(200)
    expect(
      (
        await putSite(siteUrl, '/api/settings', {
          level: 'chat',
          scope: groupB.chatId,
          key: 'reactions.chance',
          value: 100
        })
      ).status
    ).toBe(200)

    expect(readFlags(dataDir)).toEqual({
      version: 1,
      chats: {
        '0000000000@g.us': { reactions: true, reactionChance: 0 },
        '12345678901@g.us': { voice: 'all', reactions: true, reactionChance: 1 }
      }
    })
  })
})
