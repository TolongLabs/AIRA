import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { CharacterFooterWriter } from '../../src/api/footer-writer.js'
import { hostAllowed, originAllowed } from '../../src/api/writes.js'
import { type App, createApp } from '../../src/app.js'
import { buildFooter } from '../../src/format/footer.js'
import { applyOperation } from '../../src/memory/store.js'
import { ModelError } from '../../src/models/types.js'
import { createLogger } from '../../src/records/logger.js'
import {
  ensureChat,
  ensureSubject,
  getChatByWaId,
  linkIdentity,
  setChatLabel,
  setChatStatus,
  setDisplayName
} from '../../src/settings/chats.js'
import { setSetting, unsetSetting } from '../../src/settings/settings.js'
import { type Answer, CHAT, msg, queueModel, startApp } from '../support/app.js'
import { addPack, testConfig } from '../support/core.js'
import { tmpDir } from '../support/tmp.js'

const createdApps: App[] = []
afterEach(async () => {
  for (const app of createdApps.splice(0)) await app.close()
})

async function startWithSite(answers: Answer[] = [{ text: 'Hello from test!' }]) {
  const model = queueModel(answers)
  const started = await startApp(model, {
    config: (config) => {
      config.social.ytDlpPath = '/missing/aira-test-extractor'
    }
  })
  const address = await started.app.listenSite(0, '127.0.0.1')
  const siteUrl = `http://127.0.0.1:${address.port}`
  return { ...started, model, siteUrl }
}

function apiFetch(siteUrl: string, path: string, options: { method?: string } = {}) {
  return fetch(`${siteUrl}${path}`, { method: options.method ?? 'GET' })
}

