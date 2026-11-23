import { randomUUID } from 'node:crypto'
import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureChat, setChatStatus } from '../../src/settings/chats.js'
import { queueModel, startApp } from '../support/app.js'
import { tmpDir } from '../support/tmp.js'

// Focused contract for POST /owner-api/messages and GET /owner-api/messages/:id.
// Uses a fake private host for /api/settings (auth) and /api/chats/intro (dispatch).

const OWNER_TOKEN = 'test-owner-token-12345'

interface IntroCall {
  target: unknown
  text: unknown
  stamp: unknown
  headers: Record<string, string | undefined>
}

class FakeOwnerHost {
  server: Server
  url = ''
  settingsCalls = 0
  introCalls: IntroCall[] = []
  dropReply = false
  settingsBody: unknown = { markets: {} }
  settingsStatus = 200
  introHandler: (body: unknown) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }> = (
    body
  ) => ({ status: 200, body: { ...(body as object), sent_at: null } })

  constructor(private token = OWNER_TOKEN) {
    this.server = createServer((req, res) => {
      void (async () => {
        const path = (req.url ?? '/').split('?')[0] ?? '/'
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk as Buffer)
        const raw = Buffer.concat(chunks).toString('utf8')
        const headerToken = req.headers['x-tolongai-token']
        if (path === '/api/settings' && req.method === 'GET') {
          this.settingsCalls += 1
          if (headerToken !== this.token) {
            res
              .writeHead(401, { 'content-type': 'application/json' })
              .end(JSON.stringify({ error: 'Owner token required' }))
            return
          }
          if (this.settingsStatus !== 200) {
            res
              .writeHead(this.settingsStatus, { 'content-type': 'application/json' })
              .end(JSON.stringify({ error: 'boom' }))
            return
          }
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(this.settingsBody))
          return
        }
        if (path === '/api/chats/intro' && req.method === 'POST') {
          if (headerToken !== this.token) {
            res
              .writeHead(401, { 'content-type': 'application/json' })
              .end(JSON.stringify({ error: 'Owner token required' }))
            return
          }
          let parsed: unknown = null
          try {
            parsed = raw === '' ? null : JSON.parse(raw)
          } catch {
            res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'bad' }))
            return
          }
          const record: IntroCall = {
            target: (parsed as Record<string, unknown> | null)?.['target'],
            text: (parsed as Record<string, unknown> | null)?.['text'],
            stamp: (parsed as Record<string, unknown> | null)?.['stamp'],
            headers: { 'x-tolongai-token': headerToken as string | undefined }
          }
          this.introCalls.push(record)
          const out = await this.introHandler(parsed)
          if (this.dropReply) {
            res.destroy()
            return
          }
          res.writeHead(out.status, { 'content-type': 'application/json' }).end(JSON.stringify(out.body))
          return
        }
        res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not_found' }))
      })().catch(() => {
        try {
          res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'host_error' }))
        } catch {
          // closed
        }
      })
    })
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
    return this.url
  }

  async close(): Promise<void> {
    this.server.closeAllConnections()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }
}

const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
})

async function startWithOwner(host: FakeOwnerHost, options: { dataDir?: string } = {}) {
  const model = queueModel([{ text: 'unused' }])
  const started = await startApp(model, {
    ...(options.dataDir ? { dataDir: options.dataDir } : {}),
    env: { AIRA_OWNER_API_ORIGIN: host.url }
  })
  const address = await started.app.listenSite(0, '127.0.0.1')
  const siteUrl = `http://127.0.0.1:${address.port}`
  closers.push(async () => {
    await started.app.close()
    await host.close()
  })
  return { ...started, model, siteUrl }
}

function postMessage(
  siteUrl: string,
  body: unknown,
  token: string | null = OWNER_TOKEN,
  extraHeaders: Record<string, string> = {}
) {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...extraHeaders }
  if (token !== null) headers['x-tolongai-token'] = token
  return fetch(`${siteUrl}/owner-api/messages`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body)
  })
}

function getMessage(siteUrl: string, id: string, token: string | null = OWNER_TOKEN) {
  const headers: Record<string, string> = {}
  if (token !== null) headers['x-tolongai-token'] = token
  return fetch(`${siteUrl}/owner-api/messages/${encodeURIComponent(id)}`, { headers })
}

