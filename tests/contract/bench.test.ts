import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openChatSession } from '../../src/bench/chat.js'
import { type BenchRow, loadBenchSet, runBench, summarise, writeBenchResult } from '../../src/bench/run.js'
import { ModelError } from '../../src/models/types.js'
import { openReader } from '../../src/storage/database.js'
import { queueModel } from '../support/app.js'
import { testConfig } from '../support/core.js'
import { tmpDir } from '../support/tmp.js'

function benchConfig(dataDir?: string) {
  return testConfig((config) => {
    if (dataDir) config.storage.path = dataDir
    config.storage.minFreeMb = 2
    config.storage.criticalFreeMb = 1
    config.gateway.hostDataDir = '/host/aira-data'
    config.llm.main = {
      ...config.llm.main,
      provider: 'openai-compatible',
      model: 'main-model',
      baseUrl: 'https://main.invalid/v1'
    }
    config.llm.maxRetries = 0
  })
}

describe('bench', () => {
  it('loadBenchSet loads both shipped sets with no digit runs of 7+ digits and no @', () => {
    const casual = loadBenchSet('bench/casual.yml')
    const tool = loadBenchSet('bench/tool.yml')
    expect(casual.name).toBe('casual')
    expect(casual.prompts).toHaveLength(12)
    expect(tool.name).toBe('tool')
    expect(tool.prompts).toHaveLength(8)

    for (const file of ['bench/casual.yml', 'bench/tool.yml']) {
      const raw = readFileSync(file, 'utf8')
      expect(raw).not.toMatch(/\d{7,}/)
      expect(raw).not.toContain('@')
    }
  })

  it('loadBenchSet refuses files with no prompts, an empty prompt, or 51 prompts', () => {
    const dir = tmpDir('aira-bench-set-')

    const nonePath = join(dir, 'none.yml')
    writeFileSync(nonePath, 'name: empty\ndescription: none\nprompts: []\n', 'utf8')
    expect(() => loadBenchSet(nonePath)).toThrow()

    const blankPath = join(dir, 'blank.yml')
    writeFileSync(blankPath, 'name: blank\ndescription: blank\nprompts:\n  - "   "\n', 'utf8')
    expect(() => loadBenchSet(blankPath)).toThrow()

    const tooManyPath = join(dir, 'many.yml')
    const many = Array.from({ length: 51 }, (_, i) => `  - prompt ${i + 1}`).join('\n')
    writeFileSync(tooManyPath, `name: many\ndescription: many\nprompts:\n${many}\n`, 'utf8')
    expect(() => loadBenchSet(tooManyPath)).toThrow()
  })

  it('summarise computes nearest-rank percentiles, cost per turn and cache hit rate', () => {
    expect(summarise([])).toEqual({
      count: 0,
      delivered: 0,
      p50Ms: 0,
      p90Ms: 0,
      costUsd: 0,
      costPerTurnUsd: 0,
      cacheHitRate: null,
      toolTurns: 0
    })

    const rows: BenchRow[] = [
      {
        set: 's',
        index: 0,
        ms: 100,
        state: 'delivered',
        inputTokens: 100,
        outputTokens: 20,
        cachedTokens: 50,
        costUsd: 0.01,
        toolCalls: 0,
        model: 'm',
        transport: 'api'
      },
      {
        set: 's',
        index: 1,
        ms: 500,
        state: 'failed',
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        costUsd: 0,
        toolCalls: 0,
        model: 'm',
        transport: 'api'
      },
      {
        set: 's',
        index: 2,
        ms: 300,
        state: 'delivered',
        inputTokens: 100,
        outputTokens: 30,
        cachedTokens: 50,
        costUsd: 0.02,
        toolCalls: 1,
        model: 'm',
        transport: 'api'
      },
      {
        set: 's',
        index: 3,
        ms: 200,
        state: 'delivered',
        inputTokens: 200,
        outputTokens: 40,
        cachedTokens: 100,
        costUsd: 0.03,
        toolCalls: 2,
        model: 'm',
        transport: 'api'
      }
    ]

    const summary = summarise(rows)
    expect(summary.count).toBe(4)
    expect(summary.delivered).toBe(3)
    expect(summary.p50Ms).toBe(200)
    expect(summary.p90Ms).toBe(300)
    expect(summary.costUsd).toBeCloseTo(0.06, 8)
    expect(summary.costPerTurnUsd).toBeCloseTo(0.015, 8)
    expect(summary.cacheHitRate).toBeCloseTo(0.5, 8)
    expect(summary.toolTurns).toBe(2)
  })

  it('runs a three-prompt set with a scripted model and writes a prompt-free jsonl result', async () => {
    const model = queueModel([
      { text: 'first reply', usage: { inputTokens: 100, outputTokens: 10, cachedTokens: 20 }, costUsd: 0.01 },
      { text: 'second reply', usage: { inputTokens: 120, outputTokens: 15, cachedTokens: 40 }, costUsd: 0.02 },
      { text: 'third reply', usage: { inputTokens: 80, outputTokens: 12, cachedTokens: 0 }, costUsd: 0.01 }
    ])
    const session = await openChatSession({
      config: benchConfig(),
      env: {},
      clients: { main: model }
    })
    const outDir = tmpDir('aira-bench-out-')
    try {
      const set = {
        name: 'mini',
        description: 'three prompts',
        prompts: ['secret prompt alpha', 'secret prompt beta', 'secret prompt gamma']
      }
      const result = await runBench({
        set,
        session,
        transport: 'api',
        now: () => new Date('2026-01-02T03:04:05.000Z')
      })

      expect(result.rows).toHaveLength(3)
      expect(result.rows.map((r) => r.state)).toEqual(['delivered', 'delivered', 'delivered'])
      expect(result.rows[0]).toMatchObject({
        set: 'mini',
        index: 0,
        inputTokens: 100,
        outputTokens: 10,
        cachedTokens: 20,
        costUsd: 0.01,
        toolCalls: 0,
        model: 'main-model',
        transport: 'api'
      })
      expect(result.summary.count).toBe(3)
      expect(result.summary.delivered).toBe(3)
      expect(result.summary.costUsd).toBeCloseTo(0.04, 8)
      expect(result.summary.cacheHitRate).toBeCloseTo(60 / 300, 8)

      const filePath = writeBenchResult(outDir, result)
      const raw = readFileSync(filePath, 'utf8')
      const lines = raw.trimEnd().split('\n')
      expect(lines).toHaveLength(4)
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow()
      }
      const last = JSON.parse(lines[3]!) as Record<string, unknown>
      expect(last['summary']).toBe(true)

      for (const forbidden of [
        'secret prompt alpha',
        'secret prompt beta',
        'secret prompt gamma',
        'first reply',
        'second reply',
        'third reply'
      ]) {
        expect(raw).not.toContain(forbidden)
      }
    } finally {
      await session.close()
    }
  })

  it('keeps running and records a non-delivered row when the model fails on the second prompt', async () => {
    const model = queueModel([
      { text: 'first ok' },
      new ModelError('transient', 'scripted failure'),
      { text: 'third ok' }
    ])
    const session = await openChatSession({
      config: benchConfig(),
      env: {},
      clients: { main: model }
    })
    try {
      const result = await runBench({
        set: { name: 'fail-mid', description: 'mid failure', prompts: ['one', 'two', 'three'] },
        session,
        transport: 'api'
      })
      expect(result.rows).toHaveLength(3)
      expect(result.rows[0]?.state).toBe('delivered')
      expect(result.rows[1]?.state).not.toBe('delivered')
      expect(result.rows[2]?.state).toBe('delivered')
      expect(result.summary.count).toBe(3)
      expect(result.summary.delivered).toBe(2)
    } finally {
      await session.close()
    }
  })

  it('correlates each turn when the wall clock moves backwards', async () => {
    let offset = 60_000
    const session = await openChatSession({
      config: benchConfig(),
      env: {},
      now: () => new Date(Date.now() + offset),
      clients: { main: queueModel([{ text: 'first' }, { text: 'second' }]) }
    })
    try {
      const first = await session.send('one')
      offset = -60_000
      const second = await session.send('two')
      expect(first.turn?.['state']).toBe('delivered')
      expect(second.turn?.['state']).toBe('delivered')
      expect(second.turn?.['turn_id']).not.toBe(first.turn?.['turn_id'])
    } finally {
      await session.close()
    }
  })

  it('openChatSession removes its scratch folder on close and uses distinct message ids per send', async () => {
    const before = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith('aira-bench-')))
    const scratchSession = await openChatSession({
      config: benchConfig(),
      env: {},
      clients: { main: queueModel([{ text: 'hi' }]) }
    })
    const during = readdirSync(tmpdir()).filter((name) => name.startsWith('aira-bench-') && !before.has(name))
    expect(during).toHaveLength(1)
    await scratchSession.close()
    expect(existsSync(join(tmpdir(), during[0]!))).toBe(false)

    const dataDir = tmpDir('aira-bench-data-')
    const session = await openChatSession({
      config: benchConfig(dataDir),
      env: {},
      dataDir,
      clients: { main: queueModel([{ text: 'reply 1' }, { text: 'reply 2' }]) }
    })
    try {
      const first = await session.send('hello one')
      const second = await session.send('hello two')
      expect(first.turn?.['state']).toBe('delivered')
      expect(second.turn?.['state']).toBe('delivered')
    } finally {
      await session.close()
    }

    const db = openReader(join(dataDir, 'aira.db'))
    try {
      const mids = db.prepare('SELECT mid FROM inbound_message ORDER BY rowid').all() as { mid: string }[]
      expect(mids).toHaveLength(2)
      expect(mids[0]?.mid).not.toBe(mids[1]?.mid)
    } finally {
      db.close()
    }
  })
})
