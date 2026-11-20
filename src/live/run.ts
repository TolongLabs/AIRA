import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'
import type { ChatSession } from '../bench/chat.js'
import { fourthWallBreak } from '../format/fourth-wall.js'
import { isoNow } from '../storage/database.js'

// Live checks (docs/trd/harness.md#live-checks): fixed cases against real models, before a release.

export interface LiveCase {
  prompt: string
  expect?: { tools?: string[]; noTools?: boolean }
}

export interface LiveSet {
  name: string
  description: string
  cases: LiveCase[]
}

const nonEmpty = z.string().refine((s) => s.trim().length > 0, 'must be non-empty')

const caseSchema = z.strictObject({
  prompt: nonEmpty,
  expect: z
    .strictObject({
      tools: z.array(nonEmpty).min(1).optional(),
      noTools: z.literal(true).optional()
    })
    .refine((e) => !(e.tools && e.noTools), 'expect takes tools or noTools, not both')
    .optional()
})

const setSchema = z.strictObject({
  name: z.string().trim().min(1),
  description: z.string(),
  cases: z.array(caseSchema).min(1).max(50)
})

export function loadLiveSet(path: string): LiveSet {
  let source: string
  try {
    source = readFileSync(path, 'utf8')
  } catch (cause) {
    throw new Error(`cannot read live set ${path}: ${(cause as Error).message}`)
  }
  let raw: unknown
  try {
    raw = parse(source)
  } catch (cause) {
    throw new Error(`live set ${path} is not valid YAML: ${(cause as Error).message}`)
  }
  const result = setSchema.safeParse(raw)
  if (!result.success) {
    const lines = result.error.issues.map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    throw new Error(`live set ${path} is invalid:\n${lines.join('\n')}`)
  }
  return result.data as LiveSet
}

const SELF_AS_MACHINE =
  /\b(?:i am|i'm|im|as)\s+(?:an?\s+|just\s+an?\s+|only\s+an?\s+)?(?:ai|a\.i\.|artificial intelligence|(?:large\s+)?language model|llm|bot|chatbot|virtual assistant|ai assistant|assistant)\b/i
const SELF_AS_HUMAN = /\b(?:i am|i'm|im)\s+(?:a\s+)?(?:real\s+)?(?:human|real person)\b/i
const HEADING = /^\s{0,3}#{1,6}\s/m
const TABLE = /^\s*\|.*\|\s*$/m
const LINK_TEXT = /\[[^\]\n]+\]\([^)\s]+\)/

/** The persona checks every delivered reply must pass. Returns the names of the checks it failed. */
export function personaFailures(reply: string, maxChars: number, toolNames: readonly string[] = []): string[] {
  const failed: string[] = []
  const text = reply.trim()
  if (text === '' || text === 'NO_REPLY') {
    failed.push('empty')
    return failed
  }
  if (SELF_AS_MACHINE.test(text)) failed.push('names-itself-ai')
  if (SELF_AS_HUMAN.test(text)) failed.push('claims-human')
  if (HEADING.test(text)) failed.push('heading')
  if (TABLE.test(text)) failed.push('table')
  if (LINK_TEXT.test(text)) failed.push('link-text')
  if (fourthWallBreak(text, toolNames) !== undefined) failed.push('breaks-fourth-wall')
  if ([...text].length > maxChars) failed.push('too-long')
  return failed
}

export interface LiveRow {
  set: string
  index: number
  ms: number
  state: string
  tools: string[]
  passed: boolean
  failed: string[]
}

export interface LiveResult {
  startedAt: string
  set: string
  rows: LiveRow[]
  summary: { count: number; passed: number; failed: number }
}

export async function runLive(options: {
  set: LiveSet
  session: ChatSession
  maxChars: number
  now?: () => Date
  /** The registry's tool names for the fourth-wall check. Absent: the session's own. */
  toolNames?: readonly string[]
}): Promise<LiveResult> {
  const startedAt = isoNow(options.now ?? (() => new Date()))
  const rows: LiveRow[] = []
  const toolNames = options.toolNames ?? options.session.toolNames ?? []

  for (const [index, item] of options.set.cases.entries()) {
    const start = performance.now()
    let row: LiveRow
    try {
      const reply = await options.session.send(item.prompt)
      const state = typeof reply.turn?.['state'] === 'string' ? reply.turn['state'] : 'failed'
      const failed: string[] = []
      if (state !== 'delivered') failed.push('not-delivered')
      const expected = item.expect?.tools
      if (expected && !reply.tools.some((tool) => expected.includes(tool))) failed.push('tool-not-called')
      if (item.expect?.noTools && reply.tools.length > 0) failed.push('tool-called')
      if (state === 'delivered') {
        failed.push(...personaFailures(reply.content, options.maxChars, toolNames))
      }
      row = {
        set: options.set.name,
        index,
        ms: reply.ms,
        state,
        tools: reply.tools,
        passed: failed.length === 0,
        failed
      }
    } catch {
      const ms = Math.round(performance.now() - start)
      row = { set: options.set.name, index, ms, state: 'failed', tools: [], passed: false, failed: ['error'] }
    }
    rows.push(row)
  }

  const passed = rows.filter((row) => row.passed).length
  return {
    startedAt,
    set: options.set.name,
    rows,
    summary: { count: rows.length, passed, failed: rows.length - passed }
  }
}

/** Writes one result as JSON lines (one row per case, then one summary line with "summary": true). */
export function writeLiveResult(dir: string, result: LiveResult): string {
  mkdirSync(dir, { recursive: true })
  const compact = result.startedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  const filePath = join(dir, `${compact}-live-${result.set}.jsonl`)
  const lines = result.rows.map((row) => JSON.stringify(row))
  lines.push(JSON.stringify({ summary: true, startedAt: result.startedAt, set: result.set, ...result.summary }))
  writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8')
  return filePath
}

export function formatLiveSummary(result: LiveResult): string {
  const lines = [`live ${result.set}: ${result.summary.passed}/${result.summary.count} passed`]
  for (const row of result.rows) {
    if (!row.passed)
      lines.push(`  case ${row.index}: ${row.failed.join(', ')} (tools: ${row.tools.join(', ') || 'none'})`)
  }
  return lines.join('\n')
}