describe('site API read routes', () => {
  it('serves /api/* routes without a Bearer token when SITE_TOKEN is absent', async () => {
    const { siteUrl } = await startWithSite()
    const expectations: [string, number][] = [
      ['/api/health', 200],
      ['/api/chats', 200],
      ['/api/settings?level=global&scope=', 200],
      ['/api/turns', 200],
      ['/api/turns/turn-missing', 404],
      ['/api/feedback/report-missing', 404],
      ['/api/report', 404],
      ['/api/memory?chat=c_test', 200],
      ['/api/characters', 200],
      ['/api/tools', 200]
    ]
    for (const [path, status] of expectations) {
      const res = await apiFetch(siteUrl, path)
      expect(res.status, path).toBe(status)
    }
  })

  it('lists registry tool metadata grouped by feature without exposing definitions', async () => {
    const { app, siteUrl } = await startWithSite()
    for (const mode of ['implicit', 'explicit', 'both'] as const) {
      app.registry.register({
        name: `site_${mode}`,
        description: 'Private tool implementation detail',
        schema: z.object({}),
        mode,
        feature: 'features.site_test',
        mutates: false,
        ...(mode === 'implicit'
          ? {}
          : { command: { names: [mode, `${mode}alias`], kind: 'skill' as const, usage: mode } }),
        handler: () => ({ ok: true, data: {} })
      })
    }
    const res = await apiFetch(siteUrl, '/api/tools')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      features: { key: string; tools: { name: string; mode: string; commands: string[] }[] }[]
      socialCapabilities: Record<string, { id: string; name: string; operations: string[] }[]>
    }
    expect(body.features.find((feature) => feature.key === 'features.site_test')).toEqual({
      key: 'features.site_test',
      tools: [
        { name: 'site_implicit', mode: 'implicit', commands: [] },
        { name: 'site_explicit', mode: 'explicit', commands: ['/explicit', '/explicitalias'] },
        { name: 'site_both', mode: 'both', commands: ['/both', '/bothalias'] }
      ]
    })
    expect(body.features.flatMap((feature) => feature.tools).length).toBeGreaterThan(3)
    expect(body.features.every((feature) => feature.key.length > 0)).toBe(true)
    expect(body.features.flatMap((feature) => feature.tools).some((tool) => tool.name === 'help')).toBe(false)
    expect(body.socialCapabilities['features.social']).toContainEqual(expect.objectContaining({ id: 'x', name: 'X' }))
    expect(body.socialCapabilities['features.autofetch']?.map(({ id }) => id).sort()).toEqual([
      'bluesky',
      'facebook',
      'instagram',
      'lemon8',
      'threads',
      'x'
    ])
    expect(body.socialCapabilities['features.autofetch']).toContainEqual({
      id: 'x',
      name: 'X',
      operations: ['photos', 'video']
    })
    expect(JSON.stringify(body)).not.toContain('Private tool implementation detail')
  })

  it('reports ready status and role configuration on /api/health', async () => {
    const { siteUrl } = await startWithSite()
    const res = await apiFetch(siteUrl, '/api/health')
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

    const chatsRes = await apiFetch(siteUrl, '/api/chats')
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

    const turnsRes = await apiFetch(siteUrl, '/api/turns')
    expect(turnsRes.status).toBe(200)
    const turnsBody = (await turnsRes.json()) as { turns: { turn_id: string; chat_id: string; state: string }[] }
    expect(turnsBody.turns).toHaveLength(1)
    const turnId = turnsBody.turns[0]?.turn_id
    expect(turnId).toEqual(expect.any(String))
    expect(turnsBody.turns[0]?.chat_id).toBe(chatId)
    expect(turnsBody.turns[0]?.state).toBe('delivered')

    const turnRes = await apiFetch(siteUrl, `/api/turns/${turnId}`)
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
    const turnsAfterRes = await apiFetch(siteUrl, '/api/turns')
    const turnsAfter = (await turnsAfterRes.json()) as { turns: { turn_id: string }[] }
    expect(turnsAfter.turns).toHaveLength(2)
    const failedTurnId = turnsAfter.turns[0]?.turn_id
    const failedRes = await apiFetch(siteUrl, `/api/turns/${failedTurnId}`)
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

    const res = await apiFetch(siteUrl, '/api/settings?level=global&scope=')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      level: 'global',
      scope: '',
      values: { character: 'example', language: 'en' }
    })

    const bad = await apiFetch(siteUrl, '/api/settings?level=bogus&scope=')
    expect(bad.status).toBe(400)
  })

  it('requires chat on /api/memory and isolates items per chat', async () => {
    const { app, siteUrl, chatId } = await startWithSite()
    const other = ensureChat(app.storage, { waId: 'test-chat-g2', type: 'group' })

    app.storage.tx((db) => {
      applyOperation(db, chatId, { op: 'add', key: 'likes.tea', value: 'oolong', quote: 'q1' }, {})
      applyOperation(db, other.chatId, { op: 'add', key: 'likes.coffee', value: 'espresso', quote: 'q2' }, {})
    })

    const missing = await apiFetch(siteUrl, '/api/memory')
    expect(missing.status).toBe(400)
    expect(await missing.json()).toEqual({ error: 'chat_required' })

    const res = await apiFetch(siteUrl, `/api/memory?chat=${chatId}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: { key: string; value: string; status: string }[] }
    expect(body.items).toHaveLength(1)
    expect(body.items[0]).toMatchObject({ key: 'likes.tea', value: 'oolong', status: 'active' })
  })

  it('returns 404 no_snapshot on /api/report when no snapshot exists', async () => {
    const { siteUrl } = await startWithSite()
    const res = await apiFetch(siteUrl, '/api/report')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'no_snapshot' })
  })

  it('shows feedback answers beside their chat turns without leaking ref', async () => {
    const { app, siteUrl, gateway, chatId } = await startWithSite()
    await gateway.send(msg('feedback-context', 'A message for context'))
    const turnId = app.storage.read((db) => db.prepare('SELECT turn_id FROM turn LIMIT 1').pluck().get()) as string
    const at = new Date().toISOString()
    app.storage.tx((db) =>
      db
        .prepare(
          `INSERT INTO feedback_report
       (report_id, ref, chat_id, subject_id, turn_id, turn_ids, state, issued_at, expires_at, received_at, form_seq, answers)
       VALUES (?, ?, ?, ?, ?, ?, 'received', ?, ?, ?, 1, ?)`
        )
        .run(
          'fb_api_test',
          'ABCDE23456',
          chatId,
          'test-subject',
          turnId,
          JSON.stringify([turnId]),
          at,
          at,
          at,
          JSON.stringify({ whatWentWrong: 'Test feedback', expected: '', kind: 'Other', when: '', severity: '' })
        )
    )
    const response = await apiFetch(siteUrl, '/api/feedback/fb_api_test')
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      report: { answers: { whatWentWrong: string } }
      turns: { turn: { turn_id: string } }[]
    }
    expect(body.report.answers.whatWentWrong).toBe('Test feedback')
    expect(body.turns[0]?.turn.turn_id).toBe(turnId)
    expect(JSON.stringify(body)).not.toContain('ABCDE23456')
    expect((await apiFetch(siteUrl, '/api/feedback/missing')).status).toBe(404)
  })

  it('returns 405 on non-GET for known routes and 404 on unknown routes', async () => {
    const { siteUrl } = await startWithSite()

    const postChats = await apiFetch(siteUrl, '/api/chats', { method: 'POST' })
    expect(postChats.status).toBe(405)
    expect(await postChats.json()).toEqual({ error: 'method_not_allowed' })

    const unknown = await apiFetch(siteUrl, '/api/nope')
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toEqual({ error: 'not_found' })
  })

  it('always builds and listens the site server when SITE_TOKEN is absent without site_api.no_token', async () => {
    const { app, logs } = await startApp(queueModel([{ text: 'hi' }]), { env: {} })
    expect(app.siteServer).toBeDefined()
    const address = await app.listenSite(0, '127.0.0.1')
    expect(address.port).toBeGreaterThan(0)
    expect(logs.some((entry) => entry['event'] === 'site_api.no_token')).toBe(false)
    const health = await fetch(`http://127.0.0.1:${address.port}/api/health`)
    expect(health.status).toBe(200)
  })

  it('resolves missing chat labels from channel_directory.json and identity.display_name', async () => {
    const dataDir = tmpDir('aira-dir-data-')
    const dirFile = join(tmpDir('aira-dir-'), 'channel_directory.json')
    writeFileSync(
      dirFile,
      JSON.stringify({
        platforms: {
          whatsapp: [
            { id: '0000000@g.us', name: '  Weekend Crew  ' },
            { id: '00000000@s.whatsapp.net', name: 'Directory Alice' },
            { id: '000000000@g.us', name: '   ' }
          ]
        }
      })
    )
    const config = testConfig((cfg) => {
      cfg.storage.path = dataDir
      cfg.storage.minFreeMb = 2
      cfg.storage.criticalFreeMb = 1
      cfg.gateway.hostDataDir = '/host/aira-data'
      cfg.llm.main = {
        ...cfg.llm.main,
        provider: 'openai-compatible',
        model: 'main-model',
        baseUrl: 'https://main.invalid/v1'
      }
      cfg.social.ytDlpPath = '/missing/aira-test-extractor'
    })
    const app = await createApp({
      config,
      env: {},
      channelDirectoryPath: dirFile,
      clients: { main: queueModel([{ text: 'ok' }]) },
      logger: createLogger({ level: 'error', module: 'core', sink: () => {} })
    })
    createdApps.push(app)
    const address = await app.listenSite(0, '127.0.0.1')
    const siteUrl = `http://127.0.0.1:${address.port}`

    const groupFromDir = ensureChat(app.storage, { waId: '0000000@g.us', type: 'group' })
    const groupExplicit = ensureChat(app.storage, { waId: '0000000000@g.us', type: 'group' })
    setChatLabel(app.storage, { chatId: groupExplicit.chatId, label: 'Pinned Group', actor: 'site' })
    const groupBlankDir = ensureChat(app.storage, { waId: '000000000@g.us', type: 'group' })
    ensureSubject(app.storage, '000000000@g.us')
    setDisplayName(app.storage, '000000000@g.us', 'Should Not Apply To Group')

    const dmFromDir = ensureChat(app.storage, { waId: '00000000@s.whatsapp.net', type: 'dm' })
    ensureSubject(app.storage, '00000000@s.whatsapp.net')
    setDisplayName(app.storage, '00000000@s.whatsapp.net', 'Identity Alice')

    const dmFromIdentity = ensureChat(app.storage, { waId: '00000000000@s.whatsapp.net', type: 'dm' })
    ensureSubject(app.storage, '00000000000@s.whatsapp.net')
    setDisplayName(app.storage, '00000000000@s.whatsapp.net', 'Bob Identity')

    const dmLinked = ensureChat(app.storage, { waId: '000000000000@s.whatsapp.net', type: 'dm' })
    const linkedSubject = ensureSubject(app.storage, '0000000000000@lid')
    setDisplayName(app.storage, '0000000000000@lid', 'Carol Linked')
    linkIdentity(app.storage, { waId: '000000000000@s.whatsapp.net', subjectId: linkedSubject, actor: 'site' })

    const res = await apiFetch(siteUrl, '/api/chats')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { chats: { chatId: string; label: string }[] }
    const byId = new Map(body.chats.map((c) => [c.chatId, c.label]))

    expect(body.chats.find((c) => c.chatId === groupFromDir.chatId)).toMatchObject({ storedLabel: '' })
    expect(body.chats.find((c) => c.chatId === groupExplicit.chatId)).toMatchObject({ storedLabel: 'Pinned Group' })
    expect(byId.get(groupFromDir.chatId)).toBe('Weekend Crew')
    expect(byId.get(groupExplicit.chatId)).toBe('Pinned Group')
    expect(byId.get(groupBlankDir.chatId)).toBe('')
    expect(byId.get(dmFromDir.chatId)).toBe('Directory Alice')
    expect(byId.get(dmFromIdentity.chatId)).toBe('Bob Identity')
    expect(byId.get(dmLinked.chatId)).toBe('Carol Linked')

    // Missing or unreadable channel directory degrades cleanly without throwing.
    writeFileSync(dirFile, '{not valid json')
    const resFallback = await apiFetch(siteUrl, '/api/chats')
    expect(resFallback.status).toBe(200)
    const bodyFallback = (await resFallback.json()) as { chats: { chatId: string; label: string }[] }
    const fallbackById = new Map(bodyFallback.chats.map((c) => [c.chatId, c.label]))
    expect(fallbackById.get(groupFromDir.chatId)).toBe('')
    expect(fallbackById.get(dmFromDir.chatId)).toBe('Identity Alice')
    expect(fallbackById.get(dmFromIdentity.chatId)).toBe('Bob Identity')
  })

  it('auto-saves DM label from gateway senderName once and leaves groups and labeled DMs unchanged', async () => {
    const { app, gateway, siteUrl } = await startWithSite([{ text: 'Hi!' }, { text: 'Hello!' }, { text: 'Hey!' }])
    const dmWaId = '00000000000000@s.whatsapp.net'
    const dm = ensureChat(app.storage, { waId: dmWaId, type: 'dm' })
    setChatStatus(app.storage, { chatId: dm.chatId, status: 'active', actor: 'test' })

    await gateway.send({
      chat: { waId: dmWaId, kind: 'dm' },
      sender: dmWaId,
      mid: 'dm-msg-1',
      text: 'hello',
      name: 'Alice DM'
    })
    expect(getChatByWaId(app.storage, dmWaId)?.label).toBe('Alice DM')

    // Subsequent turns or different senderName must not overwrite an existing DM label.
    await gateway.send({
      chat: { waId: dmWaId, kind: 'dm' },
      sender: dmWaId,
      mid: 'dm-msg-2',
      text: 'again',
      name: 'Other Name'
    })
    expect(getChatByWaId(app.storage, dmWaId)?.label).toBe('Alice DM')

    // Group messages with senderName do not auto-label the group chat.
    await gateway.send({
      chat: { waId: CHAT, kind: 'group' },
      sender: '000000000000000@s.whatsapp.net',
      mid: 'grp-msg-1',
      text: 'group hi',
      name: 'Group Sender'
    })
    expect(getChatByWaId(app.storage, CHAT)?.label).toBe('')

    const labelChanges = app.storage.read((db) =>
      db
        .prepare(
          "SELECT target, actor, level, scope, key, old_value, new_value FROM setting_change WHERE key = 'label'"
        )
        .all()
    )
    expect(labelChanges).toEqual([
      {
        target: 'chat',
        actor: 'gateway',
        level: 'chat',
        scope: dm.chatId,
        key: 'label',
        old_value: null,
        new_value: null
      }
    ])
    expect(JSON.stringify(labelChanges)).not.toContain('Alice DM')

    const chatsRes = await apiFetch(siteUrl, '/api/chats')
    const chatsBody = (await chatsRes.json()) as { chats: { chatId: string; label: string }[] }
    expect(chatsBody.chats.find((c) => c.chatId === dm.chatId)?.label).toBe('Alice DM')
  })
})

