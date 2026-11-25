import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { type App, createApp } from '../../src/app.js'
import { ConfigError } from '../../src/config/loader.js'
import { createLogger } from '../../src/records/logger.js'
import { queueModel } from '../support/app.js'
import { testConfig } from '../support/core.js'
import { tmpDir } from '../support/tmp.js'

// The real app constructor and gateway listener, not the harness's substitute core.
const apps: App[] = []
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close()
})

function options(env: NodeJS.ProcessEnv = {}) {
  const config = testConfig((value) => {
    value.storage.path = tmpDir('aira-standalone-')
    value.storage.minFreeMb = 2
    value.storage.criticalFreeMb = 1
    value.gateway.hostDataDir = '/host/aira-data'
  })
  return {
    config,
    env,
    logger: createLogger({ level: 'error', module: 'test', sink: () => undefined })
  }
}

async function start(env: NodeJS.ProcessEnv, main?: ReturnType<typeof queueModel>) {
  const app = await createApp({ ...options(env), ...(main ? { clients: { main } } : {}) })
  apps.push(app)
  const address = await app.listen(0, '127.0.0.1')
  return { app, url: `http://127.0.0.1:${address.port}` }
}

async function refuse(url: string, path: string, body: string) {
  const response = await fetch(url + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body
  })
  expect(response.status).toBe(503)
  if (path === '/v1/chat/completions') {
    expect(await response.json()).toMatchObject({ error: { code: 'model_setup_required' } })
  } else {
    await response.text()
  }
}

describe('standalone cold boot', () => {
  it('boots without model keys and reports service and chatbot readiness separately', async () => {
    const { app, url } = await start({ AIRA_INSTALL_MODE: 'standalone' })
    const health = await fetch(url + '/health')
    expect(health.status).toBe(200)
    expect(await health.json()).toMatchObject({
      schemaVersion: 1,
      installationMode: 'standalone',
      status: 'ready',
      activeTurns: 0,
      configuration: 'setup_required',
      chatbot: 'inactive',
      chatbotReason: 'model_setup_required'
    })
    expect(app.packs().packs.has('example')).toBe(true)
    const site = await app.listenSite(0, '127.0.0.1')
    // A real owner-site listener exists even before setup. Authentication is a separate contract.
    expect(site.port).toBeGreaterThan(0)
  })

  it('refuses all gateway model work before parsing while inactive, even with a legacy key', async () => {
    const model = queueModel([{ text: 'must never run' }])
    const { app, url } = await start({ AIRA_INSTALL_MODE: 'standalone', LLM_API_KEY: 'synthetic-canary-key' }, model)
    await refuse(url, '/v1/chat/completions', '{')
    await refuse(
      url,
      '/v1/chat/completions',
      JSON.stringify({ messages: [{ role: 'user', content: 'synthetic chore' }] })
    )
    await refuse(url, '/v1/aira/autofetch', '{}')
    await refuse(url, '/v1/aira/autofetch/claim', '{}')
    await refuse(url, '/v1/aira/autofetch/complete', '{}')
    expect(model.requests).toHaveLength(0)
    expect(app.storage.read((db) => db.prepare('SELECT COUNT(*) FROM turn').pluck().get())).toBe(0)
    expect(app.storage.read((db) => db.prepare('SELECT COUNT(*) FROM model_call').pluck().get())).toBe(0)
  })

  it('keeps the legacy missing-main-credential startup error', async () => {
    await expect(createApp(options())).rejects.toThrow(ConfigError)
  })

  it('refuses an unknown explicit mode', async () => {
    await expect(start({ AIRA_INSTALL_MODE: 'bogus' }, queueModel([]))).rejects.toThrow(ConfigError)
  })

  it('does not turn a storage failure into healthy standalone readiness', async () => {
    const setup = options({ AIRA_INSTALL_MODE: 'standalone' })
    const blocked = join(tmpDir('aira-standalone-blocked-'), 'file')
    writeFileSync(blocked, 'not a directory')
    setup.config.storage.path = blocked
    await expect(createApp(setup)).rejects.toThrow()
  })

  it('preserves the legacy gateway health shape with a deterministic model', async () => {
    const { url } = await start({}, queueModel([{ text: 'hello' }]))
    const health = await fetch(url + '/health')
    expect(health.status).toBe(200)
    const body = await health.json()
    expect(body).toMatchObject({ status: 'ready', activeTurns: 0 })
    expect(body).not.toHaveProperty('installationMode')
    expect(body).not.toHaveProperty('chatbot')
  })
})
