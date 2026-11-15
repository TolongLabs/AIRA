import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'
import { isoNow } from '../storage/database.js'
import type { ChatSession } from './chat.js'

export interface BenchSet {
  name: string
  description: string
  prompts: string[]
}

const benchSetSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string(),
  prompts: z
    .array(z.string().refine((s) => s.trim().length > 0, 'prompt must be non-empty'))
    .min(1)
    .max(50)
})

export function loadBenchSet(path: string): BenchSet {
  let source: string
  try {
    source = readFileSync(path, 'utf8')
  } catch (cause) {
    throw new Error(`cannot read bench set ${path}: ${(cause as Error).message}`)
  }
  let raw: unknown
  try {
    raw = parse(source)
  } catch (cause) {
    throw new Error(`bench set ${path} is not valid YAML: ${(cause as Error).message}`)
  }
  const result = benchSetSchema.safeParse(raw)
  if (!result.success) {
    const lines = result.error.issues.map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    throw new Error(`bench set ${path} is invalid:\n${lines.join('\n')}`)
  }
  return result.data
}

export interface BenchRow {
  set: string
  index: number
  ms: number
  state: string
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  costUsd: number
  toolCalls: number
  model: string
  transport: string
}

export interface BenchSummary {
  count: number
  delivered: number
  p50Ms: number
  p90Ms: number
  costUsd: number
  costPerTurnUsd: number
  cacheHitRate: number | null
  toolTurns: number
}

export interface BenchResult {
  startedAt: string
  set: string
  transport: string
  rows: BenchRow[]
  summary: BenchSummary
}

function nearestRank(sorted: readonly number[], percentile: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1))
  return sorted[index] ?? 0
}

export function summarise(rows: readonly BenchRow[]): BenchSummary {
  const count = rows.length
  const deliveredMs = rows
    .filter((row) => row.state === 'delivered')
    .map((row) => row.ms)
    .sort((a, b) => a - b)

  let costUsd = 0
  let inputTokens = 0
  let cachedTokens = 0
  let toolTurns = 0
  for (const row of rows) {
    costUsd += row.costUsd
    inputTokens += row.inputTokens
    cachedTokens += row.cachedTokens
    if (row.toolCalls > 0) toolTurns += 1
  }

  return {
    count,
    delivered: deliveredMs.length,
    p50Ms: nearestRank(deliveredMs, 50),
    p90Ms: nearestRank(deliveredMs, 90),
    costUsd,
    costPerTurnUsd: count > 0 ? costUsd / count : 0,
    cacheHitRate: inputTokens > 0 ? cachedTokens / inputTokens : null,
    toolTurns
  }
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

export async function runBench(options: {
  set: BenchSet
  session: ChatSession
  transport: string
  now?: () => Date
}): Promise<BenchResult> {
  const now = options.now ?? (() => new Date())
  const startedAt = isoNow(now)
  const rows: BenchRow[] = []

  for (const [index, prompt] of options.set.prompts.entries()) {
    const start = performance.now()
    try {
      const reply = await options.session.send(prompt)
      const turn = reply.turn
      const toolCalls =
        'toolCalls' in reply && typeof reply.toolCalls === 'number' ? reply.toolCalls : num(turn?.['tool_calls'])
      rows.push({
        set: options.set.name,
        index,
        ms: reply.ms,
        state: str(turn?.['state'], 'failed'),
        inputTokens: num(turn?.['input_tokens']),
        outputTokens: num(turn?.['output_tokens']),
        cachedTokens: num(turn?.['cached_tokens']),
        costUsd: num(turn?.['cost_usd']),
        toolCalls,
        model: str(turn?.['model']),
        transport: str(turn?.['transport'], options.transport)
      })
    } catch {
      rows.push({
        set: options.set.name,
        index,
        ms: Math.round(performance.now() - start),
        state: 'failed',
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        costUsd: 0,
        toolCalls: 0,
        model: '',
        transport: options.transport
      })
    }
  }

  return {
    startedAt,
    set: options.set.name,
    transport: options.transport,
    rows,
    summary: summarise(rows)
  }
}

/** Writes one result as JSON lines (one row per line, then one summary line with "summary": true) and returns the file path. */
export function writeBenchResult(dir: string, result: BenchResult): string {
  mkdirSync(dir, { recursive: true })
  const compact = result.startedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  const filePath = join(dir, `${compact}-${result.set}.jsonl`)
  const lines = result.rows.map((row) => JSON.stringify(row))
  lines.push(
    JSON.stringify({
      summary: true,
      startedAt: result.startedAt,
      set: result.set,
      transport: result.transport,
      ...result.summary
    })
  )
  writeFileSync(filePath, lines.join('\n') + '\n', 'utf8')
  return filePath
}

export function formatBenchSummary(result: BenchResult): string {
  const s = result.summary
  const cache = s.cacheHitRate === null ? 'n/a' : `${(s.cacheHitRate * 100).toFixed(1)}%`
  return [
    `bench ${result.set} (${result.transport}): ${s.delivered}/${s.count} delivered`,
    `latency: p50=${s.p50Ms}ms p90=${s.p90Ms}ms`,
    `cost: total=$${s.costUsd.toFixed(4)} per-turn=$${s.costPerTurnUsd.toFixed(4)} cache=${cache}`,
    `tool turns: ${s.toolTurns}`
  ].join('\n')
}
