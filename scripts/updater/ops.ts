import { type ChildProcess, type SpawnOptions, spawn } from 'node:child_process'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DeployRecord, Release, UpdaterOps } from './update.js'

/**
 * Shared pull budget across all attempts for one deploy. dev2 pulls at 1 to 2 MB/s (measured: 428 s, 554 s and 907 s
 * for three images), and the deploy job caps at 45 minutes, so a 20-minute budget covers full pulls while leaving
 * headroom for the rest of the deploy.
 */
export const DOCKER_PULL_BUDGET_MS = 20 * 60_000
/** The first attempt only. A fresh tag sometimes stalls on its first connection; a new attempt usually goes through. */
export const DOCKER_PULL_TIMEOUT_MS = 3 * 60_000
/** Maximum pull attempts sharing {@link DOCKER_PULL_BUDGET_MS}. */
export const DOCKER_PULL_ATTEMPTS = 3
export const DOCKER_TIMEOUT_MS = 90_000
export const KILL_GRACE_MS = 5_000
export const SYNTHETIC_TURN_TIMEOUT_MS = 60_000
/** Upper bound for one health or release fetch. Polling loops must never hang past their deadline. */
export const HEALTH_FETCH_TIMEOUT_MS = 10_000
export const RELEASE_FETCH_TIMEOUT_MS = 10_000

export interface RunOptions {
  timeoutMs?: number
  killGraceMs?: number
  signal?: AbortSignal
}

export interface RealOpsOptions {
  image: string
  repository: string
  composeFile: string
  service: string
  coreUrl: string
  /** The site API base URL. When set, healthy() also requires the site to be ready. */
  siteUrl?: string
  siteTokenFile?: string
  recordFile: string
  run?: (
    command: string,
    args: string[],
    env?: Record<string, string>,
    options?: RunOptions
  ) => Promise<{ code: number; stdout: string; stderr: string }>
  fetch?: typeof fetch
}

type RunFn = NonNullable<RealOpsOptions['run']>
export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess

interface HealthBody {
  status?: unknown
  activeTurns?: unknown
  snapshot?: {
    id?: unknown
    state?: unknown
  }
}

export function createSpawnRun(spawnFn: SpawnFn = spawn): RunFn {
  return (command, args, env, options) =>
    new Promise((resolve) => {
      let child: ChildProcess
      try {
        child = spawnFn(command, args, {
          env: env ? { ...process.env, ...env } : process.env,
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe']
        })
      } catch (err) {
        resolve({ code: 1, stdout: '', stderr: err instanceof Error ? err.message : String(err) })
        return
      }

      const stdoutChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []
      let settled = false
      let killTimer: ReturnType<typeof setTimeout> | undefined
      const graceMs = options?.killGraceMs ?? KILL_GRACE_MS

      const finish = (code: number, fallbackError?: string) => {
        if (settled) return
        settled = true
        if (killTimer !== undefined) clearTimeout(killTimer)
        options?.signal?.removeEventListener('abort', onAbort)
        const stdout = Buffer.concat(stdoutChunks).toString('utf8')
        const stderr = Buffer.concat(stderrChunks).toString('utf8')
        resolve({ code, stdout, stderr: stderr || fallbackError || '' })
      }

      const onAbort = () => {
        if (settled) return
        child.kill('SIGTERM')
        if (settled) return
        killTimer = setTimeout(() => {
          if (!settled) {
            child.kill('SIGKILL')
          }
        }, graceMs)
        killTimer.unref?.()
      }

      child.stdout?.on('data', (chunk: Buffer | string) => {
        stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      })
      child.stderr?.on('data', (chunk: Buffer | string) => {
        stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      })

      child.once('error', (error: NodeJS.ErrnoException) => {
        finish(1, error.message)
      })

      child.once('close', (code, signal) => {
        const exitCode = typeof code === 'number' ? code : signal ? 1 : 0
        finish(exitCode, signal ? `killed by ${signal}` : undefined)
      })

      if (options?.signal) {
        if (options.signal.aborted) {
          onAbort()
        } else {
          options.signal.addEventListener('abort', onAbort, { once: true })
        }
      }
    })
}

