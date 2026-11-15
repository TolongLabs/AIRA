export interface Release {
  tag: string
  version: string
  manual: boolean
}

/** Every effect of a deploy. The real one is in ops.ts; tests use a fake. */
export interface UpdaterOps {
  /** The newest release, or undefined when there is none. */
  newestRelease(): Promise<Release | undefined>
  /** The version of the image that is running, or undefined when nothing runs. */
  runningVersion(): Promise<string | undefined>
  /** How many turns are in flight, from the core's health endpoint. Undefined when the core does not answer. */
  activeTurns(): Promise<number | undefined>
  /** Asks the core for a verified snapshot and waits for it. False when it failed or timed out. */
  snapshot(): Promise<boolean>
  pull(version: string): Promise<void>
  /** Stops the running container and starts the given version. */
  start(version: string): Promise<void>
  /** True when the health endpoint reports ready. */
  healthy(): Promise<boolean>
  /** Sends one synthetic turn through the endpoint. True for status 200 with non-empty content. */
  syntheticTurn(): Promise<boolean>
  /** Removes every image older than the one before `current`. */
  pruneImages(current: string, previous: string | undefined): Promise<void>
  record(entry: DeployRecord): Promise<void>
  alert(message: string): Promise<void>
  sleep(ms: number): Promise<void>
  now(): Date
}

export interface DeployRecord {
  at: string
  from: string | undefined
  to: string
  outcome: 'deployed' | 'rolled_back' | 'skipped_manual' | 'failed_before_start'
  reason?: string
}

export type UpdateResult =
  | { action: 'none'; reason: 'no_release' | 'up_to_date' | 'manual_release' | 'snapshot_failed' | 'pull_failed' }
  | { action: 'deployed'; from: string | undefined; to: string }
  | { action: 'rolled_back'; from: string | undefined; to: string; reason: string }

export interface UpdaterConfig {
  waitForIdleMs: number
  healthTimeoutMs: number
  pollMs?: number
}

function parseVersion(v: string): readonly [number, number, number] | undefined {
  const parts = v.replace(/^v/, '').split('.')
  const [p0, p1, p2] = parts
  if (parts.length !== 3 || p0 === undefined || p1 === undefined || p2 === undefined) return undefined
  if (!/^\d+$/.test(p0) || !/^\d+$/.test(p1) || !/^\d+$/.test(p2)) return undefined
  return [Number(p0), Number(p1), Number(p2)]
}

/** True when a is a newer version than b. Compares the three numbers of 'major.minor.patch'. */
export function isNewer(a: string, b: string): boolean {
  const va = parseVersion(a)
  const vb = parseVersion(b)
  if (!va || !vb) return false
  for (let i = 0; i < 3; i += 1) {
    const da = va[i] ?? 0
    const db = vb[i] ?? 0
    if (da !== db) return da > db
  }
  return false
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

async function safeRecord(ops: UpdaterOps, entry: DeployRecord): Promise<void> {
  await safeCall(() => ops.record(entry), undefined)
}

async function safeAlert(ops: UpdaterOps, message: string): Promise<void> {
  await safeCall(() => ops.alert(message), undefined)
}

async function safeSleep(ops: UpdaterOps, ms: number): Promise<void> {
  await safeCall(() => ops.sleep(ms), undefined)
}

async function waitForIdle(ops: UpdaterOps, waitForIdleMs: number, pollMs: number): Promise<void> {
  const deadline = ops.now().getTime() + waitForIdleMs
  while (true) {
    const turns = await safeCall(() => ops.activeTurns(), undefined)
    if (turns === undefined || turns === 0) return
    if (ops.now().getTime() >= deadline) return
    await safeSleep(ops, pollMs)
  }
}

async function waitForHealthy(ops: UpdaterOps, healthTimeoutMs: number, pollMs: number): Promise<boolean> {
  const deadline = ops.now().getTime() + healthTimeoutMs
  while (true) {
    if (await safeCall(() => ops.healthy(), false)) return true
    if (ops.now().getTime() >= deadline) return false
    await safeSleep(ops, pollMs)
  }
}

async function rollback(
  ops: UpdaterOps,
  previous: string | undefined,
  target: string,
  reason: 'start_failed' | 'unhealthy' | 'synthetic_turn_failed'
): Promise<UpdateResult> {
  if (previous !== undefined) {
    try {
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

export async function runUpdate(ops: UpdaterOps, config: UpdaterConfig): Promise<UpdateResult> {
  const pollMs = config.pollMs ?? 2000

  const release = await safeCall(() => ops.newestRelease(), undefined)
  if (release === undefined) {
    return { action: 'none', reason: 'no_release' }
  }

  const previous = await safeCall(() => ops.runningVersion(), undefined)
  if (previous !== undefined && !isNewer(release.version, previous)) {
    return { action: 'none', reason: 'up_to_date' }
  }

  if (release.manual) {
    await safeRecord(ops, {
      at: ops.now().toISOString(),
      from: previous,
      to: release.version,
      outcome: 'skipped_manual'
    })
    return { action: 'none', reason: 'manual_release' }
  }

  await waitForIdle(ops, config.waitForIdleMs, pollMs)

  if (previous !== undefined) {
    const snapped = await safeCall(() => ops.snapshot(), false)
    if (!snapped) {
      await safeRecord(ops, {
        at: ops.now().toISOString(),
        from: previous,
        to: release.version,
        outcome: 'failed_before_start',
        reason: 'snapshot_failed'
      })
      await safeAlert(ops, `Deploy of ${release.version} aborted: snapshot failed`)
      return { action: 'none', reason: 'snapshot_failed' }
    }
  }

  try {
    await ops.pull(release.version)
  } catch (err) {
    await safeRecord(ops, {
      at: ops.now().toISOString(),
      from: previous,
      to: release.version,
      outcome: 'failed_before_start',
      reason: 'pull_failed'
    })
    await safeAlert(ops, `Deploy of ${release.version} aborted: pull failed: ${errorMessage(err)}`)
    return { action: 'none', reason: 'pull_failed' }
  }

  try {
    await ops.start(release.version)
  } catch {
    return rollback(ops, previous, release.version, 'start_failed')
  }

  if (!(await waitForHealthy(ops, config.healthTimeoutMs, pollMs))) {
    return rollback(ops, previous, release.version, 'unhealthy')
  }

  if (!(await safeCall(() => ops.syntheticTurn(), false))) {
    return rollback(ops, previous, release.version, 'synthetic_turn_failed')
  }

  try {
    await ops.pruneImages(release.version, previous)
  } catch (err) {
    await safeAlert(ops, `Deploy of ${release.version} succeeded, but image prune failed: ${errorMessage(err)}`)
  }
  await safeRecord(ops, {
    at: ops.now().toISOString(),
    from: previous,
    to: release.version,
    outcome: 'deployed'
  })
  return { action: 'deployed', from: previous, to: release.version }
}