function writeStatus(siteUrl: string, chatId: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${siteUrl}/api/chats/${encodeURIComponent(chatId)}/status`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  })
}

function writeLabel(
  siteUrl: string,
  chatId: string,
  body: unknown,
  method = 'PUT',
  headers: Record<string, string> = {}
) {
  return fetch(`${siteUrl}/api/chats/${chatId}/label`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  })
}

describe('site API write routes', () => {
  it('switches a chat on and off, once, with a change record by the site', async () => {
    const { app, siteUrl } = await startWithSite()
    const chat = ensureChat(app.storage, { waId: 'test-chat-w1', type: 'dm' })
    const on = await writeStatus(siteUrl, chat.chatId, { status: 'active' })
    expect(on.status).toBe(200)
    expect(await on.json()).toEqual({ chatId: chat.chatId, status: 'active', changed: true })
    const again = await writeStatus(siteUrl, chat.chatId, { status: 'active' })
    expect(await again.json()).toEqual({ chatId: chat.chatId, status: 'active', changed: false })
    const rows = app.storage.read((db) =>
      db.prepare("SELECT actor, new_value FROM setting_change WHERE scope = ? AND key = 'status'").all(chat.chatId)
    )
    expect(rows).toEqual([{ actor: 'site', new_value: '"active"' }])
    const listed = (await (await apiFetch(siteUrl, '/api/chats')).json()) as {
      chats: { chatId: string; status: string }[]
    }
    expect(listed.chats.find((entry) => entry.chatId === chat.chatId)?.status).toBe('active')
    const off = await writeStatus(siteUrl, chat.chatId, { status: 'pending' })
    expect(await off.json()).toMatchObject({ status: 'pending', changed: true })
  })

  it('requires a loaded effective character to activate a chat, while switching to pending always succeeds', async () => {
    const { app, siteUrl } = await startWithSite()
    unsetSetting(app.storage, { level: 'global', scope: '', key: 'character', actor: 'test' })
    const chat = ensureChat(app.storage, { waId: 'test-chat-bind-status', type: 'dm' })

    // Unbound chat cannot be activated.
    const missing = await writeStatus(siteUrl, chat.chatId, { status: 'active' })
    expect(missing.status).toBe(400)
    expect(await missing.json()).toEqual({ error: 'missing_character' })
    expect(
      app.storage.read((db) => db.prepare('SELECT status FROM chat WHERE chat_id = ?').pluck().get(chat.chatId))
    ).toBe('pending')

    // Unloaded character at chat level also refuses activation.
    setSetting(app.storage, { level: 'chat', scope: chat.chatId, key: 'character', value: 'not_loaded', actor: 'test' })
    const unloaded = await writeStatus(siteUrl, chat.chatId, { status: 'active' })
    expect(unloaded.status).toBe(400)
    expect(await unloaded.json()).toEqual({ error: 'missing_character' })

    // Binding a loaded character allows activation.
    const loaded = [...app.packs().packs.keys()][0] as string
    setSetting(app.storage, { level: 'chat', scope: chat.chatId, key: 'character', value: loaded, actor: 'test' })
    const activated = await writeStatus(siteUrl, chat.chatId, { status: 'active' })
    expect(activated.status).toBe(200)
    expect(await activated.json()).toEqual({ chatId: chat.chatId, status: 'active', changed: true })

    // Switching to pending always succeeds, even if the active chat's character is no longer loaded.
    setSetting(app.storage, { level: 'chat', scope: chat.chatId, key: 'character', value: 'not_loaded', actor: 'test' })
    const deactivated = await writeStatus(siteUrl, chat.chatId, { status: 'pending' })
    expect(deactivated.status).toBe(200)
    expect(await deactivated.json()).toEqual({ chatId: chat.chatId, status: 'pending', changed: true })
  })

  it('refuses a body that is not JSON, a bad body, an unknown chat and a foreign origin without a Bearer token', async () => {
    const { app, siteUrl } = await startWithSite()
    const chat = ensureChat(app.storage, { waId: 'test-chat-w2', type: 'dm' })
    expect((await writeStatus(siteUrl, chat.chatId, 'status=active', { 'content-type': 'text/plain' })).status).toBe(
      415
    )
    expect((await writeStatus(siteUrl, chat.chatId, '{not json')).status).toBe(400)
    expect((await writeStatus(siteUrl, chat.chatId, { status: 'on' })).status).toBe(400)
    expect((await writeStatus(siteUrl, chat.chatId, { status: 'active', extra: 1 })).status).toBe(400)
    expect((await writeStatus(siteUrl, 'c_missing', { status: 'active' })).status).toBe(404)
    const foreign = await writeStatus(siteUrl, chat.chatId, { status: 'active' }, { origin: 'https://evil.example' })
    expect(foreign.status).toBe(403)
    expect(await foreign.json()).toEqual({ error: 'origin_refused' })
    expect((await writeStatus(siteUrl, chat.chatId, 'x'.repeat(17 * 1024))).status).toBe(413)
    const status = app.storage.read((db) =>
      db.prepare('SELECT status FROM chat WHERE chat_id = ?').pluck().get(chat.chatId)
    )
    expect(status).toBe('pending')
  })

  it('refuses a write whose Host is a name, so a rebound page cannot reach the API', async () => {
    const { app, siteUrl } = await startWithSite()
    const chat = ensureChat(app.storage, { waId: 'test-chat-w3', type: 'dm' })
    const { port } = new URL(siteUrl)
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          method: 'PUT',
          path: `/api/chats/${chat.chatId}/status`,
          headers: {
            host: `attacker.example:${port}`,
            'content-type': 'application/json'
          }
        },
        (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        }
      )
      req.on('error', reject)
      req.end('{"status":"active"}')
    })
    expect(status).toBe(403)
    expect(hostAllowed('127.0.0.1:9898')).toBe(true)
    expect(hostAllowed('localhost:9898')).toBe(true)
    expect(hostAllowed('[::1]:9898')).toBe(true)
    expect(hostAllowed('aira.example:9898')).toBe(false)
    expect(hostAllowed(undefined)).toBe(false)
    expect(originAllowed(undefined, [])).toBe(true)
    expect(originAllowed('https://site.example', ['https://site.example/'])).toBe(true)
    expect(originAllowed('https://other.example', ['https://site.example'])).toBe(false)
  })

  it('validates, persists and logs PUT /api/chats/:chatId/label without leaking label text', async () => {
    const { app, siteUrl, logs } = await startWithSite()
    const chat = ensureChat(app.storage, { waId: 'test-chat-label-1', type: 'group' })
    const secretLabel = 'Secret Family Chat'

    const saved = await writeLabel(siteUrl, encodeURIComponent(chat.chatId), { label: `  ${secretLabel}  ` })
    expect(saved.status).toBe(200)
    expect(await saved.json()).toEqual({ chatId: chat.chatId, label: secretLabel, changed: true })

    // Repeating with the same trimmed label writes no extra row and returns changed: false.
    const repeat = await writeLabel(siteUrl, encodeURIComponent(chat.chatId), { label: secretLabel })
    expect(repeat.status).toBe(200)
    expect(await repeat.json()).toEqual({ chatId: chat.chatId, label: secretLabel, changed: false })

    // GET /api/chats reflects the persisted label.
    const listed = (await (await apiFetch(siteUrl, '/api/chats')).json()) as {
      chats: { chatId: string; label: string }[]
    }
    expect(listed.chats.find((entry) => entry.chatId === chat.chatId)?.label).toBe(secretLabel)

    // Trimming happens before the 120-character limit; clearing to '' works.
    const max120 = 'a'.repeat(120)
    const maxRes = await writeLabel(siteUrl, encodeURIComponent(chat.chatId), { label: `  ${max120}  ` })
    expect(maxRes.status).toBe(200)
    expect(await maxRes.json()).toEqual({ chatId: chat.chatId, label: max120, changed: true })

    const cleared = await writeLabel(siteUrl, encodeURIComponent(chat.chatId), { label: '   ' })
    expect(cleared.status).toBe(200)
    expect(await cleared.json()).toEqual({ chatId: chat.chatId, label: '', changed: true })

    // setting_change logs key='label' with actor='site' and NULL values, never storing label text.
    const changes = app.storage.read((db) =>
      db
        .prepare(
          "SELECT target, actor, level, scope, key, old_value, new_value FROM setting_change WHERE scope = ? AND key = 'label' ORDER BY id"
        )
        .all(chat.chatId)
    )
    expect(changes).toHaveLength(3)
    for (const row of changes) {
      expect(row).toEqual({
        target: 'chat',
        actor: 'site',
        level: 'chat',
        scope: chat.chatId,
        key: 'label',
        old_value: null,
        new_value: null
      })
    }
    expect(JSON.stringify(changes)).not.toContain(secretLabel)
    expect(JSON.stringify(logs)).not.toContain(secretLabel)

    // Validation, missing chat, bad path escape, wrong method, and Origin/Host checks.
    expect((await writeLabel(siteUrl, 'c_missing', { label: 'Nope' })).status).toBe(404)
    expect((await writeLabel(siteUrl, '%ZZ', { label: 'Nope' })).status).toBe(400)
    expect((await writeLabel(siteUrl, encodeURIComponent(chat.chatId), { label: 'Nope' }, 'POST')).status).toBe(405)
    for (const badBody of [{}, { label: 42 }, { label: 'ok', extra: 1 }, { label: 'a'.repeat(121) }]) {
      const bad = await writeLabel(siteUrl, encodeURIComponent(chat.chatId), badBody)
      expect(bad.status, JSON.stringify(badBody)).toBe(400)
      expect(await bad.json()).toEqual({ error: 'invalid_body' })
    }
    const foreign = await writeLabel(siteUrl, encodeURIComponent(chat.chatId), { label: 'X' }, 'PUT', {
      origin: 'https://evil.example'
    })
    expect(foreign.status).toBe(403)
    expect(await foreign.json()).toEqual({ error: 'origin_refused' })

    const { port } = new URL(siteUrl)
    const badHost = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          method: 'PUT',
          path: `/api/chats/${chat.chatId}/label`,
          headers: { host: `attacker.example:${port}`, 'content-type': 'application/json' }
        },
        (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        }
      )
      req.on('error', reject)
      req.end('{"label":"X"}')
    })
    expect(badHost).toBe(403)
  })
})

function writeSetting(siteUrl: string, body: unknown) {
  return fetch(`${siteUrl}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
}

