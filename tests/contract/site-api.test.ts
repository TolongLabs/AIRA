import { describe, expect, it } from 'vitest'
import { applyOperation } from '../../src/memory/store.js'
import { ModelError } from '../../src/models/types.js'
import { ensureChat } from '../../src/settings/chats.js'
import { setSetting } from '../../src/settings/settings.js'
import { type Answer, CHAT, msg, queueModel, startApp } from '../support/app.js'

const TOKEN = 'test-site-token-0123456789abcdefghijklmn' // 40 invented characters
const WRONG_TOKEN = 'xxxx-site-token-0123456789abcdefghijklmn' // same length (40)

async function startWithSite(answers: Answer[] = [{ text: 'Hello from test!' }]) {
  const model = queueModel(answers)
  const started = await startApp(model, { env: { SITE_TOKEN: TOKEN } })
  const address = await started.app.listenSite(0, '127.0.0.1')
  if (!address) throw new Error('expected site server to listen')
  const siteUrl = `http://127.0.0.1:${address.port}`
  return { ...started, model, siteUrl }
}

function apiFetch(siteUrl: string, path: string, options: { token?: string; method?: string } = {}) {
  const headers: Record<string, string> = {}
  if (options.token !== undefined) headers['authorization'] = `Bearer ${options.token}`
  return fetch(`${siteUrl}${path}`, { method: options.method ?? 'GET', headers })
}

