import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  applyHostConfigKeys,
  type DeployHostConfig,
  type DeployHostOps,
  runDeployHost,
  sendNtfy,
  updateEnvContent,
  writeInstallEnv
} from '../../scripts/deploy-host.js'
import { probeTurn, syntheticTurnBody, verifyRunnerReachability } from '../../scripts/deploy-turn-probe.js'
import {
  acquireDeployLock,
  createRealOps,
  deployLockPath,
  resolveCoreUrl,
  resolveSiteUrl,
  waitForDeployLock
} from '../../scripts/updater/ops.js'
import { type DeployRecord, runUpdate, type UpdaterOps } from '../../scripts/updater/update.js'
import { parseGatewayRequest } from '../../src/gateway/request.js'
import { tmpDir } from '../support/tmp.js'

function baseOptions(overrides: Partial<Parameters<typeof createRealOps>[0]> = {}) {
  return {
    image: 'ghcr.io/tolonglabs/aira',
    repository: 'TolongLabs/AIRA',
    composeFile: join(tmpDir(), 'compose.yml'),
    service: 'aira',
    coreUrl: 'http://127.0.0.1:9881',
    recordFile: join(tmpDir(), 'deploys.jsonl'),
    run: async () => ({ code: 0, stdout: '', stderr: '' }),
    fetch: (async () => new Response('{}', { status: 200 })) as typeof fetch,
    ...overrides
  }
}

interface DeployFakeControls {
  running?: string
  noRunning?: boolean
  failRunning?: boolean
  snapshotOk?: boolean
  healthyScript?: boolean[]
  syntheticOk?: boolean
  failStart?: boolean
  failRollbackStart?: boolean
  failWriteEnv?: boolean
}

function createDeployFake(controls: DeployFakeControls = {}) {
  let clockMs = Date.parse('2026-01-01T00:00:00.000Z')
  const calls: string[] = []
  const records: DeployRecord[] = []
  const alerts: string[] = []
  const healthyScript = [...(controls.healthyScript ?? [true])]
  let startCount = 0
  const ops: DeployHostOps = {
    async newestRelease() {
      return undefined
    },
    async runningVersion() {
      calls.push('runningVersion')
      if (controls.failRunning) throw new Error('docker down')
      if (controls.noRunning) return undefined
      return controls.running ?? '1.1.0'
    },
    async activeTurns() {
      calls.push('activeTurns')
      return 0
    },
    async snapshot() {
      calls.push('snapshot')
      return controls.snapshotOk ?? true
    },
    async pull(version: string) {
      calls.push(`pull:${version}`)
    },
    async start(version: string) {
      calls.push(`start:${version}`)
      startCount += 1
      if (startCount === 1 && controls.failStart) throw new Error('start error')
      if (startCount > 1 && controls.failRollbackStart) throw new Error('rollback start error')
    },
    async healthy() {
      calls.push('healthy')
      if (healthyScript.length === 0) return false
      return healthyScript.shift() ?? false
    },
    async syntheticTurn() {
      calls.push('syntheticTurn')
      return controls.syntheticOk ?? true
    },
    async pruneImages(current: string, previous: string | undefined) {
      calls.push(`pruneImages:${current}:${previous ?? 'none'}`)
    },
    async record(entry: DeployRecord) {
      calls.push(`record:${entry.outcome}`)
      records.push(entry)
    },
    async alert(message: string) {
      calls.push('alert')
      alerts.push(message)
    },
    async writeEnv(version: string) {
      calls.push(`writeEnv:${version}`)
      if (controls.failWriteEnv) throw new Error('env error')
    },
    async sleep(ms: number) {
      calls.push(`sleep:${ms}`)
      clockMs += ms
    },
    now() {
      return new Date(clockMs)
    }
  }
  return { ops, calls, records, alerts }
}

function deployConfig(installDir: string, repoDir: string, overrides: Partial<DeployHostConfig> = {}) {
  return {
    version: 'sha-abc1234',
    installDir,
    repoDir,
    waitForIdleMs: 6000,
    healthTimeoutMs: 6000,
    pollMs: 2000,
    lockWaitMs: 5000,
    syncFiles: false,
    ...overrides
  }
}

