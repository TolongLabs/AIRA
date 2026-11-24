import { closeSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse, stringify } from 'yaml'
import { type App, createApp } from '../../src/app.js'
import { credentialPurposes, deploymentSettings } from '../../src/config/dashboard-settings.js'
import { loadConfig } from '../../src/config/loader.js'
import { createConfigStatus, revisionForConfig } from '../../src/config/status.js'
import { createLogger } from '../../src/records/logger.js'
import { queueModel } from '../support/app.js'
import { testConfig } from '../support/core.js'
import { tmpDir } from '../support/tmp.js'

/* Deployment activation readback (docs/trd/dashboard-state.md#deployment-activation-readback).
   Every fixture here is synthetic: a temp config file, a loopback owner stub,
   invented tokens. No external service, no git mutation. */

const HEX64 = /^[0-9a-f]{64}$/
const apps: App[] = []
const servers: ReturnType<typeof createServer>[] = []

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close()
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve))
})

async function ownerStub(): Promise<{ origin: string; token: string }> {
  const token = 'fixture-token'
  const host = createServer((req, res) => {
    const ok = req.url === '/api/settings' && req.headers['x-tolongai-token'] === token
    res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' }).end(JSON.stringify(ok ? { markets: {} } : {}))
  })
  await new Promise<void>((resolve) => host.listen(0, '127.0.0.1', resolve))
  servers.push(host)
  const address = host.address()
  if (!address || typeof address === 'string') throw new Error('test listener unavailable')
  return { origin: 'http://127.0.0.1:' + address.port, token }
}

function writeConfigFile(path: string, mutate: (doc: Record<string, unknown>) => void = () => {}): void {
  const dataDir = dirname(path)
  const base = testConfig((config) => {
    config.storage.path = dataDir
    config.storage.minFreeMb = 2
    config.storage.criticalFreeMb = 1
    config.gateway.hostDataDir = '/host/aira-data'
    config.llm.main = { ...config.llm.main, provider: 'openai-compatible', model: 'm', baseUrl: 'https://m.invalid/v1' }
  })
  const doc = parse(stringify(base)) as Record<string, unknown>
  mutate(doc)
  const tmp = path + '.tmp'
  writeFileSync(tmp, stringify(doc))
  renameSync(tmp, path)
}

async function startFileApp(configPath: string, origin: string): Promise<{ app: App; site: string }> {
  const config = loadConfig(configPath)
  const app = await createApp({
    config,
    configPath,
    configAppliedAt: new Date('2026-11-24T00:00:00.000Z'),
    env: { AIRA_OWNER_API_ORIGIN: origin },
    clients: { main: queueModel([]) },
    logger: createLogger({ level: 'debug', module: 'core', sink: () => {} })
  })
  apps.push(app)
  const site = await app.listenSite(0, '127.0.0.1')
  return { app, site: 'http://127.0.0.1:' + site.port }
}

