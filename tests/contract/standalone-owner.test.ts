import { chmodSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, get } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { type App, createApp } from '../../src/app.js'
import { createLogger } from '../../src/records/logger.js'
import { queueModel } from '../support/app.js'
import { testConfig } from '../support/core.js'
import { tmpDir } from '../support/tmp.js'

const apps: App[] = []
const logs: string[] = []
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close()
  logs.splice(0)
})

function options(root: string, env: NodeJS.ProcessEnv = { AIRA_INSTALL_MODE: 'standalone' }) {
  return {
    config: testConfig((value) => {
      value.storage.path = root
      value.storage.minFreeMb = 2
      value.storage.criticalFreeMb = 1
      value.gateway.hostDataDir = '/host/example'
    }),
    env,
    logger: createLogger({ level: 'debug', module: 'test', sink: (line) => logs.push(line) })
  }
}

async function start(root: string, env?: NodeJS.ProcessEnv, siteDir?: string) {
  const app = await createApp({ ...options(root, env), siteDir, clients: { main: queueModel([]) } })
  apps.push(app)
  const address = await app.listenSite(0, '127.0.0.1')
  return { app, url: `http://127.0.0.1:${address.port}` }
}

const tokenFile = (root: string) => join(root, 'standalone', 'owner.token')
const localToken = (root: string) => readFileSync(tokenFile(root), 'utf8').trim()
const auth = (token: string) => ({ 'x-tolongai-token': token })