describe('synthetic turn (D1)', () => {
  it('builds a body the core never reads as an auxiliary chore', () => {
    expect(parseGatewayRequest(syntheticTurnBody()).type).not.toBe('auxiliary')
  })

  it('delivers a tool-bearing fixture through the normal gateway turn pipeline', async () => {
    expect(parseGatewayRequest(syntheticTurnBody()).type).toBe('turn')
    await probeTurn()
  }, 15000)

  it('verifies the standalone structured transport in a disposable store', async () => {
    expect(await probeTurn('standalone')).toBe('standalone')
  }, 15000)
})

describe('site health (D2)', () => {
  function healthFetch(site: 'ready' | 'starting' | 'refused'): typeof fetch {
    return (async (input: string) => {
      if (input.endsWith('/api/health')) {
        if (site === 'refused') throw new Error('refused')
        return new Response(JSON.stringify({ status: site }), { status: 200 })
      }
      return new Response(JSON.stringify({ status: 'ready', activeTurns: 0 }), { status: 200 })
    }) as typeof fetch
  }

  it('checks both dashboard entries and answers the canonical owner challenge', async () => {
    const token = 'fixture-owner'
    const siteTokenFile = join(tmpDir(), 'fixture-token')
    await writeFile(siteTokenFile, token)
    const siteUrl = 'http://127.0.0.1:9890'
    for (const canonical of [false, true]) {
      const composeFile = join(tmpDir(), 'compose.yml')
      await writeFile(join(dirname(composeFile), '.env'), canonical ? 'AIRA_DASHBOARD_ENTRY=dashboard' : '')
      const fetcher = (async (input, init) => {
        const url = new URL(String(input))
        if (url.origin !== siteUrl) return Response.json({ status: 'ready', activeTurns: 0 })
        if (url.pathname === '/app/')
          return canonical
            ? new Response(null, { status: 302, headers: { location: '/overview' } })
            : new Response('<script src="/app/assets/classic.js"></script>')
        if (url.pathname === '/overview') return new Response('<script src="/app/assets/preview.js"></script>')
        if (url.pathname.startsWith('/app/assets/'))
          return new Response('void 0', { headers: { 'content-type': 'application/javascript' } })
        const authorized = new Headers(init?.headers).get('x-tolongai-token') === token
        if (canonical && !authorized) return new Response(null, { status: 401 })
        if (url.pathname === '/api/health') return Response.json({ status: 'ready' })
        if (url.pathname === (canonical ? '/owner-api/core/chats' : '/api/chats')) return Response.json({ chats: [] })
        if (url.pathname === '/owner-api/dashboard' && authorized) return Response.json({ services: {}, recent: [] })
        throw new Error('Unexpected probe path')
      }) as typeof fetch
      const ops = createRealOps(baseOptions({ composeFile, siteUrl, siteTokenFile, fetch: fetcher }))
      expect(await ops.healthy()).toBe(true)
      expect(await ops.ownerConsole?.()).toBe(true)
    }
  })

  it('is healthy only when the core and the site are both ready', async () => {
    const bothReady = createRealOps(baseOptions({ siteUrl: 'http://127.0.0.1:9890', fetch: healthFetch('ready') }))
    expect(await bothReady.healthy()).toBe(true)

    const refused = createRealOps(baseOptions({ siteUrl: 'http://127.0.0.1:9890', fetch: healthFetch('refused') }))
    expect(await refused.healthy()).toBe(false)

    const starting = createRealOps(baseOptions({ siteUrl: 'http://127.0.0.1:9890', fetch: healthFetch('starting') }))
    expect(await starting.healthy()).toBe(false)
  })

  it('rolls back when the site refuses while the core answers', async () => {
    const dir = tmpDir()
    // Four falses fail the health window, then the old image answers again.
    const { ops, records } = createDeployFake({ healthyScript: [false, false, false, false, true] })
    const result = await runDeployHost(ops, deployConfig(dir, dir))
    expect(result).toEqual({ action: 'rolled_back', from: '1.1.0', to: 'sha-abc1234', reason: 'unhealthy' })
    expect(records[0]).toMatchObject({ outcome: 'rolled_back', reason: 'unhealthy' })
  })
})

