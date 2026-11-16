import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRealOps } from './updater/ops.js'
import type { DeployRecord, UpdaterOps } from './updater/update.js'

const DEFAULT_IMAGE = 'ghcr.io/tolonglabs/aira'
const DEFAULT_WAIT_FOR_IDLE_MS = 120_000
const DEFAULT_HEALTH_TIMEOUT_MS = 60_000
const DEFAULT_POLL_MS = 2000

export interface DeployHostOps extends UpdaterOps {
  writeEnv(version: string): Promise<void>
}

export interface DeployHostConfig {
  version: string
  waitForIdleMs: number
  healthTimeoutMs: number
  pollMs?: number
}

export type DeployHostResult =
  | { action: 'deployed'; from: string | undefined; to: string }
  | { action: 'failed'; from: string | undefined; to: string; reason: 'snapshot_failed' | 'pull_failed' | 'env_failed' }
  | {
      action: 'rolled_back'
      from: string | undefined
      to: string
      reason: 'start_failed' | 'unhealthy' | 'synthetic_turn_failed'
    }

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function safeCall<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn()
  } catch {
    return fallback
  }
}

async function safeRecord(ops: DeployHostOps, entry: DeployRecord): Promise<void> {
  await safeCall(() => ops.record(entry), undefined)
}

async function safeAlert(ops: DeployHostOps, message: string): Promise<void> {
  await safeCall(() => ops.alert(message), undefined)
}

async function waitForIdle(ops: DeployHostOps, waitForIdleMs: number, pollMs: number): Promise<void> {
  const deadline = ops.now().getTime() + waitForIdleMs
  while (true) {
    const turns = await safeCall(() => ops.activeTurns(), undefined)
    if (turns === undefined || turns === 0) return
    if (ops.now().getTime() >= deadline) return
    await safeCall(() => ops.sleep(pollMs), undefined)
  }
}

async function waitForHealthy(ops: DeployHostOps, healthTimeoutMs: number, pollMs: number): Promise<boolean> {
  const deadline = ops.now().getTime() + healthTimeoutMs
  while (true) {
    if (await safeCall(() => ops.healthy(), false)) return true
    if (ops.now().getTime() >= deadline) return false
    await safeCall(() => ops.sleep(pollMs), undefined)
  }
}

/** Updates or appends key=value pairs in a .env file while keeping all other lines intact. */
export function updateEnvContent(content: string, updates: Record<string, string>): string {
  const remaining = new Map(Object.entries(updates))
  const lines = content.length === 0 ? [] : content.split(/\r?\n/)
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop()
  }
  const nextLines: string[] = []
  for (const line of lines) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)
    const key = match?.[1]
    if (key !== undefined && Object.hasOwn(updates, key)) {
      if (remaining.has(key)) {
        nextLines.push(`${key}=${remaining.get(key)}`)
        remaining.delete(key)
      }
      continue
    }
    nextLines.push(line)
  }
  for (const [key, value] of remaining) {
    nextLines.push(`${key}=${value}`)
  }
  return nextLines.join('\n') + '\n'
}

export async function writeInstallEnv(envFile: string, image: string, version: string): Promise<void> {
  let existing = ''
  try {
    existing = await readFile(envFile, 'utf8')
  } catch (err) {
    if ((err as { code?: unknown }).code !== 'ENOENT') {
      throw err
    }
  }
  const updated = updateEnvContent(existing, {
    AIRA_IMAGE: image,
    AIRA_VERSION: version
  })
  await writeFile(envFile, updated, 'utf8')
}

export async function sendNtfy(
  ntfyUrl: string | undefined,
  message: string,
  fetchFn: typeof fetch = fetch
): Promise<void> {
  if (!ntfyUrl) return
  await fetchFn(ntfyUrl, {
    method: 'POST',
    body: message
  })
}

async function rollback(
  ops: DeployHostOps,
  previous: string | undefined,
  target: string,
  reason: 'start_failed' | 'unhealthy' | 'synthetic_turn_failed'
): Promise<DeployHostResult> {
  if (previous !== undefined) {
    try {
      await ops.writeEnv(previous)
      await ops.start(previous)
    } catch (err) {
      await safeAlert(ops, `Rollback to ${previous} failed after ${reason}; service is down: ${errorMessage(err)}`)
    }
  }
  await safeRecord(ops, {
    at: ops.now().toISOString(),
    from: previous,
    to: target,
    outcome: 'rolled_back',
    reason
  })
  await safeAlert(ops, `Deploy of ${target} rolled back: ${reason}`)
  return { action: 'rolled_back', from: previous, to: target, reason }
}

