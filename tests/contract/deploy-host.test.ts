import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type DeployHostConfig,
  type DeployHostOps,
  runDeployHost,
  sendNtfy,
  updateEnvContent,
  writeInstallEnv
} from '../../scripts/deploy-host.js'
import {
  createRealOps,
  DOCKER_PULL_ATTEMPTS,
  DOCKER_PULL_BUDGET_MS,
  DOCKER_PULL_TIMEOUT_MS,
  type RunOptions,
  SYNTHETIC_TURN_TIMEOUT_MS
} from '../../scripts/updater/ops.js'
import type { DeployRecord } from '../../scripts/updater/update.js'
import { tmpDir } from '../support/tmp.js'

interface FakeControls {
  running: string | undefined
  activeTurnsQueue: (number | undefined)[]
  snapshotOk: boolean
  healthyQueue: boolean[]
  syntheticOk: boolean
  fail: {
    pull?: boolean
    writeEnv?: boolean
    start?: boolean
    pruneImages?: boolean
  }
}

function createFakeOps(overrides: Partial<FakeControls> = {}) {
  const controls: FakeControls = {
    running: 'sha-0000001',
    activeTurnsQueue: [0],
    snapshotOk: true,
    healthyQueue: [true],
    syntheticOk: true,
    fail: {},
    ...overrides
  }

  let clockMs = Date.parse('2026-01-01T00:00:00.000Z')
  const calls: string[] = []
  const records: DeployRecord[] = []
  const alerts: string[] = []
  let startCount = 0

  const ops: DeployHostOps = {
    async newestRelease() {
      return undefined
    },
    async runningVersion() {
      calls.push('runningVersion')
      return controls.running
    },
    async activeTurns() {
      calls.push('activeTurns')
      if (controls.activeTurnsQueue.length === 0) return 0
      return controls.activeTurnsQueue.length === 1 ? controls.activeTurnsQueue[0] : controls.activeTurnsQueue.shift()
    },
    async snapshot() {
      calls.push('snapshot')
      return controls.snapshotOk
    },
    async pull(version) {
      calls.push(`pull:${version}`)
      if (controls.fail.pull) throw new Error('pull error')
    },
    async writeEnv(version) {
      calls.push(`writeEnv:${version}`)
      if (controls.fail.writeEnv) throw new Error('env error')
    },
    async start(version) {
      calls.push(`start:${version}`)
      startCount += 1
      if (startCount === 1 && controls.fail.start) throw new Error('start error')
    },
    async healthy() {
      calls.push('healthy')
      if (controls.healthyQueue.length === 0) return false
      return controls.healthyQueue.length === 1
        ? (controls.healthyQueue[0] ?? false)
        : (controls.healthyQueue.shift() ?? false)
    },
    async syntheticTurn() {
      calls.push('syntheticTurn')
      return controls.syntheticOk
    },
    async pruneImages(current, previous) {
      calls.push(`pruneImages:${current}:${previous ?? 'none'}`)
      if (controls.fail.pruneImages) throw new Error('prune error')
    },
    async record(entry) {
      calls.push(`record:${entry.outcome}`)
      records.push(entry)
    },
    async alert(message) {
      calls.push('alert')
      alerts.push(message)
    },
    async sleep(ms) {
      calls.push(`sleep:${ms}`)
      clockMs += ms
    },
    now() {
      return new Date(clockMs)
    }
  }

  return { ops, calls, records, alerts }
}

const defaultConfig: DeployHostConfig = {
  version: 'sha-1234567',
  waitForIdleMs: 6000,
  healthTimeoutMs: 6000,
  pollMs: 2000
}