describe('rollback accounting (D3)', () => {
  it('records rollback_failed when both starts fail', async () => {
    const dir = tmpDir()
    const { ops, records, alerts } = createDeployFake({ failStart: true, failRollbackStart: true })
    const result = await runDeployHost(ops, deployConfig(dir, dir))
    expect(result).toEqual({ action: 'rollback_failed', from: '1.1.0', to: 'sha-abc1234', reason: 'start_failed' })
    expect(records[0]).toMatchObject({ outcome: 'rollback_failed', reason: 'start_failed' })
    expect(alerts.some((msg) => msg.toLowerCase().includes('service is down'))).toBe(true)
  })

  it('records rollback_failed with no target on a fresh install that fails to start', async () => {
    const dir = tmpDir()
    const { ops, records } = createDeployFake({ noRunning: true, failStart: true })
    const result = await runDeployHost(ops, deployConfig(dir, dir))
    expect(result).toEqual({ action: 'rollback_failed', from: undefined, to: 'sha-abc1234', reason: 'start_failed' })
    expect(records[0]).toMatchObject({ outcome: 'rollback_failed', from: undefined })
  })
})

describe('unknown running version (D4)', () => {
  it('aborts before pull when the running version lookup fails', async () => {
    const dir = tmpDir()
    const { ops, calls, records } = createDeployFake({ failRunning: true })
    const result = await runDeployHost(ops, deployConfig(dir, dir))
    expect(result).toEqual({ action: 'failed', from: undefined, to: 'sha-abc1234', reason: 'version_failed' })
    expect(calls).not.toContain('pull:sha-abc1234')
    expect(records[0]).toMatchObject({ outcome: 'failed_before_start', reason: 'version_failed' })
  })
})

describe('snapshot baseline (D5)', () => {
  it('fails the snapshot without signalling when no baseline health can be read', async () => {
    const killed: string[][] = []
    const ops = createRealOps(
      baseOptions({
        fetch: (async () => {
          throw new Error('down')
        }) as typeof fetch,
        run: async (command: string, args: string[]) => {
          killed.push([command, ...args])
          return { code: 0, stdout: '', stderr: '' }
        }
      })
    )
    expect(await ops.snapshot()).toBe(false)
    expect(killed).toEqual([])
  })
})

describe('.env writes (D6)', () => {
  it('updates keys in place and appends missing ones', () => {
    expect(updateEnvContent('A=1\nB=2\n', { B: '3', C: '4' })).toBe('A=1\nB=3\nC=4\n')
  })

  it('writes a new .env with mode 600 and keeps other lines on rewrite', async () => {
    const envFile = join(tmpDir(), '.env')
    await writeInstallEnv(envFile, 'ghcr.io/tolonglabs/aira', 'sha-abc1234')
    expect((await stat(envFile)).mode & 0o777).toBe(0o600)
    expect(await readFile(envFile, 'utf8')).toContain('AIRA_VERSION=sha-abc1234')

    await writeFile(envFile, 'OTHER=keep\nAIRA_VERSION=old\n', 'utf8')
    await chmod(envFile, 0o644)
    await writeInstallEnv(envFile, 'ghcr.io/tolonglabs/aira', 'sha-new')
    const text = await readFile(envFile, 'utf8')
    expect(text).toContain('OTHER=keep')
    expect(text).toContain('AIRA_VERSION=sha-new')
    expect((await stat(envFile)).mode & 0o777).toBe(0o600)
  })
})

