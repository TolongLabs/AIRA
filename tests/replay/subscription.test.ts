import { type ChildProcess, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { App } from '../../src/app.js'
import { createApp } from '../../src/app.js'
import type { Config } from '../../src/config/schema.js'
import { countedSpend, monthOf } from '../../src/models/spend.js'
import { lastTurn, msg, queueModel, startApp } from '../support/app.js'
import { testConfig } from '../support/core.js'
import { tmpDir } from '../support/tmp.js'

// The subscription transport through the whole service: the real host runner service, the real tool server, and a
// fake of the program. Nothing here runs the real program.

const TOKEN = 'test-runner-token-0123456789'
const RUNNER = fileURLToPath(new URL('../../deploy/host-runner/runner.mjs', import.meta.url))
const FAKE = fileURLToPath(new URL('../support/fake-claude.mjs', import.meta.url))

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number }
      probe.close(() => resolve(port))
    })
  })

const children: ChildProcess[] = []
afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL')
})

async function startRunner(): Promise<string> {
  const port = await freePort()
  const child = spawn(process.execPath, [RUNNER], {
    env: {
      ...process.env,
      RUNNER_TOKEN: TOKEN,
      RUNNER_PORT: String(port),
      RUNNER_PROGRAM: JSON.stringify([process.execPath, FAKE])
    },
    stdio: ['ignore', 'pipe', 'ignore']
  })
  children.push(child)
  await new Promise<void>((resolve, reject) => {
    child.once('exit', () => reject(new Error('the runner service ended before it listened')))
    child.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('runner listening')) resolve()
    })
  })
  return `http://127.0.0.1:${port}`
}

const subscription = (runnerUrl: string, toolPort: number) => (config: Config) => {
  config.llm.transport = 'subscription'
  config.llm.main = { ...config.llm.main, provider: '', model: '', baseUrl: '' }
  config.llm.subscription = {
    runnerUrl,
    toolServerPort: toolPort,
    toolServerUrl: `http://127.0.0.1:${toolPort}`
  }
}

const rows = <T>(app: App, sql: string) => app.storage.read((db) => db.prepare(sql).all() as T[])

describe('the subscription transport in the service', () => {
  it('runs a turn through the host runner, with the tools served by the core, and counts no spend', async () => {
    const runnerUrl = await startRunner()
    const fallback = queueModel([{ text: 'the fallback answered' }])
    const { app, gateway } = await startApp(undefined, {
      fallback,
      env: { RUNNER_TOKEN: TOKEN },
      config: subscription(runnerUrl, await freePort())
    })

    const delivery = await gateway.send(msg('m-1', 'hello there\nCALL recall {"query":"tea"}'))
    expect(delivery.status).toBe('delivered')
    expect(lastTurn(app)).toMatchObject({ state: 'delivered', transport: 'subscription', role: 'main' })
    expect(fallback.requests).toHaveLength(0)
    // The program called a tool of the registry: the call is recorded like any other.
    expect(rows(app, 'SELECT tool, source, outcome FROM tool_call')).toEqual([
      { tool: 'recall', source: 'model', outcome: 'ok' }
    ])
    expect(rows(app, 'SELECT transport, failure_kind FROM model_call')).toEqual([
      { transport: 'subscription', failure_kind: null }
    ])
    // The estimated cost is on the record, and does not count against the cap.
    expect(countedSpend(app.storage, monthOf(new Date()))).toBe(0)
  })

  it('answers with the fallback model when the subscription reaches its limit, and then skips the service', async () => {
    const runnerUrl = await startRunner()
    const fallback = queueModel([{ text: 'the fallback answered' }])
    const { app, gateway } = await startApp(undefined, {
      fallback,
      env: { RUNNER_TOKEN: TOKEN },
      config: subscription(runnerUrl, await freePort())
    })

    expect((await gateway.send(msg('m-1', 'FAKE_RATE_LIMIT'))).content).toBe('the fallback answered')
    expect(lastTurn(app)).toMatchObject({ state: 'delivered', role: 'fallback' })
    expect(
      rows<{ transport: string; failure_kind: string | null }>(
        app,
        'SELECT transport, failure_kind FROM model_call ORDER BY id'
      )
    ).toEqual([
      { transport: 'subscription', failure_kind: 'rate_limit' },
      { transport: 'api', failure_kind: null }
    ])
    expect((await gateway.send(msg('m-2', 'are you there')))?.content).toBe('the fallback answered')
    // The breaker is open: the second turn made no subscription attempt.
    expect(rows(app, "SELECT 1 FROM model_call WHERE transport = 'subscription'")).toHaveLength(1)
  })

  it('answers with the fallback model when the host runner service is down', async () => {
    const fallback = queueModel([{ text: 'the fallback answered' }])
    const { gateway } = await startApp(undefined, {
      fallback,
      env: { RUNNER_TOKEN: TOKEN },
      config: subscription(`http://127.0.0.1:${await freePort()}`, await freePort())
    })
    expect((await gateway.send(msg('m-1', 'hello'))).content).toBe('the fallback answered')
  })

  it('refuses to start without the shared secret', async () => {
    const config = testConfig((draft) => {
      draft.storage.path = tmpDir('aira-sub-')
      draft.storage.minFreeMb = 2
      draft.storage.criticalFreeMb = 1
      subscription('http://127.0.0.1:9', 9883)(draft)
    })
    await expect(createApp({ config, env: {} })).rejects.toThrow(/RUNNER_TOKEN/)
  })
})
