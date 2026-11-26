import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { type App, createApp } from '../../src/app.js'
import { createStandaloneModelStore } from '../../src/config/standalone-models.js'
import { portableReminderMid } from '../../src/gateway/reminder-scope.js'
import { scheduleEntries } from '../../src/gateway/schedule.js'
import { searchHistory } from '../../src/memory/recall.js'
import { createLogger } from '../../src/records/logger.js'
import { ensureChat, ensureSubject, setChatStatus } from '../../src/settings/chats.js'
import { setSetting } from '../../src/settings/settings.js'
import { openTurn, receiveInbound } from '../../src/storage/turns.js'
import { storeUserMessage } from '../../src/turn/window.js'
import { type Answer, queueModel } from '../support/app.js'
import { testConfig } from '../support/core.js'
import { tmpDir } from '../support/tmp.js'

const apps: App[] = []
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close()
})
const caps = ['text', 'document', 'receive-image', 'receive-audio', 'receive-video', 'receive-pdf', 'scheduler']
const epoch = '2026-01-01T12:00:00.000Z'
const dueAt = '2026-01-01T12:01:00.000Z'
const routeOf = (body: unknown) => z.object({ hermes: z.object({ routeId: z.uuid() }) }).parse(body).hermes.routeId
const deliveryOf = (body: unknown) =>
  z.object({ delivery: z.object({ id: z.uuid(), kind: z.literal('text') }) }).parse(body).delivery

