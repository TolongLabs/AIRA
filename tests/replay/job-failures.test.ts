import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type App, type AppOptions, createApp } from '../../src/app.js'
import { ModelError } from '../../src/models/types.js'
import { createLogger } from '../../src/records/logger.js'
import { ensureChat, setChatStatus } from '../../src/settings/chats.js'
import { setSetting } from '../../src/settings/settings.js'
import { createDiskGuard } from '../../src/storage/disk-guard.js'
import { startSnapshotTimer } from '../../src/storage/snapshot.js'
import { queueModel } from '../support/app.js'
import { testConfig } from '../support/core.js'
import { scriptedJudge } from '../support/memory.js'
import { tmpDir, tmpStorage } from '../support/tmp.js'

// Regression coverage for #123 through the production wiring.
const apps: App[] = []
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const app of apps.splice(0)) await app.close()
})

async function startApp(
  main: NonNullable<AppOptions['clients']>['main'],
  options: {
    env?: NodeJS.ProcessEnv
    memoryJudge?: AppOptions['memoryJudge']
    config?: (config: AppOptions['config']) => void
    dataDir?: string
  } = {}
) {
  const config = testConfig((config) => {
    config.storage.path = options.dataDir ?? tmpDir()
    config.storage.minFreeMb = 2
    config.storage.criticalFreeMb = 1
    config.archive.enabled = 'off'
    config.llm.main = {
      ...config.llm.main,
      model: 'test-model',
      baseUrl: 'https://model.invalid',
      provider: 'openai-compatible'
    }
    options.config?.(config)
  })
  const logs: Record<string, unknown>[] = []
  const app = await createApp({
    config,
    env: options.env ?? {},
    clients: { main },
    memoryJudge: options.memoryJudge,
    logger: createLogger({ level: 'debug', module: 'test', sink: (line) => logs.push(JSON.parse(line)) })
  })
  apps.push(app)
  setSetting(app.storage, { level: 'global', scope: '', key: 'character', value: 'example', actor: 'test' })
  const chat = ensureChat(app.storage, { waId: 'test-chat', type: 'group' })
  setChatStatus(app.storage, { chatId: chat.chatId, status: 'active', actor: 'test' })
  return { app, logs }
}
const send = (app: App, mid: string, text: string) =>
  app.turns.handle({
    type: 'turn',
    marker: { platform: 'test', chat: 'test-chat', kind: 'group', sender: 'test-member', mid },
    text,
    earlier: '',
    attachments: [],
    stream: false,
    includeUsage: false
  })

