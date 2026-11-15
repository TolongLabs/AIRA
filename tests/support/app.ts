import type { AddressInfo } from 'node:net'
import { afterEach } from 'vitest'
import { type App, createApp } from '../../src/app.js'
import type { Config } from '../../src/config/schema.js'
import { type ModelClient, ModelError, type ModelRequest, type ModelResponse } from '../../src/models/types.js'
import { createLogger } from '../../src/records/logger.js'
import { ensureChat, setChatStatus } from '../../src/settings/chats.js'
import { setSetting } from '../../src/settings/settings.js'
import type { ToolPorts } from '../../src/tools/ports.js'
import { FakeGateway, type GatewayMessage } from '../harness/gateway.js'
import { testConfig } from './core.js'
import { tmpDir } from './tmp.js'

// The whole service as the entry point builds it, for tests: only the model is replaced, by a queue of answers.

export type Answer = Partial<ModelResponse> | ModelError
export function queueModel(answers: Answer[]): ModelClient & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = []
  return {
    requests,
    async call(request) {
      requests.push(structuredClone(request))
      const answer = answers[Math.min(requests.length, answers.length) - 1] as Answer
      if (answer instanceof ModelError) throw answer
      return {
        text: '',
        toolCalls: [],
        usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 0 },
        costUsd: 0.01,
        model: request.model,
        ...answer
      }
    }
  }
}

export const CHAT = 'test-chat-g1'
export const msg = (mid: string, text: string, sender = 'test-member-alice'): GatewayMessage => ({
  chat: { waId: CHAT, kind: 'group' },
  sender,
  mid,
  text
})

const apps: App[] = []
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close()
})

export async function startApp(
  main: ModelClient,
  options: {
    fallback?: ModelClient
    config?: (config: Config) => void
    dataDir?: string
    character?: string
    ports?: Partial<Omit<ToolPorts, 'filesDir'>>
  } = {}
) {
  const dataDir = options.dataDir ?? tmpDir('aira-app-')
  const config = testConfig((config) => {
    config.storage.path = dataDir
    config.storage.minFreeMb = 2
    config.storage.criticalFreeMb = 1
    config.gateway.hostDataDir = '/host/aira-data'
    config.llm.main = {
      ...config.llm.main,
      provider: 'openai-compatible',
      model: 'main-model',
      baseUrl: 'https://main.invalid/v1'
    }
    if (options.fallback) {
      config.llm.fallback = {
        ...config.llm.fallback,
        provider: 'openai-compatible',
        model: 'fallback-model',
        baseUrl: 'https://fallback.invalid/v1'
      }
    }
    options.config?.(config)
  })
  const logs: Record<string, unknown>[] = []
  const app = await createApp({
    config,
    env: {},
    clients: { main, fallback: options.fallback },
    ports: options.ports,
    logger: createLogger({ level: 'debug', module: 'core', sink: (line) => logs.push(JSON.parse(line)) })
  })
  apps.push(app)
  const address = (await app.listen(0, '127.0.0.1')) as AddressInfo
  const baseUrl = `http://127.0.0.1:${address.port}`
  setSetting(app.storage, {
    level: 'global',
    scope: '',
    key: 'character',
    value: options.character ?? 'example',
    actor: 'test'
  })
  const chat = ensureChat(app.storage, { waId: CHAT, type: 'group' })
  setChatStatus(app.storage, { chatId: chat.chatId, status: 'active', actor: 'test' })
  return { app, baseUrl, gateway: new FakeGateway({ baseUrl }), chatId: chat.chatId, dataDir, logs, config }
}

/** The newest turn row. */
export const lastTurn = (app: App) =>
  app.storage.read(
    (db) =>
      db.prepare('SELECT * FROM turn ORDER BY received_at DESC, rowid DESC LIMIT 1').get() as Record<string, unknown>
  )