async function start(
  answers: Answer[],
  root = tmpDir('aira-standalone-reminders-'),
  clock = { value: new Date(epoch) },
  batchMs = 20
) {
  const config = testConfig((value) => {
    value.storage.path = root
    value.storage.minFreeMb = 2
    value.storage.criticalFreeMb = 1
    value.gateway.hostDataDir = '/host/fixture'
    value.memory.enabled = 'off'
    value.turn.batchMs = batchMs
  })
  const store = createStandaloneModelStore(root, config)
  if (store.snapshot().savedRevision === null) {
    const saved = store.save({
      expectedRevision: null,
      fallback: null,
      main: {
        provider: 'openai-compatible',
        model: 'fixture',
        baseUrl: 'https://fixture.invalid/v1',
        effort: '',
        deepEffort: '',
        usdPerMTokIn: 0,
        usdPerMTokOut: 0,
        usdPerMTokCached: 0,
        apiKey: 'synthetic-model-key'
      }
    })
    store.requestActivation({ expectedRevision: saved.savedRevision })
  }
  const model = queueModel(answers)
  const app = await createApp({
    config,
    env: { AIRA_INSTALL_MODE: 'standalone' },
    clients: { main: model },
    now: () => clock.value,
    logger: createLogger({ level: 'error', module: 'test', sink: () => undefined })
  })
  apps.push(app)
  const gateway = await app.listen(0, '127.0.0.1')
  const site = await app.listenSite(0, '127.0.0.1')
  app.completeStartup()
  const owner = readFileSync(join(root, 'standalone', 'owner.token'), 'utf8').trim()
  const token = readFileSync(join(root, 'standalone', 'gateway.token'), 'utf8').trim()
  async function post(path: string, body: unknown, credential = token) {
    const result = await fetch(`http://127.0.0.1:${gateway.port}/v2/aira/${path}`, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + credential, 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
    return { status: result.status, body: await result.json() }
  }
  const health = async () =>
    (
      await fetch(`http://127.0.0.1:${site.port}/owner-api/core/health`, {
        headers: { 'x-tolongai-token': owner }
      })
    ).json()
  const attach = async (capabilities = caps) =>
    routeOf(
      (
        await post('attach-check', {
          schemaVersion: 2,
          adapterVersion: 'hermes-v0.23.4',
          profile: 'fixture',
          action: 'connect',
          capabilities,
          deadlineMs: clock.value.getTime() + 10_000
        })
      ).body
    )
  const scope = (routeId: string) => ({ schemaVersion: 2, profile: 'fixture', routeId })
  const chat = ensureChat(app.storage, { waId: 'fixture-reminder', type: 'dm' })
  setSetting(app.storage, { level: 'global', scope: '', key: 'character', value: 'example', actor: 'test' })
  setChatStatus(app.storage, { chatId: chat.chatId, status: 'active', actor: 'test' })
  const subject = ensureSubject(app.storage, chat.waId)
  const turn = (routeId: string, mid: string, text: string) =>
    post('turn', {
      ...scope(routeId),
      platform: 'whatsapp',
      kind: 'dm',
      chat: chat.waId,
      sender: chat.waId,
      mid,
      text
    })
  const seed = (
    id: string,
    routeId: string,
    options: { due?: string; repeat?: string; profile?: string; chatId?: string; state?: string; text?: string } = {}
  ) => {
    app.storage.tx((db) =>
      db
        .prepare(
          `INSERT INTO reminder (reminder_id,chat_id,owner_id,target_id,state,due_at,repeat,text,created_at,updated_at,standalone_route_id,standalone_profile)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          id,
          options.chatId ?? chat.chatId,
          subject,
          subject,
          options.state ?? 'active',
          options.due ?? dueAt,
          options.repeat ?? null,
          options.text ?? 'synthetic reminder',
          epoch,
          epoch,
          routeId,
          options.profile ?? 'fixture'
        )
    )
  }
  const set = (key: string, value: unknown) =>
    setSetting(app.storage, { level: 'chat', scope: chat.chatId, key, value, actor: 'test' })
  const row = (id: string) => app.storage.read((db) => db.prepare('SELECT * FROM reminder WHERE reminder_id=?').get(id))
  return { app, model, root, clock, post, health, attach, scope, chat, subject, turn, seed, set, row, owner }
}

describe('standalone route-owned reminders', () => {
  it('creates through the current typed turn, polls only when due and derives one claimed destination', async () => {
    const core = await start([
      { toolCalls: [{ id: 'fixture-reminder-call', name: 'reminder_set', args: { text: 'fixture request', dueAt } }] },
      { text: 'Reminder saved.' },
      { text: 'Synthetic due reply.' }
    ])
    const textRoute = await core.attach(['text'])
    expect(await core.health()).toMatchObject({ capabilities: { scheduler: false } })
    expect((await core.post('reminders/poll', core.scope(textRoute))).status).toBe(403)
    const routeId = await core.attach()
    expect(await core.health()).toMatchObject({ capabilities: { scheduler: true } })
    expect(existsSync(join(core.root, 'gateway', 'schedule.json'))).toBe(false)
    const created = await core.turn(routeId, 'fixture-create', 'Please remind me.')
    expect(created.status).toBe(200)
    const row = core.app.storage.read((db) => db.prepare('SELECT * FROM reminder').get())
    expect(row).toMatchObject({
      standalone_route_id: routeId,
      standalone_profile: 'fixture',
      owner_id: core.subject,
      target_id: core.subject,
      state: 'active',
      due_at: dueAt
    })
    const scope = core.scope(routeId)
    expect((await core.post('reminders/poll', scope, core.owner)).status).toBe(401)
    expect((await core.post('reminders/poll', { ...scope, chat: 'other-fixture' })).status).toBe(400)
    expect((await core.post('reminders/poll', scope)).body).toEqual({ schemaVersion: 2, delivery: null })
    expect(core.model.requests).toHaveLength(2)
    core.clock.value = new Date(dueAt)
    const id = deliveryOf((await core.post('reminders/poll', scope)).body).id
    expect(deliveryOf((await core.post('reminders/poll', scope)).body).id).toBe(id)
    const claim = { ...scope, id }
    expect((await core.post('reminders/claim', { ...claim, chat: 'other-fixture' })).status).toBe(400)
    const ordinaryBinding = core.app.storage.read((db) =>
      db.prepare('SELECT inbound_mid FROM standalone_delivery WHERE delivery_id=?').pluck().get(id)
    )
    expect(
      (await core.post('delivery/claim', { ...scope, id, chat: core.chat.waId, mid: ordinaryBinding })).status
    ).toBe(409)
    expect((await core.post('reminders/claim', claim)).body).toMatchObject({
      schemaVersion: 2,
      delivery: { id, kind: 'text', chat: core.chat.waId, text: expect.stringContaining('Synthetic due reply') }
    })
    expect((await core.post('reminders/claim', claim)).status).toBe(409)
    expect((await core.post('reminders/ack', { ...claim, outcome: 'confirmed' })).status).toBe(200)
    expect((await core.post('reminders/ack', { ...claim, outcome: 'confirmed' })).status).toBe(200)
    expect((await core.post('reminders/ack', { ...claim, outcome: 'unknown' })).status).toBe(409)
    expect((await core.post('reminders/poll', scope)).body).toEqual({ schemaVersion: 2, delivery: null })
    expect(core.model.requests).toHaveLength(3)
    expect(core.model.requests.at(-1)?.tools).toEqual([])
    expect(existsSync(join(core.root, 'gateway', 'schedule.json'))).toBe(false)
  })

  it('survives competing polls and process restart without reopening a claim', async () => {
    const core = await start([{ text: 'Synthetic reminder.' }])
    const routeId = await core.attach()
    const scope = core.scope(routeId)
    core.seed('fixture-restart', routeId)
    core.clock.value = new Date(dueAt)
    const polls = await Promise.all([core.post('reminders/poll', scope), core.post('reminders/poll', scope)])
    const descriptors = polls
      .map((poll) => z.object({ delivery: z.object({ id: z.uuid() }).nullable() }).parse(poll.body).delivery)
      .filter(Boolean)
    expect(new Set(descriptors.map((item) => item?.id)).size).toBe(1)
    const id = descriptors[0]!.id
    expect(core.model.requests).toHaveLength(1)
    await core.app.close()
    const reopened = await start([{ text: 'Must not rerun.' }], core.root, core.clock)
    expect(deliveryOf((await reopened.post('reminders/poll', scope)).body).id).toBe(id)
    const claim = { ...scope, id }
    expect((await reopened.post('reminders/claim', claim)).status).toBe(200)
    await reopened.app.close()
    const afterClaim = await start([{ text: 'Must not rerun.' }], core.root, core.clock)
    expect((await afterClaim.post('reminders/poll', scope)).body).toEqual({ schemaVersion: 2, delivery: null })
    expect((await afterClaim.post('reminders/claim', claim)).status).toBe(409)
    expect((await afterClaim.post('reminders/ack', { ...claim, outcome: 'unknown' })).status).toBe(200)
    expect(afterClaim.model.requests).toHaveLength(0)
  })

  it('keeps disabled/foreign rows dormant, skips missed repeat intervals and expires revoked offers', async () => {
    const core = await start([{ text: 'Synthetic due.' }])
    const routeId = await core.attach()
    const scope = core.scope(routeId)
    core.seed('fixture-foreign', routeId, { profile: 'other' })
    core.seed('fixture-repeat', routeId, { repeat: 'daily' })
    core.clock.value = new Date('2026-01-04T13:00:00.000Z')
    core.set('features.reminders', false)
    expect((await core.post('reminders/poll', scope)).body).toEqual({ schemaVersion: 2, delivery: null })
    core.set('features.reminders', true)
    core.set('quietHours', { start: '00:00', end: '23:59', timeZone: 'UTC' })
    const id = deliveryOf((await core.post('reminders/poll', scope)).body).id
    expect(core.row('fixture-repeat')).toMatchObject({ state: 'active', due_at: '2026-01-05T12:01:00.000Z' })
    expect(core.row('fixture-foreign')).toMatchObject({ state: 'active', due_at: dueAt })
    core.set('muted', { by: core.subject, at: epoch })
    expect((await core.post('reminders/claim', { ...scope, id })).status).toBe(409)
    core.set('muted', false)
    expect((await core.post('reminders/claim', { ...scope, id })).status).toBe(409)
    const next = await core.attach(['text'])
    expect(next).not.toBe(routeId)
    expect((await core.post('reminders/poll', scope)).status).toBe(403)
    expect((await core.post('reminders/poll', core.scope(next))).status).toBe(403)
    expect(core.model.requests).toHaveLength(1)
  })

  it('lists and cancels only current route reminders, and cancels pending repeat delivery', async () => {
    const core = await start([
      { text: 'Due reminder.' },
      { toolCalls: [{ id: 'foreign-cancel', name: 'reminder_cancel', args: { reminderId: 'foreign-route' } }] },
      { text: 'That is not in this route.' },
      { toolCalls: [{ id: 'local-cancel', name: 'reminder_cancel', args: { reminderId: 'local-repeat' } }] },
      { text: 'Canceled.' }
    ])
    const routeId = await core.attach()
    const scope = core.scope(routeId)
    core.seed('local-repeat', routeId, { repeat: 'daily', text: 'local reminder' })
    core.seed('foreign-route', randomUUID(), { text: 'foreign reminder' })
    expect(core.app.storage.read((db) => scheduleEntries(db))).toEqual([])
    expect(
      await core.app.turns.handleScheduled({
        type: 'scheduled',
        kind: 'reminder',
        reminderId: 'local-repeat',
        due: '20260101T120100Z',
        stream: false,
        includeUsage: false
      })
    ).toBeNull()
    expect((await core.turn(routeId, 'portable-reminder-forged', 'not a schedule')).status).toBe(400)
    expect((await core.post('reminders/poll', { ...scope, profile: 'other' })).status).toBe(403)
    const listed = await core.turn(routeId, 'list', '/reminders')
    expect(listed.status).toBe(200)
    const listId = z.object({ deliveries: z.array(z.object({ id: z.uuid() })) }).parse(listed.body).deliveries[0]!.id
    const listClaim = await core.post('delivery/claim', { ...scope, id: listId, chat: core.chat.waId, mid: 'list' })
    expect(JSON.stringify(listClaim.body)).toContain('local reminder')
    expect(JSON.stringify(listClaim.body)).not.toContain('foreign reminder')
    core.clock.value = new Date(dueAt)
    const id = deliveryOf((await core.post('reminders/poll', scope)).body).id
    await core.turn(routeId, 'cancel-foreign', 'Cancel the other reminder.')
    expect(core.row('foreign-route')).toMatchObject({ state: 'active' })
    await core.turn(routeId, 'cancel-local', 'Cancel the local reminder.')
    expect(core.row('local-repeat')).toMatchObject({ state: 'cancelled' })
    expect((await core.post('reminders/claim', { ...scope, id })).status).toBe(409)
    expect((await core.post('reminders/poll', scope)).body).toEqual({ schemaVersion: 2, delivery: null })
  })

  it('does no model work for an owner-muted occurrence or a queued occurrence whose route was revoked', async () => {
    const core = await start([{ text: 'Must not run.' }], undefined, { value: new Date(epoch) }, 600)
    const routeId = await core.attach()
    const scope = core.scope(routeId)
    core.seed('muted-repeat', routeId, { repeat: 'daily' })
    core.clock.value = new Date(dueAt)
    core.set('muted', { by: core.subject, at: epoch })
    expect((await core.post('reminders/poll', scope)).body).toEqual({ schemaVersion: 2, delivery: null })
    expect(core.row('muted-repeat')).toMatchObject({ due_at: '2026-01-02T12:01:00.000Z' })
    core.set('muted', false)
    core.seed('queued-revoked', routeId)
    const poll = core.post('reminders/poll', scope)
    await vi.waitFor(() => expect(core.row('queued-revoked')).toMatchObject({ state: 'fired' }))
    await core.attach(['text'])
    expect((await poll).body).toEqual({ schemaVersion: 2, delivery: null })
    expect(core.model.requests).toHaveLength(0)
  })

  it('never reclaims a consumed interrupted occurrence under a later ordinary sender or route', async () => {
    const core = await start([{ text: 'Must not run.' }])
    const routeId = await core.attach()
    for (const [id, opened] of [
      ['crash-before-open', false],
      ['crash-during-turn', true]
    ] as const) {
      core.seed(id, routeId, { state: 'fired' })
      const mid = portableReminderMid(id, dueAt)
      receiveInbound(
        core.app.storage,
        {
          chatId: core.chat.chatId,
          senderId: core.subject,
          mid,
          onNew: (db) =>
            storeUserMessage(db, {
              chatId: core.chat.chatId,
              senderId: core.subject,
              mid,
              content: 'abandoned-portable-canary-' + id
            })
        },
        () => core.clock.value
      )
      if (opened)
        openTurn(
          core.app.storage,
          {
            turnId: 'interrupted-fixture',
            chatId: core.chat.chatId,
            senderId: core.subject,
            kind: 'scheduled',
            mids: [mid],
            also: (db) =>
              db
                .prepare('UPDATE session_message SET turn_id=? WHERE chat_id=? AND mid=?')
                .run('interrupted-fixture', core.chat.chatId, mid)
          },
          () => core.clock.value
        )
    }
    await core.app.close()
    const reopened = await start([{ text: 'Ordinary reply.' }], core.root, core.clock)
    expect((await reopened.post('reminders/poll', reopened.scope(routeId))).body).toEqual({
      schemaVersion: 2,
      delivery: null
    })
    expect((await reopened.turn(routeId, 'ordinary-after-restart', 'ordinary fixture text')).status).toBe(200)
    expect(reopened.model.requests).toHaveLength(1)
    expect(JSON.stringify(reopened.model.requests[0])).not.toContain('abandoned-portable-canary')
    expect(searchHistory(reopened.app.storage, core.chat.chatId, 'abandoned-portable-canary', 10, true)).toEqual([])
    expect(
      reopened.app.storage.read((db) =>
        db.prepare("SELECT state FROM inbound_message WHERE mid LIKE 'portable-reminder-%' ORDER BY mid").pluck().all()
      )
    ).toEqual(['dropped', 'dropped'])
  })

  it('orders due occurrences, expires offers, accepts a late terminal acknowledgement and leaves detached rows dormant', async () => {
    const core = await start([{ text: 'Earliest due.' }, { text: 'Second due.' }])
    const routeId = await core.attach()
    const scope = core.scope(routeId)
    core.seed('later-fixture', routeId, { due: '2026-01-01T12:02:00.000Z' })
    core.seed('earlier-fixture', routeId)
    core.seed('future-fixture', routeId, { due: '2026-01-01T13:00:00.000Z' })
    core.clock.value = new Date('2026-01-01T12:02:00.000Z')
    const first = deliveryOf((await core.post('reminders/poll', scope)).body).id
    expect(core.row('earlier-fixture')).toMatchObject({ state: 'fired' })
    expect(core.row('later-fixture')).toMatchObject({ state: 'active' })
    core.clock.value = new Date('2026-01-01T12:13:00.000Z')
    expect((await core.post('reminders/claim', { ...scope, id: first })).status).toBe(409)
    const second = deliveryOf((await core.post('reminders/poll', scope)).body).id
    expect(second).not.toBe(first)
    expect(core.row('later-fixture')).toMatchObject({ state: 'fired' })
    expect((await core.post('reminders/claim', { ...scope, id: second })).status).toBe(200)
    core.clock.value = new Date('2026-01-01T12:24:00.000Z')
    const ack = { ...scope, id: second, outcome: 'failed' }
    expect((await core.post('reminders/ack', ack)).status).toBe(200)
    expect((await core.post('reminders/ack', ack)).status).toBe(200)
    expect((await core.post('reminders/ack', { ...ack, outcome: 'confirmed' })).status).toBe(409)
    expect(
      (
        await core.post('attach-check', {
          ...scope,
          adapterVersion: 'hermes-v0.23.4',
          action: 'disconnect',
          deadlineMs: core.clock.value.getTime() + 10_000
        })
      ).status
    ).toBe(200)
    const next = await core.attach()
    expect(next).not.toBe(routeId)
    core.clock.value = new Date('2026-01-01T13:01:00.000Z')
    expect((await core.post('reminders/poll', scope)).status).toBe(403)
    expect((await core.post('reminders/poll', core.scope(next))).body).toEqual({ schemaVersion: 2, delivery: null })
    expect(core.row('future-fixture')).toMatchObject({ state: 'active' })
    expect(core.model.requests).toHaveLength(2)
  })

  it('uses the exact reminder row beyond the normal window and leaves ordinary pending rows alone', async () => {
    const core = await start([{ text: 'Due reply.' }], undefined, { value: new Date(epoch) }, 600)
    const routeId = await core.attach()
    core.seed('isolated-occurrence', routeId, { text: 'exact occurrence canary' })
    core.clock.value = new Date(dueAt)
    const addOrdinary = (from: number, to: number) =>
      core.app.storage.tx((db) => {
        for (let i = from; i < to; i++)
          storeUserMessage(
            db,
            {
              chatId: core.chat.chatId,
              senderId: core.subject,
              mid: 'ordinary-pending-' + i,
              content: 'ordinary-pending-canary-' + i
            },
            () => core.clock.value
          )
      })
    addOrdinary(0, 1)
    const poll = core.post('reminders/poll', core.scope(routeId))
    await vi.waitFor(() => expect(core.row('isolated-occurrence')).toMatchObject({ state: 'fired' }))
    addOrdinary(1, 122)
    expect(deliveryOf((await poll).body).kind).toBe('text')
    expect(core.model.requests).toHaveLength(1)
    expect(JSON.stringify(core.model.requests[0])).toContain('exact occurrence canary')
    expect(JSON.stringify(core.model.requests[0])).not.toContain('ordinary-pending-canary')
    expect(
      core.app.storage.read((db) =>
        db
          .prepare("SELECT COUNT(*) FROM session_message WHERE mid LIKE 'ordinary-pending-%' AND turn_id IS NULL")
          .pluck()
          .get()
      )
    ).toBe(122)
  })
})
