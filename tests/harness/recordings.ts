import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import {
  type ModelClient,
  ModelError,
  type ModelFailureKind,
  type ModelRequest,
  type ModelResponse
} from '../../src/models/types.js'

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : canonicalize(item)))
  }
  const obj = value as Record<string, unknown>
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(obj).sort()) {
    const entry = obj[key]
    if (entry !== undefined) sorted[key] = canonicalize(entry)
  }
  return sorted
}

function requestShape(request: ModelRequest): Record<string, unknown> {
  return {
    role: request.role,
    model: request.model,
    system: request.system,
    messages: request.messages,
    tools: request.tools,
    params: request.params
  }
}

/** A stable hash of a request: role, model, system blocks, messages, tools and params. Key order does not matter. */
export function hashRequest(request: ModelRequest): string {
  const canonical = canonicalize(requestShape(request))
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

export interface RecordingEntry {
  request: ModelRequest
  response?: ModelResponse
  error?: { kind: ModelFailureKind; message: string }
}

export class RecordingMissError extends Error {
  override name = 'RecordingMissError'
}

export interface RecordingClient {
  client: ModelClient
  /** How many calls reached the real model. Always 0 in replay mode. */
  liveCalls(): number
  /** Hashes that were stored but never requested in this run. */
  unused(): string[]
  /** Record mode: writes the file. Replay mode: does nothing. */
  save(): void
}

interface RecordingFile {
  version: 1
  entries: Record<string, RecordingEntry>
}

function prettyRequestLines(request: ModelRequest): string[] {
  return JSON.stringify(canonicalize(requestShape(request)), null, 2).split('\n')
}

function countSharedLines(a: string[], b: string[]): number {
  const counts = new Map<string, number>()
  for (const line of a) counts.set(line, (counts.get(line) ?? 0) + 1)
  let shared = 0
  for (const line of b) {
    const count = counts.get(line) ?? 0
    if (count > 0) {
      shared++
      counts.set(line, count - 1)
    }
  }
  return shared
}

function diffLines(stored: string[], requested: string[]): string {
  const m = stored.length
  const n = requested.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))

  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i]![j] = stored[i] === requested[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }

  const out: string[] = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (stored[i] === requested[j]) {
      out.push(`  ${stored[i]}`)
      i++
      j++
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push(`- ${stored[i]}`)
      i++
    } else {
      out.push(`+ ${requested[j]}`)
      j++
    }
  }
  while (i < m) {
    out.push(`- ${stored[i]}`)
    i++
  }
  while (j < n) {
    out.push(`+ ${requested[j]}`)
    j++
  }
  return out.join('\n')
}

function formatMissMessage(hash: string, request: ModelRequest, entries: Record<string, RecordingEntry>): string {
  const values = Object.values(entries)
  if (values.length === 0) {
    return `Recording miss for ${hash}: recording is empty`
  }

  const reqLines = prettyRequestLines(request)
  let bestLines = prettyRequestLines(values[0]!.request)
  let bestScore = countSharedLines(bestLines, reqLines)

  for (let i = 1; i < values.length; i++) {
    const candidateLines = prettyRequestLines(values[i]!.request)
    const score = countSharedLines(candidateLines, reqLines)
    if (score > bestScore) {
      bestScore = score
      bestLines = candidateLines
    }
  }

  return `Recording miss for ${hash}:\n${diffLines(bestLines, reqLines)}`
}

export function createRecordingClient(options: {
  mode: 'record' | 'replay'
  file: string
  inner?: ModelClient
}): RecordingClient {
  if (options.mode === 'record' && !options.inner) {
    throw new Error('createRecordingClient in record mode requires an inner ModelClient')
  }

  const entries: Record<string, RecordingEntry> = existsSync(options.file)
    ? ((JSON.parse(readFileSync(options.file, 'utf8')) as RecordingFile).entries ?? {})
    : {}

  const requestedHashes = new Set<string>()
  let liveCallCount = 0

  const client: ModelClient = {
    async call(request, signal) {
      const hash = hashRequest(request)
      requestedHashes.add(hash)

      if (options.mode === 'record') {
        liveCallCount++
        try {
          const response = await options.inner!.call(request, signal)
          entries[hash] = { request, response }
          return response
        } catch (err) {
          if (err instanceof ModelError) {
            entries[hash] = {
              request,
              error: { kind: err.kind, message: err.message }
            }
          }
          throw err
        }
      }

      const entry = entries[hash]
      if (!entry) {
        throw new RecordingMissError(formatMissMessage(hash, request, entries))
      }
      if (entry.error) {
        throw new ModelError(entry.error.kind, entry.error.message)
      }
      if (!entry.response) {
        throw new RecordingMissError(`Recording entry for ${hash} has neither response nor error`)
      }
      return entry.response
    }
  }

  return {
    client,
    liveCalls() {
      return liveCallCount
    },
    unused() {
      return Object.keys(entries).filter((hash) => !requestedHashes.has(hash))
    },
    save() {
      if (options.mode === 'replay') return
      const dir = dirname(options.file)
      mkdirSync(dir, { recursive: true })
      const payload = `${JSON.stringify(canonicalize({ version: 1, entries }), null, 2)}\n`
      const tmp = join(dir, `.${basename(options.file)}.${randomBytes(6).toString('hex')}.tmp`)
      writeFileSync(tmp, payload, 'utf8')
      renameSync(tmp, options.file)
    }
  }
}
