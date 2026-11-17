import { type ChildProcess, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { type IncomingMessage, type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { type App, createApp } from '../../src/app.js'
import { parseConfig } from '../../src/config/loader.js'
import type { Config } from '../../src/config/schema.js'
import { createLogger } from '../../src/records/logger.js'
import { formatTurn, readTurn } from '../../src/records/turn-view.js'
import { ensureChat, setChatStatus } from '../../src/settings/chats.js'
import { setSetting } from '../../src/settings/settings.js'
import { FakeGateway, type GatewayMessage } from '../harness/gateway.js'
import { tmpDir } from '../support/tmp.js'

const CHAT = 'test-chat-think'
const SENDER = 'test-member-think'
const RUNNER = fileURLToPath(new URL('../../deploy/host-runner/runner.mjs', import.meta.url))
const FAKE_CLAUDE = fileURLToPath(new URL('../support/fake-claude.mjs', import.meta.url))
const RUNNER_TOKEN = 'test-think-runner-token-0123456789'

interface RecordedRequest {
  url: string
  body: Record<string, unknown>
}

interface MockAnswer {
  status?: number
  body: Record<string, unknown>
}

interface MockServer {
  url: string
  requests: RecordedRequest[]
  close(): Promise<void>
}

const servers: MockServer[] = []
const apps: App[] = []
let sharedRunner: { url: string; proc: ChildProcess } | undefined

beforeAll(async () => {
  sharedRunner = await startRunner()
})

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close()
  for (const server of servers.splice(0)) await server.close()
})

afterAll(() => {
  sharedRunner?.proc.kill('SIGKILL')
})

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

async function startMockServer(answers: MockAnswer[]): Promise<MockServer> {
  const requests: RecordedRequest[] = []
  const server: Server = createServer(async (req, res) => {
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>
    requests.push({ url: req.url ?? '', body })
    const next = answers[Math.min(requests.length, answers.length) - 1] ?? { status: 200, body: {} }
    res.writeHead(next.status ?? 200, { 'content-type': 'application/json' }).end(JSON.stringify(next.body))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const mock: MockServer = {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
  servers.push(mock)
  return mock
}

function anthropicText(text: string): MockAnswer {
  return {
    body: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-5-5',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    }
  }
}

function openAiText(text: string): MockAnswer {
  return {
    body: {
      model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017',
      choices: [{ message: { content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 20 }
    }
  }
}

function openAiToolCall(id: string, name: string, args: Record<string, unknown>): MockAnswer {
  return {
    body: {
      model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017',
      choices: [
        {
          message: {
            content: '',
            reasoning_content: 'check first',
            tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }]
          },
          finish_reason: 'tool_calls'
        }
      ],
      usage: { prompt_tokens: 80, completion_tokens: 15 }
    }
  }
}

function rateLimitError(): MockAnswer {
  return { status: 429, body: { type: 'error', error: { type: 'rate_limit_error', message: 'rate limited' } } }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo
      probe.close(() => resolve(port))
    })
  })
}

async function startRunner(): Promise<{ url: string; proc: ChildProcess }> {
  const port = await freePort()
  const child = spawn(process.execPath, [RUNNER], {
    env: {
      ...process.env,
      RUNNER_TOKEN,
      RUNNER_PORT: String(port),
      RUNNER_PROGRAM: JSON.stringify([process.execPath, FAKE_CLAUDE])
    },
    stdio: ['ignore', 'pipe', 'ignore']
  })
  await new Promise<void>((resolve, reject) => {
    child.once('exit', () => reject(new Error('runner stopped before listening')))
    child.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('runner listening')) resolve()
    })
  })
  return { url: `http://127.0.0.1:${port}`, proc: child }
}

