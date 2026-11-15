import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createRealOps } from '../../scripts/updater/ops.js'
import {
  type DeployRecord,
  type Release,
  type UpdaterConfig,
  type UpdaterOps,
  isNewer,
  runUpdate
} from '../../scripts/updater/update.js'
import { tmpDir } from '../support/tmp.js'

interface FakeControls {
  release: Release | undefined
  running: string | undefined
  activeTurnsQueue: (number | undefined)[]
  snapshotOk: boolean
  healthyQueue: boolean[]
  syntheticOk: boolean
  fail: {
    newestRelease?: boolean
    runningVersion?: boolean
    activeTurns?: boolean
    snapshot?: boolean
    pull?: boolean
    start?: boolean
    failRollbackStart?: boolean
    healthy?: boolean
    syntheticTurn?: boolean
    pruneImages?: boolean
    record?: boolean
    alert?: boolean
  }
}

function createFakeOps(overrides: Partial<FakeControls> = {}) {
  const controls: FakeControls = {
    release: { tag: 'v1.2.0', version: '1.2.0', manual: false },
    running: '1.1.0',
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

  const ops: UpdaterOps = {
    async newestRelease() {
      calls.push('newestRelease')
      if (controls.fail.newestRelease) throw new Error('registry down')
      return controls.release
    },
    async runningVersion() {
      calls.push('runningVersion')
      if (controls.fail.runningVersion) throw new Error('docker down')
      return controls.running
    },
    async activeTurns() {
      calls.push('activeTurns')
      if (controls.fail.activeTurns) throw new Error('health down')
      if (controls.activeTurnsQueue.length === 0) return 0
      return controls.activeTurnsQueue.length === 1 ? controls.activeTurnsQueue[0] : controls.activeTurnsQueue.shift()
    },
    async snapshot() {
      calls.push('snapshot')
      if (controls.fail.snapshot) throw new Error('snapshot error')
      return controls.snapshotOk
    },
    async pull(version) {
      calls.push(`pull:${version}`)
      if (controls.fail.pull) throw new Error('pull error')
    },
    async start(version) {
      calls.push(`start:${version}`)
      startCount += 1
      if (startCount === 1 && controls.fail.start) throw new Error('start error')
      if (startCount > 1 && controls.fail.failRollbackStart) throw new Error('rollback start error')
    },
    async healthy() {
      calls.push('healthy')
      if (controls.fail.healthy) throw new Error('healthy error')
      if (controls.healthyQueue.length === 0) return false
      return controls.healthyQueue.length === 1
        ? (controls.healthyQueue[0] ?? false)
        : (controls.healthyQueue.shift() ?? false)
    },
    async syntheticTurn() {
      calls.push('syntheticTurn')
      if (controls.fail.syntheticTurn) throw new Error('turn error')
      return controls.syntheticOk
    },
    async pruneImages(current, previous) {
      calls.push(`pruneImages:${current}:${previous ?? 'none'}`)
      if (controls.fail.pruneImages) throw new Error('prune error')
    },
    async record(entry) {
      calls.push(`record:${entry.outcome}`)
      if (controls.fail.record) throw new Error('record error')
      records.push(entry)
    },
    async alert(message) {
      calls.push('alert')
      if (controls.fail.alert) throw new Error('alert error')
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

  return { ops, calls, records, alerts, getClockMs: () => clockMs }
}

const defaultConfig: UpdaterConfig = {
  waitForIdleMs: 6000,
  healthTimeoutMs: 6000,
  pollMs: 2000
}

describe('isNewer', () => {
  it('compares major, minor and patch numerically including 1.10.0 against 1.9.9', () => {
    expect(isNewer('1.10.0', '1.9.9')).toBe(true)
    expect(isNewer('1.9.9', '1.10.0')).toBe(false)
    expect(isNewer('2.0.0', '1.99.99')).toBe(true)
    expect(isNewer('1.2.4', '1.2.3')).toBe(true)
    expect(isNewer('1.2.3', '1.2.3')).toBe(false)
    expect(isNewer('1.2.2', '1.2.3')).toBe(false)
    expect(isNewer('v1.2.4', 'v1.2.3')).toBe(true)
    expect(isNewer('invalid', '1.0.0')).toBe(false)
  })
})

describe('runUpdate', () => {
  it('returns no_release when no release exists', async () => {
    const { ops, calls, records } = createFakeOps({ release: undefined })
    const result = await runUpdate(ops, defaultConfig)
    expect(result).toEqual({ action: 'none', reason: 'no_release' })
    expect(calls).toEqual(['newestRelease'])
    expect(records).toEqual([])
  })

  it('returns up_to_date when the running version matches the newest release', async () => {
    const { ops, calls } = createFakeOps({
      release: { tag: 'v1.2.0', version: '1.2.0', manual: false },
      running: '1.2.0'
    })
    const result = await runUpdate(ops, defaultConfig)
    expect(result).toEqual({ action: 'none', reason: 'up_to_date' })
    expect(calls).toEqual(['newestRelease', 'runningVersion'])
  })

  it('never downgrades when the running version is newer than the release', async () => {
    const { ops, calls } = createFakeOps({
      release: { tag: 'v1.2.0', version: '1.2.0', manual: false },
      running: '1.3.0'
    })
    const result = await runUpdate(ops, defaultConfig)
    expect(result).toEqual({ action: 'none', reason: 'up_to_date' })
    expect(calls).toEqual(['newestRelease', 'runningVersion'])
  })

  it('skips and records a manual release without calling anything else', async () => {
    const { ops, calls, records } = createFakeOps({
      release: { tag: 'v2.0.0', version: '2.0.0', manual: true },
      running: '1.1.0'
    })
    const result = await runUpdate(ops, defaultConfig)
    expect(result).toEqual({ action: 'none', reason: 'manual_release' })
    expect(calls).toEqual(['newestRelease', 'runningVersion', 'record:skipped_manual'])
    expect(records).toEqual([
      {
        at: '2026-01-01T00:00:00.000Z',
        from: '1.1.0',
        to: '2.0.0',
        outcome: 'skipped_manual'
      }
    ])
  })

  it('performs a first install without snapshot and without rollback target', async () => {
    const { ops, calls, records } = createFakeOps({
      running: undefined,
      release: { tag: 'v1.0.0', version: '1.0.0', manual: false }
    })
    const result = await runUpdate(ops, defaultConfig)
    expect(result).toEqual({ action: 'deployed', from: undefined, to: '1.0.0' })
    expect(calls).not.toContain('snapshot')
    expect(calls).toEqual([
      'newestRelease',
      'runningVersion',
      'activeTurns',
      'pull:1.0.0',
      'start:1.0.0',
      'healthy',
      'syntheticTurn',
      'pruneImages:1.0.0:none',
      'record:deployed'
    ])
    expect(records).toHaveLength(1)
  })

  it('waits for idle up to waitForIdleMs and proceeds when the limit is reached', async () => {
    const { ops, calls } = createFakeOps({
      activeTurnsQueue: [2, 2, 1, 1]
    })
    const result = await runUpdate(ops, { waitForIdleMs: 4000, healthTimeoutMs: 4000, pollMs: 2000 })
    expect(result).toEqual({ action: 'deployed', from: '1.1.0', to: '1.2.0' })
    expect(calls.slice(0, 7)).toEqual([
      'newestRelease',
      'runningVersion',
      'activeTurns',
      'sleep:2000',
      'activeTurns',
      'sleep:2000',
      'activeTurns'
    ])
  })

  it('aborts before pull when snapshot fails and leaves the running version untouched', async () => {
    const { ops, calls, records, alerts } = createFakeOps({ snapshotOk: false })
    const result = await runUpdate(ops, defaultConfig)
    expect(result).toEqual({ action: 'none', reason: 'snapshot_failed' })
    expect(calls).not.toContain('pull:1.2.0')
    expect(calls).not.toContain('start:1.2.0')
    expect(records[0]).toMatchObject({ outcome: 'failed_before_start', reason: 'snapshot_failed' })
    expect(alerts).toHaveLength(1)
  })

  it('aborts before start when pull fails and leaves the running version untouched', async () => {
    const { ops, calls, records, alerts } = createFakeOps({ fail: { pull: true } })
    const result = await runUpdate(ops, defaultConfig)
    expect(result).toEqual({ action: 'none', reason: 'pull_failed' })
    expect(calls).not.toContain('start:1.2.0')
    expect(records[0]).toMatchObject({ outcome: 'failed_before_start', reason: 'pull_failed' })
    expect(alerts).toHaveLength(1)
  })

  it('executes a happy deploy in the contract order and prunes old images', async () => {
    const { ops, calls, records, alerts } = createFakeOps()
    const result = await runUpdate(ops, defaultConfig)
    expect(result).toEqual({ action: 'deployed', from: '1.1.0', to: '1.2.0' })
    expect(calls).toEqual([
      'newestRelease',
      'runningVersion',
      'activeTurns',
      'snapshot',
      'pull:1.2.0',
      'start:1.2.0',
      'healthy',
      'syntheticTurn',
      'pruneImages:1.2.0:1.1.0',
      'record:deployed'
    ])
    expect(records).toEqual([
      {
        at: '2026-01-01T00:00:00.000Z',
        from: '1.1.0',
        to: '1.2.0',
        outcome: 'deployed'
      }
    ])
    expect(alerts).toEqual([])
  })

  it('rolls back, records and alerts when start fails', async () => {
    const { ops, calls, records, alerts } = createFakeOps({ fail: { start: true } })
    const result = await runUpdate(ops, defaultConfig)
    expect(result).toEqual({ action: 'rolled_back', from: '1.1.0', to: '1.2.0', reason: 'start_failed' })
    expect(calls).toContain('start:1.1.0')
    expect(records[0]).toMatchObject({ outcome: 'rolled_back', reason: 'start_failed', from: '1.1.0', to: '1.2.0' })
    expect(alerts).toHaveLength(1)
  })

  it('rolls back, records and alerts when health check times out', async () => {
    const { ops, calls, records, alerts } = createFakeOps({ healthyQueue: [false] })
    const result = await runUpdate(ops, { waitForIdleMs: 2000, healthTimeoutMs: 4000, pollMs: 2000 })
    expect(result).toEqual({ action: 'rolled_back', from: '1.1.0', to: '1.2.0', reason: 'unhealthy' })
    expect(calls).toContain('start:1.1.0')
    expect(calls).not.toContain('syntheticTurn')
    expect(records[0]).toMatchObject({ outcome: 'rolled_back', reason: 'unhealthy' })
    expect(alerts).toHaveLength(1)
  })

  it('rolls back, records and alerts when synthetic turn fails', async () => {
    const { ops, calls, records, alerts } = createFakeOps({ syntheticOk: false })
    const result = await runUpdate(ops, defaultConfig)
    expect(result).toEqual({ action: 'rolled_back', from: '1.1.0', to: '1.2.0', reason: 'synthetic_turn_failed' })
    expect(calls).toContain('start:1.1.0')
    expect(records[0]).toMatchObject({ outcome: 'rolled_back', reason: 'synthetic_turn_failed' })
    expect(alerts).toHaveLength(1)
  })

  it('alerts that the service is down when rollback start also fails', async () => {
    const { ops, alerts } = createFakeOps({ fail: { start: true, failRollbackStart: true } })
    const result = await runUpdate(ops, defaultConfig)
    expect(result).toEqual({ action: 'rolled_back', from: '1.1.0', to: '1.2.0', reason: 'start_failed' })
    expect(alerts.some((msg) => msg.toLowerCase().includes('service is down'))).toBe(true)
  })

  it('does not change the result when pruneImages, record or alert fail', async () => {
    const { ops } = createFakeOps({ fail: { pruneImages: true, record: true, alert: true } })
    const result = await runUpdate(ops, defaultConfig)
    expect(result).toEqual({ action: 'deployed', from: '1.1.0', to: '1.2.0' })
  })

  it('never rejects even when newestRelease or runningVersion reject', async () => {
    const { ops } = createFakeOps({ fail: { newestRelease: true } })
    await expect(runUpdate(ops, defaultConfig)).resolves.toEqual({ action: 'none', reason: 'no_release' })

    const { ops: ops2 } = createFakeOps({ fail: { runningVersion: true } })
    await expect(runUpdate(ops2, defaultConfig)).resolves.toEqual({ action: 'deployed', from: undefined, to: '1.2.0' })
  })
})

describe('createRealOps', () => {
  function baseOptions(
    overrides: Partial<Parameters<typeof createRealOps>[0]> = {}
  ): Parameters<typeof createRealOps>[0] {
    return {
      image: 'ghcr.io/tolonglabs/aira',
      repository: 'TolongLabs/AIRA',
      composeFile: '/opt/aira/compose.yml',
      service: 'aira',
      coreUrl: 'http://127.0.0.1:9881',
      recordFile: join(tmpDir(), 'deploys.jsonl'),
      run: async () => ({ code: 0, stdout: '', stderr: '' }),
      fetch: (async () => new Response('{}', { status: 200 })) as typeof fetch,
      ...overrides
    }
  }

  it('reads newestRelease and detects the manual mark from release notes', async () => {
    const opsManual = createRealOps(
      baseOptions({
        fetch: (async () =>
          new Response(JSON.stringify({ tag_name: 'v1.4.0', body: 'Notes\nManual: breaking migration' }), {
            status: 200
          })) as typeof fetch
      })
    )
    expect(await opsManual.newestRelease()).toEqual({ tag: 'v1.4.0', version: '1.4.0', manual: true })

    const opsAuto = createRealOps(
      baseOptions({
        fetch: (async () =>
          new Response(JSON.stringify({ tag_name: 'v1.4.1', body: 'Bug fixes' }), { status: 200 })) as typeof fetch
      })
    )
    expect(await opsAuto.newestRelease()).toEqual({ tag: 'v1.4.1', version: '1.4.1', manual: false })

    const ops404 = createRealOps(
      baseOptions({
        fetch: (async () => new Response('not found', { status: 404 })) as typeof fetch
      })
    )
    expect(await ops404.newestRelease()).toBeUndefined()
  })

  it('parses runningVersion from docker compose images json output and ignores stable', async () => {
    const opsVersion = createRealOps(
      baseOptions({
        run: async () => ({
          code: 0,
          stdout: JSON.stringify([{ Repository: 'ghcr.io/tolonglabs/aira', Tag: '1.2.3' }]),
          stderr: ''
        })
      })
    )
    expect(await opsVersion.runningVersion()).toBe('1.2.3')

    const opsStable = createRealOps(
      baseOptions({
        run: async () => ({
          code: 0,
          stdout: JSON.stringify([{ Repository: 'ghcr.io/tolonglabs/aira', Tag: 'stable' }]),
          stderr: ''
        })
      })
    )
    expect(await opsStable.runningVersion()).toBeUndefined()

    const opsEmpty = createRealOps(
      baseOptions({
        run: async () => ({ code: 0, stdout: '[]', stderr: '' })
      })
    )
    expect(await opsEmpty.runningVersion()).toBeUndefined()
  })

  it('sends SIGUSR2 for snapshot and waits for a newer verified snapshot', async () => {
    const ran: { command: string; args: string[] }[] = []
    let healthCall = 0
    const ops = createRealOps(
      baseOptions({
        run: async (command, args) => {
          ran.push({ command, args })
          return { code: 0, stdout: '', stderr: '' }
        },
        fetch: (async () => {
          healthCall += 1
          if (healthCall === 1) {
            return new Response(
              JSON.stringify({ status: 'ready', activeTurns: 0, snapshot: { id: 4, state: 'verified' } }),
              { status: 200 }
            )
          }
          return new Response(
            JSON.stringify({ status: 'ready', activeTurns: 0, snapshot: { id: 5, state: 'verified' } }),
            { status: 200 }
          )
        }) as typeof fetch
      })
    )

    expect(await ops.snapshot()).toBe(true)
    expect(ran).toEqual([
      { command: 'docker', args: ['compose', '-f', '/opt/aira/compose.yml', 'kill', '-s', 'SIGUSR2', 'aira'] }
    ])
  })

  it('sets AIRA_VERSION when calling start and never invokes a shell', async () => {
    const ran: { command: string; args: string[]; env?: Record<string, string> }[] = []
    const ops = createRealOps(
      baseOptions({
        run: async (command, args, env) => {
          ran.push({ command, args, env })
          return { code: 0, stdout: '', stderr: '' }
        }
      })
    )

    await ops.start('1.5.0')
    expect(ran).toEqual([
      {
        command: 'docker',
        args: ['compose', '-f', '/opt/aira/compose.yml', 'up', '-d', 'aira'],
        env: { AIRA_VERSION: '1.5.0' }
      }
    ])
    for (const call of ran) {
      expect(['sh', 'bash', '/bin/sh', '/bin/bash']).not.toContain(call.command)
    }
  })

  it('pruneImages keeps current, previous and stable while removing older tags', async () => {
    const ran: { command: string; args: string[] }[] = []
    const ops = createRealOps(
      baseOptions({
        run: async (command, args) => {
          ran.push({ command, args })
          if (args[0] === 'images') {
            return { code: 0, stdout: '1.5.0\n1.4.0\n1.3.0\nstable\n<none>\n', stderr: '' }
          }
          return { code: 0, stdout: '', stderr: '' }
        }
      })
    )

    await ops.pruneImages('1.5.0', '1.4.0')
    expect(ran).toEqual([
      { command: 'docker', args: ['images', 'ghcr.io/tolonglabs/aira', '--format', '{{.Tag}}'] },
      { command: 'docker', args: ['rmi', 'ghcr.io/tolonglabs/aira:1.3.0'] }
    ])
  })

  it('rejects with stderr when a command exits non-zero', async () => {
    const ops = createRealOps(
      baseOptions({
        run: async () => ({ code: 1, stdout: '', stderr: 'manifest unknown' })
      })
    )
    await expect(ops.pull('9.9.9')).rejects.toThrow('manifest unknown')
  })

  it('checks syntheticTurn status 200 with non-empty content and appends deploy records', async () => {
    const recordFile = join(tmpDir(), 'deploys.jsonl')
    const ops = createRealOps(
      baseOptions({
        recordFile,
        fetch: (async () =>
          new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 })) as typeof fetch
      })
    )

    expect(await ops.syntheticTurn()).toBe(true)
    await ops.record({ at: '2026-01-01T00:00:00.000Z', from: '1.0.0', to: '1.1.0', outcome: 'deployed' })
    const saved = readFileSync(recordFile, 'utf8').trim()
    expect(JSON.parse(saved)).toEqual({
      at: '2026-01-01T00:00:00.000Z',
      from: '1.0.0',
      to: '1.1.0',
      outcome: 'deployed'
    })
  })
})
