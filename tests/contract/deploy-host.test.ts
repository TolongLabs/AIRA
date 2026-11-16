import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  type DeployHostConfig,
  type DeployHostOps,
  runDeployHost,
  sendNtfy,
  updateEnvContent,
  writeInstallEnv
} from '../../scripts/deploy-host.js'
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
      healthyQueue: [false]
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