describe('deployment activation readback', () => {
  it('reports current when the file matches the startup revision', async () => {
    const dir = tmpDir('aira-config-')
    const configPath = join(dir, 'config.yml')
    writeConfigFile(configPath)
    const { origin, token } = await ownerStub()
    const { site } = await startFileApp(configPath, origin)
    const res = await fetch(site + '/owner-api/core/config', { headers: { 'x-tolongai-token': token } })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/)
    const body = (await res.json()) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['appliedAt', 'appliedRevision', 'checkedAt', 'currentRevision', 'status'])
    expect(body['appliedRevision']).toMatch(HEX64)
    expect(body['currentRevision']).toBe(body['appliedRevision'])
    expect(body['status']).toBe('current')
    expect(body['appliedRevision']).toBe(revisionForConfig(loadConfig(configPath)))
  })

  it('reports pending_restart on a valid edit and keeps both opaque tokens value-free', async () => {
    const dir = tmpDir('aira-config-')
    const configPath = join(dir, 'config.yml')
    writeConfigFile(configPath)
    const { origin, token } = await ownerStub()
    const { site } = await startFileApp(configPath, origin)
    const headers = { 'x-tolongai-token': token }
    const before = (await (await fetch(site + '/owner-api/core/config', { headers })).json()) as {
      appliedRevision: string
    }
    writeConfigFile(configPath, (doc) => {
      const format = doc['format'] as Record<string, unknown>
      format['bubbleMaxChars'] = 3801
    })
    const res = await fetch(site + '/owner-api/core/config', { headers })
    const body = (await res.json()) as {
      appliedRevision: string
      currentRevision: string
      status: string
    }
    expect(body.status).toBe('pending_restart')
    expect(body.appliedRevision).toBe(before.appliedRevision)
    expect(body.currentRevision).toMatch(HEX64)
    expect(body.currentRevision).not.toBe(body.appliedRevision)
    expect(JSON.stringify(body)).not.toMatch(/bubbleMaxChars|3801|host|path|\/host/i)
  })

  it.runIf(process.platform === 'linux')('reports an unlinked mount as inaccessible', () => {
    const path = join(tmpDir('aira-config-'), 'config.yml')
    writeConfigFile(path)
    const config = loadConfig(path)
    const fd = openSync(path, 'r')
    try {
      const status = createConfigStatus({ config, configPath: '/proc/self/fd/' + fd })
      expect(status.read().status).toBe('current')
      unlinkSync(path)
      expect(status.read()).toMatchObject({
        status: 'inaccessible',
        appliedRevision: revisionForConfig(config),
        currentRevision: null
      })
    } finally {
      closeSync(fd)
    }
  })

  it('reports invalid on a malformed file and leaves the applied revision intact', async () => {
    const dir = tmpDir('aira-config-')
    const configPath = join(dir, 'config.yml')
    writeConfigFile(configPath)
    const { origin, token } = await ownerStub()
    const { site } = await startFileApp(configPath, origin)
    const headers = { 'x-tolongai-token': token }
    const before = (await (await fetch(site + '/owner-api/core/config', { headers })).json()) as {
      appliedRevision: string
    }
    writeFileSync(configPath + '.tmp', 'format: { bubbleMaxChars: "nope" }\n')
    renameSync(configPath + '.tmp', configPath)
    const body = (await (await fetch(site + '/owner-api/core/config', { headers })).json()) as {
      appliedRevision: string
      currentRevision: unknown
      status: string
    }
    expect(body.status).toBe('invalid')
    expect(body.appliedRevision).toBe(before.appliedRevision)
    expect(body.currentRevision).toBeNull()
  })

  it('a restart adopts a valid edit as the new applied revision', async () => {
    const dir = tmpDir('aira-config-')
    const configPath = join(dir, 'config.yml')
    writeConfigFile(configPath)
    const { origin, token } = await ownerStub()
    const headers = { 'x-tolongai-token': token }
    const first = await startFileApp(configPath, origin)
    const beforeRes = await fetch(first.site + '/owner-api/core/config', { headers })
    const before = (await beforeRes.json()) as { appliedRevision: string }
    writeConfigFile(configPath, (doc) => {
      const turn = doc['turn'] as Record<string, unknown>
      turn['batchMs'] = 2000
    })
    const editedRevision = revisionForConfig(loadConfig(configPath))
    expect(editedRevision).not.toBe(before.appliedRevision)
    await Promise.all(apps.splice(0).map((app) => app.close()))
    const second = await startFileApp(configPath, origin)
    const afterRes = await fetch(second.site + '/owner-api/core/config', { headers })
    const body = (await afterRes.json()) as {
      appliedRevision: string
      currentRevision: string
      status: string
    }
    expect(body.status).toBe('current')
    expect(body.appliedRevision).toBe(editedRevision)
    expect(body.currentRevision).toBe(editedRevision)
  })

  it('refuses anonymous and public access and refuses edits', async () => {
    const dir = tmpDir('aira-config-')
    const configPath = join(dir, 'config.yml')
    writeConfigFile(configPath)
    const { origin, token } = await ownerStub()
    const { site } = await startFileApp(configPath, origin)
    expect((await fetch(site + '/owner-api/core/config')).status).toBe(401)
    expect((await fetch(site + '/api/config')).status).toBe(404)
    const put = await fetch(site + '/owner-api/core/config', {
      method: 'PUT',
      headers: { 'x-tolongai-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({})
    })
    expect(put.status).toBe(405)
  })
})

