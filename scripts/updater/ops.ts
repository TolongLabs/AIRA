import { type ChildProcess, type SpawnOptions, spawn } from 'node:child_process'
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { DeployRecord, Release, UpdaterOps } from './update.js'

/**
 * Shared pull budget across all attempts for one deploy. dev2 pulls at 1 to 2 MB/s (measured: 428 s, 554 s and 907 s
 * for three images), and the deploy job caps at 30 minutes, so a 20-minute budget covers full pulls while leaving
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
  if (typeof tag !== 'string' || tag.length === 0 || tag === 'stable' || tag === '<none>') {
    return undefined
  }
  return tag
}

export function createRealOps(options: RealOpsOptions): UpdaterOps {
  const run = options.run ?? defaultRun
  const fetchFn = options.fetch ?? fetch
  const baseUrl = options.coreUrl.replace(/\/+$/, '')

  const readHealth = async (): Promise<HealthBody | undefined> => {
    try {
      const res = await fetchFn(`${baseUrl}/health`)
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
        headers: { accept: 'application/vnd.github+json' }
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
      return parseComposeTag(stdout)
    },

    async activeTurns(): Promise<number | undefined> {
      const health = await readHealth()
      return typeof health?.activeTurns === 'number' ? health.activeTurns : undefined
    },

    async snapshot(): Promise<boolean> {
      const before = await readHealth()
      const beforeId = typeof before?.snapshot?.id === 'number' ? before.snapshot.id : 0
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
      return health?.status === 'ready'
    },

    async syntheticTurn(): Promise<boolean> {
      try {
        const res = await fetchFn(`${baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            messages: [{ role: 'user', content: 'deploy check' }],
            stream: false
          }),
          signal: AbortSignal.timeout(SYNTHETIC_TURN_TIMEOUT_MS)
        })
        if (res.status !== 200) return false
        const data = (await res.json()) as {
          choices?: { message?: { content?: unknown } }[]
        }
        const content = data.choices?.[0]?.message?.content
        return typeof content === 'string' && content.trim().length > 0
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