async function startRunnerProxy(targetUrl: string) {
  const runs: Array<{ request: Record<string, unknown>; fakeOutput: Record<string, unknown> }> = []
  const server: Server = createServer(async (req, res) => {
    const raw = await readBody(req)
    const headers: Record<string, string> = {}
    if (typeof req.headers.authorization === 'string') headers['authorization'] = req.headers.authorization
    if (req.method === 'POST') headers['content-type'] = 'application/json'
    const upstream = await fetch(`${targetUrl}${req.url ?? ''}`, {
      method: req.method,
      headers,
      ...(req.method === 'POST' ? { body: raw } : {})
    })
    const text = await upstream.text()
    if (req.url === '/run' && raw) {
      const resultLine = text
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((event) => event['type'] === 'result')
      runs.push({
        request: JSON.parse(raw) as Record<string, unknown>,
        fakeOutput: JSON.parse(String(resultLine?.['result'] ?? '{}')) as Record<string, unknown>
      })
    }
    res
      .writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' })
      .end(text)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const mock: MockServer = {
    url: `http://127.0.0.1:${port}`,
    requests: [],
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
  servers.push(mock)
  return { url: mock.url, runs }
}

async function startThinkApp(options: {
  mainAnswers?: MockAnswer[]
  fallbackAnswers?: MockAnswer[]
  configure?: (config: Config) => void
  env?: NodeJS.ProcessEnv
}) {
  const mainServer = options.mainAnswers ? await startMockServer(options.mainAnswers) : undefined
  const fallbackServer = options.fallbackAnswers ? await startMockServer(options.fallbackAnswers) : undefined
  const dataDir = tmpDir('aira-think-')
  const config = parseConfig(readFileSync('config.yml', 'utf8'))
  config.storage.path = dataDir
  config.storage.minFreeMb = 2
  config.storage.criticalFreeMb = 1
  config.turn.batchMs = 0
  config.gateway.hostDataDir = '/host/aira-data'
  if (mainServer) {
    config.llm.main = { ...config.llm.main, provider: 'anthropic', baseUrl: mainServer.url }
  }
  if (fallbackServer) {
    config.llm.fallback = { ...config.llm.fallback, provider: 'openai-compatible', baseUrl: `${fallbackServer.url}/v1` }
  }
  options.configure?.(config)

  const app = await createApp({
    config,
    env: {
      LLM_API_KEY: 'test-main-key',
      ...(fallbackServer ? { LLM_FALLBACK_API_KEY: 'test-fallback-key' } : {}),
      ...options.env
    },
    logger: createLogger({ level: 'error', module: 'think-test', sink: () => {} })
  })
  apps.push(app)
  const address = await app.listen(0, '127.0.0.1')
  const baseUrl = `http://127.0.0.1:${address.port}`
  setSetting(app.storage, { level: 'global', scope: '', key: 'character', value: 'example', actor: 'test' })
  const chat = ensureChat(app.storage, { waId: CHAT, type: 'group' })
  setChatStatus(app.storage, { chatId: chat.chatId, status: 'active', actor: 'test' })

  const send = (mid: string, text: string, extra: Partial<GatewayMessage> = {}) =>
    new FakeGateway({ baseUrl }).send({
      chat: { waId: CHAT, kind: 'group' },
      sender: SENDER,
      mid,
      text,
      ...extra
    })

  return { app, chatId: chat.chatId, mainServer, fallbackServer, send }
}

const rows = <T>(app: App, sql: string, ...args: unknown[]) =>
  app.storage.read((db) => db.prepare(sql).all(...args) as T[])

describe('/think deeper effort', () => {
  it(
    '/think at the start runs the turn at deepEffort and the model never sees the prefix',
    { timeout: 15_000 },
    async () => {
      const { app, mainServer, send } = await startThinkApp({
        mainAnswers: [
          anthropicText('normal answer'),
          anthropicText('deep answer'),
          anthropicText('caps answer'),
          anthropicText('bare answer')
        ]
      })

      await send('m-1', 'what is two plus two?')
      await send('m-2', '/think explain quantum tunnelling')
      await send('m-3', '/THINK explain again')
      await send('m-4', '/think', { quote: { text: 'why did it fail?', id: 'q-1' } })

      expect(mainServer?.requests.map((r) => r.body['output_config'])).toEqual([
        { effort: 'medium' },
        { effort: 'high' },
        { effort: 'high' },
        { effort: 'high' }
      ])
      for (const req of mainServer?.requests ?? []) {
        expect(JSON.stringify(req.body['messages']).toLowerCase()).not.toContain('/think')
      }
      const stored = rows<{ content: string }>(
        app,
        "SELECT content FROM session_message WHERE role = 'user' ORDER BY id"
      )
      expect(stored.map((r) => r.content)).toEqual([
        'what is two plus two?',
        'explain quantum tunnelling',
        'explain again',
        ''
      ])

      const proxy = await startRunnerProxy(sharedRunner!.url)
      const toolPort = await freePort()
      const subApp = await startThinkApp({
        env: { RUNNER_TOKEN },
        configure: (cfg) => {
          cfg.llm.transport = 'subscription'
          cfg.llm.main = { ...cfg.llm.main, provider: '', model: '', baseUrl: '' }
          cfg.llm.subscription = {
            runnerUrl: proxy.url,
            toolServerPort: toolPort,
            toolServerUrl: `http://127.0.0.1:${toolPort}`
          }
        }
      })
      const subNormal = await subApp.send('sub-1', 'hello normally')
      const subDeep = await subApp.send('sub-2', '/think think deeply')
      expect(subNormal.status).toBe('delivered')
      expect(subDeep.status).toBe('delivered')
      expect(proxy.runs).toHaveLength(2)
      expect(proxy.runs[0]?.request['effort']).toBe('medium')
      expect(proxy.runs[1]?.request['effort']).toBe('high')
      expect((proxy.runs[0]?.fakeOutput['args'] as string[]).slice(-2)).toEqual(['--effort', 'medium'])
      expect((proxy.runs[1]?.fakeOutput['args'] as string[]).slice(-2)).toEqual(['--effort', 'high'])
      expect(String(proxy.runs[1]?.fakeOutput['prompt']).toLowerCase()).not.toContain('/think')
    }
  )

  it('/think in the middle of a message is ordinary text', async () => {
    const { app, mainServer, send } = await startThinkApp({
      mainAnswers: [anthropicText('middle answer'), anthropicText('word answer'), anthropicText('line answer')]
    })

    await send('m-1', 'can you /think about this carefully?')
    await send('m-2', '/thinking about this')
    await send('m-3', 'first line\n/think second line')

    expect(mainServer?.requests.map((r) => r.body['output_config'])).toEqual([
      { effort: 'medium' },
      { effort: 'medium' },
      { effort: 'medium' }
    ])
    expect(JSON.stringify(mainServer?.requests[0]?.body['messages'])).toContain('can you /think about this carefully?')
    expect(JSON.stringify(mainServer?.requests[1]?.body['messages'])).toContain('/thinking about this')
    expect(JSON.stringify(mainServer?.requests[2]?.body['messages'])).toContain('first line\\n/think second line')
    expect(
      rows<{ content: string }>(app, "SELECT content FROM session_message WHERE role = 'user' ORDER BY id")
    ).toEqual([
      { content: 'can you /think about this carefully?' },
      { content: '/thinking about this' },
      { content: 'first line\n/think second line' }
    ])
    expect(rows<{ think: number }>(app, 'SELECT think FROM turn ORDER BY rowid')).toEqual([
      { think: 0 },
      { think: 0 },
      { think: 0 }
    ])
  })

  it('features.think off removes the prefix and runs at normal effort', async () => {
    const { app, chatId, mainServer, send } = await startThinkApp({
      mainAnswers: [anthropicText('normal effort answer')]
    })
    setSetting(app.storage, { level: 'chat', scope: chatId, key: 'features.think', value: false, actor: 'test' })

    await send('m-1', '/think explain why the sky is blue')

    expect(mainServer?.requests[0]?.body['output_config']).toEqual({ effort: 'medium' })
    expect(JSON.stringify(mainServer?.requests[0]?.body['messages'])).toContain('explain why the sky is blue')
    expect(JSON.stringify(mainServer?.requests[0]?.body['messages']).toLowerCase()).not.toContain('/think')
    expect(rows<{ content: string }>(app, "SELECT content FROM session_message WHERE role = 'user'")).toEqual([
      { content: 'explain why the sky is blue' }
    ])
    expect(rows<{ think: number }>(app, 'SELECT think FROM turn')).toEqual([{ think: 0 }])
    expect(rows<{ effort: string | null }>(app, 'SELECT effort FROM model_call')).toEqual([{ effort: 'medium' }])
  })

  it("the fallback of a think turn runs at the fallback's deepEffort", { timeout: 15_000 }, async () => {
    const normalRun = await startThinkApp({
      mainAnswers: [rateLimitError()],
      fallbackAnswers: [openAiText('Normal fallback')]
    })
    expect((await normalRun.send('n-1', 'ordinary message')).content).toBe('Normal fallback')
    expect(normalRun.mainServer?.requests[0]?.body['output_config']).toEqual({ effort: 'medium' })
    expect(normalRun.fallbackServer?.requests[0]?.body['reasoning_effort']).toBe('high')

    const deepRun = await startThinkApp({
      mainAnswers: [rateLimitError()],
      fallbackAnswers: [openAiText('Deep fallback')]
    })
    expect((await deepRun.send('d-1', '/think hard question')).content).toBe('Deep fallback')
    expect(deepRun.mainServer?.requests[0]?.body['output_config']).toEqual({ effort: 'high' })
    expect(deepRun.fallbackServer?.requests[0]?.body['reasoning_effort']).toBe('max')
    expect(JSON.stringify(deepRun.fallbackServer?.requests[0]?.body['messages']).toLowerCase()).not.toContain('/think')

    const emptyDeepFallback = await startThinkApp({
      mainAnswers: [rateLimitError()],
      fallbackAnswers: [openAiText('Normal fallback on empty deep')],
      configure: (cfg) => {
        cfg.llm.fallback.deepEffort = ''
      }
    })
    expect((await emptyDeepFallback.send('e-1', '/think question')).content).toBe('Normal fallback on empty deep')
    expect(emptyDeepFallback.fallbackServer?.requests[0]?.body['reasoning_effort']).toBe('high')

    const subToolPort = await freePort()
    const subFallback = await startThinkApp({
      fallbackAnswers: [openAiText('Sub deep fallback')],
      env: { RUNNER_TOKEN },
      configure: (cfg) => {
        cfg.llm.transport = 'subscription'
        cfg.llm.main = { ...cfg.llm.main, provider: '', model: '', baseUrl: '' }
        cfg.llm.subscription = {
          runnerUrl: 'http://127.0.0.1:9',
          toolServerPort: subToolPort,
          toolServerUrl: `http://127.0.0.1:${subToolPort}`
        }
      }
    })
    expect((await subFallback.send('sf-1', '/think rescue me')).content).toBe('Sub deep fallback')
    expect(subFallback.fallbackServer?.requests[0]?.body['reasoning_effort']).toBe('max')
  })

  it('the turn record notes think and the effort of each call', async () => {
    const { app, send } = await startThinkApp({
      mainAnswers: [anthropicText('normal reply'), rateLimitError()],
      fallbackAnswers: [openAiToolCall('call-1', 'recall', { query: 'tea' }), openAiText('deep fallback reply')]
    })

    await send('m-1', 'ordinary turn')
    await send('m-2', '/think check my tea preferences')

    const turns = rows<{ turn_id: string; think: number; role: string; attempts: number }>(
      app,
      'SELECT turn_id, think, role, attempts FROM turn ORDER BY rowid'
    )
    expect(turns).toEqual([
      { turn_id: expect.any(String), think: 0, role: 'main', attempts: 1 },
      { turn_id: expect.any(String), think: 1, role: 'fallback', attempts: 3 }
    ])

    const calls = rows<{ turn_id: string; role: string; effort: string | null; failure_kind: string | null }>(
      app,
      'SELECT turn_id, role, effort, failure_kind FROM model_call ORDER BY id'
    )
    expect(calls).toEqual([
      { turn_id: turns[0]?.turn_id, role: 'main', effort: 'medium', failure_kind: null },
      { turn_id: turns[1]?.turn_id, role: 'main', effort: 'high', failure_kind: 'rate_limit' },
      { turn_id: turns[1]?.turn_id, role: 'fallback', effort: 'max', failure_kind: null },
      { turn_id: turns[1]?.turn_id, role: 'fallback', effort: 'max', failure_kind: null }
    ])

    const view = app.storage.read((db) => readTurn(db, turns[1]!.turn_id))!
    const formatted = formatTurn(view)
    expect(formatted).toContain('think=true')
    expect(formatted).toContain('effort=high')
    expect(formatted).toContain('effort=max')
  })
})
