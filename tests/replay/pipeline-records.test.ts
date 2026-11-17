import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadPacks, type Pack } from '../../src/character/loader.js'
import { withAttachments } from '../../src/format/attachments.js'
import { createReplyCleaner } from '../../src/format/clean.js'
import type { GatewayRequest } from '../../src/gateway/request.js'
import { createApiRunner } from '../../src/models/api-runner.js'
import { createBreaker } from '../../src/models/breaker.js'
import { createRoutedClient } from '../../src/models/routed-client.js'
import { createSubscriptionRunner } from '../../src/models/subscription-runner.js'
import { createToolServer } from '../../src/models/tool-server.js'
import { ModelError } from '../../src/models/types.js'
import { withStickers } from '../../src/prompt/stickers.js'
import { createLogger } from '../../src/records/logger.js'
import { createRedactor } from '../../src/records/redact.js'
import { stageDurations } from '../../src/records/turn-view.js'
import { ensureChat, setChatStatus } from '../../src/settings/chats.js'
import { setSetting } from '../../src/settings/settings.js'
import type { Storage } from '../../src/storage/database.js'
import { basicPromptBuilder, plainCleaner } from '../../src/turn/defaults.js'
import { createTurnService } from '../../src/turn/pipeline.js'
import type { PromptBuilder, ReplyCleaner, TurnRunner } from '../../src/turn/types.js'
import { runResult, scriptedRunner, testConfig } from '../support/core.js'
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

