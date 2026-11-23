import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isMap, isScalar, isSeq, parseDocument } from 'yaml'
import { createRealOps, resolveCoreUrl, resolveSiteUrl, waitForDeployLock } from './updater/ops.js'
import type { DeployRecord, UpdaterOps } from './updater/update.js'

const DEFAULT_IMAGE = 'ghcr.io/tolonglabs/aira'
const DEFAULT_WAIT_FOR_IDLE_MS = 120_000
const DEFAULT_HEALTH_TIMEOUT_MS = 60_000
const DEFAULT_POLL_MS = 2000
/** Upper bound for one ntfy post. The deploy must never hang on its alert. */
export const NTFY_TIMEOUT_MS = 10_000
/** How long a CI deploy waits for the timer path to finish before giving up. */
export const DEPLOY_LOCK_WAIT_MS = 10 * 60_000

export interface DeployHostOps extends UpdaterOps {
  writeEnv(version: string): Promise<void>
}

export interface DeployHostConfig {
  version: string
  waitForIdleMs: number
  healthTimeoutMs: number
  pollMs?: number
  /** The host install folder. Holds compose.yml, .env, config.yml and the deploy lock. */
  installDir?: string
  /** The repo checkout that carries deploy/compose.yml and config.yml. Auto-detected when unset. */
  repoDir?: string
  /** Sync compose.yml and config.yml from the repo before starting. Defaults to true. */
  syncFiles?: boolean
  /** How long to wait for the timer path to finish. Defaults to DEPLOY_LOCK_WAIT_MS. */
  lockWaitMs?: number
}

export type DeployHostResult =
  | { action: 'deployed'; from: string | undefined; to: string }
  | {
      action: 'failed'
      from: string | undefined
      to: string
      reason: 'snapshot_failed' | 'pull_failed' | 'env_failed' | 'config_failed' | 'version_failed' | 'locked'
    }
  | {
      action: 'rolled_back'
      from: string | undefined
      to: string
      reason: 'start_failed' | 'unhealthy' | 'owner_console_failed' | 'synthetic_turn_failed'
    }
  | {
      action: 'rollback_failed'
      from: string | undefined
      to: string
      reason: 'start_failed' | 'unhealthy' | 'owner_console_failed' | 'synthetic_turn_failed'
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
  // Secrets live here: replace the file atomically and keep it readable by its owner only.
  await mkdir(dirname(envFile), { recursive: true })
  const tmpFile = `${envFile}.tmp.${process.pid}.${Date.now()}`
  try {
    await writeFile(tmpFile, updated, { mode: 0o600 })
    await rename(tmpFile, envFile)
    await chmod(envFile, 0o600)
  } catch (err) {
    await rm(tmpFile, { force: true })
    throw err
  }
}

export async function sendNtfy(
  ntfyUrl: string | undefined,
  message: string,
  fetchFn: typeof fetch = fetch
): Promise<void> {
  if (!ntfyUrl) return
  await fetchFn(ntfyUrl, {
    method: 'POST',
    body: message,
    signal: AbortSignal.timeout(NTFY_TIMEOUT_MS)
  })
}

function writeLine(line: string): void {
  process.stdout.write(line + '\n')
}

function elapsedSeconds(ops: DeployHostOps, startedMs: number): number {
  return Math.max(0, Math.round((ops.now().getTime() - startedMs) / 1000))
}

async function runStep<T>(
  ops: DeployHostOps,
  step: string,
  fn: () => Promise<T>,
  options: { detail?: string; ok?: (value: T) => boolean } = {}
): Promise<T> {
  const startedMs = ops.now().getTime()
  writeLine(options.detail ? `deploy: ${step} ${options.detail} start` : `deploy: ${step} start`)
  try {
    const result = await fn()
    const status = options.ok && !options.ok(result) ? 'failed' : 'done'
    writeLine(`deploy: ${step} ${status} ${elapsedSeconds(ops, startedMs)}s`)
    return result
  } catch (err) {
    writeLine(`deploy: ${step} failed ${elapsedSeconds(ops, startedMs)}s`)
    throw err
  }
}

async function readRepoFile(
  repoDir: string | undefined,
  ...segments: string[]
): Promise<{ path: string; text: string } | undefined> {
  const candidates = [
    ...(repoDir === undefined ? [] : [join(repoDir, ...segments)]),
    fileURLToPath(new URL(['..', ...segments].join('/'), import.meta.url)),
    resolve(process.cwd(), ...segments)
  ]
  for (const candidate of candidates) {
    try {
      return { path: candidate, text: await readFile(candidate, 'utf8') }
    } catch {}
  }
  return undefined
}

