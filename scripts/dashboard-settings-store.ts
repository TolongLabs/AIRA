import { createHmac, randomBytes } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { parseDocument } from 'yaml'
import { credentialPurposes, hostConfigFields } from '../src/config/dashboard-settings.js'
import type { HostSettingsSnapshot } from '../src/config/dashboard-types.js'
import { parseConfig, requireDeployable } from '../src/config/loader.js'

export class SettingsError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}
const invalid = () => new SettingsError(400, 'Invalid settings change')
export type RouterStatus = HostSettingsSnapshot['router']
type Change =
  | { revision: string; group: string; changes: Record<string, unknown> }
  | { revision: string; credential: string; replacement: string }
type FileName = 'config.yml' | '.env'
interface Pending {
  revision: string
  prepare?: { before: string; file: FileName }
  files: FileName[]
  phase: 'pending' | 'applying' | 'restored' | 'failed'
}

/** Replace on one filesystem, with private permissions, before acknowledging a save. */
function replace(path: string, content: string) {
  const tmp = path + '.' + randomBytes(12).toString('hex') + '.tmp'
  try {
    const fd = openSync(tmp, 'wx', 0o600)
    try {
      writeFileSync(fd, content)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, path)
    const parent = openSync(dirname(path), 'r')
    try {
      fsyncSync(parent)
    } finally {
      closeSync(parent)
    }
  } finally {
    rmSync(tmp, { force: true })
  }
}

// Scan logical Compose assignments so text inside a quoted multiline value is never treated as another key.
function assignments(text: string) {
  const entries: { key: string; start: number; end: number; present: boolean }[] = []
  let start = 0
  while (start < text.length) {
    let end = text.indexOf('\n', start)
    if (end < 0) end = text.length
    const match = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z_0-9]*)[ \t]*=[ \t]*/.exec(text.slice(start, end))
    if (match) {
      const from = start + match[0].length
      const quote = text[from]
      let present = false
      if (quote === '"' || quote === "'") {
        let i = from + 1
        while (i < text.length && text[i] !== quote) {
          if (text[i] === '\\' && (text[i + 1] === quote || text[i + 1] === '\\')) i++
          i++
        }
        if (i === text.length) throw new SettingsError(409, 'The installed secret file has an unterminated quote')
        present = i > from + 1
        end = text.indexOf('\n', i + 1)
        if (end < 0) end = text.length
      } else
        present =
          text
            .slice(from, end)
            .replace(/\s+#.*$/, '')
            .trim().length > 0
      entries.push({ key: match[1]!, start, end, present })
    }
    start = end + 1
  }
  return entries
}
function updateCredential(text: string, key: string, value: string) {
  if (
    !Object.hasOwn(credentialPurposes, key) ||
    Array.from(value).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
    value.length > 16384
  )
    throw invalid()
  // Compose expands double-quoted values. Escape interpolation and quoted control characters.
  const escaped = value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('$', () => '$$')
  const line = key + '="' + escaped + '"'
  const matches = assignments(text).filter((e) => e.key === key)
  if (matches.length > 1) throw new SettingsError(409, 'Remove duplicate entries for this credential on the host')
  const entry = matches[0]
  if (!entry) return text + (text.length && !text.endsWith('\n') ? '\n' : '') + line + '\n'
  return text.slice(0, entry.start) + line + text.slice(entry.end)
}

function checkRoutes(
  parsed: ReturnType<typeof parseConfig>,
  next: ReturnType<typeof parseConfig>,
  router: RouterStatus
) {
  for (const role of ['main', 'fallback'] as const) {
    const key = role === 'main' ? 'transport' : 'fallbackTransport'
    if (
      next.llm[key] === 'api' &&
      next.llm[role].provider === 'aira-router' &&
      (parsed.llm[key] !== 'api' || parsed.llm[role].provider !== 'aira-router') &&
      !router.legacy?.available
    )
      throw new SettingsError(409, router.legacy?.status ?? 'AIRA router unavailable')
  }
  if (
    ((next.llm.transport === 'subscription' && parsed.llm.transport !== 'subscription') ||
      (next.llm.fallbackTransport === 'subscription' && parsed.llm.fallbackTransport !== 'subscription')) &&
    !router.available
  )
    throw new SettingsError(409, router.status)
}

