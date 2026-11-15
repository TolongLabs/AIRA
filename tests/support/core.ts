import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterEach } from 'vitest'
import { type PackSet, loadPacks } from '../../src/character/loader.js'
import { parseConfig } from '../../src/config/loader.js'
import type { Config } from '../../src/config/schema.js'
import { createGatewayServer } from '../../src/gateway/server.js'
import { ModelError } from '../../src/models/types.js'
import { type Logger, createLogger } from '../../src/records/logger.js'
import { createRedactor } from '../../src/records/redact.js'
import { ensureChat, setChatStatus } from '../../src/settings/chats.js'
import { setSetting } from '../../src/settings/settings.js'
import type { Storage } from '../../src/storage/database.js'
import { type StartedStorage, startStorage } from '../../src/storage/startup.js'
import { type AlertKind, createAlerter } from '../../src/turn/alerts.js'
import { basicPromptBuilder, plainCleaner } from '../../src/turn/defaults.js'
import { type TurnService, type TurnServiceDeps, createTurnService } from '../../src/turn/pipeline.js'
import type { RunResult, TurnRunner } from '../../src/turn/types.js'
import { FakeGateway } from '../harness/gateway.js'
import { tmpDir } from './tmp.js'

// A whole core in one process, for tests: real storage, real pipeline, real endpoint, and a scripted runner in
// place of a model. The fake gateway talks to it over HTTP, as the real gateway would.

export type RunnerInput = Parameters<TurnRunner['run']>[0]
export type Script = (input: RunnerInput, call: number) => string | Promise<string>

export function runResult(text: string, startedAt = new Date()): RunResult {
  return {
    text,
    usage: { inputTokens: 10, outputTokens: 5, cachedTokens: 0 },
    costUsd: 0.001,
    model: 'scripted-model',
    role: 'main',
    transport: 'api',
    calls: [
      {
        role: 'main',
        model: 'scripted-model',
        transport: 'api',
        attempt: 1,
        startedAt,
        durationMs: 1,
        usage: { inputTokens: 10, outputTokens: 5, cachedTokens: 0 },
        costUsd: 0.001
      }
    ],
    receipts: []
  }
}

/** A runner that answers from a script. It records every input it was given. */
export function scriptedRunner(script: Script): TurnRunner & { inputs: RunnerInput[] } {
  const inputs: RunnerInput[] = []
  return {
    inputs,
    async run(input) {
      inputs.push(input)
      return runResult(await script(input, inputs.length))
    }
  }
}

export function testConfig(overrides: (config: Config) => void = () => {}): Config {
  const config = parseConfig(readFileSync('config.yml', 'utf8'))
  config.turn.batchMs = 20
  overrides(config)
  return config
}

/** Copies the example pack under a new id, with a core identity that names the id, so two packs can be told apart. */
export function addPack(dataDir: string, id: string): void {
  const dir = join(dataDir, 'characters', id)
  mkdirSync(join(dataDir, 'characters'), { recursive: true })
  cpSync('characters/example', dir, { recursive: true })
  const card = readFileSync(join(dir, 'card.yml'), 'utf8')
  writeFileSync(
    join(dir, 'card.yml'),
    card
      .replace(/^id: .*$/m, `id: ${id}`)
      .replace(/^coreIdentity: >-\n(?: {2}.*\n)+/m, `coreIdentity: You are the ${id} test character.\n`)
  )
}

export interface TestCore {
  dataDir: string
  config: Config
  storage: Storage
  started: StartedStorage
  turns: TurnService
  server: Server
  baseUrl: string
  gateway: FakeGateway
  alerts: { kind: AlertKind; detail: Record<string, unknown> }[]
  logs: Record<string, unknown>[]
  packs: () => PackSet
  /** Switches a chat on and binds the default character, as the owner site will. */
  activate(waId: string, type?: 'dm' | 'group'): string
  /** Stops the server and closes the database. The data folder stays, so a new core can start on it. */
  close(): Promise<void>
}

const open: TestCore[] = []
afterEach(async () => {
  for (const core of open.splice(0)) await core.close()
})

export async function startTestCore(
  options: {
    dataDir?: string
    runner?: TurnRunner
    config?: Config
    deps?: Partial<TurnServiceDeps>
    logger?: Logger
    defaultCharacter?: string | null
  } = {}
): Promise<TestCore> {
  const dataDir = options.dataDir ?? tmpDir('aira-core-')
  const config = options.config ?? testConfig()
  const logs: Record<string, unknown>[] = []
  const logger =
    options.logger ?? createLogger({ level: 'debug', module: 'core', sink: (line) => logs.push(JSON.parse(line)) })
  const started = await startStorage({
    config: { storage: { ...config.storage, path: dataDir, minFreeMb: 2, criticalFreeMb: 1 } },
    logger
  })
  const { storage } = started
  const packs = () => loadPacks({ repositoryDir: 'characters', dataDir: join(dataDir, 'characters') })
  const alerts: TestCore['alerts'] = []
  if (options.defaultCharacter !== null) {
    setSetting(storage, {
      level: 'global',
      scope: '',
      key: 'character',
      value: options.defaultCharacter ?? 'example',
      actor: 'test'
    })
  }
  const redactor = createRedactor()
  const turns = createTurnService({
    storage,
    config,
    logger,
    redactor,
    packs,
    runner: options.runner ?? scriptedRunner((_, call) => `scripted reply ${call}`),
    prompt: basicPromptBuilder,
    cleaner: plainCleaner,
    alerter: createAlerter({
      minGapMs: config.alerts.minGapMs,
      logger,
      send: (kind, detail) => alerts.push({ kind, detail })
    }),
    ...options.deps
  })
  let ready = true
  const server = createGatewayServer({ turns, storage, logger, redactor, ready: () => ready })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  let closed = false
  const core: TestCore = {
    dataDir,
    config,
    storage,
    started,
    turns,
    server,
    baseUrl,
    gateway: new FakeGateway({ baseUrl }),
    alerts,
    logs,
    packs,
    activate(waId, type = 'group') {
      const chat = ensureChat(storage, { waId, type })
      setChatStatus(storage, { chatId: chat.chatId, status: 'active', actor: 'test' })
      return chat.chatId
    },
    async close() {
      if (closed) return
      closed = true
      ready = false
      await turns.drain(2000)
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
      storage.close()
    }
  }
  open.push(core)
  return core
}

/** A runner error of a given kind, for failure tests. */
export const modelError = (kind: ConstructorParameters<typeof ModelError>[0]) =>
  new ModelError(kind, `scripted ${kind}`)