/** Add defaults to an installed YAML document without resetting host-managed values.
 * Compose mounts are keyed by container destination, including after a host path change. */
export function applyHostConfigKeys(repoText: string, installText: string, compose = false): string {
  const installed = parseDocument(installText),
    defaults = parseDocument(repoText)
  if (installed.errors.length || defaults.errors.length || !isMap(installed.contents) || !isMap(defaults.contents))
    throw new Error('Invalid deployment YAML')
  let changed = false
  function merge(template: unknown, path: string[]) {
    if (!isMap(template)) return
    for (const item of template.items) {
      const key = String(item.key),
        where = [...path, key]
      const before = installed.getIn(where, true)
      if (before === undefined || (compose && where.join('.') === 'services.aira.image')) {
        if (String(before) !== String(item.value) || before === undefined) {
          installed.setIn(where, item.value)
          changed = true
        }
      } else if (compose && where.join('.') === 'services.aira.volumes' && isSeq(before) && isSeq(item.value)) {
        const mount = (node: unknown) =>
          isMap(node)
            ? node.get('target')
            : isScalar(node)
              ? String(node.value)
                  .replace(/:(?:ro|rw)$/, '')
                  .split(':')
                  .at(-1)
              : undefined
        const targets = new Set(before.items.map(mount))
        for (const entry of item.value.items)
          if (!targets.has(mount(entry))) {
            before.add(entry)
            changed = true
          }
      } else if (isMap(before)) merge(item.value, where)
    }
  }
  merge(defaults.contents, [])
  return changed ? installed.toString() : installText
}

async function replaceYaml(target: string, text: string) {
  const tmp = target + '.' + process.pid + '.tmp'
  try {
    await writeFile(tmp, text, { mode: 0o600, flag: 'wx' })
    await rename(tmp, target)
  } finally {
    await rm(tmp, { force: true })
  }
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (err) {
    if ((err as { code?: unknown }).code === 'ENOENT') return undefined
    throw err
  }
}

async function syncComposeFile(repoDir: string | undefined, installDir: string): Promise<void> {
  const found = await readRepoFile(repoDir, 'deploy', 'compose.yml')
  if (!found) {
    writeLine('deploy: sync-compose skipped (no repo checkout found)')
    return
  }
  const target = join(installDir, 'compose.yml')
  const current = await readOptional(target)
  const merged = current === undefined ? found.text : applyHostConfigKeys(found.text, current, true)
  if (current === merged) return
  await mkdir(dirname(target), { recursive: true })
  await replaceYaml(target, merged)
  writeLine('deploy: sync-compose updated compose.yml')
}

async function syncConfigFile(repoDir: string | undefined, installDir: string): Promise<void> {
  const found = await readRepoFile(repoDir, 'config.yml')
  if (!found) {
    writeLine('deploy: sync-config skipped (no repo checkout found)')
    return
  }
  const target = join(installDir, 'config.yml')
  const current = await readOptional(target)
  const merged = current === undefined ? found.text : applyHostConfigKeys(found.text, current)
  if (current === merged) return
  await mkdir(dirname(target), { recursive: true })
  await replaceYaml(target, merged)
  writeLine('deploy: sync-config updated config.yml')
}