describe('down core snapshot (D7)', () => {
  it('uses a fresh offline snapshot when the core is down', async () => {
    const dir = tmpDir()
    const { ops, calls, alerts } = createDeployFake({ snapshotOk: false, healthyScript: [] })
    ops.offlineSnapshot = async () => true
    const result = await runDeployHost(ops, deployConfig(dir, dir))
    expect(calls).toContain('pull:sha-abc1234')
    expect(result).toEqual({ action: 'rollback_failed', from: '1.1.0', to: 'sha-abc1234', reason: 'unhealthy' })
    expect(alerts.some((msg) => msg.includes('fresh offline snapshot'))).toBe(true)
  })

  it('still aborts when a healthy core fails to snapshot', async () => {
    const dir = tmpDir()
    const { ops, calls, records } = createDeployFake({ snapshotOk: false, healthyScript: [true] })
    const result = await runDeployHost(ops, deployConfig(dir, dir))
    expect(result).toEqual({ action: 'failed', from: '1.1.0', to: 'sha-abc1234', reason: 'snapshot_failed' })
    expect(calls).not.toContain('pull:sha-abc1234')
    expect(records[0]).toMatchObject({ outcome: 'failed_before_start', reason: 'snapshot_failed' })
  })
})

describe('host lock (D8)', () => {
  it('skips the timer tick while another deploy holds the lock', async () => {
    const lockPath = join(tmpDir(), 'deploy.lock')
    const held = await acquireDeployLock(lockPath)
    expect(held).toBeDefined()
    const stub = new Proxy(
      {},
      {
        get: () => async () => {
          throw new Error('must not be called')
        }
      }
    ) as UpdaterOps
    const result = await runUpdate(stub, { waitForIdleMs: 1000, healthTimeoutMs: 1000, lockPath })
    expect(result).toEqual({ action: 'none', reason: 'locked' })
    await held?.release()
  })

  it('takes, releases and retakes the lock, and gives up without waiting past the timeout', async () => {
    const lockPath = join(tmpDir(), 'deploy.lock')
    const held = await acquireDeployLock(lockPath)
    expect(held).toBeDefined()
    expect(await acquireDeployLock(lockPath)).toBeUndefined()
    const waiter = { now: () => new Date(), sleep: async () => {} }
    expect(await waitForDeployLock(waiter, lockPath, 0)).toBeUndefined()
    await held?.release()
    const next = await acquireDeployLock(lockPath)
    expect(next).toBeDefined()
    await next?.release()
  })

  it('derives the lock path from the compose file', () => {
    expect(deployLockPath(join('/opt/aira', 'compose.yml'))).toBe(join('/opt/aira', 'deploy.lock'))
  })
})

describe('fetch timeouts and local images (D9)', () => {
  it('bounds health fetches with a timeout', async () => {
    const signals: (AbortSignal | undefined)[] = []
    const ops = createRealOps(
      baseOptions({
        siteUrl: 'http://127.0.0.1:9890',
        fetch: (async (input: string, init?: { signal?: AbortSignal }) => {
          signals.push(init?.signal)
          if (input.includes('/api/health')) return new Response(JSON.stringify({ status: 'ready' }), { status: 200 })
          return new Response(JSON.stringify({ status: 'ready', activeTurns: 0 }), { status: 200 })
        }) as typeof fetch
      })
    )
    expect(await ops.healthy()).toBe(true)
    expect(signals).toHaveLength(2)
    for (const signal of signals) expect(signal).toBeInstanceOf(AbortSignal)
  })

  it('bounds the ntfy post with a timeout', async () => {
    const seen: (AbortSignal | undefined)[] = []
    const fetchFn = (async (_url: string, init?: { signal?: AbortSignal }) => {
      seen.push(init?.signal)
      return new Response('ok')
    }) as typeof fetch
    await sendNtfy('http://127.0.0.1:1', 'deploy ok', fetchFn)
    expect(seen[0]).toBeInstanceOf(AbortSignal)
  })

  it('skips the registry pull for a locally built image', async () => {
    const ops = createRealOps(
      baseOptions({
        image: 'aira-local',
        run: async () => {
          throw new Error('must not pull a local image')
        }
      })
    )
    await expect(ops.pull('abc1234')).resolves.toBeUndefined()
  })
})