export class DashboardSettingsStore {
  readonly dir: string
  constructor(
    readonly root: string,
    readonly signingKey: Buffer
  ) {
    this.dir = join(root, '.dashboard-settings')
  }
  private revision(config: string, env: string) {
    return createHmac('sha256', this.signingKey).update(config).update('\0').update(env).digest('hex')
  }
  private pending(): Pending | undefined {
    const path = join(this.dir, 'state.json')
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Pending) : undefined
  }
  private setState(value: Pending) {
    replace(join(this.dir, 'state.json'), JSON.stringify(value))
  }
  private files() {
    return {
      config: readFileSync(join(this.root, 'config.yml'), 'utf8'),
      env: readFileSync(join(this.root, '.env'), 'utf8')
    }
  }
  recoverPrepared() {
    const state = this.pending()
    if (!state?.prepare) return
    const { config, env } = this.files()
    const revision = this.revision(config, env)
    if (revision === state.prepare.before) {
      const candidate = readFileSync(join(this.dir, 'pending.write'), 'utf8')
      const after = this.revision(
        state.prepare.file === 'config.yml' ? candidate : config,
        state.prepare.file === '.env' ? candidate : env
      )
      if (after !== state.revision) throw new SettingsError(409, 'Pending settings could not be verified')
      replace(join(this.root, state.prepare.file), candidate)
    } else if (revision !== state.revision)
      throw new SettingsError(409, 'Installed files changed during a pending save')
    delete state.prepare
    this.setState(state)
    rmSync(join(this.dir, 'pending.write'), { force: true })
  }
  snapshot(router: RouterStatus): HostSettingsSnapshot {
    const { config, env } = this.files()
    const entries = new Map(assignments(env).map((e) => [e.key, e.present]))
    return {
      revision: this.revision(config, env),
      state: this.pending()?.phase ?? 'current',
      router,
      fields: hostConfigFields(parseConfig(config)),
      credentials: Object.entries(credentialPurposes).map(([name, purpose]) => ({
        name,
        purpose,
        present: entries.get(name) ?? false
      }))
    }
  }
  save(input: Change, router: RouterStatus) {
    this.recoverPrepared()
    const { config, env } = this.files()
    if (input.revision !== this.revision(config, env))
      throw new SettingsError(409, 'Settings changed. Refresh before saving.')
    let state = this.pending()
    if (state?.phase === 'applying' || state?.phase === 'failed')
      throw new SettingsError(409, 'Finish applying or recovering the pending changes first')
    if (state?.phase === 'pending' && state.revision !== input.revision)
      throw new SettingsError(409, 'Installed files changed outside the pending edit. Reconcile on the host.')
    let name: FileName
    let content: string
    if ('credential' in input) {
      if (typeof input.credential !== 'string' || typeof input.replacement !== 'string') throw invalid()
      name = '.env'
      content = updateCredential(env, input.credential, input.replacement)
    } else {
      name = 'config.yml'
      if (
        typeof input.group !== 'string' ||
        !input.changes ||
        typeof input.changes !== 'object' ||
        Array.isArray(input.changes) ||
        !Object.keys(input.changes).length
      )
        throw invalid()
      const parsed = parseConfig(config)
      const fields = hostConfigFields(parsed)
      if (!Object.hasOwn(fields, input.group)) throw invalid()
      const allowed = fields[input.group]!
      const doc = parseDocument(config)
      for (const [path, value] of Object.entries(input.changes)) {
        if (!Object.hasOwn(allowed, path)) throw invalid()
        const kind = allowed[path]!.kind
        if (kind === 'list' ? !Array.isArray(value) : typeof value !== kind) throw invalid()
        doc.setIn(
          [input.group, ...path.split('.')],
          input.group === 'media' && path === 'watcher.model' && value === '' ? null : value
        )
      }
      content = doc.toString()
      try {
        const next = parseConfig(content)
        requireDeployable(next)
        checkRoutes(parsed, next, router)
      } catch (error) {
        if (error instanceof SettingsError) throw error
        throw new SettingsError(
          400,
          'Configuration failed validation. Check the field types, values and routing choices.'
        )
      }
    }
    if (content === (name === '.env' ? env : config)) return
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    if (!state || state.phase === 'restored') state = { phase: 'pending', revision: input.revision, files: [] }
    if (!state.files.includes(name)) {
      replace(join(this.dir, name + '.previous'), name === '.env' ? env : config)
      state.files.push(name)
    }
    // Persist the intent before the change. A retry after a process exit can reconcile either file revision.
    state.phase = 'pending'
    state.revision = this.revision(name === 'config.yml' ? content : config, name === '.env' ? content : env)
    state.prepare = { before: input.revision, file: name }
    replace(join(this.dir, 'pending.write'), content)
    this.setState(state)
    this.recoverPrepared()
  }
  checkPendingRoutes(router: RouterStatus) {
    const state = this.pending()
    if (state?.phase !== 'pending' || !state.files.includes('config.yml')) return
    checkRoutes(
      parseConfig(readFileSync(join(this.dir, 'config.yml.previous'), 'utf8')),
      parseConfig(this.files().config),
      router
    )
  }
  pendingForApply(expected: string) {
    this.recoverPrepared()
    const state = this.pending()
    if (!state || state.phase === 'restored') return
    const { config, env } = this.files()
    if (expected !== this.revision(config, env) || state.revision !== expected)
      throw new SettingsError(409, 'Settings changed. Refresh before applying.')
    return state
  }
  async apply(expected: string, recreate: () => Promise<void>) {
    const state = this.pendingForApply(expected)
    if (!state) return
    state.phase = 'applying'
    this.setState(state)
    try {
      await recreate()
    } catch {
      for (const name of state.files)
        replace(join(this.root, name), readFileSync(join(this.dir, name + '.previous'), 'utf8'))
      try {
        await recreate()
      } catch {
        state.phase = 'failed'
        const restored = this.files()
        state.revision = this.revision(restored.config, restored.env)
        this.setState(state)
        throw new SettingsError(503, 'Recovery needs attention on the host')
      }
      state.phase = 'restored'
      state.files = []
      this.setState(state)
      for (const name of ['config.yml', '.env']) rmSync(join(this.dir, name + '.previous'), { force: true })
      throw new SettingsError(409, 'The core did not become healthy. The previous settings were restored.')
    }
    rmSync(join(this.dir, 'state.json'), { force: true })
    for (const name of state.files) rmSync(join(this.dir, name + '.previous'), { force: true })
  }
}