describe('site API settings write', () => {
  it('sets, repeats and clears one key at one level, with change records by the site', async () => {
    const { app, siteUrl } = await startWithSite()
    const set = await writeSetting(siteUrl, { level: 'type', scope: 'dm', key: 'language', value: 'ms' })
    expect(await set.json()).toEqual({ level: 'type', scope: 'dm', key: 'language', value: 'ms', changed: true })
    const repeat = await writeSetting(siteUrl, { level: 'type', scope: 'dm', key: 'language', value: 'ms' })
    expect(await repeat.json()).toMatchObject({ changed: false })
    const cleared = await writeSetting(siteUrl, { level: 'type', scope: 'dm', key: 'language', value: null })
    expect(await cleared.json()).toMatchObject({ value: null, changed: true })
    const actors = app.storage.read((db) =>
      db.prepare("SELECT actor FROM setting_change WHERE key = 'language' ORDER BY rowid").pluck().all()
    )
    expect(actors).toEqual(['site', 'site'])
  })

  it('binds a loaded pack and refuses one that is not loaded', async () => {
    const { app, siteUrl, chatId } = await startWithSite()
    const loaded = [...app.packs().packs.keys()][0] as string
    const bound = await writeSetting(siteUrl, { level: 'chat', scope: chatId, key: 'character', value: loaded })
    expect(bound.status).toBe(200)
    const missing = await writeSetting(siteUrl, { level: 'global', scope: '', key: 'character', value: 'no-such-pack' })
    expect(missing.status).toBe(400)
    expect(await missing.json()).toEqual({ error: 'unknown_character' })
  })

  it('refuses clearing chat character on an active chat without a loaded inherited character', async () => {
    const { app, siteUrl } = await startWithSite()
    const loaded = [...app.packs().packs.keys()][0] as string
    unsetSetting(app.storage, { level: 'global', scope: '', key: 'character', actor: 'test' })

    const activeChat = ensureChat(app.storage, { waId: 'test-chat-clear-active', type: 'group' })
    setSetting(app.storage, { level: 'chat', scope: activeChat.chatId, key: 'character', value: loaded, actor: 'test' })
    setChatStatus(app.storage, { chatId: activeChat.chatId, status: 'active', actor: 'test' })

    // No type or global character exists -> clearing chat character is refused.
    const refusedUnset = await writeSetting(siteUrl, {
      level: 'chat',
      scope: activeChat.chatId,
      key: 'character',
      value: null
    })
    expect(refusedUnset.status).toBe(400)
    expect(await refusedUnset.json()).toEqual({ error: 'missing_character' })

    // Unloaded type-level character overrides loaded global character -> clearing chat character is refused.
    setSetting(app.storage, { level: 'global', scope: '', key: 'character', value: loaded, actor: 'test' })
    setSetting(app.storage, { level: 'type', scope: 'group', key: 'character', value: 'not_loaded', actor: 'test' })
    const refusedUnloadedType = await writeSetting(siteUrl, {
      level: 'chat',
      scope: activeChat.chatId,
      key: 'character',
      value: null
    })
    expect(refusedUnloadedType.status).toBe(400)
    expect(await refusedUnloadedType.json()).toEqual({ error: 'missing_character' })

    // Loaded type-level character -> clearing chat character succeeds.
    setSetting(app.storage, { level: 'type', scope: 'group', key: 'character', value: loaded, actor: 'test' })
    const clearedWithType = await writeSetting(siteUrl, {
      level: 'chat',
      scope: activeChat.chatId,
      key: 'character',
      value: null
    })
    expect(clearedWithType.status).toBe(200)
    expect(await clearedWithType.json()).toEqual({
      level: 'chat',
      scope: activeChat.chatId,
      key: 'character',
      value: null,
      changed: true
    })

    // Loaded global-level character with no type override -> clearing chat character succeeds.
    setSetting(app.storage, { level: 'chat', scope: activeChat.chatId, key: 'character', value: loaded, actor: 'test' })
    unsetSetting(app.storage, { level: 'type', scope: 'group', key: 'character', actor: 'test' })
    const clearedWithGlobal = await writeSetting(siteUrl, {
      level: 'chat',
      scope: activeChat.chatId,
      key: 'character',
      value: null
    })
    expect(clearedWithGlobal.status).toBe(200)
    expect(await clearedWithGlobal.json()).toEqual({
      level: 'chat',
      scope: activeChat.chatId,
      key: 'character',
      value: null,
      changed: true
    })

    // Pending chat can clear chat character even with no inherited character.
    unsetSetting(app.storage, { level: 'global', scope: '', key: 'character', actor: 'test' })
    const pendingChat = ensureChat(app.storage, { waId: 'test-chat-clear-pending', type: 'dm' })
    setSetting(app.storage, {
      level: 'chat',
      scope: pendingChat.chatId,
      key: 'character',
      value: loaded,
      actor: 'test'
    })
    const clearedPending = await writeSetting(siteUrl, {
      level: 'chat',
      scope: pendingChat.chatId,
      key: 'character',
      value: null
    })
    expect(clearedPending.status).toBe(200)
    expect(await clearedPending.json()).toEqual({
      level: 'chat',
      scope: pendingChat.chatId,
      key: 'character',
      value: null,
      changed: true
    })
  })

  it('refuses an unknown key, a bad value, a bad scope, a missing value and an unknown chat', async () => {
    const { siteUrl } = await startWithSite()
    const refused = async (body: unknown) => {
      const res = await writeSetting(siteUrl, body)
      return [res.status, ((await res.json()) as { error: string }).error]
    }
    expect(await refused({ level: 'global', scope: '', key: 'no_such_key', value: 1 })).toEqual([
      400,
      'invalid_setting'
    ])
    expect(await refused({ level: 'global', scope: '', key: 'language', value: 42 })).toEqual([400, 'invalid_setting'])
    expect(await refused({ level: 'type', scope: 'channel', key: 'language', value: null })).toEqual([
      400,
      'invalid_setting'
    ])
    expect(await refused({ level: 'type', scope: 'channel', key: 'language', value: 'ms' })).toEqual([
      400,
      'invalid_setting'
    ])
    expect(await refused({ level: 'global', scope: '', key: 'language' })).toEqual([400, 'invalid_body'])
    expect(await refused({ level: 'chat', scope: 'c_missing', key: 'language', value: 'ms' })).toEqual([
      404,
      'not_found'
    ])
  })

  it('accepts valid nameCall.names and rejects invalid values', async () => {
    const { siteUrl, chatId } = await startWithSite()
    const ok = await writeSetting(siteUrl, {
      level: 'chat',
      scope: chatId,
      key: 'nameCall.names',
      value: ['Taiga', 'Ah Boy', 'Café', '小明', 'A1']
    })
    expect(ok.status).toBe(200)

    const cleared = await writeSetting(siteUrl, { level: 'chat', scope: chatId, key: 'nameCall.names', value: null })
    expect(cleared.status).toBe(200)

    const invalid = [
      [],
      ['One', 'Two', 'Three', 'Four', 'Five', 'Six'],
      ['A'],
      ['a'.repeat(25)],
      ['  '],
      [' Taiga'],
      ['Taiga '],
      ['Taiga!'],
      ['Taiga_1'],
      ['Taiga', 'taiga'],
      'Taiga',
      [123]
    ]
    for (const value of invalid) {
      const res = await writeSetting(siteUrl, { level: 'chat', scope: chatId, key: 'nameCall.names', value })
      expect(res.status, JSON.stringify(value)).toBe(400)
      expect(await res.json()).toEqual({ error: 'invalid_setting' })
    }
  })
})