describe('runDeployHost', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('executes the full deploy flow in contract order and alerts on success', async () => {
    const { ops, calls, records, alerts } = createFakeOps({
      activeTurnsQueue: [1, 0]
    })

    const result = await runDeployHost(ops, defaultConfig)

    expect(result).toEqual({
      action: 'deployed',
      from: 'sha-0000001',
      to: 'sha-1234567'
    })
    expect(calls).toEqual([
      'runningVersion',
      'activeTurns',
      'sleep:2000',
      'activeTurns',
      'snapshot',
      'pull:sha-1234567',
      'writeEnv:sha-1234567',
      'start:sha-1234567',
      'healthy',
      'syntheticTurn',
      'pruneImages:sha-1234567:sha-0000001',
      'record:deployed',
      'alert'
    ])
    expect(records).toEqual([
      {
        at: '2026-01-01T00:00:02.000Z',
        from: 'sha-0000001',
        to: 'sha-1234567',
        outcome: 'deployed'
      }
    ])
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toContain('sha-1234567')
    expect(alerts[0]).toContain('succeeded')
  })

  it('rolls back .env and container when health check times out', async () => {
    const { ops, calls, records, alerts } = createFakeOps({
      healthyQueue: [false, false, false, true]
    })

    const result = await runDeployHost(ops, {
      version: 'sha-1234567',
      waitForIdleMs: 2000,
      healthTimeoutMs: 4000,
      pollMs: 2000
    })

    expect(result).toEqual({
      action: 'rolled_back',
      from: 'sha-0000001',
      to: 'sha-1234567',
      reason: 'unhealthy'
    })
    expect(calls).toContain('writeEnv:sha-0000001')
    expect(calls).toContain('start:sha-0000001')
    expect(calls).not.toContain('syntheticTurn')
    expect(calls).not.toContain('pruneImages:sha-1234567:sha-0000001')
    expect(records[0]).toMatchObject({
      from: 'sha-0000001',
      to: 'sha-1234567',
      outcome: 'rolled_back',
      reason: 'unhealthy'
    })
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toContain('unhealthy')
  })

  it('rolls back .env and container when synthetic turn fails', async () => {
    const { ops, calls, records, alerts } = createFakeOps({
      syntheticOk: false
    })

    const result = await runDeployHost(ops, defaultConfig)

    expect(result).toEqual({
      action: 'rolled_back',
      from: 'sha-0000001',
      to: 'sha-1234567',
      reason: 'synthetic_turn_failed'
    })
    expect(calls).toContain('writeEnv:sha-0000001')
    expect(calls).toContain('start:sha-0000001')
    expect(calls).not.toContain('pruneImages:sha-1234567:sha-0000001')
    expect(records[0]).toMatchObject({
      from: 'sha-0000001',
      to: 'sha-1234567',
      outcome: 'rolled_back',
      reason: 'synthetic_turn_failed'
    })
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toContain('synthetic_turn_failed')
  })

  function createRealPullHarness(
    onPull: (attempt: number, options?: RunOptions) => Promise<{ code: number; stdout: string; stderr: string }>
  ) {
    const dir = tmpDir()
    const envFile = join(dir, '.env')
    const recordFile = join(dir, 'deploys.jsonl')
    const initialEnv = 'AIRA_IMAGE=ghcr.io/tolonglabs/aira\nAIRA_VERSION=sha-0000001\n'
    writeFileSync(envFile, initialEnv, 'utf8')

    const commands: string[][] = []
    const pullTimeouts: (number | undefined)[] = []
    const alerts: string[] = []
    let healthCall = 0
    let pullAttempt = 0

    const baseOps = createRealOps({
      image: 'ghcr.io/tolonglabs/aira',
      repository: 'TolongLabs/AIRA',
      composeFile: join(dir, 'compose.yml'),
      service: 'aira',
      coreUrl: 'http://127.0.0.1:9881',
      recordFile,
      run: async (_command, args, _env, options) => {
        commands.push(args)
        if (args.includes('dist/scripts/deploy-turn-probe.js')) return { code: 0, stdout: 'deploy-turn-ok', stderr: '' }
        if (args.includes('images')) {
          return {
            code: 0,
            stdout: JSON.stringify([{ Repository: 'ghcr.io/tolonglabs/aira', Tag: 'sha-0000001' }]),
            stderr: ''
          }
        }
        if (args[0] === 'pull') {
          pullAttempt += 1
          pullTimeouts.push(options?.timeoutMs)
          return onPull(pullAttempt, options)
        }
        return { code: 0, stdout: '', stderr: '' }
      },
      fetch: (async (input: string | URL | Request) => {
        if (String(input).endsWith('/v1/chat/completions')) {
          return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 })
        }
        healthCall += 1
        return new Response(
          JSON.stringify({ status: 'ready', activeTurns: 0, snapshot: { id: healthCall, state: 'verified' } }),
          { status: 200 }
        )
      }) as typeof fetch
    })

    const writeEnv = vi.fn((version: string) => writeInstallEnv(envFile, 'ghcr.io/tolonglabs/aira', version))

    const ops: DeployHostOps = {
      ...baseOps,
      writeEnv,
      alert: async (message) => {
        alerts.push(message)
      }
    }

    return { ops, envFile, recordFile, initialEnv, commands, pullTimeouts, alerts, writeEnv }
  }

  it('a stalled pull ends the deploy as pull_failed with the core untouched', async () => {
    vi.useFakeTimers()
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const { ops, envFile, recordFile, initialEnv, commands, pullTimeouts, alerts, writeEnv } = createRealPullHarness(
      (_attempt, options) =>
        new Promise((resolve) => {
          options?.signal?.addEventListener(
            'abort',
            () => resolve({ code: 1, stdout: '', stderr: 'killed by SIGTERM' }),
            { once: true }
          )
        })
    )

    const resultPromise = runDeployHost(ops, defaultConfig)
    await vi.advanceTimersByTimeAsync(DOCKER_PULL_TIMEOUT_MS + 6_000)
    await vi.advanceTimersByTimeAsync(DOCKER_PULL_BUDGET_MS)
    const result = await resultPromise

    expect(commands.filter((args) => args[0] === 'pull')).toHaveLength(2)
    expect(pullTimeouts[0]).toBe(DOCKER_PULL_TIMEOUT_MS)
    expect(pullTimeouts[1]).toBeGreaterThan(DOCKER_PULL_BUDGET_MS - DOCKER_PULL_TIMEOUT_MS - 10_000)
    expect(result).toEqual({
      action: 'failed',
      from: 'sha-0000001',
      to: 'sha-1234567',
      reason: 'pull_failed'
    })
    expect(writeEnv).not.toHaveBeenCalled()
    expect(commands.some((args) => args.includes('up'))).toBe(false)
    expect(readFileSync(envFile, 'utf8')).toBe(initialEnv)
    const savedRecord = JSON.parse(readFileSync(recordFile, 'utf8').trim()) as DeployRecord
    expect(savedRecord).toMatchObject({
      from: 'sha-0000001',
      to: 'sha-1234567',
      outcome: 'failed_before_start',
      reason: 'pull_failed'
    })
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toContain('pull failed')
  })

  it('a pull that needs 15 minutes succeeds on the second attempt, after the short first one', async () => {
    vi.useFakeTimers()
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const fifteenMinutesMs = 15 * 60_000
    const { ops, envFile, commands, pullTimeouts } = createRealPullHarness(
      (_attempt, options) =>
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve({ code: 0, stdout: '', stderr: '' }), fifteenMinutesMs)
          options?.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer)
              resolve({ code: 1, stdout: '', stderr: 'killed by SIGTERM' })
            },
            { once: true }
          )
        })
    )

    const resultPromise = runDeployHost(ops, defaultConfig)
    await vi.advanceTimersByTimeAsync(DOCKER_PULL_TIMEOUT_MS + 6_000)
    await vi.advanceTimersByTimeAsync(fifteenMinutesMs)
    const result = await resultPromise

    expect(result).toEqual({
      action: 'deployed',
      from: 'sha-0000001',
      to: 'sha-1234567'
    })
    expect(commands.filter((args) => args[0] === 'pull')).toHaveLength(2)
    expect(pullTimeouts[0]).toBe(DOCKER_PULL_TIMEOUT_MS)
    expect(readFileSync(envFile, 'utf8')).toContain('AIRA_VERSION=sha-1234567')
  })

  it('after the budget is spent, no further attempt starts and it fails as pull_failed before .env', async () => {
    vi.useFakeTimers()
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const firstAttemptMs = 2 * 60_000
    const remainingMs = DOCKER_PULL_BUDGET_MS - firstAttemptMs
    const { ops, envFile, initialEnv, commands, pullTimeouts, writeEnv } = createRealPullHarness((attempt, options) => {
      if (attempt === 1) {
        return new Promise((resolve) => {
          setTimeout(() => resolve({ code: 1, stdout: '', stderr: 'connection reset' }), firstAttemptMs)
        })
      }
      return new Promise((resolve) => {
        options?.signal?.addEventListener(
          'abort',
          () => resolve({ code: 1, stdout: '', stderr: 'killed by SIGTERM' }),
          { once: true }
        )
      })
    })

    const resultPromise = runDeployHost(ops, defaultConfig)
    await vi.advanceTimersByTimeAsync(firstAttemptMs)
    await vi.advanceTimersByTimeAsync(remainingMs + 6_000)
    const result = await resultPromise

    expect(pullTimeouts).toEqual([DOCKER_PULL_TIMEOUT_MS, remainingMs])
    expect(commands.filter((args) => args[0] === 'pull')).toHaveLength(2)
    expect(commands.filter((args) => args[0] === 'pull').length).toBeLessThan(DOCKER_PULL_ATTEMPTS)
    expect(result).toEqual({
      action: 'failed',
      from: 'sha-0000001',
      to: 'sha-1234567',
      reason: 'pull_failed'
    })
    expect(writeEnv).not.toHaveBeenCalled()
    expect(readFileSync(envFile, 'utf8')).toBe(initialEnv)
    expect(commands.some((args) => args.includes('up'))).toBe(false)
  })

  it('a timed-out synthetic turn counts as failed and rolls back', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    let checkedTimeout = 0
    const dir = tmpDir()
    const envFile = join(dir, '.env')
    const recordFile = join(dir, 'deploys.jsonl')
    writeFileSync(envFile, 'AIRA_IMAGE=ghcr.io/tolonglabs/aira\nAIRA_VERSION=sha-0000001\n', 'utf8')

    const upVersions: (string | undefined)[] = []
    const alerts: string[] = []
    let healthCall = 0

    const baseOps = createRealOps({
      image: 'ghcr.io/tolonglabs/aira',
      repository: 'TolongLabs/AIRA',
      composeFile: join(dir, 'compose.yml'),
      service: 'aira',
      coreUrl: 'http://127.0.0.1:9881',
      recordFile,
      run: async (_command, args, env, options) => {
        if (args.includes('dist/scripts/deploy-turn-probe.js')) {
          checkedTimeout = options?.timeoutMs ?? 0
          throw new Error('synthetic turn timed out')
        }
        if (args.includes('images')) {
          return {
            code: 0,
            stdout: JSON.stringify([{ Repository: 'ghcr.io/tolonglabs/aira', Tag: 'sha-0000001' }]),
            stderr: ''
          }
        }
        if (args.includes('up')) {
          upVersions.push(env?.['AIRA_VERSION'])
        }
        return { code: 0, stdout: '', stderr: '' }
      },
      fetch: (async () => {
        healthCall += 1
        return Promise.resolve(
          new Response(
            JSON.stringify({ status: 'ready', activeTurns: 0, snapshot: { id: healthCall, state: 'verified' } }),
            { status: 200 }
          )
        )
      }) as typeof fetch
    })

    const ops: DeployHostOps = {
      ...baseOps,
      writeEnv: (version) => writeInstallEnv(envFile, 'ghcr.io/tolonglabs/aira', version),
      alert: async (message) => {
        alerts.push(message)
      }
    }

    const result = await runDeployHost(ops, defaultConfig)

    expect(checkedTimeout).toBe(SYNTHETIC_TURN_TIMEOUT_MS)
    expect(result).toEqual({
      action: 'rolled_back',
      from: 'sha-0000001',
      to: 'sha-1234567',
      reason: 'synthetic_turn_failed'
    })
    expect(upVersions).toEqual(['sha-1234567', 'sha-0000001'])
    expect(readFileSync(envFile, 'utf8')).toContain('AIRA_VERSION=sha-0000001')
    const savedRecord = JSON.parse(readFileSync(recordFile, 'utf8').trim()) as DeployRecord
    expect(savedRecord).toMatchObject({
      from: 'sha-0000001',
      to: 'sha-1234567',
      outcome: 'rolled_back',
      reason: 'synthetic_turn_failed'
    })
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toContain('synthetic_turn_failed')
  })

  it('the deploy prints a start and done line for each step', async () => {
    const chunks: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      chunks.push(String(chunk))
      return true
    })

    const { ops } = createFakeOps({
      activeTurnsQueue: [1, 0]
    })

    const result = await runDeployHost(ops, defaultConfig)
    expect(result.action).toBe('deployed')

    const lines = chunks.join('').split('\n').filter(Boolean)
    expect(lines).toEqual([
      'deploy: running-version start',
      'deploy: running-version done 0s',
      'deploy: idle-wait start',
      'deploy: idle-wait done 2s',
      'deploy: snapshot start',
      'deploy: snapshot done 0s',
      'deploy: pull sha-1234567 start',
      'deploy: pull done 0s',
      'deploy: env sha-1234567 start',
      'deploy: env done 0s',
      'deploy: recreate sha-1234567 start',
      'deploy: recreate done 0s',
      'deploy: health start',
      'deploy: health done 0s',
      'deploy: synthetic-turn start',
      'deploy: synthetic-turn done 0s',
      'deploy: prune start',
      'deploy: prune done 0s',
      'deploy: alert start',
      'deploy: alert done 0s'
    ])
  })
})