describe('owner message contract', () => {
  it('sends once, trims outer whitespace, keeps internal newlines and returns acknowledged', async () => {
    const host = new FakeOwnerHost()
    await host.start()
    const { app, siteUrl, model, logs, chatId } = await startWithOwner(host)
    void app

    const submissionId = randomUUID()
    const res = await postMessage(siteUrl, { submissionId, chatId, text: '  hello\n\nworld  ' })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({ submissionId, outcome: 'acknowledged' })
    expect(host.introCalls).toHaveLength(1)
    expect(host.introCalls[0]).toMatchObject({ target: 'whatsapp:test-chat-g1', text: 'hello\n\nworld', stamp: false })
    expect(model.requests).toHaveLength(0)

    const get = await getMessage(siteUrl, submissionId)
    expect(get.status).toBe(200)
    expect(get.headers.get('cache-control')).toBe('no-store')
    expect(await get.json()).toEqual({ submissionId, outcome: 'acknowledged' })

    // No raw body or identifiers in logs.
    const logged = JSON.stringify(logs)
    expect(logged).not.toContain('hello')
    expect(logged).not.toContain(OWNER_TOKEN)
    expect(logged).not.toContain('whatsapp:test-chat-g1')
  })

  it('selects one direct chat among group and DM records', async () => {
    const host = new FakeOwnerHost()
    await host.start()
    const { app, siteUrl } = await startWithOwner(host)
    const dm = ensureChat(app.storage, { waId: 'fixture-direct', type: 'dm' })
    const submissionId = randomUUID()
    await postMessage(siteUrl, { submissionId, chatId: dm.chatId, text: 'DM fixture' })
    expect(host.introCalls.map((call) => call.target)).toEqual(['whatsapp:fixture-direct'])
    const lookup = await getMessage(siteUrl, submissionId.toUpperCase())
    expect(await lookup.json()).toEqual({ submissionId, outcome: 'acknowledged' })
  })

  it('refuses ambiguous and unsupported gateway destinations before dispatch', async () => {
    const host = new FakeOwnerHost()
    await host.start()
    const { app, siteUrl, chatId } = await startWithOwner(host)
    ensureChat(app.storage, { waId: 'whatsapp:test-chat-g1', type: 'group' })
    const broadcast = ensureChat(app.storage, { waId: 'fixture@broadcast', type: 'dm' })
    for (const id of [chatId, broadcast.chatId]) {
      expect((await postMessage(siteUrl, { submissionId: randomUUID(), chatId: id, text: 'fixture' })).status).toBe(404)
    }
    expect(host.introCalls).toHaveLength(0)
  })

  it('duplicate with matching content returns prior outcome without a second dispatch', async () => {
    const host = new FakeOwnerHost()
    await host.start()
    const { siteUrl, chatId } = await startWithOwner(host)

    const submissionId = randomUUID()
    const first = await postMessage(siteUrl, { submissionId, chatId, text: 'once' })
    expect(first.status).toBe(200)
    expect(host.introCalls).toHaveLength(1)

    const second = await postMessage(siteUrl, { submissionId: submissionId.toUpperCase(), chatId, text: 'once' })
    expect(second.status).toBe(200)
    expect(await second.json()).toEqual({ submissionId, outcome: 'acknowledged' })
    expect(host.introCalls).toHaveLength(1)

    // Outer whitespace only still matches after trim.
    const trimmed = await postMessage(siteUrl, { submissionId, chatId, text: '  once  ' })
    expect(trimmed.status).toBe(200)
    expect(host.introCalls).toHaveLength(1)
  })

  it('concurrent duplicates dispatch once', async () => {
    const host = new FakeOwnerHost()
    host.introHandler = async (body) => {
      await new Promise((resolve) => setTimeout(resolve, 80))
      return { status: 200, body: { ...(body as object), sent_at: null } }
    }
    await host.start()
    const { siteUrl, chatId } = await startWithOwner(host)

    const submissionId = randomUUID()
    const payload = { submissionId, chatId, text: 'race' }
    const [a, b] = await Promise.all([postMessage(siteUrl, payload), postMessage(siteUrl, payload)])
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    const aBody = (await a.json()) as { submissionId: string; outcome: string }
    const bBody = (await b.json()) as { submissionId: string; outcome: string }
    expect([aBody.outcome, bBody.outcome].every((o) => o === 'unknown' || o === 'acknowledged')).toBe(true)
    expect([aBody.outcome, bBody.outcome]).toContain('acknowledged')
    expect(host.introCalls).toHaveLength(1)
    const settled = await getMessage(siteUrl, submissionId)
    expect(await settled.json()).toEqual({ submissionId, outcome: 'acknowledged' })
  })

  it('conflicting payload returns 409 and never dispatches the second', async () => {
    const host = new FakeOwnerHost()
    await host.start()
    const { siteUrl, chatId, app } = await startWithOwner(host)
    const other = ensureChat(app.storage, { waId: 'test-chat-owner-other', type: 'group' })
    setChatStatus(app.storage, { chatId: other.chatId, status: 'active', actor: 'test' })

    const submissionId = randomUUID()
    const first = await postMessage(siteUrl, { submissionId, chatId, text: 'original' })
    expect(first.status).toBe(200)
    expect(host.introCalls).toHaveLength(1)

    const otherText = await postMessage(siteUrl, { submissionId, chatId, text: 'different' })
    expect(otherText.status).toBe(409)
    expect(host.introCalls).toHaveLength(1)

    const otherChat = await postMessage(siteUrl, { submissionId, chatId: other.chatId, text: 'original' })
    expect(otherChat.status).toBe(409)
    expect(host.introCalls).toHaveLength(1)
  })

  it('rejects malformed input before dispatch with no reservation', async () => {
    const host = new FakeOwnerHost()
    await host.start()
    const { siteUrl, chatId, app } = await startWithOwner(host)

    const badBodies: unknown[] = [
      {},
      { submissionId: 'not-a-uuid', chatId, text: 'hi' },
      { submissionId: randomUUID(), chatId: '', text: 'hi' },
      { submissionId: randomUUID(), chatId, text: '' },
      { submissionId: randomUUID(), chatId, text: '   \n  ' },
      { submissionId: randomUUID(), chatId, text: 42 },
      { submissionId: randomUUID(), chatId: 'c_missing', text: 'hi' }
    ]
    for (const body of badBodies) {
      const res = await postMessage(siteUrl, body)
      expect([400, 404].includes(res.status), JSON.stringify(body)).toBe(true)
      expect(res.headers.get('cache-control')).toBe('no-store')
    }
    expect(host.introCalls).toHaveLength(0)
    const rows = app.storage.read((db) => db.prepare('SELECT count(*) AS n FROM owner_message').get() as { n: number })
    expect(rows.n).toBe(0)

    const unknownChat = await postMessage(siteUrl, { submissionId: randomUUID(), chatId: 'c_ffffffffff00', text: 'hi' })
    expect(unknownChat.status).toBe(404)
    expect(host.introCalls).toHaveLength(0)
  })

  it('accepts 4000 code points and rejects 4001, including emoji and JSON escaping', async () => {
    const host = new FakeOwnerHost()
    await host.start()
    const { siteUrl, chatId } = await startWithOwner(host)

    const ok4000 = '😀'.repeat(4000)
    expect([...ok4000].length).toBe(4000)
    const res4000 = await postMessage(siteUrl, { submissionId: randomUUID(), chatId, text: ok4000 })
    expect(res4000.status).toBe(200)
    expect(host.introCalls).toHaveLength(1)
    expect(host.introCalls[0]?.text).toBe(ok4000)

    const bad4001 = '😀'.repeat(4001)
    const res4001 = await postMessage(siteUrl, { submissionId: randomUUID(), chatId, text: bad4001 })
    expect(res4001.status).toBe(400)
    expect(host.introCalls).toHaveLength(1)

    // JSON-escaped emoji decodes to one code point and is accepted.
    const escapedId = randomUUID()
    const raw = `{"submissionId":"${escapedId}","chatId":"${chatId}","text":"\\ud83d\\ude00"}`
    const boundary = raw.replace('\\ud83d\\ude00', '\\ud83d\\ude00'.repeat(4000))
    expect(raw).toContain('\\ud83d')
    const escaped = await postMessage(siteUrl, boundary)
    expect(escaped.status).toBe(200)
    expect(await escaped.json()).toEqual({ submissionId: escapedId, outcome: 'acknowledged' })
    expect(host.introCalls).toHaveLength(2)
    expect(host.introCalls[1]?.text).toBe('😀'.repeat(4000))
  })

  it('does not infer acknowledgement from sent_at alone and preserves unknown', async () => {
    const host = new FakeOwnerHost()
    host.introHandler = () => ({ status: 200, body: { sent_at: new Date().toISOString() } })
    await host.start()
    const { siteUrl, chatId, app } = await startWithOwner(host)

    const submissionId = randomUUID()
    const res = await postMessage(siteUrl, { submissionId, chatId, text: 'ambiguous' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ submissionId, outcome: 'unknown' })

    const row = app.storage.read(
      (db) =>
        db
          .prepare('SELECT outcome, chat_id, fingerprint FROM owner_message WHERE submission_id = ?')
          .get(submissionId) as { outcome: string; chat_id: string; fingerprint: string }
    )
    expect(row.outcome).toBe('unknown')
    expect(row.chat_id).toBe(chatId)
    expect(row.fingerprint).toMatch(/^[0-9a-f]{64}$/)

    const again = await postMessage(siteUrl, { submissionId, chatId, text: 'ambiguous' })
    expect(await again.json()).toEqual({ submissionId, outcome: 'unknown' })
    expect(host.introCalls).toHaveLength(1)
  })

  it('records refused on definite host refusal and never resends it', async () => {
    const host = new FakeOwnerHost()
    host.introHandler = () => ({ status: 400, body: { error: 'invalid target' } })
    await host.start()
    const { siteUrl, chatId, app } = await startWithOwner(host)

    const submissionId = randomUUID()
    const res = await postMessage(siteUrl, { submissionId, chatId, text: 'nope' })
    expect(await res.json()).toEqual({ submissionId, outcome: 'refused' })
    const stored = app.storage.read((db) =>
      db.prepare('SELECT outcome FROM owner_message WHERE submission_id = ?').pluck().get(submissionId)
    )
    expect(stored).toBe('refused')

    const again = await postMessage(siteUrl, { submissionId, chatId, text: 'nope' })
    expect(await again.json()).toEqual({ submissionId, outcome: 'refused' })
    expect(host.introCalls).toHaveLength(1)
  })

  it('preserves unknown after socket loss across restart with no auto resend', async () => {
    const host = new FakeOwnerHost()
    host.dropReply = true
    await host.start()
    const dataDir = tmpDir('aira-owner-restart-')
    const first = await startWithOwner(host, { dataDir })
    closers.pop()
    const chatId = first.chatId
    const submissionId = randomUUID()

    let reservedAtDispatch: unknown
    host.introHandler = () => {
      reservedAtDispatch = first.app.storage.read((db) =>
        db.prepare('SELECT outcome FROM owner_message WHERE submission_id=?').pluck().get(submissionId)
      )
      return { status: 200, body: {} }
    }
    const res = await postMessage(first.siteUrl, { submissionId, chatId, text: 'lost ack' })
    expect(await res.json()).toEqual({ submissionId, outcome: 'unknown' })
    expect(host.introCalls).toHaveLength(1)
    expect(reservedAtDispatch).toBe('unknown')
    await first.app.close()

    const second = await startWithOwner(host, { dataDir })
    const get = await getMessage(second.siteUrl, submissionId)
    expect(get.status).toBe(200)
    expect(await get.json()).toEqual({ submissionId, outcome: 'unknown' })

    const retry = await postMessage(second.siteUrl, { submissionId, chatId, text: 'lost ack' })
    expect(await retry.json()).toEqual({ submissionId, outcome: 'unknown' })
    expect(host.introCalls).toHaveLength(1)
  })

  it('preserves unknown when the final write fails', async () => {
    const host = new FakeOwnerHost()
    await host.start()
    const { siteUrl, chatId, app } = await startWithOwner(host)

    app.storage.tx((db) => {
      db.exec(
        `CREATE TRIGGER block_owner_ack BEFORE UPDATE ON owner_message WHEN NEW.outcome = 'acknowledged'
         BEGIN SELECT RAISE(ABORT, 'blocked'); END;`
      )
    })
    const submissionId = randomUUID()
    const res = await postMessage(siteUrl, { submissionId, chatId, text: 'write fails' })
    expect(await res.json()).toEqual({ submissionId, outcome: 'unknown' })
    expect(host.introCalls).toHaveLength(1)

    app.storage.tx((db) => db.exec('DROP TRIGGER block_owner_ack'))
    const again = await postMessage(siteUrl, { submissionId, chatId, text: 'write fails' })
    expect(await again.json()).toEqual({ submissionId, outcome: 'unknown' })
    expect(host.introCalls).toHaveLength(1)
  })

  it('stores internal target, fingerprint and timestamps only', async () => {
    const host = new FakeOwnerHost()
    await host.start()
    const { siteUrl, chatId, app } = await startWithOwner(host)

    const submissionId = randomUUID()
    await postMessage(siteUrl, { submissionId, chatId, text: 'store only receipts' })
    const row = app.storage.read(
      (db) =>
        db.prepare('SELECT * FROM owner_message WHERE submission_id = ?').get(submissionId) as Record<string, unknown>
    )
    expect(Object.keys(row).sort()).toEqual(
      ['chat_id', 'created_at', 'fingerprint', 'outcome', 'submission_id', 'updated_at'].sort()
    )
    expect(row['chat_id']).toBe(chatId)
    expect(row['outcome']).toBe('acknowledged')
    expect(JSON.stringify(row)).not.toContain('store only receipts')
  })

  it('enforces host, origin and owner token on both routes with no-store', async () => {
    const host = new FakeOwnerHost()
    await host.start()
    const { siteUrl, chatId } = await startWithOwner(host)
    const submissionId = randomUUID()
    await postMessage(siteUrl, { submissionId, chatId, text: 'guarded' })

    const noToken = await postMessage(siteUrl, { submissionId: randomUUID(), chatId, text: 'hi' }, null)
    expect(noToken.status).toBe(401)
    expect(noToken.headers.get('cache-control')).toBe('no-store')

    const badToken = await postMessage(siteUrl, { submissionId: randomUUID(), chatId, text: 'hi' }, 'wrong')
    expect(badToken.status).toBe(401)

    const foreign = await postMessage(siteUrl, { submissionId: randomUUID(), chatId, text: 'hi' }, OWNER_TOKEN, {
      origin: 'https://evil.example'
    })
    expect(foreign.status).toBe(403)

    const { port } = new URL(siteUrl)
    const badHost = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/owner-api/messages',
          headers: {
            host: `attacker.example:${port}`,
            'content-type': 'application/json',
            'x-tolongai-token': OWNER_TOKEN
          }
        },
        (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        }
      )
      req.on('error', reject)
      req.end(JSON.stringify({ submissionId: randomUUID(), chatId, text: 'hi' }))
    })
    expect(badHost).toBe(403)

    const badGet = await getMessage(siteUrl, submissionId, null)
    expect(badGet.status).toBe(401)

    expect((await getMessage(siteUrl, submissionId, 'wrong')).status).toBe(401)
    expect(
      (
        await fetch(siteUrl + '/owner-api/messages/' + submissionId, {
          headers: { origin: 'http://wrong.invalid', 'x-tolongai-token': OWNER_TOKEN }
        })
      ).status
    ).toBe(403)
    const hostRead = await new Promise<number>((resolve, reject) => {
      httpRequest(
        siteUrl + '/owner-api/messages/' + submissionId,
        { headers: { host: 'wrong.invalid', 'x-tolongai-token': OWNER_TOKEN } },
        (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        }
      )
        .on('error', reject)
        .end()
    })
    expect(hostRead).toBe(403)

    const missing = await getMessage(siteUrl, randomUUID())
    expect(missing.status).toBe(404)

    const malformed = await fetch(`${siteUrl}/owner-api/messages/not-a-uuid`, {
      headers: { 'x-tolongai-token': OWNER_TOKEN }
    })
    expect(malformed.status).toBe(400)
    expect(malformed.headers.get('cache-control')).toBe('no-store')
  })

  it('refuses a malformed protected settings response before reads and writes', async () => {
    const host = new FakeOwnerHost()
    host.settingsBody = { error: 'invalid upstream' }
    await host.start()
    const { siteUrl, chatId } = await startWithOwner(host)
    const submissionId = randomUUID()
    expect((await postMessage(siteUrl, { submissionId, chatId, text: 'private fixture' })).status).toBe(502)
    expect((await getMessage(siteUrl, submissionId)).status).toBe(502)
    expect(host.introCalls).toHaveLength(0)
  })

  it('fails closed when the host is unconfigured', async () => {
    const model = queueModel([{ text: 'unused' }])
    const started = await startApp(model, {})
    const address = await started.app.listenSite(0, '127.0.0.1')
    const siteUrl = `http://127.0.0.1:${address.port}`
    closers.push(async () => started.app.close())

    const post = await postMessage(siteUrl, { submissionId: randomUUID(), chatId: 'c_x', text: 'hi' })
    expect(post.status).toBe(503)

    const get = await getMessage(siteUrl, randomUUID())
    expect(get.status).toBe(503)
  })

  it('keeps file send and introduction proxy flows', async () => {
    const host = new FakeOwnerHost()
    await host.start()
    const { siteUrl, app } = await startWithOwner(host)

    const proxied = await fetch(`${siteUrl}/owner-api/chats/intro`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tolongai-token': OWNER_TOKEN },
      body: JSON.stringify({ target: 'some-wa-id', text: 'direct intro', stamp: false })
    })
    expect(proxied.status).toBe(200)
    expect(host.introCalls).toHaveLength(1)
    expect(host.introCalls[0]).toMatchObject({ text: 'direct intro', stamp: false })

    const settings = await fetch(`${siteUrl}/owner-api/settings`, {
      headers: { 'x-tolongai-token': OWNER_TOKEN }
    })
    expect(settings.status).toBe(200)
    expect(settings.headers.get('cache-control')).toBe('no-store')

    const rows = app.storage.read((db) => db.prepare('SELECT count(*) AS n FROM owner_message').get() as { n: number })
    expect(rows.n).toBe(0)
  })
})