describe('standalone owner authentication', () => {
  it('protects every core and host route using its private per-install credential', async () => {
    const root = tmpDir('aira-owner-')
    const site = tmpDir('aira-owner-site-')
    writeFileSync(join(site, 'preview.html'), '<!doctype html><title>Fixture dashboard</title>')
    const { url } = await start(root, { AIRA_INSTALL_MODE: 'standalone' }, site)
    const token = localToken(root)
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(statSync(tokenFile(root)).mode & 0o777).toBe(0o600)
    expect(statSync(join(root, 'standalone')).mode & 0o777).toBe(0o700)
    expect((await fetch(url + '/overview')).status).toBe(200)

    for (const path of ['/owner-api/core/health', '/api/health', '/owner-api/core/chats', '/owner-api/settings']) {
      for (const headers of [{}, auth('wrong-token')]) {
        const denied = await fetch(url + path, { headers })
        expect(denied.status).toBe(401)
        expect(denied.headers.get('cache-control')).toBe('no-store')
      }
    }

    const health = await fetch(url + '/owner-api/core/health', { headers: auth(token) })
    expect(health.status).toBe(200)
    const body = await health.text()
    expect(body).not.toContain(token)
    expect(JSON.parse(body)).toMatchObject({
      status: 'ready',
      schemaVersion: 1,
      installationMode: 'standalone',
      configuration: 'setup_required',
      chatbot: 'inactive',
      chatbotReason: 'model_setup_required',
      capabilities: {
        hostOwnerService: false,
        subscriptionRunner: false,
        fileBrowser: false,
        gatewayConnection: false,
        scheduler: false
      }
    })
    expect((await fetch(url + '/api/health', { headers: auth(token) })).status).toBe(200)
    expect(
      (
        await fetch(url + '/owner-api/core/health', {
          headers: { ...auth(token), origin: 'http://untrusted.invalid' }
        })
      ).status
    ).toBe(403)
    // fetch normalizes Host; use the raw HTTP client to test the supplied header.
    const hostStatus = await new Promise<number | undefined>((resolve, reject) => {
      get(
        url + '/owner-api/core/health',
        { headers: { ...auth(token), host: 'untrusted.invalid:9890' } },
        (response) => {
          response.resume()
          response.once('end', () => resolve(response.statusCode))
        }
      ).once('error', reject)
    })
    expect(hostStatus).toBe(403)

    for (const path of ['/owner-api/settings', '/owner-api/cron', '/owner-api/messages']) {
      const denied = await fetch(url + path, { method: 'POST', headers: auth(token), body: '{}' })
      expect(denied.status).toBe(503)
      expect(await denied.json()).toMatchObject({ error: 'capability_unavailable' })
    }
    expect(logs.join('\n')).not.toContain(token)
  })

  it('refuses legacy integration reads and writes without reaching a configured host service', async () => {
    let calls = 0
    const host = createServer((_request, response) => {
      calls++
      response.writeHead(500).end('{}')
    })
    await new Promise<void>((resolve) => host.listen(0, '127.0.0.1', resolve))
    try {
      const root = tmpDir('aira-owner-integration-refusal-')
      const address = host.address() as AddressInfo
      const { url } = await start(root, {
        AIRA_INSTALL_MODE: 'standalone',
        AIRA_OWNER_API_ORIGIN: `http://127.0.0.1:${address.port}`
      })
      const token = localToken(root)
      const operations = [
        ['GET', '/owner-api/library/index'],
        ['GET', '/owner-api/notices'],
        ['GET', '/owner-api/settings/file?kind=fixture'],
        ['POST', '/owner-api/settings/markets'],
        ['POST', '/owner-api/settings/models_probe'],
        ['POST', '/owner-api/cron'],
        ['POST', '/owner-api/messages']
      ]
      for (const [method, path] of operations) {
        const denied = await fetch(url + path, {
          method,
          headers: auth(token),
          ...(method === 'POST' ? { body: '{}' } : {})
        })
        expect(denied.status, path).toBe(503)
        expect(await denied.json()).toEqual({ error: 'capability_unavailable' })
      }
      expect(calls).toBe(0)
    } finally {
      host.closeAllConnections()
      await new Promise<void>((resolve) => host.close(() => resolve()))
    }
  })

  it('retains the same credential across a full core restart', async () => {
    const root = tmpDir('aira-owner-restart-')
    const first = await start(root)
    const token = localToken(root)
    await first.app.close()
    const second = await start(root)
    expect(localToken(root)).toBe(token)
    expect((await fetch(second.url + '/owner-api/core/health', { headers: auth(token) })).status).toBe(200)
  })

  it('refuses malformed or symlinked credentials without replacing them', async () => {
    for (const symlink of [false, true]) {
      const root = tmpDir('aira-owner-invalid-')
      mkdirSync(join(root, 'standalone'), { mode: 0o700 })
      const other = join(root, 'other')
      if (symlink) {
        writeFileSync(other, 'a'.repeat(64) + '\n', { mode: 0o600 })
        symlinkSync(other, tokenFile(root))
      } else {
        writeFileSync(tokenFile(root), 'malformed\n', { mode: 0o600 })
      }
      await expect(createApp(options(root))).rejects.toThrow()
      expect(readFileSync(tokenFile(root), 'utf8')).toBe(symlink ? 'a'.repeat(64) + '\n' : 'malformed\n')
    }
  })

  it('refuses insecure existing permissions without rewriting them', async () => {
    const root = tmpDir('aira-owner-mode-')
    mkdirSync(join(root, 'standalone'), { mode: 0o700 })
    writeFileSync(tokenFile(root), 'c'.repeat(64) + '\n', { mode: 0o600 })
    chmodSync(join(root, 'standalone'), 0o755)
    await expect(createApp(options(root))).rejects.toThrow()
    expect(statSync(join(root, 'standalone')).mode & 0o777).toBe(0o755)
    chmodSync(join(root, 'standalone'), 0o700)
    chmodSync(tokenFile(root), 0o644)
    await expect(createApp(options(root))).rejects.toThrow()
    expect(statSync(tokenFile(root)).mode & 0o777).toBe(0o644)
  })

  it('does not switch legacy authority when the host becomes unavailable', async () => {
    const root = tmpDir('aira-legacy-owner-')
    const token = 'synthetic-legacy-owner-token'
    const local = 'b'.repeat(64)
    mkdirSync(join(root, 'standalone'), { mode: 0o700 })
    writeFileSync(tokenFile(root), local + '\n', { mode: 0o600 })
    const host = createServer((request, response) => {
      if (request.headers['x-tolongai-token'] !== token) response.writeHead(401).end('{}')
      else response.writeHead(200, { 'content-type': 'application/json' }).end('{"markets":{}}')
    })
    await new Promise<void>((resolve) => host.listen(0, '127.0.0.1', resolve))
    try {
      const address = host.address() as AddressInfo
      const { url } = await start(root, {
        AIRA_DASHBOARD_ENTRY: 'dashboard',
        AIRA_OWNER_API_ORIGIN: `http://127.0.0.1:${address.port}`
      })
      expect((await fetch(url + '/owner-api/core/health', { headers: auth(token) })).status).toBe(200)
      expect((await fetch(url + '/owner-api/core/health', { headers: auth(local) })).status).toBe(401)
      host.closeAllConnections()
      await new Promise<void>((resolve) => host.close(() => resolve()))
      expect((await fetch(url + '/owner-api/core/health', { headers: auth(local) })).status).toBe(502)
    } finally {
      host.closeAllConnections()
      if (host.listening) await new Promise<void>((resolve) => host.close(() => resolve()))
    }
  })
})