describe('writeInstallEnv', () => {
  it('updates AIRA_IMAGE and AIRA_VERSION while keeping every other line', async () => {
    const dir = tmpDir()
    const envFile = join(dir, '.env')
    writeFileSync(
      envFile,
      [
        '# Secrets',
        'LLM_API_KEY=sk-test-0000',
        '',
        'AIRA_PORT=9881',
        'AIRA_IMAGE=aira-local',
        'AIRA_VERSION=old-tag',
        'SITE_TOKEN=tok-0000'
      ].join('\n') + '\n',
      'utf8'
    )

    await writeInstallEnv(envFile, 'ghcr.io/tolonglabs/aira', 'sha-1234567')

    const saved = readFileSync(envFile, 'utf8')
    expect(saved).toBe(
      [
        '# Secrets',
        'LLM_API_KEY=sk-test-0000',
        '',
        'AIRA_PORT=9881',
        'AIRA_IMAGE=ghcr.io/tolonglabs/aira',
        'AIRA_VERSION=sha-1234567',
        'SITE_TOKEN=tok-0000'
      ].join('\n') + '\n'
    )
  })

  it('appends AIRA_IMAGE and AIRA_VERSION when missing from .env', () => {
    const updated = updateEnvContent('LLM_API_KEY=sk-test-0000\n', {
      AIRA_IMAGE: 'ghcr.io/tolonglabs/aira',
      AIRA_VERSION: 'sha-1234567'
    })
    expect(updated).toBe(
      ['LLM_API_KEY=sk-test-0000', 'AIRA_IMAGE=ghcr.io/tolonglabs/aira', 'AIRA_VERSION=sha-1234567'].join('\n') + '\n'
    )
  })
})

describe('sendNtfy', () => {
  it('skips when AIRA_NTFY_URL is unset and posts when set', async () => {
    const calls: { url: string; method: string; body: string }[] = []
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        body: String(init?.body ?? '')
      })
      return new Response('ok', { status: 200 })
    }) as typeof fetch

    await sendNtfy(undefined, 'skipped', fakeFetch)
    await sendNtfy('', 'skipped', fakeFetch)
    expect(calls).toEqual([])

    await sendNtfy('https://ntfy.example.com/aira', 'Deploy of sha-1234567 succeeded', fakeFetch)
    expect(calls).toEqual([
      {
        url: 'https://ntfy.example.com/aira',
        method: 'POST',
        body: 'Deploy of sha-1234567 succeeded'
      }
    ])
  })
})