const defaultRun: RunFn = createSpawnRun()

function defaultCommandTimeoutMs(command: string, args: string[]): number {
  return command === 'docker' && args[0] === 'pull' ? DOCKER_PULL_TIMEOUT_MS : DOCKER_TIMEOUT_MS
}

export async function execChecked(
  run: RunFn,
  command: string,
  args: string[],
  env?: Record<string, string>,
  timeoutMs = defaultCommandTimeoutMs(command, args),
  killGraceMs = KILL_GRACE_MS
): Promise<string> {
  const controller = new AbortController()
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let forceRejectTimer: ReturnType<typeof setTimeout> | undefined

  const sub = args[0]
  const label = sub ? `${command} ${sub}` : command
  const duration = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`
  const timeoutError = () => new Error(`${label} timed out after ${duration}`)

  const runPromise = run(command, args, env, { timeoutMs, killGraceMs, signal: controller.signal })

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      controller.abort()
      // Fallback reject if an injected runner ignores signal and never settles.
      forceRejectTimer = setTimeout(() => {
        runPromise.catch(() => {})
        reject(timeoutError())
      }, killGraceMs + 100)
      forceRejectTimer.unref?.()
    }, timeoutMs)
  })

  try {
    let result: Awaited<ReturnType<RunFn>>
    try {
      result = await Promise.race([runPromise, timeoutPromise])
    } catch (err) {
      if (timedOut) {
        throw timeoutError()
      }
      throw err
    }
    if (timedOut) {
      throw timeoutError()
    }
    if (result.code !== 0) {
      throw new Error(result.stderr || `${command} exited with code ${result.code}`)
    }
    return result.stdout
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (forceRejectTimer !== undefined) clearTimeout(forceRejectTimer)
  }
}

function isManualBody(body: unknown): boolean {
  if (typeof body !== 'string') return false
  return body.split(/\r?\n/).some((line) => {
    const trimmed = line.trim().toLowerCase()
    return trimmed === 'manual' || trimmed.startsWith('manual:')
  })
}

function parseComposeTag(stdout: string): string | undefined {
  const trimmed = stdout.trim()
  if (trimmed.length === 0) return undefined
  let first: Record<string, unknown> | undefined
  try {
    if (trimmed.startsWith('[')) {
      const arr = JSON.parse(trimmed) as unknown
      if (Array.isArray(arr) && arr.length > 0 && typeof arr[0] === 'object' && arr[0] !== null) {
        first = arr[0] as Record<string, unknown>
      }
    } else {
      const firstLine = trimmed.split(/\r?\n/)[0]
      if (firstLine) {
        const parsed = JSON.parse(firstLine) as unknown
        if (typeof parsed === 'object' && parsed !== null) {
          first = parsed as Record<string, unknown>
        }
      }
    }
  } catch {
    return undefined
  }
  const tag = first?.['Tag'] ?? first?.['tag']
  if (typeof tag !== 'string' || tag.length === 0 || tag === '<none>') {
    return undefined
  }
  return tag
}

export async function verifyOwnerConsole(
  site: string,
  fetcher: typeof fetch,
  tokenFile = join(homedir(), '.hermes', 'brain', '.site-token')
) {
  const base = site.replace(/\/+$/, '')
  const load = (path: string, headers: Record<string, string> = {}) =>
    fetcher(base + path, { headers, signal: AbortSignal.timeout(HEALTH_FETCH_TIMEOUT_MS), redirect: 'error' })
  const entry = await fetcher(base + '/app/', {
    redirect: 'manual',
    signal: AbortSignal.timeout(HEALTH_FETCH_TIMEOUT_MS)
  })
  const page = entry.status === 302 && entry.headers.get('location') === '/overview' ? await load('/overview') : entry
  if (!page.ok || !(await page.text()).includes('/app/assets/')) return false
  const token = (await readFile(tokenFile, 'utf8')).trim()
  if (!token) return false
  const headers = { 'X-TolongAI-Token': token }
  const chats = await load('/api/chats', headers)
  if (!chats.ok || !Array.isArray(((await chats.json()) as { chats?: unknown }).chats)) return false
  const dash = await load('/owner-api/dashboard', headers)
  if (!dash.ok) return false
  const data = (await dash.json()) as { services?: unknown; recent?: unknown }
  return typeof data.services === 'object' && data.services !== null && Array.isArray(data.recent)
}

export function createRealOps(options: RealOpsOptions): UpdaterOps {
  const run = options.run ?? defaultRun
  const fetchFn = options.fetch ?? fetch
  const baseUrl = options.coreUrl.replace(/\/+$/, '')
  const siteUrl = options.siteUrl

  const readHealth = async (): Promise<HealthBody | undefined> => {
    try {
      const res = await fetchFn(`${baseUrl}/health`, { signal: AbortSignal.timeout(HEALTH_FETCH_TIMEOUT_MS) })
      if (!res.ok) return undefined
      const data = (await res.json()) as unknown
      return typeof data === 'object' && data !== null ? (data as HealthBody) : undefined
    } catch {
      return undefined
    }
  }

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  return {
    async newestRelease(): Promise<Release | undefined> {
      const res = await fetchFn(`https://api.github.com/repos/${options.repository}/releases/latest`, {
        headers: { accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(RELEASE_FETCH_TIMEOUT_MS)
      })
      if (res.status === 404) return undefined
      if (!res.ok) {
        throw new Error(`releases API returned ${res.status}`)
      }
      const data = (await res.json()) as { tag_name?: unknown; body?: unknown }
      if (typeof data.tag_name !== 'string' || data.tag_name.length === 0) return undefined
      return {
        tag: data.tag_name,
        version: data.tag_name.replace(/^v/, ''),
        manual: isManualBody(data.body)
      }
    },

    async runningVersion(): Promise<string | undefined> {
      const stdout = await execChecked(run, 'docker', [
        'compose',
        '-f',
        options.composeFile,
        'images',
        '--format',
        'json',
        options.service
      ])
      if (!stdout.trim() || stdout.trim() === '[]') return undefined
      const tag = parseComposeTag(stdout)
      if (tag && /^(?:sha-[a-f0-9]+|v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?|rollback-[a-f0-9]+)$/.test(tag)) return tag
      const container = (
        await execChecked(run, 'docker', ['compose', '-f', options.composeFile, 'ps', '-a', '-q', options.service])
      ).trim()
      if (!container) throw new Error('Cannot identify the current container')
      const image = (await execChecked(run, 'docker', ['inspect', '--format', '{{.Image}}', container])).trim()
      if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('Cannot identify rollback image')
      const pinned = 'rollback-' + image.slice(7, 23)
      await execChecked(run, 'docker', ['image', 'tag', image, options.image + ':' + pinned])
      return pinned
    },

    async activeTurns(): Promise<number | undefined> {
      const health = await readHealth()
      return typeof health?.activeTurns === 'number' ? health.activeTurns : undefined
    },

    async offlineSnapshot(): Promise<boolean> {
      const id = (
        await execChecked(run, 'docker', ['compose', '-f', options.composeFile, 'ps', '-a', '-q', options.service])
      ).trim()
      if (!id) return false
      const root = (
        await execChecked(run, 'docker', [
          'inspect',
          '--format',
          '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}',
          id
        ])
      ).trim()
      if (!root.startsWith('/')) return false
      await execChecked(
        run,
        'python3',
        [fileURLToPath(new URL('./offline-snapshot.py', import.meta.url)), root],
        undefined,
        120_000
      )
      return true
    },
    async snapshot(): Promise<boolean> {
      const before = await readHealth()
      // Without a readable baseline an old verified snapshot would look new. Fail instead of snapshotting blind.
      if (!before) return false
      const beforeId = typeof before.snapshot?.id === 'number' ? before.snapshot.id : 0
      await execChecked(run, 'docker', ['compose', '-f', options.composeFile, 'kill', '-s', 'SIGUSR2', options.service])
      const deadline = Date.now() + 60_000
      while (true) {
        const health = await readHealth()
        const snapId = health?.snapshot?.id
        const state = health?.snapshot?.state
        if (typeof snapId === 'number' && snapId > beforeId) {
          if (state === 'verified') return true
          if (state === 'failed') return false
        }
        if (Date.now() >= deadline) return false
        await sleep(1000)
      }
    },

    async pull(version: string): Promise<void> {
      // A locally built image has no registry tag. Pulling it would ask a registry that never held it.
      if (!options.image.includes('/')) {
        process.stdout.write(`deploy: pull skipped for local image ${options.image}:${version}\n`)
        return
      }
      const deadline = Date.now() + DOCKER_PULL_BUDGET_MS
      let lastError: unknown
      for (let attempt = 1; attempt <= DOCKER_PULL_ATTEMPTS; attempt += 1) {
        const remainingMs = deadline - Date.now()
        if (remainingMs <= 0) break
        // The first attempt is short, so a stalled first connection retries quickly; later ones get the time left.
        const timeoutMs = attempt === 1 ? Math.min(DOCKER_PULL_TIMEOUT_MS, remainingMs) : remainingMs
        try {
          await execChecked(run, 'docker', ['pull', `${options.image}:${version}`], undefined, timeoutMs)
          return
        } catch (error) {
          lastError = error
          if (attempt < DOCKER_PULL_ATTEMPTS && deadline - Date.now() > 0) {
            process.stdout.write(`deploy: pull attempt ${attempt} failed, retrying\n`)
          }
        }
      }
      throw lastError ?? new Error('docker pull budget exhausted')
    },

    async start(version: string): Promise<void> {
      await execChecked(run, 'docker', ['compose', '-f', options.composeFile, 'up', '-d', options.service], {
        AIRA_VERSION: version
      })
    },

    async healthy(): Promise<boolean> {
      const health = await readHealth()
      if (health?.status !== 'ready') return false
      if (siteUrl === undefined || siteUrl === '') return true
      try {
        const url = siteUrl.replace(/\/+$/, '') + '/api/health'
        const probe = (headers?: Record<string, string>) =>
          fetchFn(url, { headers, redirect: 'error', signal: AbortSignal.timeout(HEALTH_FETCH_TIMEOUT_MS) })
        let res = await probe()
        if (res.status === 401) {
          const token = (
            await readFile(options.siteTokenFile ?? join(homedir(), '.hermes', 'brain', '.site-token'), 'utf8')
          ).trim()
          if (!token) return false
          res = await probe({ 'X-TolongAI-Token': token })
        }
        if (!res.ok) return false
        const data = (await res.json()) as unknown
        return typeof data === 'object' && data !== null && (data as { status?: unknown }).status === 'ready'
      } catch {
        return false
      }
    },

    async ownerConsole(): Promise<boolean> {
      return !siteUrl || verifyOwnerConsole(siteUrl, fetchFn, options.siteTokenFile)
    },

    async syntheticTurn(): Promise<boolean> {
      try {
        // A router or auxiliary canned answer cannot satisfy the check. The image must record
        // delivery from the normal model turn branch in an isolated fixture.
        const out = await execChecked(
          run,
          'docker',
          [
            'compose',
            '-f',
            options.composeFile,
            'exec',
            '-T',
            options.service,
            'node',
            'dist/scripts/deploy-turn-probe.js'
          ],
          undefined,
          SYNTHETIC_TURN_TIMEOUT_MS
        )
        return out.trim().split('\n').at(-1) === 'deploy-turn-ok'
      } catch {
        return false
      }
    },

    async pruneImages(current: string, previous: string | undefined): Promise<void> {
      const stdout = await execChecked(run, 'docker', ['images', options.image, '--format', '{{.Tag}}'])
      const keep = new Set([current, 'stable'])
      if (previous !== undefined) keep.add(previous)
      const tags = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((tag) => tag.length > 0 && tag !== '<none>' && !keep.has(tag))
      for (const tag of tags) {
        await execChecked(run, 'docker', ['rmi', `${options.image}:${tag}`])
      }
    },

    async record(entry: DeployRecord): Promise<void> {
      await mkdir(dirname(options.recordFile), { recursive: true })
      await appendFile(options.recordFile, JSON.stringify(entry) + '\n', 'utf8')
    },

    async alert(message: string): Promise<void> {
      process.stderr.write(`ALERT: ${message}\n`)
    },

    sleep,

    now(): Date {
      return new Date()
    }
  }
}