describe('site API read routes', () => {
  it('returns 401 on every route when the token is missing or wrong', async () => {
    const { siteUrl } = await startWithSite()
    const paths = [
      '/api/health',
      '/api/chats',
      '/api/settings?level=global&scope=',
      '/api/turns',
      '/api/turns/turn-missing',
      '/api/report',
      '/api/memory?chat=c_test'
    ]
    for (const path of paths) {
      const noToken = await apiFetch(siteUrl, path)
      expect(noToken.status).toBe(401)
      expect(await noToken.json()).toEqual({ error: 'unauthorized' })

      const wrongToken = await apiFetch(siteUrl, path, { token: WRONG_TOKEN })
      expect(wrongToken.status).toBe(401)
      expect(await wrongToken.json()).toEqual({ error: 'unauthorized' })
    }
  })

  it('reports ready status and role configuration on /api/health', async () => {
    const { siteUrl } = await startWithSite()
    const res = await apiFetch(siteUrl, '/api/health', { token: TOKEN })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      status: 'ready',
      version: '0.0.0',
      activeTurns: 0,
      roles: {
        main: { configured: true, breakerOpen: false },
        fallback: { configured: false, breakerOpen: false },
        judge: { configured: false, breakerOpen: false },
        media: { configured: false, breakerOpen: false }
      }
    })
  })

  it('lists chats, turns, and turn details without failure message text after a gateway turn', async () => {
    const { siteUrl, gateway, chatId } = await startWithSite([
      { text: 'Hello from test!' },
      new ModelError('rate_limit', 'upstream secret detail')
    ])
    const delivery = await gateway.send(msg('m-1', 'hello there'))
    expect(delivery.content).toBe('Hello from test!')

    const chatsRes = await apiFetch(siteUrl, '/api/chats', { token: TOKEN })
    expect(chatsRes.status).toBe(200)
    const chatsBody = (await chatsRes.json()) as {
      chats: {
        chatId: string
        waId: string
        type: string
        status: string
        settings: Record<string, { value: unknown; level: string }>
      }[]
    }
    expect(chatsBody.chats).toHaveLength(1)
    expect(chatsBody.chats[0]).toMatchObject({
      chatId,
      waId: CHAT,
      type: 'group',
      status: 'active'
    })
    expect(chatsBody.chats[0]?.settings['character']).toEqual({ value: 'example', level: 'global' })

    const turnsRes = await apiFetch(siteUrl, '/api/turns', { token: TOKEN })
    expect(turnsRes.status).toBe(200)
    const turnsBody = (await turnsRes.json()) as { turns: { turn_id: string; chat_id: string; state: string }[] }
    expect(turnsBody.turns).toHaveLength(1)
    const turnId = turnsBody.turns[0]?.turn_id
    expect(turnId).toEqual(expect.any(String))
    expect(turnsBody.turns[0]?.chat_id).toBe(chatId)
    expect(turnsBody.turns[0]?.state).toBe('delivered')

    const turnRes = await apiFetch(siteUrl, `/api/turns/${turnId}`, { token: TOKEN })
    expect(turnRes.status).toBe(200)
    const turnBody = (await turnRes.json()) as {
      turn: { turn_id: string }
      modelCalls: { role: string; attempt: number }[]
      toolCalls: unknown[]
      failures: Record<string, unknown>[]
    }
    expect(turnBody.turn.turn_id).toBe(turnId)
    expect(turnBody.modelCalls).toHaveLength(1)
    expect(turnBody.failures).toEqual([])

    // Trigger a failed turn so failure rows are populated and checked for redaction.
    await gateway.send(msg('m-2', 'trigger failure'))
    const turnsAfterRes = await apiFetch(siteUrl, '/api/turns', { token: TOKEN })
    const turnsAfter = (await turnsAfterRes.json()) as { turns: { turn_id: string }[] }
    expect(turnsAfter.turns).toHaveLength(2)
    const failedTurnId = turnsAfter.turns[0]?.turn_id
    const failedRes = await apiFetch(siteUrl, `/api/turns/${failedTurnId}`, { token: TOKEN })
    expect(failedRes.status).toBe(200)
    const failedBody = (await failedRes.json()) as { failures: Record<string, unknown>[] }
    expect(failedBody.failures.length).toBeGreaterThanOrEqual(1)
    expect(failedBody.failures[0]).toMatchObject({
      stage: expect.any(String),
      kind: 'rate_limit',
      createdAt: expect.any(String)
    })
    expect(failedBody.failures[0]).not.toHaveProperty('message')
    expect(failedBody.failures[0]).not.toHaveProperty('stack')
  })

  it('returns raw settings for a level and scope, and 400 on an invalid level', async () => {
    const { app, siteUrl } = await startWithSite()
    setSetting(app.storage, {
      level: 'global',
      scope: '',
      key: 'language',
      value: 'en',
      actor: 'test'
    })

    const res = await apiFetch(siteUrl, '/api/settings?level=global&scope=', { token: TOKEN })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      level: 'global',
      scope: '',
      values: { character: 'example', language: 'en' }
    })

    const bad = await apiFetch(siteUrl, '/api/settings?level=bogus&scope=', { token: TOKEN })
    expect(bad.status).toBe(400)
  })

  it('requires chat on /api/memory and isolates items per chat', async () => {
    const { app, siteUrl, chatId } = await startWithSite()
    const other = ensureChat(app.storage, { waId: 'test-chat-g2', type: 'group' })

    app.storage.tx((db) => {
      applyOperation(db, chatId, { op: 'add', key: 'likes.tea', value: 'oolong', quote: 'q1' }, {})
      applyOperation(db, other.chatId, { op: 'add', key: 'likes.coffee', value: 'espresso', quote: 'q2' }, {})
    })

    const missing = await apiFetch(siteUrl, '/api/memory', { token: TOKEN })
    expect(missing.status).toBe(400)
    expect(await missing.json()).toEqual({ error: 'chat_required' })

    const res = await apiFetch(siteUrl, `/api/memory?chat=${chatId}`, { token: TOKEN })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: { key: string; value: string; status: string }[] }
    expect(body.items).toHaveLength(1)
    expect(body.items[0]).toMatchObject({ key: 'likes.tea', value: 'oolong', status: 'active' })
  })

  it('returns 404 no_snapshot on /api/report when no snapshot exists', async () => {
    const { siteUrl } = await startWithSite()
    const res = await apiFetch(siteUrl, '/api/report', { token: TOKEN })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'no_snapshot' })
  })

  it('returns 405 on non-GET for known routes and 404 on unknown routes', async () => {
    const { siteUrl } = await startWithSite()

    const postChats = await apiFetch(siteUrl, '/api/chats', { token: TOKEN, method: 'POST' })
    expect(postChats.status).toBe(405)
    expect(await postChats.json()).toEqual({ error: 'method_not_allowed' })

    const unknown = await apiFetch(siteUrl, '/api/nope', { token: TOKEN })
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toEqual({ error: 'not_found' })
  })

  it('does not build or listen the site server when SITE_TOKEN is absent', async () => {
    const { app, logs } = await startApp(queueModel([{ text: 'hi' }]), { env: {} })
    expect(app.siteServer).toBeUndefined()
    expect(await app.listenSite(0, '127.0.0.1')).toBeUndefined()
    expect(logs.some((entry) => entry['event'] === 'site_api.no_token')).toBe(true)
  })
})
