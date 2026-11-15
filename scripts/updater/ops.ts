import { execFile } from 'node:child_process'
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { DeployRecord, Release, UpdaterOps } from './update.js'

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
    env?: Record<string, string>
  ) => Promise<{ code: number; stdout: string; stderr: string }>
  fetch?: typeof fetch
}

type RunFn = NonNullable<RealOpsOptions['run']>

interface HealthBody {
  status?: unknown
  activeTurns?: unknown
  snapshot?: {
    id?: unknown
    state?: unknown
  }
}

const defaultRun: RunFn = (command, args, env) =>
  new Promise((resolve) => {
    execFile(command, args, { env: env ? { ...process.env, ...env } : process.env }, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ code: 0, stdout, stderr })
        return
      }
      const code = typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1
      resolve({ code, stdout, stderr: stderr || error.message })
    })
  })

async function execChecked(run: RunFn, command: string, args: string[], env?: Record<string, string>): Promise<string> {
  const result = await run(command, args, env)
  if (result.code !== 0) {
    throw new Error(result.stderr || `${command} exited with code ${result.code}`)
  }
  return result.stdout
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
      await execChecked(run, 'docker', ['pull', `${options.image}:${version}`])
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
          })
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