/** Runs the host deploy sequence: idle wait, snapshot, pull, .env update, recreate, health, turn, prune, alert. */
export async function runDeployHost(ops: DeployHostOps, config: DeployHostConfig): Promise<DeployHostResult> {
  const pollMs = config.pollMs ?? DEFAULT_POLL_MS
  const previous = await safeCall(() => ops.runningVersion(), undefined)

  await waitForIdle(ops, config.waitForIdleMs, pollMs)

  if (previous !== undefined) {
    const snapped = await safeCall(() => ops.snapshot(), false)
    if (!snapped) {
      await safeRecord(ops, {
        at: ops.now().toISOString(),
        from: previous,
        to: config.version,
        outcome: 'failed_before_start',
        reason: 'snapshot_failed'
      })
      await safeAlert(ops, `Deploy of ${config.version} aborted: snapshot failed`)
      return { action: 'failed', from: previous, to: config.version, reason: 'snapshot_failed' }
    }
  }

  try {
    await ops.pull(config.version)
  } catch (err) {
    await safeRecord(ops, {
      at: ops.now().toISOString(),
      from: previous,
      to: config.version,
      outcome: 'failed_before_start',
      reason: 'pull_failed'
    })
    await safeAlert(ops, `Deploy of ${config.version} aborted: pull failed: ${errorMessage(err)}`)
    return { action: 'failed', from: previous, to: config.version, reason: 'pull_failed' }
  }

  try {
    await ops.writeEnv(config.version)
  } catch (err) {
    await safeRecord(ops, {
      at: ops.now().toISOString(),
      from: previous,
      to: config.version,
      outcome: 'failed_before_start',
      reason: 'env_failed'
    })
    await safeAlert(ops, `Deploy of ${config.version} aborted: .env update failed: ${errorMessage(err)}`)
    return { action: 'failed', from: previous, to: config.version, reason: 'env_failed' }
  }

  try {
    await ops.start(config.version)
  } catch {
    return rollback(ops, previous, config.version, 'start_failed')
  }

  if (!(await waitForHealthy(ops, config.healthTimeoutMs, pollMs))) {
    return rollback(ops, previous, config.version, 'unhealthy')
  }

  if (!(await safeCall(() => ops.syntheticTurn(), false))) {
    return rollback(ops, previous, config.version, 'synthetic_turn_failed')
  }

  try {
    await ops.pruneImages(config.version, previous)
  } catch (err) {
    await safeAlert(ops, `Deploy of ${config.version} succeeded, but image prune failed: ${errorMessage(err)}`)
  }

  await safeRecord(ops, {
    at: ops.now().toISOString(),
    from: previous,
    to: config.version,
    outcome: 'deployed'
  })
  const summary =
    previous !== undefined
      ? `Deploy of ${config.version} succeeded (from ${previous})`
      : `Deploy of ${config.version} succeeded`
  await safeAlert(ops, summary)
  return { action: 'deployed', from: previous, to: config.version }
}

export function expandHome(input: string): string {
  if (input === '~') return homedir()
  if (input.startsWith('~/')) return join(homedir(), input.slice(2))
  return input
}

export function parseArgs(argv: string[]): { version: string; install: string } {
  let version = ''
  let install = '~/aira'
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--version') {
      version = argv[i + 1] ?? ''
      i += 1
    } else if (arg?.startsWith('--version=')) {
      version = arg.slice('--version='.length)
    } else if (arg === '--install') {
      install = argv[i + 1] ?? install
      i += 1
    } else if (arg?.startsWith('--install=')) {
      install = arg.slice('--install='.length)
    }
  }
  if (!version) {
    throw new Error('--version is required')
  }
  return { version, install: expandHome(install) }
}

function createDeployHostOps(installDir: string, image: string, ntfyUrl: string | undefined): DeployHostOps {
  const baseOps = createRealOps({
    image,
    repository: process.env['AIRA_REPOSITORY'] || 'TolongLabs/AIRA',
    composeFile: join(installDir, 'compose.yml'),
    service: 'aira',
    coreUrl: process.env['AIRA_CORE_URL'] || 'http://127.0.0.1:9881',
    recordFile: process.env['AIRA_DEPLOY_LOG'] || join(installDir, 'deploys.jsonl')
  })
  const envFile = join(installDir, '.env')
  return {
    ...baseOps,
    async writeEnv(version: string): Promise<void> {
      await writeInstallEnv(envFile, image, version)
    },
    async alert(message: string): Promise<void> {
      await baseOps.alert(message)
      await sendNtfy(ntfyUrl, message)
    }
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain) {
  const { version, install } = parseArgs(process.argv.slice(2))
  const image = process.env['AIRA_IMAGE'] || DEFAULT_IMAGE
  const ntfyUrl = process.env['AIRA_NTFY_URL'] || undefined
  const ops = createDeployHostOps(install, image, ntfyUrl)
  const result = await runDeployHost(ops, {
    version,
    waitForIdleMs: Number(process.env['AIRA_WAIT_FOR_IDLE_MS'] || DEFAULT_WAIT_FOR_IDLE_MS),
    healthTimeoutMs: Number(process.env['AIRA_HEALTH_TIMEOUT_MS'] || DEFAULT_HEALTH_TIMEOUT_MS)
  })
  process.stdout.write(JSON.stringify(result) + '\n')
  process.exit(result.action === 'deployed' ? 0 : 1)
}