async function rollback(
  ops: DeployHostOps,
  timeouts: { healthTimeoutMs: number; pollMs: number; verifyRestoredConsole?: boolean },
  previous: string | undefined,
  target: string,
  reason: 'start_failed' | 'unhealthy' | 'owner_console_failed' | 'synthetic_turn_failed'
): Promise<DeployHostResult> {
  if (previous === undefined) {
    await safeRecord(ops, {
      at: ops.now().toISOString(),
      from: previous,
      to: target,
      outcome: 'rollback_failed',
      reason
    })
    await runStep(ops, 'alert', () =>
      safeAlert(ops, `Deploy of ${target} failed (${reason}) with nothing to roll back to; service is down`)
    )
    return { action: 'rollback_failed', from: previous, to: target, reason }
  }
  let restarted = false
  try {
    await runStep(
      ops,
      'rollback',
      async () => {
        await ops.writeEnv(previous)
        await ops.start(previous)
      },
      { detail: previous }
    )
    restarted = true
  } catch (err) {
    await safeAlert(ops, `Rollback to ${previous} failed after ${reason}; service is down: ${errorMessage(err)}`)
  }
  if (restarted) {
    // The old image may be broken too. Only a healthy rollback counts as rolled back.
    const recovered = await runStep(
      ops,
      'rollback-health',
      () => waitForHealthy(ops, timeouts.healthTimeoutMs, timeouts.pollMs),
      {
        ok: (value) => value
      }
    )
    const consoleRestored =
      !timeouts.verifyRestoredConsole ||
      (ops.ownerConsole &&
        (await safeCall(ops.ownerConsole, false)) &&
        (await safeCall(() => ops.syntheticTurn(), false)))
    if (!recovered || !consoleRestored) {
      await safeRecord(ops, {
        at: ops.now().toISOString(),
        from: previous,
        to: target,
        outcome: 'rollback_failed',
        reason
      })
      await runStep(ops, 'alert', () =>
        safeAlert(ops, `Rollback to ${previous} started but stayed unhealthy after ${reason}; service is down`)
      )
      return { action: 'rollback_failed', from: previous, to: target, reason }
    }
  } else {
    await safeRecord(ops, {
      at: ops.now().toISOString(),
      from: previous,
      to: target,
      outcome: 'rollback_failed',
      reason
    })
    return { action: 'rollback_failed', from: previous, to: target, reason }
  }
  await safeRecord(ops, {
    at: ops.now().toISOString(),
    from: previous,
    to: target,
    outcome: 'rolled_back',
    reason
  })
  await runStep(ops, 'alert', () => safeAlert(ops, `Deploy of ${target} rolled back: ${reason}`))
  return { action: 'rolled_back', from: previous, to: target, reason }
}

async function failBeforeStart(
  ops: DeployHostOps,
  previous: string | undefined,
  target: string,
  reason: 'snapshot_failed' | 'pull_failed' | 'env_failed' | 'config_failed' | 'version_failed' | 'locked',
  message: string
): Promise<DeployHostResult> {
  await safeRecord(ops, {
    at: ops.now().toISOString(),
    from: previous,
    to: target,
    outcome: 'failed_before_start',
    reason
  })
  await runStep(ops, 'alert', () => safeAlert(ops, message))
  return { action: 'failed', from: previous, to: target, reason }
}

