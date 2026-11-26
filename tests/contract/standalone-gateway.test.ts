import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { type App, createApp } from '../../src/app.js'
import { createStandaloneModelStore } from '../../src/config/standalone-models.js'
import { STANDALONE_ADAPTER_VERSIONS } from '../../src/gateway/standalone.js'
import type { MediaFile } from '../../src/media/limits.js'
import { createLogger } from '../../src/records/logger.js'
import { ensureChat, ensureSubject, setChatStatus } from '../../src/settings/chats.js'
import { setSetting } from '../../src/settings/settings.js'
import { receiveInbound } from '../../src/storage/turns.js'
import { storeUserMessage } from '../../src/turn/window.js'
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
  batchMs = 20,
  mediaConfigured = false
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
      fallback: null,
      ...(mediaConfigured
        ? { media: { provider: 'gemini', model: 'fixture-watcher', apiKey: 'synthetic-media-key' } }
        : {})
    })
    store.requestActivation({ expectedRevision: saved.savedRevision })
  }
  const model = queueModel(answers)
  const watch = vi.fn(async (_file: MediaFile) => ({
    reading: { description: 'synthetic visual evidence' },
    usage: { inputTokens: 10, outputTokens: 10, cachedTokens: 0 },
    costUsd: 0,
    model: 'fixture-watcher'
  }))
  const app = await createApp({
    config,
    env: { AIRA_INSTALL_MODE: 'standalone' },
    clients: { main: model },
    mediaWatcher: { watch },
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
  return { app, model, post, ownerCall, owner, token, root, watch }
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

const mediaCapabilities = ['text', 'document', 'receive-image', 'receive-audio', 'receive-video', 'receive-pdf']
const mediaAttach = () => ({ ...typedAttach(), capabilities: mediaCapabilities })
const mediaTurn = (routeId: string, chat: string, mid: string, bytes: Buffer, kind = 'image', mime = 'image/png') => ({
  ...typedTurn(routeId, chat, mid, 'fixture caption'),
  media: {
    kind,
    mime,
    base64: bytes.toString('base64'),
    sha256: createHash('sha256').update(bytes).digest('hex')
  }
})
const png = Buffer.from('89504e470d0a1a0a00000000', 'hex')

describe('standalone direct media candidate', () => {
  async function ready(core: Awaited<ReturnType<typeof start>>) {
    const route = await core.post('/v2/aira/attach-check', mediaAttach())
    expect(route.status).toBe(200)
    const routeId = routeIdOf(route.body)
    const chat = ensureChat(core.app.storage, { waId: 'fixture-media', type: 'dm' })
    setSetting(core.app.storage, { level: 'global', scope: '', key: 'character', value: 'example', actor: 'test' })
    setChatStatus(core.app.storage, { chatId: chat.chatId, status: 'active', actor: 'test' })
    return { routeId, chat }
  }

  it('reads each finite kind with the applied watcher, without paths or repeated provider calls', async () => {
    const core = await start(true, [{ text: 'fixture reply' }], 20, true)
    const { routeId, chat } = await ready(core)
    expect(await core.ownerCall('health')).toMatchObject({ capabilities: { inboundMedia: true } })
    const fixtures = [
      ['image', 'image/png', png],
      ['image', 'image/jpeg', Buffer.from('ffd8ff00', 'hex')],
      ['audio', 'audio/mpeg', Buffer.from('ID3synthetic')],
      ['voice', 'audio/ogg', Buffer.from('OggSsynthetic')],
      ['video', 'video/mp4', Buffer.from('00000018667479706d703432', 'hex')],
      ['document', 'application/pdf', Buffer.from('%PDF-1.5\nsynthetic')]
    ] as const
    for (const [kind, mime, bytes] of fixtures) {
      const input = mediaTurn(routeId, chat.waId, 'fixture-' + kind + '-' + mime.replace('/', '-'), bytes, kind, mime)
      const result = await core.post('/v2/aira/media-turn', input)
      expect(result.status).toBe(200)
      expect(result.body).toMatchObject({ disposition: 'reply' })
      expect(core.watch.mock.lastCall?.[0]).toEqual({ data: bytes, contentType: mime })
      expect((await core.post('/v2/aira/media-turn', input)).body).toMatchObject({ disposition: 'no_reply' })
    }
    expect(core.watch).toHaveBeenCalledTimes(fixtures.length)
    expect(core.model.requests).toHaveLength(fixtures.length)
    expect(JSON.stringify(core.model.requests[0])).toContain('synthetic visual evidence')
    expect(JSON.stringify(core.model.requests[0])).not.toContain(png.toString('base64'))
  })

  it('refuses wrong routes, unconfigured, malformed and unauthorized media before watcher or main', async () => {
    const core = await start(true, [{ text: 'fixture reply' }], 20, true)
    const { routeId, chat } = await ready(core)
    const input = mediaTurn(routeId, chat.waId, 'fixture-input', png)
    expect((await core.post('/v2/aira/media-turn', input, core.owner)).status).toBe(401)
    expect((await core.post('/v2/aira/media-turn', { ...input, routeId: randomUUID() })).status).toBe(403)
    expect((await core.post('/v2/aira/media-turn', { ...input, profile: 'other' })).status).toBe(403)
    for (const malformed of [
      { ...input, path: '/fixture/not-authorized' },
      { ...input, sender: '' },
      { ...input, media: { ...input.media, mime: 'image/jpeg' } },
      { ...input, media: { ...input.media, sha256: 'a'.repeat(64) } },
      { ...input, media: { ...input.media, base64: input.media.base64 + '=' } },
      { ...input, media: { ...input.media, kind: 'document' } },
      { ...input, media: { ...input.media, filename: 'fixture.png' } }
    ])
      expect((await core.post('/v2/aira/media-turn', malformed)).status).toBe(400)
    expect((await core.post('/v2/aira/media-turn', { ...input, kind: 'group' })).status).toBe(409)
    expect((await core.post('/v2/aira/media-turn', { ...input, chat: 'unknown-fixture' })).status).toBe(409)
    const pending = ensureChat(core.app.storage, { waId: 'pending-fixture', type: 'dm' })
    expect((await core.post('/v2/aira/media-turn', { ...input, chat: pending.waId })).status).toBe(409)
    const tooLarge = Buffer.alloc(5 * 1024 * 1024 + 1)
    png.copy(tooLarge)
    expect((await core.post('/v2/aira/media-turn', mediaTurn(routeId, chat.waId, 'oversize', tooLarge))).status).toBe(
      400
    )
    const bodyOverflow = await core
      .post('/v2/aira/media-turn', {
        ...input,
        media: { ...input.media, base64: 'A'.repeat(8 * 1024 * 1024) }
      })
      .then(
        (result) => result.status,
        () => null
      )
    // The HTTP reader destroys an over-limit connection rather than buffering it.
    expect([null, 400]).toContain(bodyOverflow)
    expect((await core.post('/v2/aira/turn', input)).status).toBe(400)
    setSetting(core.app.storage, {
      level: 'chat',
      scope: chat.chatId,
      key: 'features.media',
      value: false,
      actor: 'test'
    })
    expect((await core.post('/v2/aira/media-turn', input)).status).toBe(409)
    const old = await core.post('/v2/aira/attach-check', typedAttach())
    expect(routeIdOf(old.body)).not.toBe(routeId)
    expect((await core.post('/v2/aira/media-turn', input)).status).toBe(403)
    expect(await core.ownerCall('health')).toMatchObject({ capabilities: { inboundMedia: false } })
    expect(core.watch).not.toHaveBeenCalled()
    expect(core.model.requests).toHaveLength(0)
    const noRole = await start(true)
    const missing = await ready(noRole)
    expect(await noRole.ownerCall('health')).toMatchObject({ capabilities: { inboundMedia: false } })
    expect(
      (await noRole.post('/v2/aira/media-turn', mediaTurn(missing.routeId, missing.chat.waId, 'fixture', png))).status
    ).toBe(503)
    expect(noRole.watch).not.toHaveBeenCalled()
    expect(noRole.model.requests).toHaveLength(0)
  })

  it('does not watch muted, unauthorized sender or media queued under a revoked route', async () => {
    const core = await start(true, [{ text: 'fixture reply' }], 600, true)
    const { routeId, chat } = await ready(core)
    const set = (key: string, value: unknown) =>
      setSetting(core.app.storage, { level: 'chat', scope: chat.chatId, key, value, actor: 'test' })
    set('muted', { by: 'fixture', at: '2026-01-01T00:00:00.000Z' })
    expect((await core.post('/v2/aira/media-turn', mediaTurn(routeId, chat.waId, 'muted', png))).status).toBe(409)
    set('muted', false)
    set('allowedSenders', [])
    expect(
      (await core.post('/v2/aira/media-turn', mediaTurn(routeId, chat.waId, 'not-allowed', png))).body
    ).toMatchObject({ disposition: 'no_reply' })
    set('allowedSenders', 'all')
    const queued = core.post('/v2/aira/media-turn', mediaTurn(routeId, chat.waId, 'queued-revocation', png))
    await vi.waitFor(() => {
      expect(
        core.app.storage.read((db) =>
          db.prepare('SELECT mid FROM inbound_message WHERE mid = ?').pluck().get('queued-revocation')
        )
      ).toBe('queued-revocation')
    })
    const textOnly = routeIdOf((await core.post('/v2/aira/attach-check', typedAttach())).body)
    expect(textOnly).not.toBe(routeId)
    expect((await queued).body).toMatchObject({ disposition: 'no_reply' })
    expect(core.watch).not.toHaveBeenCalled()
    expect(core.model.requests).toHaveLength(0)
  })

  it('limits concurrent media requests while their bytes remain in the turn queue', async () => {
    const core = await start(true, [{ text: 'fixture reply' }], 20, true)
    const { routeId, chat } = await ready(core)
    const initialWatch = core.watch.getMockImplementation()!
    let release!: () => void
    const block = new Promise<void>((resolve) => {
      release = resolve
    })
    core.watch.mockImplementation(async (file) => {
      await block
      return initialWatch(file)
    })
    const requests = Array.from({ length: 4 }, (_, i) =>
      core.post('/v2/aira/media-turn', mediaTurn(routeId, chat.waId, 'concurrent-' + i, png))
    )
    try {
      await vi.waitFor(() => {
        expect(
          core.app.storage.read((db) =>
            db.prepare("SELECT COUNT(*) FROM inbound_message WHERE mid LIKE 'concurrent-%'").pluck().get()
          )
        ).toBe(4)
      })
      expect(
        (await core.post('/v2/aira/media-turn', mediaTurn(routeId, chat.waId, 'concurrent-overflow', png))).status
      ).toBe(429)
    } finally {
      release()
      await Promise.all(requests)
    }
    expect(core.watch).toHaveBeenCalledTimes(4)
    expect((await core.post('/v2/aira/media-turn', mediaTurn(routeId, chat.waId, 'after-release', png))).status).toBe(
      200
    )
    expect(core.watch).toHaveBeenCalledTimes(5)
  })

  it('cannot introduce bytes on a retry of a durably received message after interruption', async () => {
    const core = await start(true, [{ text: 'fixture reply' }], 20, true)
    const { routeId, chat } = await ready(core)
    const senderId = ensureSubject(core.app.storage, chat.waId)
    const mid = 'previously-received'
    // This is the durable state after ingress committed but before the old process ran the turn.
    receiveInbound(core.app.storage, {
      chatId: chat.chatId,
      senderId,
      mid,
      onNew: (db) => storeUserMessage(db, { chatId: chat.chatId, senderId, mid, content: 'previous text' })
    })
    const result = await core.post('/v2/aira/media-turn', mediaTurn(routeId, chat.waId, mid, png))
    expect(result.status).toBe(200)
    expect(core.watch).not.toHaveBeenCalled()
    expect(core.model.requests).toHaveLength(1)
    expect(JSON.stringify(core.model.requests[0])).toContain('previous text')
  })

  it('keeps the first pending bytes and isolates media from a newer admitted text sender', async () => {
    const core = await start(true, [{ text: 'fixture reply' }], 200, true)
    const { routeId, chat } = await ready(core)
    const input = mediaTurn(routeId, chat.waId, 'duplicate-media', png)
    const first = core.post('/v2/aira/media-turn', input)
    await vi.waitFor(() => {
      expect(
        core.app.storage.read((db) =>
          db.prepare('SELECT mid FROM inbound_message WHERE mid = ?').pluck().get(input.mid)
        )
      ).toBe(input.mid)
    })
    const replacement = Buffer.concat([png, Buffer.from('replacement')])
    const second = core.post('/v2/aira/media-turn', mediaTurn(routeId, chat.waId, input.mid, replacement))
    const replies = await Promise.all([first, second])
    expect(
      replies.filter((reply) => z.object({ disposition: z.string() }).parse(reply.body).disposition === 'reply')
    ).toHaveLength(1)
    expect(core.watch).toHaveBeenCalledTimes(1)
    expect(core.watch.mock.lastCall?.[0].data).toEqual(png)

    const group = ensureChat(core.app.storage, { waId: 'fixture-group', type: 'group' })
    setChatStatus(core.app.storage, { chatId: group.chatId, status: 'active', actor: 'test' })
    const allowedSender = ensureSubject(core.app.storage, 'fixture-allowed')
    setSetting(core.app.storage, {
      level: 'chat',
      scope: group.chatId,
      key: 'allowedSenders',
      value: [allowedSender],
      actor: 'test'
    })
    const blocked = core.post('/v2/aira/media-turn', {
      ...mediaTurn(routeId, group.waId, 'blocked-media', png),
      kind: 'group',
      sender: 'fixture-blocked'
    })
    await vi.waitFor(() => {
      expect(
        core.app.storage.read((db) =>
          db.prepare('SELECT mid FROM inbound_message WHERE mid = ?').pluck().get('blocked-media')
        )
      ).toBe('blocked-media')
    })
    const allowed = core.post('/v2/aira/turn', {
      ...typedTurn(routeId, group.waId, 'allowed-text', 'allowed text'),
      kind: 'group',
      sender: 'fixture-allowed'
    })
    expect((await blocked).body).toMatchObject({ disposition: 'no_reply' })
    expect((await allowed).body).toMatchObject({ disposition: 'reply' })
    expect(core.watch).toHaveBeenCalledTimes(1)
    expect(core.model.requests).toHaveLength(2)
    setSetting(core.app.storage, {
      level: 'chat',
      scope: chat.chatId,
      key: 'muted',
      value: { by: 'fixture', at: '2026-01-01T00:00:00.000Z' },
      actor: 'test'
    })
    expect(
      (await core.post('/v2/aira/turn', typedTurn(routeId, chat.waId, 'muted-text', 'ordinary text'))).body
    ).toMatchObject({ disposition: 'reply' })
    expect(core.watch).toHaveBeenCalledTimes(1)
  })
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

  it('allows explicit document attachment in keyless setup without authorizing a model turn', async () => {
    const core = await start(false)
    const attached = await core.post('/v2/aira/attach-check', { ...typedAttach(), capabilities: ['text', 'document'] })
    expect(attached.status).toBe(200)
    const route = routeIdOf(attached.body)
    const response = await core.post('/v2/aira/turn', typedTurn(route, 'fixture-a', 'keyless', '/doc fixture'))
    expect(response.status).toBe(503)
    expect(core.model.requests).toHaveLength(0)
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
      {
        toolCalls: [
          {
            id: 'implicit-report-call',
            name: 'make_report',
            args: { title: 'Implicit synthetic report', sections: [{ heading: 'Details', body: 'Implicit fixture.' }] }
          }
        ]
      },
      { text: 'Here is the implicit report.' },
      {
        toolCalls: [
          {
            id: 'disabled-report-call',
            name: 'make_report',
            args: { title: 'Disabled synthetic report', sections: [{ heading: 'Details', body: 'Not permitted.' }] }
          }
        ]
      },
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
    const implicit = await core.post(
      '/v2/aira/turn',
      typedTurn(documentRoute, 'fixture-a', 'implicit', 'Please write a brief Markdown report.')
    )
    expect(implicit.status).toBe(200)
    expect(implicit.body).toMatchObject({ deliveries: [{ kind: 'text' }, { kind: 'document' }] })
    expect(core.model.requests[3]?.tools.map((tool) => tool.name)).toContain('make_report')
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
    const disabled = await core.post('/v2/aira/turn', typedTurn(documentRoute, 'fixture-a', 'disabled', 'hello'))
    expect(disabled.body).toMatchObject({ deliveries: [{ kind: 'text' }] })
    expect(core.model.requests[5]?.tools.map((tool) => tool.name)).not.toContain('make_report')
    expect(
      core.app.storage.read((db) =>
        db.prepare("SELECT count(*) FROM receipt WHERE kind = 'report.created'").pluck().get()
      )
    ).toBe(2)
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
