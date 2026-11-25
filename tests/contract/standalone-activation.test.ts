import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { type App, createApp } from '../../src/app.js'
import { createLogger } from '../../src/records/logger.js'
import { queueModel } from '../support/app.js'
import { testConfig } from '../support/core.js'
import { tmpDir } from '../support/tmp.js'

const apps: App[] = []
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close()
})
const candidate = {
  provider: 'openai-compatible',
  model: 'fixture-model',
  baseUrl: 'http://127.0.0.1:12345/v1',
  effort: '',
  deepEffort: '',
  usdPerMTokIn: 0,
  usdPerMTokOut: 0,
  usdPerMTokCached: 0,
  apiKey: 'synthetic-model-key'
}

async function start(root: string, restart = vi.fn()) {
  const config = testConfig((value) => {
    value.storage.path = root
    value.storage.minFreeMb = 2
    value.storage.criticalFreeMb = 1
    value.gateway.hostDataDir = '/host/fixture'
  })
  const main = queueModel([{ text: 'fixture response' }])
  const app = await createApp({
    config,
    env: { AIRA_INSTALL_MODE: 'standalone', LLM_API_KEY: 'ignored-legacy-key' },
    clients: { main },
    onActivationRequested: restart,
    logger: createLogger({ level: 'error', module: 'test', sink: () => undefined })
  })
  apps.push(app)
  const gateway = await app.listen(0, '127.0.0.1')
  const site = await app.listenSite(0, '127.0.0.1')
  const token = readFileSync(join(root, 'standalone', 'owner.token'), 'utf8').trim()
  async function request(path: string, method = 'GET', body?: unknown) {
    const result = await fetch(`http://127.0.0.1:${site.port}/owner-api/core/${path}`, {
      method,
      headers: { 'x-tolongai-token': token, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
    return { status: result.status, body: await result.json() }
  }
  return { app, request, main, restart, gateway: `http://127.0.0.1:${gateway.port}` }
}

describe('standalone model activation through the protected listener', () => {
  it('saves, requests restart and commits the exact revision only after successful startup', async () => {
    const root = tmpDir('aira-activation-')
    const cold = await start(root)
    const initial = await cold.request('standalone-config')
    expect(initial.status).toBe(200)
    expect(initial.body).toMatchObject({ configuration: 'setup_required', savedRevision: null, appliedRevision: null })
    const saved = await cold.request('standalone-config', 'PUT', {
      expectedRevision: null,
      main: candidate,
      fallback: null
    })
    expect(saved.status).toBe(200)
    expect(JSON.stringify(saved.body)).not.toContain(candidate.apiKey)
    const revision = z.object({ savedRevision: z.string() }).parse(saved.body).savedRevision
    expect(saved.body).toMatchObject({ configuration: 'pending_activation', appliedRevision: null })
    expect(
      (await cold.request('standalone-config', 'PUT', { expectedRevision: null, main: candidate, fallback: null }))
        .status
    ).toBe(409)
    const requested = await cold.request('standalone-config/activate', 'POST', { expectedRevision: revision })
    expect(requested.status).toBe(202)
    expect(requested.body).toMatchObject({ activation: 'requested', appliedRevision: null })
    expect(cold.restart).toHaveBeenCalledOnce()
    expect(cold.main.requests).toHaveLength(0)
    await cold.app.close()
    const candidateBoot = await start(root)
    expect((await candidateBoot.request('standalone-config')).body).toMatchObject({
      activation: 'starting',
      appliedRevision: null
    })
    candidateBoot.app.completeStartup()
    expect((await candidateBoot.request('standalone-config')).body).toMatchObject({
      configuration: 'configured',
      appliedRevision: revision,
      activation: 'idle'
    })
    expect((await candidateBoot.request('health')).body).toMatchObject({
      configuration: 'configured',
      chatbot: 'inactive',
      chatbotReason: 'hermes_disconnected',
      appliedRevision: revision
    })
    const health = await fetch(candidateBoot.gateway + '/health')
    expect(await health.json()).toMatchObject({ configuration: 'configured', chatbot: 'inactive' })
    expect(candidateBoot.main.requests).toHaveLength(0)
  })
})
