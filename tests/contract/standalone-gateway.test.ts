import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { type App, createApp } from '../../src/app.js'
import { createStandaloneModelStore } from '../../src/config/standalone-models.js'
import { createLogger } from '../../src/records/logger.js'
import { queueModel } from '../support/app.js'
import { testConfig } from '../support/core.js'
import { tmpDir } from '../support/tmp.js'

const apps: App[] = []
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close()
})

async function start(configured: boolean) {
  const root = tmpDir('aira-structured-gateway-')
  const config = testConfig((value) => {
    value.storage.path = root
    value.storage.minFreeMb = 2
    value.storage.criticalFreeMb = 1
    value.gateway.hostDataDir = '/host/fixture'
    value.memory.enabled = 'off'
  })
  if (configured) {
    const store = createStandaloneModelStore(root, config)
    const saved = store.save({
      expectedRevision: null,
      main: {
        provider: 'openai-compatible',
        model: 'test-model',
        baseUrl: 'http://127.0.0.1:12345/v1',
        effort: '',
        deepEffort: '',
        usdPerMTokIn: 0,
        usdPerMTokOut: 0,
        usdPerMTokCached: 0,
        apiKey: 'synthetic-model-key'
      },
      fallback: null
    })
    store.requestActivation({ expectedRevision: saved.savedRevision })
  }
  const model = queueModel([{ text: 'fixture reply alpha' }, { text: 'fixture reply beta' }])
  const app = await createApp({
    config,
    env: { AIRA_INSTALL_MODE: 'standalone' },
    clients: { main: model },
    logger: createLogger({ level: 'error', module: 'test', sink: () => undefined })
  })
  apps.push(app)
  const gateway = await app.listen(0, '127.0.0.1')
  const site = await app.listenSite(0, '127.0.0.1')
  app.completeStartup()
  const owner = readFileSync(join(root, 'standalone', 'owner.token'), 'utf8').trim()
  const tokenPath = join(root, 'standalone', 'gateway.token')
  const token = readFileSync(tokenPath, 'utf8').trim()
  expect(token).not.toBe(owner)
  expect(statSync(tokenPath).mode & 0o777).toBe(0o600)
  async function post(path: string, body: unknown, credential = token) {
    const result = await fetch(`http://127.0.0.1:${gateway.port}${path}`, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + credential, 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
    return { status: result.status, body: await result.json() }
  }
  async function ownerCall(path: string, method = 'GET', body?: unknown) {
    const result = await fetch(`http://127.0.0.1:${site.port}/owner-api/core/${path}`, {
      method,
      headers: { 'x-tolongai-token': owner, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
    expect(result.status).toBe(200)
    return result.json()
  }
  return { model, post, ownerCall, owner, token, root }
}
const attach = (action: 'connect' | 'disconnect' = 'connect') => ({
  schemaVersion: 1,
  adapterVersion: 'hermes-v0.23.4',
  profile: 'fixture',
  action
})
const turn = (chat: string, mid: string, text: string) => ({
  schemaVersion: 1,
  profile: 'fixture',
  platform: 'whatsapp',
  kind: 'dm',
  chat,
  sender: chat,
  mid,
  text
})

describe('standalone structured Hermes transport', () => {
  it('verifies its route without requiring or spending a model credential', async () => {
    const core = await start(false)
    expect((await core.post('/v1/aira/attach-check', attach(), core.owner)).status).toBe(401)
    expect((await core.post('/v1/aira/attach-check', attach())).status).toBe(200)
    expect(await core.ownerCall('health')).toMatchObject({
      configuration: 'setup_required',
      chatbot: 'inactive',
      hermes: { state: 'connected', adapterVersion: 'hermes-v0.23.4' }
    })
    expect((await core.post('/v1/aira/turn', turn('fixture-a', 'm1', 'hello'))).status).toBe(503)
    expect(core.model.requests).toHaveLength(0)
  })

  it('keeps chat identity separate, admits only enabled chats, and never uses the legacy path', async () => {
    const core = await start(true)
    expect((await core.post('/v1/aira/attach-check', attach())).status).toBe(200)
    expect(await core.ownerCall('health')).toMatchObject({
      chatbot: 'ready',
      capabilities: { gatewayConnection: true }
    })
    expect((await core.post('/v1/chat/completions', { messages: [] })).status).toBe(403)
    expect((await core.post('/v1/aira/turn', turn('fixture-a', 'm1', 'first'), core.owner)).status).toBe(401)
    expect((await core.post('/v1/aira/turn', { ...turn('fixture-a', 'm1', 'first'), profile: 'other' })).status).toBe(
      403
    )
    const defaults = z.object({ revision: z.string() }).parse(await core.ownerCall('settings?level=global&scope='))
    await core.ownerCall('settings', 'PUT', {
      level: 'global',
      scope: '',
      key: 'character',
      value: 'example',
      expectedRevision: defaults.revision
    })
    for (const chat of ['fixture-a', 'fixture-b']) {
      const pending = await core.post('/v1/aira/turn', turn(chat, 'm1', 'pending'))
      expect(pending).toEqual({ status: 200, body: { schemaVersion: 1, disposition: 'no_reply', reply: null } })
    }
    expect(core.model.requests).toHaveLength(0)
    const chats = z
      .object({ chats: z.array(z.object({ chatId: z.string(), waId: z.string(), status: z.string() })) })
      .parse(await core.ownerCall('chats'))
    expect(chats.chats).toHaveLength(2)
    for (const chat of chats.chats) {
      expect(chat.status).toBe('pending')
      await core.ownerCall(`chats/${chat.chatId}/status`, 'PUT', { status: 'active' })
    }
    const alpha = await core.post('/v1/aira/turn', turn('fixture-a', 'm2', 'alpha-private-fixture'))
    const beta = await core.post('/v1/aira/turn', turn('fixture-b', 'm2', 'beta-private-fixture'))
    expect(alpha.status).toBe(200)
    expect(alpha.body).toMatchObject({ disposition: 'reply' })
    expect(beta.status).toBe(200)
    expect(beta.body).toMatchObject({ disposition: 'reply' })
    expect(JSON.stringify(alpha.body)).toMatch(/fixture reply alpha/i)
    expect(JSON.stringify(beta.body)).toMatch(/fixture reply beta/i)
    expect(core.model.requests).toHaveLength(2)
    expect((await core.post('/v1/aira/turn', { ...turn('fixture-a', 'm3', 'wrong kind'), kind: 'group' })).status).toBe(
      409
    )
    expect(core.model.requests).toHaveLength(2)
    expect(JSON.stringify(core.model.requests[0])).toContain('alpha-private-fixture')
    expect(JSON.stringify(core.model.requests[1])).not.toContain('alpha-private-fixture')
    expect((await core.post('/v1/aira/attach-check', attach('disconnect'))).status).toBe(200)
    expect((await core.post('/v1/aira/turn', turn('fixture-a', 'm3', 'after disconnect'))).status).toBe(503)
    expect(core.model.requests).toHaveLength(2)
  })

  it('distinguishes invalid or unsupported route receipts from a deliberate disconnect', async () => {
    const core = await start(true)
    const receipt = join(core.root, 'standalone', 'hermes.json')
    writeFileSync(receipt, '{invalid', { mode: 0o600 })
    expect(await core.ownerCall('health')).toMatchObject({ chatbot: 'inactive', hermes: { state: 'invalid' } })
    writeFileSync(
      receipt,
      JSON.stringify({
        schemaVersion: 1,
        state: 'connected',
        adapterVersion: 'different',
        profile: 'fixture',
        verifiedAt: new Date().toISOString()
      })
    )
    expect(await core.ownerCall('health')).toMatchObject({ chatbot: 'inactive', hermes: { state: 'unsupported' } })
    expect((await core.post('/v1/aira/attach-check', attach('disconnect'))).status).toBe(200)
    expect(await core.ownerCall('health')).toMatchObject({ chatbot: 'inactive', hermes: { state: 'disconnected' } })
  })
})