function setup(
  runner: TurnRunner = scriptedRunner(() => 'test reply'),
  batchMs = 0,
  overrides: { cleaner?: ReplyCleaner; packs?: () => ReturnType<typeof loadPacks>; prompt?: PromptBuilder } = {}
) {
  const storage = tmpStorage()
  const config = testConfig((config) => {
    config.turn.batchMs = batchMs
  })
  const logs: Record<string, unknown>[] = []
  const logger = createLogger({ module: 'test', level: 'debug', sink: (line) => logs.push(JSON.parse(line)) })
  const packs =
    overrides.packs ?? (() => loadPacks({ repositoryDir: 'characters', dataDir: '/tmp/aira-no-private-packs' }))
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
    prompt: overrides.prompt ?? basicPromptBuilder,
    cleaner: overrides.cleaner ?? plainCleaner,
    alerter: {
      raise() {
        return false
      }
    }
  })
  return { storage, turns, logs, packs }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

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

  it('a cleaner throw is recorded as internal at stage clean', async () => {
    const throwingName = {
      length: 1,
      replace() {
        throw new Error('cleaner step exploded')
      }
    } as unknown as string
    const cleaner = createReplyCleaner({ format: { bubbleMaxChars: 700, maxBubbles: 3, leakCheck: 'off' } }, () => [
      throwingName
    ])
    const core = setup(
      scriptedRunner(() => 'hello there'),
      0,
      { cleaner }
    )
    const reply = await core.turns.handle(request('clean-throw'))

    expect(reply.content).toBe(core.packs().packs.get('example')?.lines.error)
    expect(reply.content).not.toContain('cleaner step exploded')
    expect(rows(core.storage, 'SELECT state, outcome, failure_kind FROM turn')).toEqual([
      { state: 'failed', outcome: 'failed', failure_kind: 'internal' }
    ])
    expect(rows(core.storage, 'SELECT stage, kind, message, stack FROM failure')).toEqual([
      {
        stage: 'clean',
        kind: 'internal',
        message: 'cleaner step exploded',
        stack: expect.stringContaining('Error: cleaner step exploded')
      }
    ])
  })

  it('a sticker or attachment storage error is recorded as a handled failure', async () => {
    const basePacks = loadPacks({ repositoryDir: 'characters', dataDir: '/tmp/aira-no-private-packs' })
    const basePack = basePacks.packs.get('example')!
    const moods = new Map(basePack.moods)
    const neutral = moods.get('neutral')!
    moods.set('neutral', { ...neutral, stickers: ['wave.webp'] })
    const dataPack: Pack = { ...basePack, source: 'data', moods }
    const brokenStorage = (msg: string): Storage =>
      ({
        read() {
          throw new Error(msg)
        },
        tx() {
          throw new Error(msg)
        }
      }) as unknown as Storage

    const stickerCore = setup(
      scriptedRunner(() => 'sticker text reply'),
      0,
      {
        packs: () => ({ packs: new Map([['example', dataPack]]), faults: [] }),
        prompt: {
          async build(input) {
            const built = await basicPromptBuilder.build(input)
            return { ...built, record: { ...built.record, mood: 'neutral' } }
          }
        },
        cleaner: withStickers(plainCleaner, {
          storage: brokenStorage('sticker store failed'),
          hostDataDir: '/host',
          random: () => 0
        })
      }
    )
    const stickerReply = await stickerCore.turns.handle(request('sticker-err'))
    expect(stickerReply.content).toBe('sticker text reply')
    expect(rows(stickerCore.storage, 'SELECT state, outcome, failure_kind FROM turn')).toEqual([
      { state: 'delivered', outcome: 'delivered', failure_kind: null }
    ])
    expect(rows(stickerCore.storage, 'SELECT stage, kind, handled_by, message, stack FROM failure')).toEqual([
      {
        stage: 'clean',
        kind: 'storage_error',
        handled_by: 'stickers',
        message: 'sticker store failed',
        stack: expect.stringContaining('Error: sticker store failed')
      }
    ])
    expect(stickerCore.logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: 'turn.failure', level: 'warn', stage: 'clean', kind: 'storage_error' })
      ])
    )

    const receiptRunner: TurnRunner = {
      run: async () => ({ ...runResult('attachment text reply'), receipts: ['rcpt_1'] })
    }
    const attachCore = setup(receiptRunner, 0, {
      packs: () => ({ packs: new Map([['example', dataPack]]), faults: [] }),
      prompt: {
        async build(input) {
          const built = await basicPromptBuilder.build(input)
          return { ...built, record: { ...built.record, mood: 'neutral' } }
        }
      },
      cleaner: withStickers(
        withAttachments(plainCleaner, {
          storage: brokenStorage('attachment store failed'),
          hostDataDir: '/host'
        }),
        {
          storage: tmpStorage(),
          hostDataDir: '/host',
          random: () => 0
        }
      )
    })
    const attachReply = await attachCore.turns.handle(request('attach-err'))
    expect(attachReply.content).toBe('attachment text reply\nMEDIA:/host/characters/example/stickers/wave.webp')
    expect(rows(attachCore.storage, 'SELECT state, outcome, failure_kind FROM turn')).toEqual([
      { state: 'delivered', outcome: 'delivered', failure_kind: null }
    ])
    expect(rows(attachCore.storage, 'SELECT stage, kind, handled_by, message, stack FROM failure')).toEqual([
      {
        stage: 'clean',
        kind: 'storage_error',
        handled_by: 'attachments',
        message: 'attachment store failed',
        stack: expect.stringContaining('Error: attachment store failed')
      }
    ])
  })

  it('closes the turn as failed with storage_error and returns the error line when closeTurn throws once', async () => {
    const core = setup()
    const origTx = core.storage.tx.bind(core.storage)
    let threw = false
    vi.spyOn(core.storage, 'tx').mockImplementation((fn) =>
      origTx((db) => {
        const result = fn(db)
        if (
          !threw &&
          (db.prepare("SELECT count(*) FROM session_message WHERE role = 'assistant'").pluck().get() as number) === 1
        ) {
          threw = true
          throw new Error('simulated closeTurn failure')
        }
        return result
      })
    )
    const reply = await core.turns.handle(request('close-throws-once'))

    expect(reply.content).not.toBe('')
    expect(reply.content).not.toBe('NO_REPLY')
    expect(reply.content).toBe(core.packs().packs.get('example')?.lines.error)
    expect(rows(core.storage, 'SELECT turn_id, state, outcome, failure_kind FROM turn')).toEqual([
      { turn_id: reply.turnId, state: 'failed', outcome: 'failed', failure_kind: 'storage_error' }
    ])
    expect(rows(core.storage, 'SELECT turn_id, stage, kind FROM failure')).toEqual([
      { turn_id: reply.turnId, stage: 'clean', kind: 'storage_error' }
    ])
    expect(core.logs).toEqual(
      expect.arrayContaining([expect.objectContaining({ event: 'turn.storage_failed', level: 'error' })])
    )
    const replayed = await core.turns.handle(request('close-throws-once'))
    expect(replayed.content).toBe(reply.content)
  })

  it('rejects waiters when both closeTurn and the fallback close transaction fail', async () => {
    const core = setup()
    const origTx = core.storage.tx.bind(core.storage)
    vi.spyOn(core.storage, 'tx').mockImplementation((fn) =>
      origTx((db) => {
        const result = fn(db)
        const assistantCount = db
          .prepare("SELECT count(*) FROM session_message WHERE role = 'assistant'")
          .pluck()
          .get() as number
        const failedCount = db.prepare("SELECT count(*) FROM turn WHERE state = 'failed'").pluck().get() as number
        if (assistantCount === 1 || failedCount === 1) {
          throw new Error('persistent storage failure')
        }
        return result
      })
    )
    await expect(core.turns.handle(request('close-throws-always'))).rejects.toThrow('persistent storage failure')
    expect(core.logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: 'turn.storage_failed', level: 'error' }),
        expect.objectContaining({ event: 'turn.storage_fallback_failed', level: 'error' })
      ])
    )
  })

  it('falls back to the default pack error line and records one internal failure when packs() throws', async () => {
    const basePacks = loadPacks({ repositoryDir: 'characters', dataDir: '/tmp/aira-no-private-packs' })
    let calls = 0
    const core = setup(
      scriptedRunner(() => 'unused'),
      0,
      {
        packs: () => {
          calls += 1
          // Call 1 runs during handle() mention replacement; call 2 runs inside execute() before context is built.
          if (calls === 2) throw new Error('pack read failed')
          return basePacks
        }
      }
    )
    const reply = await core.turns.handle(request('packs-throws'))

    expect(reply.content).toBe(basePacks.packs.get('example')?.lines.error)
    expect(rows(core.storage, 'SELECT turn_id, state, outcome, failure_kind FROM turn')).toEqual([
      { turn_id: reply.turnId, state: 'failed', outcome: 'failed', failure_kind: 'internal' }
    ])
    expect(rows(core.storage, 'SELECT turn_id, stage, kind FROM failure')).toEqual([
      { turn_id: reply.turnId, stage: 'internal', kind: 'internal' }
    ])
  })

  it('rejects when no pack loads after an uncaught exception so the gateway can retry', async () => {
    const basePacks = loadPacks({ repositoryDir: 'characters', dataDir: '/tmp/aira-no-private-packs' })
    let broken = true
    let calls = 0
    const core = setup(
      scriptedRunner(() => 'recovered reply'),
      0,
      {
        packs: () => {
          calls += 1
          if (broken && calls >= 2) throw new Error('no packs available')
          return basePacks
        }
      }
    )
    await expect(core.turns.handle(request('no-pack-retry'))).rejects.toThrow('no packs available')
    expect(rows(core.storage, 'SELECT state, outcome, failure_kind FROM turn')).toEqual([
      { state: 'failed', outcome: 'failed', failure_kind: 'internal' }
    ])
    expect(rows(core.storage, 'SELECT state FROM inbound_message')).toEqual([{ state: 'received' }])
    expect(rows(core.storage, 'SELECT stage, kind FROM failure')).toEqual([{ stage: 'internal', kind: 'internal' }])

    broken = false
    const retried = await core.turns.handle(request('no-pack-retry'))
    expect(retried.content).toBe('recovered reply')
  })
})
