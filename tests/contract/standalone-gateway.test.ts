import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { type App, createApp } from '../../src/app.js'
import { createStandaloneModelStore } from '../../src/config/standalone-models.js'
import { STANDALONE_ADAPTER_VERSIONS } from '../../src/gateway/standalone.js'
import { createLogger } from '../../src/records/logger.js'
import { type Answer, queueModel } from '../support/app.js'
import { testConfig } from '../support/core.js'
import { tmpDir } from '../support/tmp.js'

const apps: App[] = []
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close()
})

async function start(
  configured: boolean,
  answers: Answer[] = [{ text: 'fixture reply alpha' }, { text: 'fixture reply beta' }],
  batchMs = 20
) {
  const root = tmpDir('aira-structured-gateway-')
  const config = testConfig((value) => {
    value.storage.path = root
    value.storage.minFreeMb = 2
    value.storage.criticalFreeMb = 1
    value.gateway.hostDataDir = '/host/fixture'
    value.memory.enabled = 'off'
    value.turn.batchMs = batchMs
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
  const model = queueModel(answers)
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
  return { app, model, post, ownerCall, owner, token, root }
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

const typedAttach = () => ({ ...attach(), schemaVersion: 2, capabilities: ['text'], deadlineMs: Date.now() + 10_000 })
const routeIdOf = (body: unknown) => z.object({ hermes: z.object({ routeId: z.uuid() }) }).parse(body).hermes.routeId
const typedTurn = (routeId: string, chat: string, mid: string, text: string) => ({
  ...turn(chat, mid, text),
  schemaVersion: 2,
  routeId
})

describe('standalone structured Hermes transport', () => {
  it('has only the reviewed v1 adapter version IDs', () => {
    expect(STANDALONE_ADAPTER_VERSIONS).toEqual(['hermes-v0.23.2', 'hermes-v0.23.3', 'hermes-v0.23.4'])
  })

  it.each(['hermes-v0.23.2', 'hermes-v0.23.3', 'hermes-v0.23.4'])(
    'verifies the exact %s route without requiring or spending a model credential',
    async (adapterVersion) => {
      const core = await start(false)
      const request = { ...attach(), adapterVersion }
      expect((await core.post('/v1/aira/attach-check', request, core.owner)).status).toBe(401)
      const response = await core.post('/v1/aira/attach-check', request)
      expect(response.status).toBe(200)
      expect(response.body).toMatchObject({ hermes: { state: 'connected', adapterVersion, profile: 'fixture' } })
      expect(await core.ownerCall('health')).toMatchObject({
        configuration: 'setup_required',
        chatbot: 'inactive',
        hermes: { state: 'connected', adapterVersion }
      })
      expect((await core.post('/v1/aira/turn', turn('fixture-a', 'm1', 'hello'))).status).toBe(503)
      expect(core.model.requests).toHaveLength(0)
    }
  )

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

  it('keeps the current route when an earlier adapter version tries to disconnect it', async () => {
    const core = await start(false)
    const previous = { ...attach(), adapterVersion: 'hermes-v0.23.2' }
    const current = { ...attach(), adapterVersion: 'hermes-v0.23.3' }
    expect((await core.post('/v1/aira/attach-check', previous)).status).toBe(200)
    expect((await core.post('/v1/aira/attach-check', current)).status).toBe(200)
    expect((await core.post('/v1/aira/attach-check', { ...previous, action: 'disconnect' })).status).toBe(409)
    expect(await core.ownerCall('health')).toMatchObject({
      hermes: { state: 'connected', adapterVersion: current.adapterVersion, profile: 'fixture' }
    })
    expect((await core.post('/v1/aira/attach-check', { ...current, action: 'disconnect' })).status).toBe(200)
    expect(await core.ownerCall('health')).toMatchObject({ hermes: { state: 'disconnected' } })
    expect(core.model.requests).toHaveLength(0)
  })

  it('refuses unlisted adapter versions and a foreign profile without changing the route', async () => {
    const core = await start(false)
    expect((await core.post('/v1/aira/attach-check', attach())).status).toBe(200)
    for (const adapterVersion of ['hermes-v0.23.1', 'hermes-v0.23.5', 'hermes-v0.23.4+canary']) {
      expect((await core.post('/v1/aira/attach-check', { ...attach(), adapterVersion })).status).toBe(400)
    }
    expect(
      (await core.post('/v1/aira/attach-check', { ...attach(), adapterVersion: 'hermes-v0.23.2', profile: 'other' }))
        .status
    ).toBe(409)
    expect(await core.ownerCall('health')).toMatchObject({
      hermes: { state: 'connected', adapterVersion: 'hermes-v0.23.4', profile: 'fixture' }
    })
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

describe('standalone typed Hermes candidate', () => {
  it('negotiates only text, preserves an identical route, and refuses stale disconnects without a model', async () => {
    const core = await start(false)
    const request = typedAttach()
    expect((await core.post('/v2/aira/attach-check', request, core.owner)).status).toBe(401)
    const attached = await core.post('/v2/aira/attach-check', request)
    expect(attached).toMatchObject({
      status: 200,
      body: { schemaVersion: 2, hermes: { state: 'connected', protocolVersion: 2, capabilities: ['text'] } }
    })
    const original = routeIdOf(attached.body)
    expect(routeIdOf((await core.post('/v2/aira/attach-check', request)).body)).toBe(original)
    expect((await core.post('/v2/aira/attach-check', { ...request, capabilities: ['text', 'sticker'] })).status).toBe(
      400
    )
    expect((await core.post('/v2/aira/attach-check', { ...request, profile: 'other' })).status).toBe(409)
    expect((await core.post('/v1/aira/attach-check', attach('disconnect'))).status).toBe(409)
    expect((await core.post('/v1/aira/attach-check', attach())).status).toBe(409)
    expect((await core.post('/v2/aira/attach-check', { ...request, deadlineMs: Date.now() - 1 })).status).toBe(409)
    expect((await core.post('/v2/aira/turn', typedTurn(original, 'fixture-a', 'm1', 'keyless'))).status).toBe(503)
    const migrated = await core.post('/v2/aira/attach-check', { ...request, adapterVersion: 'hermes-v0.23.2' })
    expect(migrated.status).toBe(200)
    const current = routeIdOf(migrated.body)
    expect(current).not.toBe(original)
    expect(
      (
        await core.post('/v2/aira/attach-check', {
          schemaVersion: 2,
          adapterVersion: 'hermes-v0.23.2',
          profile: 'fixture',
          action: 'disconnect',
          deadlineMs: Date.now() + 10_000,
          routeId: original
        })
      ).status
    ).toBe(409)
    expect(await core.ownerCall('health')).toMatchObject({
      hermes: { state: 'connected', routeId: current, capabilities: ['text'] }
    })
    expect(core.model.requests).toHaveLength(0)
  })

  it('gives concurrent identical returns one delivery claim and suppresses a later v1 replay', async () => {
    const core = await start(true)
    const routeId = routeIdOf((await core.post('/v2/aira/attach-check', typedAttach())).body)
    expect((await core.post('/v1/aira/turn', turn('fixture-a', 'v1-refused', 'wrong protocol'))).status).toBe(403)
    const defaults = z.object({ revision: z.string() }).parse(await core.ownerCall('settings?level=global&scope='))
    await core.ownerCall('settings', 'PUT', {
      level: 'global',
      scope: '',
      key: 'character',
      value: 'example',
      expectedRevision: defaults.revision
    })
    expect(await core.post('/v2/aira/turn', typedTurn(routeId, 'fixture-a', 'm1', 'pending'))).toEqual({
      status: 200,
      body: { schemaVersion: 2, disposition: 'no_reply', deliveries: [] }
    })
    expect(core.model.requests).toHaveLength(0)
    const chats = z.object({ chats: z.array(z.object({ chatId: z.string() })) }).parse(await core.ownerCall('chats'))
    await core.ownerCall(`chats/${chats.chats[0]!.chatId}/status`, 'PUT', { status: 'active' })
    const request = typedTurn(routeId, 'fixture-a', 'm2', 'synthetic reply request')
    const responses = await Promise.all([core.post('/v2/aira/turn', request), core.post('/v2/aira/turn', request)])
    expect(responses.map((result) => result.status)).toEqual([200, 200])
    const envelope = z.object({ deliveries: z.array(z.object({ id: z.uuid(), kind: z.literal('text') })) })
    const descriptors = responses.flatMap((result) => envelope.parse(result.body).deliveries)
    expect(descriptors).toHaveLength(1)
    const id = descriptors[0]!.id
    const claim = { schemaVersion: 2, profile: 'fixture', routeId, chat: 'fixture-a', mid: 'm2', id }
    expect((await core.post('/v2/aira/delivery/claim', claim, core.owner)).status).toBe(401)
    expect((await core.post('/v2/aira/delivery/claim', { ...claim, chat: 'fixture-b' })).status).toBe(409)
    expect((await core.post('/v2/aira/delivery/ack', { ...claim, outcome: 'confirmed' })).status).toBe(409)
    const delivered = await core.post('/v2/aira/delivery/claim', claim)
    expect(delivered).toMatchObject({ status: 200, body: { schemaVersion: 2, delivery: { id, kind: 'text' } } })
    expect(JSON.stringify(delivered.body)).toMatch(/fixture reply alpha/i)
    expect((await core.post('/v2/aira/delivery/claim', claim)).status).toBe(409)
    for (let retry = 0; retry < 2; retry++) {
      expect((await core.post('/v2/aira/delivery/ack', { ...claim, outcome: 'confirmed' })).status).toBe(200)
    }
    expect((await core.post('/v2/aira/delivery/ack', { ...claim, outcome: 'failed' })).status).toBe(409)
    expect(
      (
        await core.post('/v2/aira/attach-check', {
          schemaVersion: 2,
          action: 'downgrade',
          profile: 'fixture',
          adapterVersion: 'hermes-v0.23.4',
          routeId,
          deadlineMs: Date.now() + 10_000
        })
      ).status
    ).toBe(200)
    expect((await core.post('/v2/aira/delivery/claim', claim)).status).toBe(403)
    expect(await core.post('/v1/aira/turn', turn('fixture-a', 'm2', 'synthetic replay'))).toEqual({
      status: 200,
      body: { schemaVersion: 1, disposition: 'no_reply', reply: null }
    })
    expect(core.model.requests).toHaveLength(1)
  })

  it('does not issue a delivery when the route changes during a model turn', async () => {
    const core = await start(true)
    const routeId = routeIdOf((await core.post('/v2/aira/attach-check', typedAttach())).body)
    const defaults = z.object({ revision: z.string() }).parse(await core.ownerCall('settings?level=global&scope='))
    await core.ownerCall('settings', 'PUT', {
      level: 'global',
      scope: '',
      key: 'character',
      value: 'example',
      expectedRevision: defaults.revision
    })
    await core.post('/v2/aira/turn', typedTurn(routeId, 'fixture-a', 'pending', 'pending'))
    const chats = z.object({ chats: z.array(z.object({ chatId: z.string() })) }).parse(await core.ownerCall('chats'))
    await core.ownerCall(`chats/${chats.chats[0]!.chatId}/status`, 'PUT', { status: 'active' })
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const call = core.model.call.bind(core.model)
    core.model.call = async (request) => {
      entered.resolve()
      await release.promise
      return call(request)
    }
    const request = typedTurn(routeId, 'fixture-a', 'm1', 'synthetic reply request')
    const response = core.post('/v2/aira/turn', request)
    let nextRoute: string
    try {
      await entered.promise
      nextRoute = routeIdOf(
        (await core.post('/v2/aira/attach-check', { ...typedAttach(), adapterVersion: 'hermes-v0.23.2' })).body
      )
      expect(nextRoute).not.toBe(routeId)
    } finally {
      release.resolve()
    }
    expect(await response).toEqual({ status: 200, body: { schemaVersion: 2, disposition: 'no_reply', deliveries: [] } })
    expect((await core.post('/v2/aira/turn', request)).status).toBe(403)
    expect(await core.post('/v2/aira/turn', { ...request, routeId: nextRoute })).toEqual({
      status: 200,
      body: { schemaVersion: 2, disposition: 'no_reply', deliveries: [] }
    })
    expect(core.model.requests).toHaveLength(1)
  })

  it('does not return a v1 reply if v2 takes over during the same model turn', async () => {
    const core = await start(true)
    expect((await core.post('/v1/aira/attach-check', attach())).status).toBe(200)
    const defaults = z.object({ revision: z.string() }).parse(await core.ownerCall('settings?level=global&scope='))
    await core.ownerCall('settings', 'PUT', {
      level: 'global',
      scope: '',
      key: 'character',
      value: 'example',
      expectedRevision: defaults.revision
    })
    await core.post('/v1/aira/turn', turn('fixture-a', 'pending', 'pending'))
    const chats = z.object({ chats: z.array(z.object({ chatId: z.string() })) }).parse(await core.ownerCall('chats'))
    await core.ownerCall(`chats/${chats.chats[0]!.chatId}/status`, 'PUT', { status: 'active' })
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const call = core.model.call.bind(core.model)
    core.model.call = async (request) => {
      entered.resolve()
      await release.promise
      return call(request)
    }
    const pending = core.post('/v1/aira/turn', turn('fixture-a', 'm1', 'fixture request'))
    try {
      await entered.promise
      const attached = await core.post('/v2/aira/attach-check', typedAttach())
      expect(attached.status).toBe(200)
    } finally {
      release.resolve()
    }
    expect(await pending).toEqual({ status: 200, body: { schemaVersion: 1, disposition: 'no_reply', reply: null } })
    expect(core.model.requests).toHaveLength(1)
  })

  it('offers and claims a report only on an explicitly document-capable current route', async () => {
    const core = await start(true, [
      { text: 'text-only fixture reply' },
      {
        toolCalls: [
          {
            id: 'fixture-report-call',
            name: 'make_report',
            args: { title: 'Synthetic report', sections: [{ heading: 'Details', body: 'Fixture only.' }] }
          }
        ]
      },
      { text: 'Here is the report.' },
      { text: 'document disabled fixture reply' }
    ])
    const textRoute = routeIdOf((await core.post('/v2/aira/attach-check', typedAttach())).body)
    expect(await core.ownerCall('health')).toMatchObject({ capabilities: { reportDocuments: false } })
    const defaults = z.object({ revision: z.string() }).parse(await core.ownerCall('settings?level=global&scope='))
    await core.ownerCall('settings', 'PUT', {
      level: 'global',
      scope: '',
      key: 'character',
      value: 'example',
      expectedRevision: defaults.revision
    })
    await core.post('/v2/aira/turn', typedTurn(textRoute, 'fixture-a', 'pending', 'pending'))
    const chats = z.object({ chats: z.array(z.object({ chatId: z.string() })) }).parse(await core.ownerCall('chats'))
    const chatId = chats.chats[0]!.chatId
    await core.ownerCall(`chats/${chatId}/status`, 'PUT', { status: 'active' })
    await core.post('/v2/aira/turn', typedTurn(textRoute, 'fixture-a', 'text', 'hello'))
    expect(core.model.requests[0]?.tools.map((tool) => tool.name)).not.toContain('make_report')
    const docRequest = { ...typedAttach(), capabilities: ['text', 'document'] }
    const documentRoute = routeIdOf((await core.post('/v2/aira/attach-check', docRequest)).body)
    expect(documentRoute).not.toBe(textRoute)
    expect(routeIdOf((await core.post('/v2/aira/attach-check', docRequest)).body)).toBe(documentRoute)
    expect(await core.ownerCall('health')).toMatchObject({ capabilities: { reportDocuments: true } })
    expect((await core.post('/v2/aira/turn', typedTurn(textRoute, 'fixture-a', 'stale', 'stale'))).status).toBe(403)
    const reply = await core.post(
      '/v2/aira/turn',
      typedTurn(documentRoute, 'fixture-a', 'report', '/doc synthetic report in markdown')
    )
    const descriptors = z
      .object({ deliveries: z.array(z.strictObject({ id: z.uuid(), kind: z.enum(['text', 'document']) })) })
      .parse(reply.body).deliveries
    expect(descriptors.map((item) => item.kind)).toEqual(['text', 'document'])
    expect(core.model.requests[1]?.tools.map((tool) => tool.name)).toEqual(['make_report'])
    expect(JSON.stringify(reply.body)).not.toContain('/host/fixture')
    const claim = {
      schemaVersion: 2,
      profile: 'fixture',
      routeId: documentRoute,
      chat: 'fixture-a',
      mid: 'report',
      id: descriptors[1]!.id
    }
    expect((await core.post('/v2/aira/delivery/claim', { ...claim, chat: 'fixture-b' })).status).toBe(409)
    const document = await core.post('/v2/aira/delivery/claim', claim)
    const payload = z
      .object({
        delivery: z.strictObject({
          id: z.uuid(),
          kind: z.literal('document'),
          mime: z.literal('text/markdown'),
          filename: z.literal('report.md'),
          sha256: z.string(),
          base64: z.string()
        })
      })
      .parse(document.body).delivery
    expect(Buffer.from(payload.base64, 'base64').toString()).toContain('Fixture only.')
    expect((await core.post('/v2/aira/delivery/claim', claim)).status).toBe(409)
    expect((await core.post('/v2/aira/delivery/ack', { ...claim, outcome: 'confirmed' })).status).toBe(200)
    const chatSettings = z
      .object({ revision: z.string() })
      .parse(await core.ownerCall(`settings?level=chat&scope=${chatId}`))
    await core.ownerCall('settings', 'PUT', {
      level: 'chat',
      scope: chatId,
      key: 'features.reports',
      value: false,
      expectedRevision: chatSettings.revision
    })
    await core.post('/v2/aira/turn', typedTurn(documentRoute, 'fixture-a', 'disabled', 'hello'))
    expect(core.model.requests[3]?.tools.map((tool) => tool.name)).not.toContain('make_report')
    const next = routeIdOf((await core.post('/v2/aira/attach-check', typedAttach())).body)
    expect(next).not.toBe(documentRoute)
    expect(await core.ownerCall('health')).toMatchObject({ capabilities: { reportDocuments: false } })
  })

  it.each(['same', 'distinct'])(
    'does not offer reports when %s message waiters combine v1 and a document route',
    async (kind) => {
      const core = await start(true, [{ text: 'mixed route reply' }], 500)
      expect((await core.post('/v1/aira/attach-check', attach())).status).toBe(200)
      const defaults = z.object({ revision: z.string() }).parse(await core.ownerCall('settings?level=global&scope='))
      await core.ownerCall('settings', 'PUT', {
        level: 'global',
        scope: '',
        key: 'character',
        value: 'example',
        expectedRevision: defaults.revision
      })
      await core.post('/v1/aira/turn', turn('fixture-a', 'pending', 'pending'))
      const chats = z.object({ chats: z.array(z.object({ chatId: z.string() })) }).parse(await core.ownerCall('chats'))
      await core.ownerCall(`chats/${chats.chats[0]!.chatId}/status`, 'PUT', { status: 'active' })
      const v1 = core.post('/v1/aira/turn', turn('fixture-a', 'mixed', 'hello'))
      await expect
        .poll(
          () =>
            core.app.storage.read((db) =>
              db.prepare('SELECT state FROM inbound_message WHERE mid = ?').pluck().get('mixed')
            ),
          { interval: 5 }
        )
        .toBe('received')
      const routeId = routeIdOf(
        (await core.post('/v2/aira/attach-check', { ...typedAttach(), capabilities: ['text', 'document'] })).body
      )
      const v2 = core.post(
        '/v2/aira/turn',
        typedTurn(routeId, 'fixture-a', kind === 'same' ? 'mixed' : 'second', 'hello')
      )
      const responses = await Promise.all([v1, v2])
      expect(responses.map((result) => result.status)).toEqual([200, 200])
      expect(core.model.requests).toHaveLength(1)
      expect(core.model.requests[0]?.tools.map((tool) => tool.name)).not.toContain('make_report')
      expect(
        core.app.storage.read((db) =>
          db.prepare("SELECT count(*) FROM receipt WHERE kind = 'report.created'").pluck().get()
        )
      ).toBe(0)
    }
  )
})
