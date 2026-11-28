import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
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
    value.media.watcher.model = 'ambient-fixture-model'
  })
  const main = queueModel([{ text: 'fixture response' }])
  const watch = vi.fn(async () => {
    throw new Error('unexpected media request')
  })
  const app = await createApp({
    config,
    env: {
      AIRA_INSTALL_MODE: 'standalone',
      LLM_API_KEY: 'ignored-legacy-key',
      MEDIA_WATCHER_API_KEY: 'ignored-media-key'
    },
    clients: { main },
    mediaWatcher: { watch },
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
  return {
    app,
    request,
    main,
    restart,
    watch,
    site: `http://127.0.0.1:${site.port}`,
    gateway: `http://127.0.0.1:${gateway.port}`
  }
}

describe('standalone model activation through the protected listener', () => {
  it('previews with the activated model without requiring a connected Hermes route', async () => {
    const root = tmpDir('aira-preview-activation-')
    const cold = await start(root)
    const input = { id: 'example', message: 'hello' }
    expect((await cold.request('pack/schema')).status).toBe(200)
    expect((await cold.request('pack/try', 'POST', { ...input, live: false })).status).toBe(200)
    expect((await cold.request('pack/try', 'POST', { ...input, live: true })).status).toBe(503)
    expect(cold.main.requests).toHaveLength(0)
    const saved = await cold.request('standalone-config', 'PUT', {
      expectedRevision: null,
      main: candidate,
      fallback: null
    })
    const revision = z.object({ savedRevision: z.string() }).parse(saved.body).savedRevision
    expect((await cold.request('standalone-config/activate', 'POST', { expectedRevision: revision })).status).toBe(202)
    await cold.app.close()
    const boot = await start(root)
    expect((await boot.request('pack/try', 'POST', { ...input, live: true })).status).toBe(503)
    boot.app.completeStartup()
    expect(boot.app.chatbotReady()).toBe(false)
    const live = await boot.request('pack/try', 'POST', { ...input, live: true })
    expect(live.status).toBe(200)
    expect(live.body).toMatchObject({ reply: 'Fixture response', live: true })
    expect(boot.main.requests).toHaveLength(1)
    expect(boot.main.requests[0]?.tools).toEqual([])
    const script = [
      'import sys',
      'from pathlib import Path',
      'from deploy.cli import configure, install, main, operations',
      'configure.selected_api = lambda *a, **k: {"base": sys.argv[1], ' +
        '"token": install.read_owner_token(Path(sys.argv[2])), "state": {}}',
      'operations.log_event = lambda *a, **k: "fixture-operation"',
      'sys.exit(main.main(sys.argv[3:]))'
    ].join('\n')
    const { stdout } = await promisify(execFile)('python3', [
      '-c',
      script,
      boot.site,
      join(root, 'standalone', 'owner.token'),
      'pack',
      'try',
      'example',
      'hello',
      '--live',
      '--json'
    ])
    expect(JSON.parse(stdout)).toMatchObject({ pack: { reply: 'Fixture response', live: true } })
    expect(boot.main.requests).toHaveLength(2)
    expect(boot.app.storage.read((db) => db.prepare('SELECT COUNT(*) FROM turn').pluck().get())).toBe(0)
  })

  it('exposes the optional media role only after the exact configured revision is applied', async () => {
    const root = tmpDir('aira-media-activation-')
    const cold = await start(root)
    expect((await cold.request('health')).body).toMatchObject({ roles: { media: { configured: false } } })
    const saved = await cold.request('standalone-config', 'PUT', {
      expectedRevision: null,
      main: candidate,
      fallback: null,
      media: { provider: 'gemini', model: 'fixture-model', apiKey: 'synthetic-media-key' }
    })
    expect(saved.status).toBe(200)
    expect(JSON.stringify(saved.body)).not.toContain('synthetic-media-key')
    const revision = z.object({ savedRevision: z.string() }).parse(saved.body).savedRevision
    expect((await cold.request('health')).body).toMatchObject({ roles: { media: { configured: false } } })
    expect((await cold.request('standalone-config/activate', 'POST', { expectedRevision: revision })).status).toBe(202)
    await cold.app.close()
    const boot = await start(root)
    expect((await boot.request('health')).body).toMatchObject({ roles: { media: { configured: false } } })
    boot.app.completeStartup()
    expect((await boot.request('health')).body).toMatchObject({ roles: { media: { configured: true } } })
    const cleared = await boot.request('standalone-config', 'PUT', {
      expectedRevision: revision,
      main: candidate,
      fallback: null,
      media: { provider: 'gemini', model: 'fixture-model', apiKey: null }
    })
    expect(cleared.status).toBe(200)
    const next = z.object({ savedRevision: z.string() }).parse(cleared.body).savedRevision
    expect((await boot.request('health')).body).toMatchObject({ roles: { media: { configured: true } } })
    expect((await boot.request('standalone-config/activate', 'POST', { expectedRevision: next })).status).toBe(202)
    await boot.app.close()
    const disabled = await start(root)
    disabled.app.completeStartup()
    expect((await disabled.request('health')).body).toMatchObject({ roles: { media: { configured: false } } })
    for (const run of [cold, boot, disabled]) {
      expect(run.watch).not.toHaveBeenCalled()
      expect(run.main.requests).toHaveLength(0)
    }
  })

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
