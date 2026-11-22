import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { checkOwnerResponse } from '../../site/src/lib/owner-response.js'
import { queueModel, startApp } from '../support/app.js'
import { tmpDir } from '../support/tmp.js'

const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
})

it('keeps both chat shapes separate and streams owner requests without exposing the token', async () => {
  const calls: string[] = []
  const owner = createServer(async (req, res) => {
    calls.push(req.url ?? '')
    if (req.headers['x-tolongai-token'] !== 'fixture') return void res.writeHead(401).end()
    if (req.method === 'POST') {
      const parts = []
      for await (const part of req) parts.push(Buffer.from(part))
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ bytes: Buffer.concat(parts).length }))
    } else res.end(JSON.stringify({ chats: [{ label: 'Fixture', id: 'fixture' }] }))
  })
  await new Promise<void>((resolve) => owner.listen(0, '127.0.0.1', resolve))
  closers.push(() => new Promise<void>((resolve) => owner.close(() => resolve())))
  const { app } = await startApp(queueModel([]), {
    env: { AIRA_OWNER_API_ORIGIN: 'http://127.0.0.1:' + (owner.address() as AddressInfo).port }
  })
  const site = 'http://127.0.0.1:' + (await app.listenSite(0, '127.0.0.1')).port
  closers.push(() => app.close())
  const core = await (await fetch(site + '/api/chats')).json()
  expect(core).toMatchObject({ chats: [expect.objectContaining({ chatId: expect.any(String) })] })
  expect(calls).toHaveLength(0)
  expect((await fetch(site + '/owner-api/chats')).status).toBe(401)
  const headers = { 'x-tolongai-token': 'fixture' }
  const actual = await fetch(site + '/owner-api/chats?scope=all', { headers })
  expect(await actual.json()).toEqual({ chats: [{ id: 'fixture', label: 'Fixture' }] })
  const form = new FormData()
  form.append('file', new Blob(['fixture']), 'fixture.txt')
  expect(await (await fetch(site + '/owner-api/send', { method: 'POST', headers, body: form })).json()).toMatchObject({
    bytes: expect.any(Number)
  })
  expect(
    (
      await fetch(site + '/owner-api/send', {
        method: 'POST',
        headers: { ...headers, origin: 'https://other.example' }
      })
    ).status
  ).toBe(403)
  expect((await fetch(site + '/owner-api/media?token=fixture')).status).toBe(400)
  expect(calls).toEqual(['/api/chats', '/api/chats?scope=all', '/api/send'])
  expect(() => checkOwnerResponse('/api/settings', {}, 'GET')).toThrow('Invalid')
  expect(() => checkOwnerResponse('/api/cron', { success: false }, 'GET')).toThrow()
})

it('requires the persisted collections in market write acknowledgements', () => {
  for (const response of [{}, { markets: null }, { markets: { watchlist: [] } }])
    expect(() => checkOwnerResponse('/api/settings/markets', response, 'POST')).toThrow('acknowledgement')
  expect(() =>
    checkOwnerResponse('/api/settings/markets', { markets: { watchlist: [], alerts: [] } }, 'POST')
  ).not.toThrow()
})

it('routes the production sockets independently and surfaces an unavailable host service', async () => {
  const dir = tmpDir()
  const socket = join(dir, 'owner-api.sock')
  const host = createServer((request, response) => {
    expect(request.url).toBe('/api/settings/models_probe')
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ reachable: true, tags: [] }))
  })
  await new Promise<void>((resolve) => host.listen(join(dir, 'model-probe.sock'), resolve))
  closers.push(() => new Promise<void>((resolve) => host.close(() => resolve())))
  const { app } = await startApp(queueModel([]), { env: { AIRA_OWNER_API_SOCKET: socket } })
  closers.push(() => app.close())
  const site = 'http://127.0.0.1:' + (await app.listenSite(0, '127.0.0.1')).port
  expect((await fetch(site + '/owner-api/settings')).status).toBe(502)
  const probe = await fetch(site + '/owner-api/settings/models_probe', { method: 'POST' })
  expect(await probe.json()).toEqual({ reachable: true, tags: [] })
})

it('rejects incomplete per-chat watchlist acknowledgements', () => {
  for (const route of ['/api/settings/watchlist', '/api/settings/watchlist_inherit']) {
    expect(() => checkOwnerResponse(route, { watchlist: [] }, 'POST')).toThrow('watchlist')
    expect(() =>
      checkOwnerResponse(route, { scope_key: 'fixture', inherits_default: false, watchlist: [] }, 'POST')
    ).not.toThrow()
  }
})
