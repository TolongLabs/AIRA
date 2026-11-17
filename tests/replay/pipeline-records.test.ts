import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadPacks } from '../../src/character/loader.js'
import type { GatewayRequest } from '../../src/gateway/request.js'
import { createApiRunner } from '../../src/models/api-runner.js'
import { createBreaker } from '../../src/models/breaker.js'
import { createRoutedClient } from '../../src/models/routed-client.js'
import { createSubscriptionRunner } from '../../src/models/subscription-runner.js'
import { createToolServer } from '../../src/models/tool-server.js'
import { ModelError } from '../../src/models/types.js'
import { createLogger } from '../../src/records/logger.js'
import { createRedactor } from '../../src/records/redact.js'
import { stageDurations } from '../../src/records/turn-view.js'
import { ensureChat, setChatStatus } from '../../src/settings/chats.js'
import { setSetting } from '../../src/settings/settings.js'
import type { Storage } from '../../src/storage/database.js'
import { basicPromptBuilder, plainCleaner } from '../../src/turn/defaults.js'
import { createTurnService } from '../../src/turn/pipeline.js'
import type { TurnRunner } from '../../src/turn/types.js'
import { scriptedRunner, testConfig } from '../support/core.js'
import { tmpStorage } from '../support/tmp.js'

const CHAT = 'test-chat-records'
const MEMBER = 'test-member-records'
const request = (mid = 'test-record'): Extract<GatewayRequest, { type: 'turn' }> => ({
  type: 'turn',
  marker: { platform: 'test', chat: CHAT, kind: 'group', sender: MEMBER, mid },
  text: 'test request',
  earlier: '',
  attachments: [],
  stream: false,
  includeUsage: false
})
const rows = <T = Record<string, unknown>>(storage: Storage, sql: string): T[] =>
  storage.read((db) => db.prepare(sql).all() as T[])

function setup(runner: TurnRunner = scriptedRunner(() => 'test reply'), batchMs = 0) {
  const storage = tmpStorage()
  const config = testConfig((config) => {
    config.turn.batchMs = batchMs
  })
  const logs: Record<string, unknown>[] = []
  const logger = createLogger({ module: 'test', level: 'debug', sink: (line) => logs.push(JSON.parse(line)) })
  const packs = () => loadPacks({ repositoryDir: 'characters', dataDir: '/tmp/aira-no-private-packs' })
  const chat = ensureChat(storage, { waId: CHAT, type: 'group' })
  setChatStatus(storage, { chatId: chat.chatId, status: 'active', actor: 'test' })
  setSetting(storage, { level: 'global', scope: '', key: 'character', value: 'example', actor: 'test' })
  const turns = createTurnService({
    storage,
    config,
    logger,
    redactor: createRedactor(),
    packs,
    runner,
    prompt: basicPromptBuilder,
    cleaner: plainCleaner,
    alerter: {
      raise() {
        return false
      }
    }
  })
  return { storage, turns, logs }
}

afterEach(() => vi.useRealTimers())

describe('attempt records and arrival latency', () => {
  it('keeps all three failed requests and their errors when the runner throws', async () => {
    const runner = createApiRunner({
      model: 'test-model',
      limits: { maxCallsPerTurn: 3, timeBudgetMs: 1000 },
      clientFor: (onCall) =>
        createRoutedClient({
          main: {
            model: 'test-model',
            client: {
              async call() {
                throw new ModelError('transient', 'attempt failed')
              }
            }
          },
          storage: core.storage,
          config: { llm: { maxRetries: 2, monthlyBudgetUsd: 50 } },
          breaker: createBreaker({ breakerMs: 1000 }),
          transport: 'api',
          sleep: async () => {},
          onCall
        })
    })
    const core = setup(runner)
    await core.turns.handle(request('failed-attempts'))
    expect(rows(core.storage, 'SELECT failure_kind FROM model_call')).toEqual([
      { failure_kind: 'transient' },
      { failure_kind: 'transient' },
      { failure_kind: 'transient' }
    ])
    expect(rows(core.storage, 'SELECT message, handled_by FROM failure')).toEqual([
      { message: 'attempt failed', handled_by: 'retry' },
      { message: 'attempt failed', handled_by: 'retry' },
      { message: 'attempt failed', handled_by: 'line:error' }
    ])
    expect(rows(core.storage, 'SELECT transport, role, attempts FROM turn')).toEqual([
      { transport: 'api', role: 'main', attempts: 3 }
    ])
  })

  it('returns a reply and records a warning and storage failure when spend cannot be saved', async () => {
    const runner = createApiRunner({
      model: 'test-model',
      limits: { maxCallsPerTurn: 3, timeBudgetMs: 1000 },
      clientFor: (onCall, onSpendError) =>
        createRoutedClient({
          main: {
            model: 'test-model',
            client: {
              async call() {
                vi.spyOn(core.storage, 'tx').mockImplementationOnce(() => {
                  throw new Error('spend write failed')
                })
                return {
                  text: 'test reply',
                  toolCalls: [],
                  usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
                  costUsd: 0.01,
                  model: 'test-model'
                }
              }
            }
          },
          storage: core.storage,
          config: { llm: { maxRetries: 2, monthlyBudgetUsd: 50 } },
          breaker: createBreaker({ breakerMs: 1000 }),
          transport: 'api',
          onCall,
          onSpendError
        })
    })
    const core = setup(runner)
    expect((await core.turns.handle(request())).content).toBe('test reply')
    expect(rows(core.storage, 'SELECT kind, handled_by FROM failure')).toEqual([
      { kind: 'storage_error', handled_by: 'reply' }
    ])
    expect(core.logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: 'model.spend_failed', level: 'warn', turn_id: expect.any(String) })
      ])
    )
  })

  it('keeps a failed subscription request when no fallback exists', async () => {
    const logger = createLogger({ module: 'test', level: 'warn', sink() {} })
    const runner = createSubscriptionRunner({
      subscription: { runnerUrl: 'http://127.0.0.1:1', toolServerUrl: 'http://127.0.0.1:2' },
      model: 'test-model',
      effort: '',
      runnerToken: 'test-token',
      logger,
      toolServer: createToolServer({ limits: { maxCallsPerTurn: 3, timeBudgetMs: 1000 }, logger }),
      breaker: createBreaker({ breakerMs: 1000 }),
      fetch: async () => new Response('', { status: 503 })
    })
    const core = setup(runner)
    await core.turns.handle(request())
    expect(rows(core.storage, 'SELECT transport, failure_kind FROM model_call')).toEqual([
      { transport: 'subscription', failure_kind: 'transient' }
    ])
    expect(rows(core.storage, 'SELECT kind, message FROM failure')).toEqual([
      { kind: 'transient', message: 'subscription runner returned HTTP 503' }
    ])
  })

  it('includes a 1500 ms batch wait in total latency and balances stage durations', async () => {
    const core = setup(
      scriptedRunner(() => {
        vi.setSystemTime(Date.now() + 120)
        return 'test reply'
      }),
      1500
    )
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    try {
      const pending = core.turns.handle(request())
      await vi.advanceTimersByTimeAsync(1500)
      await pending
      const turn = rows<Record<string, unknown>>(core.storage, 'SELECT * FROM turn')[0]!
      expect(turn['queue_ms']).toBe(1500)
      expect(turn['total_ms']).toBe(1620)
      expect(Number(turn['queue_ms']) + stageDurations(turn).reduce((sum, stage) => sum + stage.ms, 0)).toBe(1620)
    } finally {
      vi.useRealTimers()
    }
  })
})
