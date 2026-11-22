import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { hostAllowed, originAllowed } from '../../src/api/writes.js'
import { buildFooter } from '../../src/format/footer.js'
import { applyOperation } from '../../src/memory/store.js'
import { ModelError } from '../../src/models/types.js'
import { ensureChat } from '../../src/settings/chats.js'
import { setSetting } from '../../src/settings/settings.js'
import { type Answer, CHAT, msg, queueModel, startApp } from '../support/app.js'
import { addPack } from '../support/core.js'
import { tmpDir } from '../support/tmp.js'

const TOKEN = 'test-site-token-0123456789abcdefghijklmn' // 40 invented characters
const WRONG_TOKEN = 'xxxx-site-token-0123456789abcdefghijklmn' // same length (40)

async function startWithSite(answers: Answer[] = [{ text: 'Hello from test!' }]) {
  const model = queueModel(answers)
  const started = await startApp(model, {
    env: { SITE_TOKEN: TOKEN },
    config: (config) => {
      config.social.ytDlpPath = '/missing/aira-test-extractor'
    }
  })
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
      '/api/feedback/report-missing',
      '/api/report',
      '/api/memory?chat=c_test',
      '/api/characters',
      '/api/tools'
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
    const res = await apiFetch(siteUrl, '/api/tools', { token: TOKEN })
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

  it('shows feedback answers beside their chat turns only through the protected API', async () => {
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
    expect((await apiFetch(siteUrl, '/api/feedback/fb_api_test')).status).toBe(401)
    const response = await apiFetch(siteUrl, '/api/feedback/fb_api_test', { token: TOKEN })
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      report: { answers: { whatWentWrong: string } }
      turns: { turn: { turn_id: string } }[]
    }
    expect(body.report.answers.whatWentWrong).toBe('Test feedback')
    expect(body.turns[0]?.turn.turn_id).toBe(turnId)
    expect(JSON.stringify(body)).not.toContain('ABCDE23456')
    expect((await apiFetch(siteUrl, '/api/feedback/missing', { token: TOKEN })).status).toBe(404)
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

function writeStatus(siteUrl: string, chatId: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${siteUrl}/api/chats/${encodeURIComponent(chatId)}/status`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...headers },
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
    const listed = (await (await apiFetch(siteUrl, '/api/chats', { token: TOKEN })).json()) as {
      chats: { chatId: string; status: string }[]
    }
    expect(listed.chats.find((entry) => entry.chatId === chat.chatId)?.status).toBe('active')
    const off = await writeStatus(siteUrl, chat.chatId, { status: 'pending' })
    expect(await off.json()).toMatchObject({ status: 'pending', changed: true })
  })

  it('refuses a missing token, a body that is not JSON, a bad body, an unknown chat and a foreign origin', async () => {
    const { app, siteUrl } = await startWithSite()
    const chat = ensureChat(app.storage, { waId: 'test-chat-w2', type: 'dm' })
    const noToken = await fetch(`${siteUrl}/api/chats/${chat.chatId}/status`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '{"status":"active"}'
    })
    expect(noToken.status).toBe(401)
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
            authorization: `Bearer ${TOKEN}`,
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
})

function writeSetting(siteUrl: string, body: unknown) {
  return fetch(`${siteUrl}/api/settings`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
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
    const started = await startApp(queueModel([{ text: 'hi' }]), { env: { SITE_TOKEN: TOKEN }, siteDir })
    const address = await started.app.listenSite(0, '127.0.0.1')
    if (!address) throw new Error('expected site server to listen')
    return { ...started, siteUrl: `http://127.0.0.1:${address.port}` }
  }

  it('serves the build under /app/ without a token, and redirects / there', async () => {
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
    expect((await fetch(`${siteUrl}/api/health`)).status).toBe(401)
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
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
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
    const res = await apiFetch(siteUrl, '/api/characters', { token: TOKEN })
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
    const res = await apiFetch(siteUrl, '/api/characters', { token: TOKEN })
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

    // Mismatched folder id passes cardSchema in step 2 but throws in step 6 loadPack -> rollback.
    const mismatched = readFileSync(cardPath, 'utf8').replace(/^id: custom$/m, 'id: other')
    writeFileSync(cardPath, mismatched, 'utf8')
    const rollbackRes = await writeFooter(siteUrl, 'custom', { icon: '🧪' })
    expect(rollbackRes.status).toBe(400)
    expect(await rollbackRes.json()).toEqual({ error: 'invalid_footer' })
    expect(readFileSync(cardPath, 'utf8')).toBe(mismatched)
    expect(
      app.storage.read((db) =>
        Number(db.prepare("SELECT count(*) FROM setting_change WHERE target = 'pack'").pluck().get())
      )
    ).toBe(0)
  })
})