describe('serving the site', () => {
  async function startServing() {
    const siteDir = tmpDir('aira-site-')
    mkdirSync(join(siteDir, 'assets'))
    writeFileSync(join(siteDir, 'index.html'), '<!doctype html><title>AIRA</title>')
    writeFileSync(join(siteDir, 'assets', 'app-1a2b.js'), 'console.log(1)')
    writeFileSync(join(siteDir, 'secret.env'), 'NOT_SERVED=1')
    const started = await startApp(queueModel([{ text: 'hi' }]), { siteDir })
    const address = await started.app.listenSite(0, '127.0.0.1')
    return { ...started, siteUrl: `http://127.0.0.1:${address.port}` }
  }

  it('serves the build under /app/, redirects / there, and keeps /api/ open without a token', async () => {
    const { siteUrl } = await startServing()
    const page = await fetch(`${siteUrl}/app/`)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toContain('text/html')
    expect(page.headers.get('cache-control')).toBe('no-cache')
    expect(await page.text()).toContain('<title>AIRA</title>')
    const asset = await fetch(`${siteUrl}/app/assets/app-1a2b.js`)
    expect(asset.headers.get('cache-control')).toContain('immutable')
    const root = await fetch(`${siteUrl}/`, { redirect: 'manual' })
    expect(root.status).toBe(302)
    expect(root.headers.get('location')).toBe('/app/')
  })

  it('serves nothing outside the build, no unknown file type, and no write', async () => {
    const { siteUrl } = await startServing()
    for (const path of ['/app/../config.yml', '/app/%2e%2e/config.yml', '/app/secret.env', '/app/missing.html', '/x']) {
      expect((await fetch(`${siteUrl}${path}`)).status).toBe(404)
    }
    expect((await fetch(`${siteUrl}/app/`, { method: 'POST' })).status).toBe(405)
    expect((await fetch(`${siteUrl}/api/health`)).status).toBe(200)
  })

  it("accepts a browser write from the API's own origin", async () => {
    const { app, siteUrl } = await startServing()
    const chat = ensureChat(app.storage, { waId: 'test-chat-w4', type: 'dm' })
    const ok = await writeStatus(siteUrl, chat.chatId, { status: 'active' }, { origin: siteUrl })
    expect(ok.status).toBe(200)
  })
})