describe('background and judge failure records', () => {
  it('records a judge 401 once and alerts with the judge role and turn context', async () => {
    const original = globalThis.fetch
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) =>
      String(input).startsWith('https://api.typesafe.ai/')
        ? Promise.resolve(new Response('{}', { status: 401 }))
        : original(input, init)
    )
    const { app, logs } = await startApp(queueModel([{ text: 'Ready.' }]), {
      env: { TYPESAFE_API_KEY: 'invented-judge-secret' },
      config: (config) => {
        config.judge.model = 'judge-test'
        config.judge.mood = 'on'
      }
    })
    await send(app, 'judge-failure', 'hello')
    expect(app.storage.read((db) => db.prepare('SELECT state, failure_kind FROM turn').all())).toEqual([
      expect.objectContaining({ state: 'delivered' })
    ])
    const calls = app.storage.read((db) => db.prepare("SELECT * FROM model_call WHERE role = 'judge'").all())
    expect(calls).toEqual([
      expect.objectContaining({ role: 'judge', failure_kind: 'auth', turn_id: expect.any(String) })
    ])
    expect(
      app.storage.read((db) => db.prepare("SELECT * FROM failure WHERE kind = 'judge_unavailable'").all())
    ).toEqual([expect.objectContaining({ turn_id: expect.any(String) })])
    expect(logs.filter((line) => line['event'] === 'alert' && line['kind'] === 'model_auth')).toEqual([
      expect.objectContaining({ role: 'judge' })
    ])
  })

  it('prunes expired diagnostics at start-up after a 25-hour-old retention run', async () => {
    const dataDir = tmpDir()
    const storage = tmpStorage({ dir: dataDir })
    const old = new Date(Date.now() - 25 * 3_600_000).toISOString()
    storage.tx((db) => {
      db.prepare("INSERT INTO job_run (kind, started_at, ended_at, outcome) VALUES ('retention', ?, ?, 'ok')").run(
        old,
        old
      )
      db.prepare(
        "INSERT INTO turn (turn_id, chat_id, sender_id, kind, state, stage, received_at, ended_at) VALUES ('expired', 'chat', 'member', 'reply', 'failed', 'receive', ?, ?)"
      ).run(old, old)
      db.prepare(
        "INSERT INTO failure_diagnostics (turn_id, request, created_at) VALUES ('expired', 'invented request', ?)"
      ).run(new Date(Date.now() - 80 * 3_600_000).toISOString())
    })
    storage.close()
    const { app } = await startApp(queueModel([{ text: 'Ready.' }]), { dataDir })
    expect(app.storage.read((db) => db.prepare('SELECT * FROM failure_diagnostics').all())).toEqual([])
    expect(app.storage.read((db) => db.prepare("SELECT * FROM job_run WHERE kind = 'retention'").all())).toHaveLength(2)
  })

  it('calls onError once and records backup_failed when a transaction inside takeSnapshot throws', async () => {
    const storage = tmpStorage()
    const tx = storage.tx.bind(storage)
    let calls = 0
    vi.spyOn(storage, 'tx').mockImplementation((work) => {
      calls += 1
      if (calls === 2) throw new Error('snapshot transaction unavailable')
      return tx(work)
    })
    vi.useFakeTimers()
    const onError = vi.fn()
    const stop = startSnapshotTimer(storage, join(tmpDir(), 'snapshots'), { everyMin: 1, keepDays: 1, onError })
    await vi.advanceTimersByTimeAsync(60_000)
    await stop()
    expect(onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: 'snapshot transaction unavailable' })
    )
    expect(storage.read((db) => db.prepare("SELECT * FROM failure WHERE kind = 'backup_failed'").all())).toEqual([
      expect.objectContaining({ job_id: expect.any(String) })
    ])
    expect(storage.read((db) => db.prepare("SELECT outcome FROM job_run WHERE kind = 'snapshot'").all())).toEqual([
      { outcome: 'failed' }
    ])
  })

  it('logs and alerts a failed snapshot while keeping one failure row and failed job run', async () => {
    const { app, logs } = await startApp(queueModel([{ text: 'Ready.' }]))
    vi.spyOn(app.storage, 'backup').mockRejectedValueOnce(new Error('backup unavailable'))
    expect(await app.snapshot('manual')).toMatchObject({ state: 'failed' })
    expect(
      app.storage.read((db) => db.prepare("SELECT * FROM failure WHERE kind = 'backup_failed'").all())
    ).toHaveLength(1)
    expect(app.storage.read((db) => db.prepare("SELECT outcome FROM job_run WHERE kind = 'snapshot'").all())).toEqual([
      { outcome: 'failed' }
    ])
    expect(logs.filter((line) => line['event'] === 'storage.backup_failed')).toHaveLength(1)
    expect(logs.filter((line) => line['event'] === 'alert' && line['kind'] === 'storage')).toHaveLength(1)
  })

  it('reports each failed disk measurement while preserving the last level', async () => {
    const onError = vi.fn()
    const measure = vi
      .fn()
      .mockReturnValueOnce(100)
      .mockImplementation(() => {
        throw new Error('measurement unavailable')
      })
    const guard = createDiskGuard({ dataDir: tmpDir(), minFreeMb: 50, criticalFreeMb: 10, freeMb: measure, onError })
    guard.check()
    vi.useFakeTimers()
    const stop = guard.start(1000)
    await vi.advanceTimersByTimeAsync(2000)
    stop()
    expect(onError).toHaveBeenCalledTimes(2)
    expect(guard.state()).toMatchObject({ level: 'ok', freeMb: 100 })
  })

  it('records each memory attempt, its failure stack and model calls with the job id', async () => {
    const model = queueModel([{ text: 'Ready.' }])
    const original = model.call.bind(model)
    let attempts = 0
    model.call = async (request, signal) => {
      if ('response_format' in request.params) {
        attempts += 1
        if (attempts === 1) throw new ModelError('transient', 'extraction unavailable')
        return {
          text: '{"operations":[]}',
          toolCalls: [],
          model: request.model,
          usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
          costUsd: 0
        }
      }
      return original(request, signal)
    }
    const { app } = await startApp(model, {
      memoryJudge: scriptedJudge(),
      config: (config) => {
        config.memory.episodeIdleMs = 1
        config.llm.maxRetries = 0
      }
    })
    await send(app, 'memory-attempt', 'I prefer tea every morning')
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(await app.memory?.tick()).toBe('retry')
    app.storage.tx((db) =>
      db.prepare("UPDATE memory_job SET run_after = ? WHERE state = 'queued'").run(new Date(0).toISOString())
    )
    expect(await app.memory?.tick()).toBe('done')
    const runs = app.storage.read((db) =>
      db.prepare("SELECT * FROM job_run WHERE kind = 'memory' ORDER BY id").all()
    ) as { job_id: string }[]
    expect(runs).toHaveLength(2)
    const jobId = runs[0]?.job_id
    expect(jobId).toEqual(expect.any(String))
    expect(runs).toEqual([
      expect.objectContaining({ outcome: 'retry' }),
      expect.objectContaining({ outcome: 'done', job_id: jobId })
    ])
    expect(
      app.storage.read((db) => db.prepare("SELECT * FROM failure WHERE kind = 'memory_job_failed'").all())
    ).toEqual([expect.objectContaining({ job_id: jobId, stack: expect.stringContaining('extraction unavailable') })])
    const calls = app.storage.read((db) => db.prepare('SELECT job_id FROM model_call WHERE turn_id IS NULL').all())
    expect(calls.length).toBeGreaterThanOrEqual(2)
    expect(calls.every((call) => (call as { job_id: string }).job_id === jobId)).toBe(true)
  })
})