describe('owner deployment settings', () => {
  it('serves applied values only after authentication and reports unapplied file changes', async () => {
    const path = join(tmpDir('aira-settings-'), 'config.yml')
    writeConfigFile(path)
    const { origin, token } = await ownerStub()
    const { site } = await startFileApp(path, origin)
    const url = site + '/owner-api/core/deployment-settings'
    const headers = { 'x-tolongai-token': token }
    expect((await fetch(url)).status).toBe(401)
    expect((await fetch(site + '/api/deployment-settings')).status).toBe(404)
    expect((await fetch(url, { method: 'POST', headers })).status).toBe(405)
    writeConfigFile(path, (doc) => {
      ;(doc['prompt'] as { maxSystemTokens: number }).maxSystemTokens = 456789
    })
    const res = await fetch(url, { headers })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = (await res.json()) as ReturnType<typeof deploymentSettings>
    expect(body.activation).toBe('pending_restart')
    expect(body.groups.prompt?.maxSystemTokens).not.toBe(456789)
    expect(body.models.main).toMatchObject({ model: 'm', connection: 'OpenAI-compatible API', configured: true })
    expect(Object.keys(body.groups).sort()).toEqual(Object.keys(loadConfig(path)).sort())
  })
  it('describes the subscription primary and independent API fallback without returning private data', () => {
    const marker = 'private-fixture-marker'
    const config = testConfig((c) => {
      c.llm.transport = 'subscription'
      c.llm.main.effort = ''
      c.llm.main.deepEffort = ''
      c.llm.fallback = {
        ...c.llm.fallback,
        provider: 'openai-compatible',
        model: 'fixture-flash',
        effort: 'high',
        deepEffort: 'max',
        baseUrl: 'https://user:' + marker + '@api.invalid/' + marker + '?k=' + marker
      }
      c.storage.path = '/' + marker
      c.gateway.selfIds = [marker]
      c.gateway.jobs = [{ id: marker, chat: marker }]
      c.render.report.header = marker
      c.backup.offsite.repository = marker
      c.mcp.servers = [
        { id: 'fixture', transport: 'stdio', command: [marker], tools: [marker], chats: [marker], timeoutMs: 2500 }
      ]
    })
    const snapshot = createConfigStatus({ config }).read()
    const env = Object.fromEntries(Object.keys(credentialPurposes).map((k) => [k, marker]))
    env['UNLISTED_PRIVATE_CREDENTIAL'] = marker
    const view = deploymentSettings(config, env, snapshot, {
      main: { configured: true },
      fallback: { configured: false }
    })
    expect(view.models.main).toMatchObject({
      connection: 'Claude Code subscription',
      effort: 'medium',
      deepEffort: 'medium',
      credential: 'RUNNER_TOKEN'
    })
    expect(view.models.fallback).toMatchObject({
      connection: 'OpenAI-compatible API',
      effort: 'high',
      deepEffort: 'max',
      endpoint: 'https://api.invalid',
      configured: false
    })
    expect(view.groups.mcp?.['servers[0].timeoutMs']).toBe(2500)
    expect(view.credentials.every((c) => c.present)).toBe(true)
    expect(JSON.stringify(view)).not.toContain(marker)
    expect(JSON.stringify(view)).not.toContain('UNLISTED_PRIVATE_CREDENTIAL')
  })
})
