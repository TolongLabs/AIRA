import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { z } from 'zod'
import type { ToolDefinition } from '../types.js'

const DEFAULT_SINCE_MIN = 30
const MAX_CHARS = 3000
const MAX_EDIT_FILES = 6
const MAX_LAST_TEXT = 280
const MAX_TOOLS = 5

const EDIT_TOOL_NAMES = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

const MEANS_ALL = new Set([
  'all',
  'all machines',
  'every machine',
  'every',
  'everything',
  'any',
  'both',
  '*',
  'all of them',
  'everywhere',
  'from all machines',
  'all my machines',
  'all of my machines',
  'my machines',
  'all devices',
  'all my devices',
  'both machines',
  'any machine',
  'every one',
  'all of the machines',
  'everyone'
])

const LEADING_WORDS = ['my ', 'the ', 'this ', 'that ', 'on ', 'from ']
const POSSESSIVE_SUFFIXES = ["'s", '\u2019s', "s'"]

interface ParsedSession {
  path: string
  cwd: string
  branch?: string
  title?: string
  sessionId?: string
  entrypoint?: string
  model?: string
  firstTs?: string
  lastTs?: string
  tools: Record<string, number>
  files: string[]
  lastText?: string
  lastUser?: string
  turns: number
  mtimeMs: number
}

interface RouteRow {
  machine?: unknown
  target?: unknown
  enabled?: unknown
  [key: string]: unknown
}

interface RoutesDoc {
  routes?: unknown
  [key: string]: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function parseSession(filePath: string): ParsedSession | null {
  let raw: string
  let mtimeMs: number
  try {
    raw = readFileSync(filePath, 'utf8')
    mtimeMs = statSync(filePath).mtimeMs
  } catch {
    return null
  }

  let cwd: string | undefined
  let branch: string | undefined
  let title: string | undefined
  let sessionId: string | undefined
  let entrypoint: string | undefined
  let model: string | undefined
  let firstTs: string | undefined
  let lastTs: string | undefined
  let lastText: string | undefined
  let lastUser: string | undefined
  let turns = 0
  const tools: Record<string, number> = {}
  const files: string[] = []

  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue

    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(parsed)) continue

    const ts = asNonEmptyString(parsed.timestamp)
    if (ts) {
      firstTs = firstTs ?? ts
      lastTs = ts
    }

    cwd = asNonEmptyString(parsed.cwd) ?? cwd
    branch = asNonEmptyString(parsed.gitBranch) ?? branch
    sessionId = asNonEmptyString(parsed.sessionId) ?? sessionId
    entrypoint = asNonEmptyString(parsed.entrypoint) ?? entrypoint

    const entryType = asNonEmptyString(parsed.type)
    if (entryType === 'ai-title') {
      const aiTitle = asNonEmptyString(parsed.aiTitle)
      if (aiTitle) title = aiTitle
      continue
    }

    const msg = parsed.message
    if (!isRecord(msg)) continue
    model = asNonEmptyString(msg.model) ?? model
    const content = msg.content

    if (entryType === 'assistant') {
      turns += 1
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (!isRecord(block)) continue
        if (block.type === 'tool_use') {
          const name = asNonEmptyString(block.name) ?? '?'
          tools[name] = (tools[name] ?? 0) + 1
          const input = isRecord(block.input) ? block.input : undefined
          const fp = input ? (asNonEmptyString(input.file_path) ?? asNonEmptyString(input.notebook_path)) : undefined
          if (fp && EDIT_TOOL_NAMES.has(name)) files.push(fp)
        } else if (block.type === 'text') {
          const text = asNonEmptyString(block.text)
          if (text) lastText = text.trim()
        }
      }
    } else if (entryType === 'user') {
      if (typeof content === 'string' && content.trim()) {
        lastUser = content.trim()
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (isRecord(block) && block.type === 'text') {
            const text = asNonEmptyString(block.text)
            if (text) lastUser = text.trim()
          }
        }
      }
    }
  }

  if (!cwd) return null
  return {
    path: filePath,
    cwd,
    branch,
    title,
    sessionId,
    entrypoint,
    model,
    firstTs,
    lastTs,
    tools,
    files,
    lastText,
    lastUser,
    turns,
    mtimeMs
  }
}

function collectSessions(projectsDir: string, project?: string): ParsedSession[] {
  if (!existsSync(projectsDir)) return []
  let slugs: string[]
  try {
    slugs = readdirSync(projectsDir)
  } catch {
    return []
  }

  const out: ParsedSession[] = []
  const projectNeedle = project?.toLowerCase()

  for (const slug of slugs) {
    const slugDir = join(projectsDir, slug)
    try {
      if (!statSync(slugDir).isDirectory()) continue
    } catch {
      continue
    }

    let files: string[]
    try {
      files = readdirSync(slugDir)
    } catch {
      continue
    }

    for (const fileName of files) {
      if (!fileName.endsWith('.jsonl')) continue
      const session = parseSession(join(slugDir, fileName))
      if (!session) continue
      if (projectNeedle && !session.cwd.toLowerCase().includes(projectNeedle)) continue
      out.push(session)
    }
  }

  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return out
}