describe('site URL resolution (D2)', () => {
  it('defaults to loopback and honours env and .env', async () => {
    const gatewayInstall = tmpDir()
    await writeFile(join(gatewayInstall, '.env'), 'AIRA_PORT=9901\n')
    expect(await resolveCoreUrl(gatewayInstall, {})).toBe('http://127.0.0.1:9901')
    expect(await resolveSiteUrl(tmpDir(), {})).toBe('http://127.0.0.1:9890')
    expect(await resolveSiteUrl(tmpDir(), { AIRA_SITE_URL: 'https://site.example:9898' })).toBe(
      'https://site.example:9898'
    )
    const dir = tmpDir()
    await writeFile(dir + '/.env', 'AIRA_SITE_BIND=10.1.2.3\nAIRA_SITE_PORT=9898\n', 'utf8')
    expect(await resolveSiteUrl(dir, {})).toBe('http://10.1.2.3:9898')
  })
})

describe('config sync (D7)', () => {
  const repoConfig = [
    'gateway:',
    "  hostDataDir: ''",
    '  selfIds: []',
    '  jobs: []',
    'llm:',
    "  transport: 'api'",
    ''
  ].join('\n')

  it('keeps the install host keys over the repo config', () => {
    const installConfig = [
      'gateway:',
      "  hostDataDir: '/home/user/aira/data'",
      "  selfIds: ['12345@g.us']",
      '  jobs:',
      '    - { id: morning, chat: c_abc }',
      'llm:',
      "  transport: 'api'",
      ''
    ].join('\n')
    const merged = applyHostConfigKeys(repoConfig, installConfig)
    expect(merged).toContain("hostDataDir: '/home/user/aira/data'")
    expect(merged).toContain("selfIds: ['12345@g.us']")
    expect(merged).toContain('- { id: morning, chat: c_abc }')
    expect(merged).toContain("transport: 'api'")
  })

  it('keeps repo defaults for host keys the install does not set', () => {
    const merged = applyHostConfigKeys(repoConfig, "llm:\n  transport: 'api'\n")
    expect(merged).toContain("hostDataDir: ''")
    expect(merged).toContain('selfIds: []')
  })

  it('syncs compose and config files end to end on deploy', async () => {
    const installDir = tmpDir()
    const repoDir = tmpDir()
    await mkdir(join(repoDir, 'deploy'), { recursive: true })
    await writeFile(join(repoDir, 'deploy', 'compose.yml'), 'services:\n  aira:\n    image: new\n', 'utf8')
    await writeFile(join(repoDir, 'config.yml'), repoConfig, 'utf8')
    await writeFile(join(installDir, 'compose.yml'), 'services:\n  aira:\n    image: old\n', 'utf8')
    await writeFile(
      join(installDir, 'config.yml'),
      repoConfig.replace("hostDataDir: ''", "hostDataDir: '/home/user/aira/data'"),
      'utf8'
    )
    await writeFile(join(installDir, '.env'), 'AIRA_IMAGE=ghcr.io/tolonglabs/aira\nAIRA_VERSION=v1.1.0\n', 'utf8')

    const { ops } = createDeployFake({ running: 'v1.1.0' })
    ops.writeEnv = (version) => writeInstallEnv(join(installDir, '.env'), 'ghcr.io/tolonglabs/aira', version)
    const result = await runDeployHost(ops, deployConfig(installDir, repoDir, { syncFiles: true }))
    expect(result).toEqual({ action: 'deployed', from: 'v1.1.0', to: 'sha-abc1234' })
    expect(await readFile(join(installDir, 'compose.yml'), 'utf8')).toBe('services:\n  aira:\n    image: new\n')
    const config = await readFile(join(installDir, 'config.yml'), 'utf8')
    expect(config).toContain("hostDataDir: '/home/user/aira/data'")
    const env = await readFile(join(installDir, '.env'), 'utf8')
    expect(env).toContain('AIRA_VERSION=sha-abc1234')
    expect((await stat(join(installDir, '.env'))).mode & 0o777).toBe(0o600)
  })
})

it('checks the selected subscription runner before using a fixture model', async () => {
  let calls = 0
  const request = async (input: Parameters<typeof fetch>[0]) => {
    calls++
    expect(String(input)).toBe('http://localhost:9882/health')
    return Response.json({ ok: false })
  }
  await verifyRunnerReachability('api', 'http://localhost:9882', request)
  expect(calls).toBe(0)
  await expect(verifyRunnerReachability('subscription', 'http://localhost:9882', request)).rejects.toThrow(
    'health check'
  )
  expect(calls).toBe(1)
})