/** The host lock that serialises the timer path with CI deploys. Both run on the host install folder. */
export function deployLockPath(composeFile: string): string {
  return join(dirname(composeFile), 'deploy.lock')
}

/** The site API base URL on the host: explicit env, else the install's .env, else loopback. */
export async function resolveSiteUrl(dir: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const fromEnv = env['AIRA_SITE_URL']
  if (fromEnv && fromEnv.trim() !== '') return fromEnv.trim()
  let text = ''
  try {
    text = await readFile(join(dir, '.env'), 'utf8')
  } catch {
    text = ''
  }
  const readKey = (key: string): string | undefined => {
    const line = text.split(/\r?\n/).find((candidate) => candidate.startsWith(`${key}=`))
    if (!line) return undefined
    let value = line.slice(key.length + 1).trim()
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1)
    return value === '' ? undefined : value
  }
  const bind = env['AIRA_SITE_BIND'] || readKey('AIRA_SITE_BIND') || '127.0.0.1'
  const port = env['AIRA_SITE_PORT'] || readKey('AIRA_SITE_PORT') || '9890'
  return `http://${bind}:${port}`
}

export interface DeployLock {
  release(): Promise<void>
}

/** Linux releases flock on process exit, even if a deployment is interrupted. */
export async function acquireDeployLock(lockPath: string): Promise<DeployLock | undefined> {
  await mkdir(dirname(lockPath), { recursive: true })
  const holder = spawn('flock', ['--exclusive', '--nonblock', lockPath, 'sh', '-c', 'printf ready; cat >/dev/null'], {
    stdio: ['pipe', 'pipe', 'ignore']
  })
  const exited = new Promise<number | null>((resolve, reject) => {
    holder.once('error', reject)
    holder.once('close', resolve)
  })
  const ready = await Promise.race([
    new Promise<boolean>((resolve) => holder.stdout.once('data', () => resolve(true))),
    exited.then((code) => {
      if (code !== 0 && code !== 1) throw new Error('Deploy lock unavailable')
      return false
    })
  ])
  if (!ready) return undefined
  return {
    async release() {
      holder.stdin.end()
      await exited
    }
  }
}

/** Waits up to timeoutMs for the host deploy lock. Returns undefined when the wait runs out. */
export async function waitForDeployLock(
  ops: { now(): Date; sleep(ms: number): Promise<void> },
  lockPath: string,
  timeoutMs: number,
  pollMs = 5000
): Promise<DeployLock | undefined> {
  const deadline = ops.now().getTime() + timeoutMs
  while (true) {
    const lock = await acquireDeployLock(lockPath)
    if (lock) return lock
    if (ops.now().getTime() >= deadline) return undefined
    await ops.sleep(pollMs)
  }
}