function writeFooter(siteUrl: string, id: string, body: unknown, method = 'PUT') {
  return fetch(`${siteUrl}/api/characters/${id}/footer`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
}

function addCleanDataPack(dataDir: string, id: string, comment?: string): string {
  addPack(dataDir, id)
  const cardPath = join(dataDir, 'characters', id, 'card.yml')
  const raw = readFileSync(cardPath, 'utf8').replace(/\ntoolFooter:[\s\S]*$/, '\n')
  writeFileSync(cardPath, comment ? `# ${comment}\n${raw}` : raw, 'utf8')
  return cardPath
}

describe('site API characters', () => {
  it('lists the loaded packs with their names and sources, and the packs that did not load', async () => {
    const { siteUrl } = await startWithSite()
    const res = await apiFetch(siteUrl, '/api/characters')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      characters: { id: string; displayName: string; source: string; languages: string[]; toolFooter: unknown }[]
      faults: unknown[]
      footerKinds: { kind: string; defaultLabel: string }[]
    }
    expect(body.characters.map((pack) => pack.id)).toContain('example')
    const example = body.characters.find((pack) => pack.id === 'example')
    expect(example?.source).toBe('repository')
    expect(typeof example?.displayName).toBe('string')
    expect(Array.isArray(body.faults)).toBe(true)
    expect(Array.isArray(body.footerKinds)).toBe(true)
  })

  it('site-api: GET /api/characters lists toolFooter per pack and footerKinds with defaults', async () => {
    const { dataDir, siteUrl } = await startWithSite()
    addCleanDataPack(dataDir, 'custom')
    const res = await apiFetch(siteUrl, '/api/characters')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      characters: {
        id: string
        source: string
        toolFooter: { icon?: string; labels?: Record<string, string> }
      }[]
      footerKinds: { kind: string; defaultLabel: string }[]
    }
    const example = body.characters.find((c) => c.id === 'example')
    expect(example?.toolFooter).toEqual({
      labels: {
        media_video: 'watched a video',
        media_youtube: 'watched a video',
        media_image: 'looked at an image',
        media_audio: 'listened to audio',
        media_document: 'read a document',
        media_post: 'read a post'
      }
    })
    const custom = body.characters.find((c) => c.id === 'custom')
    expect(custom?.source).toBe('data')
    expect(custom?.toolFooter).toEqual({})

    const kinds = body.footerKinds.map((entry) => entry.kind)
    expect(kinds).toEqual([...kinds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)))
    expect(body.footerKinds).toEqual(
      expect.arrayContaining([
        { kind: 'media_video', defaultLabel: 'watched a video' },
        { kind: 'media_youtube', defaultLabel: 'watched a video' },
        { kind: 'research_start', defaultLabel: 'started research' },
        { kind: 'report_pdf', defaultLabel: 'made a PDF' },
        { kind: 'web_search', defaultLabel: 'searched the web' },
        { kind: 'market_quote', defaultLabel: 'used market quote' }
      ])
    )
  })

  it('site-api: PUT footer sets a label, writes one setting_change row of target pack, and the next packs() sees it', async () => {
    const { app, dataDir, siteUrl } = await startWithSite()
    const cardPath = addCleanDataPack(dataDir, 'custom', 'keep this comment')

    const res = await writeFooter(siteUrl, 'custom', {
      icon: '🧪',
      labels: { media_video: '  watched a clip  ' }
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      id: 'custom',
      toolFooter: { icon: '🧪', labels: { media_video: 'watched a clip' } },
      changed: true
    })

    const changes = app.storage.read((db) =>
      db
        .prepare(
          "SELECT target, actor, level, scope, key, old_value, new_value FROM setting_change WHERE target = 'pack' ORDER BY id"
        )
        .all()
    )
    expect(changes).toEqual([
      {
        target: 'pack',
        actor: 'site',
        level: null,
        scope: 'custom',
        key: 'toolFooter.icon',
        old_value: null,
        new_value: '"🧪"'
      },
      {
        target: 'pack',
        actor: 'site',
        level: null,
        scope: 'custom',
        key: 'toolFooter.labels.media_video',
        old_value: null,
        new_value: '"watched a clip"'
      }
    ])

    const pack = app.packs().packs.get('custom')
    expect(pack?.card.toolFooter).toEqual({ icon: '🧪', labels: { media_video: 'watched a clip' } })
    expect(readFileSync(cardPath, 'utf8')).toContain('# keep this comment')
  })

  it('site-api: PUT footer with null removes the key and the default applies', async () => {
    const { app, dataDir, siteUrl } = await startWithSite()
    const cardPath = addCleanDataPack(dataDir, 'custom')

    expect(
      (await writeFooter(siteUrl, 'custom', { icon: '🧪', labels: { media_video: 'watched a clip' } })).status
    ).toBe(200)

    const clearOne = await writeFooter(siteUrl, 'custom', { labels: { media_video: null } })
    expect(clearOne.status).toBe(200)
    expect(await clearOne.json()).toEqual({
      id: 'custom',
      toolFooter: { icon: '🧪' },
      changed: true
    })
    expect(readFileSync(cardPath, 'utf8')).not.toContain('labels:')

    const clearIcon = await writeFooter(siteUrl, 'custom', { icon: null })
    expect(clearIcon.status).toBe(200)
    expect(await clearIcon.json()).toEqual({
      id: 'custom',
      toolFooter: {},
      changed: true
    })
    expect(readFileSync(cardPath, 'utf8')).not.toContain('toolFooter:')

    const pack = app.packs().packs.get('custom')
    expect(pack?.card.toolFooter).toBeUndefined()
    expect(buildFooter(['media_video'], pack?.card.toolFooter)).toBe('_🛠️ watched a video_')
  })

  it('site-api: PUT footer on a repository pack is 409 pack_read_only', async () => {
    const { siteUrl } = await startWithSite()
    const res = await writeFooter(siteUrl, 'example', { labels: { web_search: 'looked online' } })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'pack_read_only' })
  })

  it('site-api: PUT footer on an unparseable card.yml is 409 pack_unparseable and leaves the file byte-identical', async () => {
    const { dataDir, siteUrl } = await startWithSite()
    const cardPath = addCleanDataPack(dataDir, 'broken')
    const brokenBytes = Buffer.from('id: [unclosed\n# secret parser line\n', 'utf8')
    writeFileSync(cardPath, brokenBytes)

    const res = await writeFooter(siteUrl, 'broken', { labels: { web_search: 'looked online' } })
    expect(res.status).toBe(409)
    const text = await res.text()
    expect(JSON.parse(text)).toEqual({ error: 'pack_unparseable' })
    expect(text).not.toContain('secret parser line')
    expect(readFileSync(cardPath).equals(brokenBytes)).toBe(true)

    const invalidSchemaBytes = Buffer.from('id: broken\ndisplayName: Broken\n', 'utf8')
    writeFileSync(cardPath, invalidSchemaBytes)
    const res2 = await writeFooter(siteUrl, 'broken', { labels: { web_search: 'looked online' } })
    expect(res2.status).toBe(409)
    expect(await res2.json()).toEqual({ error: 'pack_unparseable' })
    expect(readFileSync(cardPath).equals(invalidSchemaBytes)).toBe(true)
  })

  it('site-api: PUT footer with an unknown kind is 400 unknown_footer_kind', async () => {
    const { dataDir, siteUrl } = await startWithSite()
    addCleanDataPack(dataDir, 'custom')
    const res = await writeFooter(siteUrl, 'custom', { labels: { no_such_tool: 'did something' } })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'unknown_footer_kind' })
  })

  it('site-api: an unchanged PUT returns changed false and writes no row', async () => {
    const { app, dataDir, siteUrl } = await startWithSite()
    addCleanDataPack(dataDir, 'custom')

    expect((await writeFooter(siteUrl, 'custom', { icon: '🧪', labels: { web_search: 'searched' } })).status).toBe(200)
    const countBefore = app.storage.read((db) =>
      Number(db.prepare("SELECT count(*) FROM setting_change WHERE target = 'pack'").pluck().get())
    )

    const repeat = await writeFooter(siteUrl, 'custom', { icon: '🧪', labels: { web_search: 'searched' } })
    expect(repeat.status).toBe(200)
    expect(await repeat.json()).toEqual({
      id: 'custom',
      toolFooter: { icon: '🧪', labels: { web_search: 'searched' } },
      changed: false
    })

    const noop = await writeFooter(siteUrl, 'custom', {})
    expect(noop.status).toBe(200)
    expect(await noop.json()).toMatchObject({ changed: false })

    const countAfter = app.storage.read((db) =>
      Number(db.prepare("SELECT count(*) FROM setting_change WHERE target = 'pack'").pluck().get())
    )
    expect(countAfter).toBe(countBefore)
  })

  it('rejects invalid footer values, unknown packs, bad escapes, wrong methods and rolls back failed loadPack', async () => {
    const { app, dataDir, siteUrl } = await startWithSite()
    const cardPath = addCleanDataPack(dataDir, 'custom')

    expect((await writeFooter(siteUrl, 'missing_pack', { icon: '🧪' })).status).toBe(404)
    expect((await writeFooter(siteUrl, '%ZZ', { icon: '🧪' })).status).toBe(400)
    expect((await writeFooter(siteUrl, 'custom', { icon: '🧪' }, 'POST')).status).toBe(405)

    for (const badBody of [
      { icon: 'not-emoji' },
      { icon: '🛠️_' },
      { labels: { web_search: 'has_underscore' } },
      { labels: { web_search: 'line1\nline2' } },
      { labels: { web_search: '   ' } },
      { labels: { web_search: 'a'.repeat(41) } }
    ]) {
      const badRes = await writeFooter(siteUrl, 'custom', badBody)
      expect(badRes.status, JSON.stringify(badBody)).toBe(400)
      expect(await badRes.json()).toEqual({ error: 'invalid_footer' })
    }

    // Pre-existing load fault (mismatched id before edit) passes cardSchema, fails loadPack -> 409 pack_unparseable.
    const mismatched = readFileSync(cardPath, 'utf8').replace(/^id: custom$/m, 'id: other')
    writeFileSync(cardPath, mismatched, 'utf8')
    const rollbackRes = await writeFooter(siteUrl, 'custom', { icon: '🧪' })
    expect(rollbackRes.status).toBe(409)
    expect(await rollbackRes.json()).toEqual({ error: 'pack_unparseable' })
    expect(readFileSync(cardPath, 'utf8')).toBe(mismatched)
    expect(
      app.storage.read((db) =>
        Number(db.prepare("SELECT count(*) FROM setting_change WHERE target = 'pack'").pluck().get())
      )
    ).toBe(0)
  })

  it('returns aliases on GET /api/characters when a pack configures aliases', async () => {
    const { dataDir, siteUrl } = await startWithSite()
    const cardPath = addCleanDataPack(dataDir, 'aliased')
    const updated = readFileSync(cardPath, 'utf8').replace(
      /^displayName: Example$/m,
      'displayName: Aliased\naliases:\n  - Ari\n  - Example Bot'
    )
    writeFileSync(cardPath, updated, 'utf8')

    const res = await apiFetch(siteUrl, '/api/characters')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      characters: { id: string; aliases?: string[] }[]
    }
    const aliased = body.characters.find((entry) => entry.id === 'aliased')
    const example = body.characters.find((entry) => entry.id === 'example')
    expect(aliased?.aliases).toEqual(['Ari', 'Example Bot'])
    expect(example).not.toHaveProperty('aliases')
  })

  it('rolls back with 400 invalid_footer when a clean pack fails reload after footer write', async () => {
    const { app, dataDir } = await startWithSite()
    const cardPath = addCleanDataPack(dataDir, 'custom')
    const snapshot = app.packs()
    const mismatched = readFileSync(cardPath, 'utf8').replace(/^id: custom$/m, 'id: other')
    writeFileSync(cardPath, mismatched, 'utf8')

    const writer = new CharacterFooterWriter({
      registry: app.registry,
      storage: app.storage,
      packs: () => snapshot,
      paths: app.paths,
      version: '0.0.0',
      ready: () => true,
      activeTurns: () => 0,
      roles: () => ({
        main: { configured: true, breakerOpen: false },
        fallback: { configured: false, breakerOpen: false },
        judge: { configured: false, breakerOpen: false },
        media: { configured: false, breakerOpen: false }
      })
    })

    const res = writer.write('custom', { icon: '🧪' })
    expect(res).toEqual({ status: 400, body: { error: 'invalid_footer' } })
    expect(readFileSync(cardPath, 'utf8')).toBe(mismatched)
    expect(
      app.storage.read((db) =>
        Number(db.prepare("SELECT count(*) FROM setting_change WHERE target = 'pack'").pluck().get())
      )
    ).toBe(0)
  })

  it('restores card.yml when setting_change insert fails during PUT /api/characters/:id/footer', async () => {
    const { app, dataDir, siteUrl } = await startWithSite()
    const cardPath = addCleanDataPack(dataDir, 'custom', 'restore on audit failure')
    const beforeBytes = readFileSync(cardPath)

    app.storage.tx((db) => {
      db.exec(`
        CREATE TRIGGER abort_pack_audit
        BEFORE INSERT ON setting_change
        WHEN NEW.target = 'pack'
        BEGIN
          SELECT RAISE(ABORT, 'audit insert blocked');
        END;
      `)
    })

    const res = await writeFooter(siteUrl, 'custom', { icon: '🧪', labels: { web_search: 'searched' } })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'internal' })
    expect(readFileSync(cardPath).equals(beforeBytes)).toBe(true)
    expect(existsSync(`${cardPath}.tmp`)).toBe(false)
    expect(
      app.storage.read((db) =>
        Number(db.prepare("SELECT count(*) FROM setting_change WHERE target = 'pack'").pluck().get())
      )
    ).toBe(0)
  })
})