function formatAgo(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`
  return `${Math.floor(s / 86400)}d ago`
}

function renderSessions(sessions: ParsedSession[], sinceMinutes: number, nowMs: number): string {
  if (sessions.length === 0) return 'No Claude Code sessions found.'

  const lines: string[] = []
  for (const s of sessions) {
    const idleSec = Math.max(0, (nowMs - s.mtimeMs) / 1000)
    const live = idleSec < sinceMinutes * 60
    const repoName = basename(s.cwd.replace(/\/+$/, '')) || s.cwd
    lines.push(`${live ? '🟢 ACTIVE' : '⚪ idle'}  ${repoName}`)
    if (s.title) lines.push(`   ${s.title}`)

    const meta: string[] = []
    if (s.branch) meta.push(`branch ${s.branch}`)
    if (s.entrypoint) meta.push(s.entrypoint)
    if (s.model) meta.push(s.model)
    meta.push(`last activity ${formatAgo(idleSec)}`)
    lines.push(`   ${meta.join(' · ')}`)

    const toolEntries = Object.entries(s.tools).sort((a, b) => b[1] - a[1])
    if (toolEntries.length > 0) {
      const top = toolEntries
        .slice(0, MAX_TOOLS)
        .map(([k, v]) => `${k} ${v}`)
        .join(', ')
      lines.push(`   ${s.turns} turns · ${top}`)
    }

    const uniqFiles = [...new Set(s.files)]
    if (uniqFiles.length > 0) {
      const prefix = `${s.cwd.replace(/\/+$/, '')}/`
      const rel = uniqFiles.map((f) => (f.startsWith(prefix) ? f.slice(prefix.length) : f))
      const shown = rel.slice(0, MAX_EDIT_FILES).join(', ')
      const more = rel.length > MAX_EDIT_FILES ? ` (+${rel.length - MAX_EDIT_FILES} more)` : ''
      lines.push(`   edited ${rel.length}: ${shown}${more}`)
    }

    if (s.lastText) {
      const snippet = s.lastText.replace(/\s+/g, ' ').trim().slice(0, MAX_LAST_TEXT)
      lines.push(`   last said: ${snippet}`)
    }
    lines.push('')
  }

  let text = lines.join('\n').trimEnd()
  if (text.length > MAX_CHARS) {
    text = `${text.slice(0, MAX_CHARS).trimEnd()}\n… (truncated)`
  }
  return text
}

function isLocalMachineName(name: string): boolean {
  const normalized = name.trim().toLowerCase()
  if (!normalized) return true
  const localNames = new Set(['this', 'local', 'localhost', hostname().toLowerCase()])
  return localNames.has(normalized)
}

function resolveMachine(known: string[], want: string): string {
  const normalized = want.trim().toLowerCase()
  if (!normalized) return ''

  const lows = new Map<string, string>()
  for (const m of known) {
    if (m) lows.set(m.toLowerCase(), m)
  }

  const exact = lows.get(normalized)
  if (exact) return exact

  let bare = normalized
  let stripped = true
  while (stripped) {
    stripped = false
    for (const lead of LEADING_WORDS) {
      if (bare.startsWith(lead)) {
        bare = bare.slice(lead.length).trim()
        stripped = true
      }
    }
  }
  for (const suffix of POSSESSIVE_SUFFIXES) {
    if (bare.endsWith(suffix)) {
      bare = bare.slice(0, -suffix.length).trim()
      break
    }
  }

  const bareExact = lows.get(bare)
  if (bareExact) return bareExact
  if (bare.length < 3) return ''

  const hits: string[] = []
  for (const [low, orig] of lows.entries()) {
    if (low.includes(bare) || bare.includes(low)) hits.push(orig)
  }
  return hits.length === 1 ? (hits[0] ?? '') : ''
}

function readRoutesDoc(routesFile: string): { ok: true; doc: RoutesDoc } | { ok: false } {
  if (!existsSync(routesFile)) {
    return { ok: true, doc: { routes: [] } }
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(routesFile, 'utf8'))
    if (!isRecord(parsed)) return { ok: false }
    return { ok: true, doc: parsed }
  } catch {
    return { ok: false }
  }
}

function writeJsonAtomic(filePath: string, data: unknown): void {
  const dir = dirname(filePath)
  const tmp = join(dir, `.${basename(filePath)}.${randomBytes(6).toString('hex')}.tmp`)
  const content = `${JSON.stringify(data, null, 2)}\n`
  try {
    writeFileSync(tmp, content, 'utf8')
    renameSync(tmp, filePath)
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {
      // ignore cleanup failure
    }
    throw err
  }
}

function chatRowsForTarget(doc: RoutesDoc, target: string, machineFilter?: string): RouteRow[] {
  const routes = Array.isArray(doc.routes) ? doc.routes : []
  const out: RouteRow[] = []
  for (const row of routes) {
    if (!isRecord(row)) continue
    const rowTarget = typeof row.target === 'string' ? row.target.trim() : ''
    const rowMachine = typeof row.machine === 'string' ? row.machine.trim() : ''
    if (rowTarget !== target || !rowMachine) continue
    if (machineFilter && rowMachine !== machineFilter) continue
    out.push(row)
  }
  return out
}

function machineStates(rows: RouteRow[]): Map<string, boolean> {
  const byMachine = new Map<string, boolean>()
  for (const row of rows) {
    const machine = typeof row.machine === 'string' ? row.machine.trim() : ''
    if (!machine) continue
    const prev = byMachine.get(machine) ?? false
    byMachine.set(machine, prev || Boolean(row.enabled))
  }
  return byMachine
}

function summarizeMachines(rows: RouteRow[]): { machine: string; on: boolean }[] {
  const states = machineStates(rows)
  return [...states.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([machine, on]) => ({ machine, on }))
}

const claudeSessionsSchema = z.strictObject({
  project: z.string().trim().max(200).optional(),
  active_only: z.boolean().optional(),
  since_minutes: z.number().int().optional(),
  machine: z.string().trim().max(100).optional()
})

const sessionNoticesSchema = z.strictObject({
  op: z.enum(['on', 'off', 'status']),
  machine: z.string().trim().max(100).optional()
})

function claudeSessionsTool(
  projectsDir: string,
  nowOverride?: () => Date
): ToolDefinition<z.infer<typeof claudeSessionsSchema>> {
  return {
    name: 'claude_sessions',
    description:
      'What Claude Code is doing on this host right now — which sessions are running, in which repo, on which branch, and how long since each one did anything. Not for turning session notices on or off: that is session_notices.',
    schema: claudeSessionsSchema,
    mode: 'both',
    mutates: false,
    feature: 'features.owner',
    handler(args, context) {
      if (args.machine && !isLocalMachineName(args.machine)) {
        return {
          ok: true,
          data: {
            sessions: 0,
            remoteUnsupported: true,
            machine: args.machine,
            text: `Only sessions on this host can be checked right now; remote machine '${args.machine}' is not queried.`
          }
        }
      }

      const since = Math.max(1, Math.min(args.since_minutes ?? DEFAULT_SINCE_MIN, 60 * 24))
      const activeOnly = args.active_only ?? true
      const project = args.project || undefined
      const nowMs = (nowOverride ?? context.now)().getTime()

      let sessions = collectSessions(projectsDir, project)
      if (activeOnly) {
        const cutoffMs = since * 60 * 1000
        sessions = sessions.filter((s) => nowMs - s.mtimeMs < cutoffMs)
      }

      if (sessions.length === 0) {
        const where = project ? ` in ${project}` : ''
        const window = activeOnly ? ` in the last ${since} minutes` : ''
        return {
          ok: true,
          data: {
            sessions: 0,
            text: `No Claude Code session${where} has done anything${window} on this machine.`,
            note: 'Only this host was checked.'
          }
        }
      }

      return {
        ok: true,
        data: {
          sessions: sessions.length,
          text: renderSessions(sessions, since, nowMs),
          note: "Answer from this. 'last activity' is how long ago it wrote anything."
        }
      }
    }
  }
}

function sessionNoticesTool(routesFile: string): ToolDefinition<z.infer<typeof sessionNoticesSchema>> {
  return {
    name: 'session_notices',
    description:
      'Turn Claude Code session notices that arrive in this chat on or off, or report what they are set to. Affects only this chat.',
    schema: sessionNoticesSchema,
    mode: 'both',
    mutates: true,
    feature: 'features.owner',
    handler(args, context) {
      const target = context.chat.waId.trim()
      if (!target) {
        return { ok: false, kind: 'refused', reason: 'chat has no WhatsApp id' }
      }

      const initial = readRoutesDoc(routesFile)
      if (!initial.ok) {
        return { ok: false, kind: 'error', reason: 'could not read notice routes' }
      }

      const mine = chatRowsForTarget(initial.doc, target)
      if (mine.length === 0) {
        return {
          ok: true,
          data: {
            changed: false,
            now: 'unrouted',
            notices: [],
            note: 'No machine sends session notices to this chat, so there is nothing to turn on or off.'
          }
        }
      }

      const known = [...new Set(mine.map((r) => (typeof r.machine === 'string' ? r.machine.trim() : '')))].sort()
      let wantMachine = (args.machine ?? '').trim()
      if (MEANS_ALL.has(wantMachine.toLowerCase())) wantMachine = ''

      let picked = ''
      if (wantMachine) {
        picked = resolveMachine(known, wantMachine)
        if (!picked) {
          return {
            ok: false,
            kind: 'invalid',
            reason: `nothing called '${wantMachine}' reports to this chat; known machines: ${known.join(', ')}`
          }
        }
      }

      const selected = picked ? mine.filter((r) => String(r.machine).trim() === picked) : mine
      if (args.op === 'status') {
        const notices = summarizeMachines(selected)
        return {
          ok: true,
          data: {
            changed: false,
            notices,
            note: 'Report this as it is. Do not turn anything on or off unless asked.'
          }
        }
      }

      const enabled = args.op === 'on'
      try {
        const { data } = context.commit(() => {
          const latest = readRoutesDoc(routesFile)
          if (!latest.ok) {
            throw new Error('could not read notice routes')
          }
          const doc = latest.doc
          const routes = Array.isArray(doc.routes) ? doc.routes : []
          const beforeRows = chatRowsForTarget(doc, target, picked || undefined)
          const was = machineStates(beforeRows)

          for (const row of routes) {
            if (!isRecord(row)) continue
            const rowTarget = typeof row.target === 'string' ? row.target.trim() : ''
            const rowMachine = typeof row.machine === 'string' ? row.machine.trim() : ''
            if (rowTarget !== target || !rowMachine) continue
            if (picked && rowMachine !== picked) continue
            row.enabled = enabled
          }

          const afterRows = chatRowsForTarget(doc, target, picked || undefined)
          const after = machineStates(afterRows)
          const changed = [...after.entries()]
            .filter(([machine, isOn]) => was.has(machine) && was.get(machine) !== isOn)
            .map(([machine]) => machine)
            .sort()
          const machinesAlreadySet = [...after.keys()].filter((m) => !changed.includes(m)).sort()

          if (changed.length > 0) {
            writeJsonAtomic(routesFile, doc)
          }

          const notices = summarizeMachines(afterRows)
          return {
            data: {
              changed: changed.length > 0,
              now: enabled ? 'on' : 'off',
              machines_changed: changed,
              machines_already_set: machinesAlreadySet,
              notices,
              note:
                changed.length > 0
                  ? `Updated ${changed.join(', ')} to ${enabled ? 'on' : 'off'}.`
                  : 'Nothing changed — they were already set that way.'
            },
            receipt: {
              kind: enabled ? 'session_notices.on' : 'session_notices.off',
              target: context.chat.chatId,
              state: {
                now: enabled ? 'on' : 'off',
                machinesChanged: changed,
                machinesAlreadySet
              }
            }
          }
        })
        return { ok: true, data }
      } catch {
        return { ok: false, kind: 'error', reason: 'could not update notice routes' }
      }
    }
  }
}

export function claudeTools(options: {
  projectsDir?: string
  routesFile?: string
  now?: () => Date
}): ToolDefinition[] {
  const tools: ToolDefinition[] = []
  const projectsDir = options.projectsDir?.trim()
  const routesFile = options.routesFile?.trim()

  if (projectsDir) {
    tools.push(claudeSessionsTool(projectsDir, options.now) as ToolDefinition)
  }
  if (routesFile) {
    // Atomic tools: one reads the setting, one changes it (docs/trd/tools.md#atomic-tools).
    const notices = sessionNoticesTool(routesFile).handler
    const machine = { machine: z.string().trim().max(100).optional() }
    tools.push(
      {
        name: 'session_notices_status',
        description: 'Report whether Claude Code session notices arrive in this chat.',
        schema: z.strictObject(machine),
        mode: 'both',
        mutates: false,
        feature: 'features.owner',
        handler: (args: { machine?: string }, context) => notices({ ...args, op: 'status' }, context)
      } as ToolDefinition,
      {
        name: 'session_notices_set',
        description: 'Turn Claude Code session notices in this chat on or off. Affects only this chat.',
        schema: z.strictObject({ enabled: z.boolean(), ...machine }),
        mode: 'both',
        mutates: true,
        feature: 'features.owner',
        handler: ({ enabled, ...rest }: { enabled: boolean; machine?: string }, context) =>
          notices({ ...rest, op: enabled ? 'on' : 'off' }, context)
      } as ToolDefinition
    )
  }

  return tools
}