/** Runs the host deploy sequence: lock, idle wait, file sync, snapshot, pull, .env update, recreate, health, turn, prune, alert. */
export async function runDeployHost(ops: DeployHostOps, config: DeployHostConfig): Promise<DeployHostResult> {
  const pollMs = config.pollMs ?? DEFAULT_POLL_MS
  const timeouts = { healthTimeoutMs: config.healthTimeoutMs, pollMs }
  const installDir = config.installDir
  const lock = installDir
    ? await runStep(ops, 'lock', () =>
        waitForDeployLock(ops, join(installDir, 'deploy.lock'), config.lockWaitMs ?? DEPLOY_LOCK_WAIT_MS)
      )
    : undefined
  if (installDir && !lock) {
    return failBeforeStart(
      ops,
      undefined,
      config.version,
      'locked',
      `Deploy of ${config.version} aborted: another deploy holds the lock`
    )
  }
  try {
    let previous: string | undefined
    try {
      previous = await runStep(ops, 'running-version', () => ops.runningVersion())
    } catch (err) {
      return failBeforeStart(
        ops,
        undefined,
        config.version,
        'version_failed',
        `Deploy of ${config.version} aborted: running version lookup failed: ${errorMessage(err)}`
      )
    }

    await runStep(ops, 'idle-wait', () => waitForIdle(ops, config.waitForIdleMs, pollMs))

    if (previous !== undefined) {
      const snapped = await runStep(ops, 'snapshot', () => safeCall(() => ops.snapshot(), false), {
        ok: (value) => value
      })
      if (!snapped) {
        if (
          (await safeCall(() => ops.healthy(), false)) ||
          !ops.offlineSnapshot ||
          !(await safeCall(ops.offlineSnapshot, false))
        ) {
          return failBeforeStart(
            ops,
            previous,
            config.version,
            'snapshot_failed',
            `Deploy of ${config.version} aborted: snapshot failed`
          )
        }
        await runStep(ops, 'alert', () =>
          safeAlert(ops, `Deploy of ${config.version} used a fresh offline snapshot of the unavailable core`)
        )
      }
    }

    try {
      await runStep(ops, 'pull', () => ops.pull(config.version), { detail: config.version })
    } catch (err) {
      return failBeforeStart(
        ops,
        previous,
        config.version,
        'pull_failed',
        `Deploy of ${config.version} aborted: pull failed: ${errorMessage(err)}`
      )
    }

    const verifyRestoredConsole = Boolean(previous && ops.ownerConsole && (await safeCall(ops.ownerConsole, false)))
    const originals = new Map<string, string | undefined>()
    async function restoreFiles() {
      for (const [path, text] of originals) {
        if (text === undefined) await rm(path, { force: true })
        else if ((await readOptional(path)) !== text) await replaceYaml(path, text)
      }
    }
    async function restore(reason: 'start_failed' | 'unhealthy' | 'owner_console_failed' | 'synthetic_turn_failed') {
      try {
        await restoreFiles()
      } catch {
        await safeRecord(ops, {
          at: ops.now().toISOString(),
          from: previous,
          to: config.version,
          outcome: 'rollback_failed',
          reason
        })
        await safeAlert(ops, 'Rollback failed to restore the install configuration')
        return { action: 'rollback_failed' as const, from: previous, to: config.version, reason }
      }
      return rollback(ops, { ...timeouts, verifyRestoredConsole }, previous, config.version, reason)
    }
    let writingEnv = false
    try {
      if (installDir && config.syncFiles !== false) {
        for (const name of ['compose.yml', 'config.yml']) {
          const file = join(installDir, name)
          originals.set(file, await readOptional(file))
        }
        await runStep(ops, 'sync-compose', () => syncComposeFile(config.repoDir, installDir))
        await runStep(ops, 'sync-config', () => syncConfigFile(config.repoDir, installDir))
      }
      writingEnv = true
      await runStep(ops, 'env', () => ops.writeEnv(config.version), { detail: config.version })
    } catch (err) {
      const reason = writingEnv ? 'env_failed' : 'config_failed'
      try {
        await restoreFiles()
      } catch (restoreError) {
        return failBeforeStart(
          ops,
          previous,
          config.version,
          reason,
          'Install configuration restoration failed: ' + errorMessage(restoreError)
        )
      }
      return failBeforeStart(
        ops,
        previous,
        config.version,
        reason,
        `Deploy of ${config.version} aborted: ${reason}: ${errorMessage(err)}`
      )
    }

    try {
      await runStep(ops, 'recreate', () => ops.start(config.version), { detail: config.version })
    } catch {
      return restore('start_failed')
    }

    const healthy = await runStep(ops, 'health', () => waitForHealthy(ops, config.healthTimeoutMs, pollMs), {
      ok: (value) => value
    })
    if (!healthy) {
      return restore('unhealthy')
    }

    if (ops.ownerConsole && !(await safeCall(ops.ownerConsole, false))) return restore('owner_console_failed')

    const turned = await runStep(ops, 'synthetic-turn', () => safeCall(() => ops.syntheticTurn(), false), {
      ok: (value) => value
    })
    if (!turned) {
      return restore('synthetic_turn_failed')
    }

    try {
      await runStep(ops, 'prune', () => ops.pruneImages(config.version, previous))
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
    await runStep(ops, 'alert', () => safeAlert(ops, summary))
    return { action: 'deployed', from: previous, to: config.version }
  } finally {
    if (lock) await safeCall(() => lock.release(), undefined)
  }
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

async function createDeployHostOps(
  installDir: string,
  image: string,
  ntfyUrl: string | undefined
): Promise<DeployHostOps> {
  const baseOps = createRealOps({
    image,
    repository: process.env['AIRA_REPOSITORY'] || 'TolongLabs/AIRA',
    composeFile: join(installDir, 'compose.yml'),
    service: 'aira',
    coreUrl: await resolveCoreUrl(installDir, process.env),
    siteUrl: await resolveSiteUrl(installDir, process.env),
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
  const ops = await createDeployHostOps(install, image, ntfyUrl)
  const result = await runDeployHost(ops, {
    version,
    installDir: install,
    waitForIdleMs: Number(process.env['AIRA_WAIT_FOR_IDLE_MS'] || DEFAULT_WAIT_FOR_IDLE_MS),
    healthTimeoutMs: Number(process.env['AIRA_HEALTH_TIMEOUT_MS'] || DEFAULT_HEALTH_TIMEOUT_MS)
  })
  process.stdout.write(JSON.stringify(result) + '\n')
  process.exit(result.action === 'deployed' ? 0 : 1)
}
