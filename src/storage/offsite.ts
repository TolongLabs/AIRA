import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import type { Config } from '../config/schema.js'
import type { Logger } from '../records/logger.js'
import { type Redactor, createRedactor } from '../records/redact.js'
import type { AlertKind } from '../turn/alerts.js'
import { type Storage, isoNow } from './database.js'
import { insertFailure } from './failures.js'
import { dataPaths } from './startup.js'

// Encrypted off-host backup shipper and repository checks (docs/trd/storage.md#snapshots-and-the-off-host-copy).

const HOUR_MS = 3_600_000
const MAX_BUFFER_BYTES = 10 * 1024 * 1024
const RESTIC_TIMEOUT_MS = 10 * 60_000
const MAX_DETAIL_CHARS = 2000

const OFFSITE_SECRET_KEYS = [
  'AIRA_BACKUP_PASSWORD',
  'RESTIC_PASSWORD',
  'RESTIC_REST_PASSWORD',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY'
] as const

export interface ResticResult {
  code: number
  stdout: string
  stderr: string
}

export type ResticRunner = (command: string, args: string[], env: NodeJS.ProcessEnv) => Promise<ResticResult>

export interface OffsiteAlerter {
  raise(kind: AlertKind | 'backup_stale', detail: Record<string, unknown>): boolean
}

export interface OffsiteOptions {
  config: Pick<Config, 'backup' | 'storage'>
  env: NodeJS.ProcessEnv
  run?: ResticRunner
  storage: Storage
  alerter: OffsiteAlerter
  logger: Logger
  now?: () => Date
}

export interface Offsite {
  ship(snapshotFile: string): Promise<void>
  check(): Promise<void>
  checkStale(): void
  start(): () => Promise<void>
}

export const defaultResticRun: ResticRunner = (command, args, env) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      { env, maxBuffer: MAX_BUFFER_BYTES, timeout: RESTIC_TIMEOUT_MS },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stdout, stderr })
          return
        }
        const code = typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1
        resolve({ code, stdout, stderr: stderr || error.message })
      }
    )
  })

/** Builds an isolated environment for restic so secrets only cross via process environment, never argv. */
export function buildResticEnv(
  repository: string,
  kind: 'rest' | 's3' | 'all',
  env: NodeJS.ProcessEnv,
  password: string | undefined = env['AIRA_BACKUP_PASSWORD']
): NodeJS.ProcessEnv {
  const tmp = env['TMPDIR'] || tmpdir()
  const childEnv: NodeJS.ProcessEnv = {
    PATH: env['PATH'] ?? process.env['PATH'] ?? '',
    TMPDIR: tmp,
    RESTIC_CACHE_DIR: env['RESTIC_CACHE_DIR'] || join(tmp, 'restic-cache'),
    RESTIC_REPOSITORY: repository
  }
  const home = env['HOME'] ?? process.env['HOME']
  if (home) childEnv['HOME'] = home
  if (password) childEnv['RESTIC_PASSWORD'] = password

  if (kind === 'rest' || kind === 'all') {
    if (env['RESTIC_REST_USERNAME']) childEnv['RESTIC_REST_USERNAME'] = env['RESTIC_REST_USERNAME']
    if (env['RESTIC_REST_PASSWORD']) childEnv['RESTIC_REST_PASSWORD'] = env['RESTIC_REST_PASSWORD']
  }
  if (kind === 's3' || kind === 'all') {
    if (env['AWS_ACCESS_KEY_ID']) childEnv['AWS_ACCESS_KEY_ID'] = env['AWS_ACCESS_KEY_ID']
    if (env['AWS_SECRET_ACCESS_KEY']) childEnv['AWS_SECRET_ACCESS_KEY'] = env['AWS_SECRET_ACCESS_KEY']
  }
  return childEnv
}

export function createSecretScrubber(env: NodeJS.ProcessEnv): (text: string) => string {
  const redactor: Redactor = createRedactor({
    secrets: Object.values(env).filter((value): value is string => typeof value === 'string' && value !== '')
  })
  const directSecrets = [
    ...new Set(
      OFFSITE_SECRET_KEYS.map((key) => env[key]).filter(
        (value): value is string => typeof value === 'string' && value.length > 0
      )
    )
  ].sort((a, b) => b.length - a.length)

  return (text: string): string => {
    let out = redactor.scrub(text)
    for (const secret of directSecrets) out = out.split(secret).join('[secret]')
    return out
  }
}

function isRepoMissing(result: ResticResult): boolean {
  if (result.code === 10) return true
  const combined = `${result.stdout}\n${result.stderr}`
  return /does not exist|is there a repository|unable to open config file|config file does not exist/i.test(combined)
}

function formatResticError(prefix: string, result: ResticResult): string {
  const detail = (result.stderr || result.stdout).trim()
  return detail ? `${prefix} (code ${result.code}): ${detail}` : `${prefix} (code ${result.code})`
}

function parseBackupSummary(stdout: string): { bytes: number | null; detail: string | null } {
  const lines = stdout.trim().split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim()
    if (!line) continue
    try {
      const parsed = JSON.parse(line) as {
        message_type?: unknown
        snapshot_id?: unknown
        total_bytes_processed?: unknown
      }
      if (parsed.message_type === 'summary') {
        const bytes =
          typeof parsed.total_bytes_processed === 'number' && Number.isFinite(parsed.total_bytes_processed)
            ? Math.trunc(parsed.total_bytes_processed)
            : null
        const detail = typeof parsed.snapshot_id === 'string' ? `snapshot ${parsed.snapshot_id.slice(0, 12)}` : null
        return { bytes, detail }
      }
    } catch {
      // Ignore non-JSON progress lines.
    }
  }
  return { bytes: null, detail: null }
}

export function createOffsite(options: OffsiteOptions): Offsite {
  const offsite = options.config.backup.offsite
  if (offsite.kind === 'off') {
    return {
      ship: async () => {},
      check: async () => {},
      checkStale: () => {},
      start: () => async () => {}
    }
  }

  const kind = offsite.kind
  const repository = offsite.repository ?? ''
  const run = options.run ?? defaultResticRun
  const now = options.now ?? (() => new Date())
  const paths = dataPaths(options.config.storage.path)
  const scrub = createSecretScrubber(options.env)
  const startedAtMs = now().getTime()

  let initialized = false
  let staleAlerted = false
  let inFlight: Promise<void> = Promise.resolve()

  const serialize = (work: () => Promise<void>): Promise<void> => {
    const next = inFlight.then(work, work)
    inFlight = next.catch(() => {})
    return next
  }

  const recordRun = (
    reason: 'offsite' | 'check',
    state: 'ok' | 'failed',
    file: string,
    startedAt: Date,
    info: { bytes?: number | null; detail?: string | null }
  ): void => {
    const endedIso = isoNow(now)
    const detail = info.detail ? scrub(info.detail).slice(0, MAX_DETAIL_CHARS) : null
    options.storage.tx((db) => {
      db.prepare(
        'INSERT INTO backup_run (reason, state, file, bytes, detail, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(reason, state, file, info.bytes ?? null, detail, startedAt.toISOString(), endedIso)
      if (state === 'failed') {
        insertFailure(
          db,
          {
            stage: 'offsite',
            kind: 'backup_failed',
            message: detail ?? `offsite ${reason} failed`,
            handledBy: 'offsite'
          },
          now
        )
      }
    })
  }

  const prepareEnv = (): NodeJS.ProcessEnv => {
    if (!repository) throw new Error('backup.offsite.repository is not set')
    if (!options.env['AIRA_BACKUP_PASSWORD']) throw new Error('AIRA_BACKUP_PASSWORD is not set')
    return buildResticEnv(repository, kind, options.env)
  }

  const ensureInitialized = async (childEnv: NodeJS.ProcessEnv): Promise<void> => {
    if (initialized) return
    const catResult = await run('restic', ['cat', 'config'], childEnv)
    if (catResult.code === 0) {
      initialized = true
      return
    }
    if (!isRepoMissing(catResult)) {
      throw new Error(formatResticError('restic cat config failed', catResult))
    }
    const initResult = await run('restic', ['init'], childEnv)
    if (initResult.code !== 0) {
      throw new Error(formatResticError('restic init failed', initResult))
    }
    initialized = true
  }

  const checkStale = (): void => {
    try {
      const lastOk = options.storage.read(
        (db) =>
          db
            .prepare(
              `SELECT COALESCE(ended_at, started_at) FROM backup_run
               WHERE reason = 'offsite' AND state = 'ok'
               ORDER BY COALESCE(ended_at, started_at) DESC, id DESC LIMIT 1`
            )
            .pluck()
            .get() as string | undefined
      )
      const referenceMs = lastOk ? Date.parse(lastOk) : startedAtMs
      const staleMs = offsite.staleAlertMin * 60_000
      const ageMs = now().getTime() - referenceMs
      if (ageMs < staleMs) {
        staleAlerted = false
        return
      }
      if (!staleAlerted) {
        staleAlerted = true
        options.alerter.raise('backup_stale', {
          ageMin: Math.floor(ageMs / 60_000),
          staleAlertMin: offsite.staleAlertMin
        })
      }
    } catch (error) {
      const message = scrub(error instanceof Error ? error.message : String(error))
      options.logger.error('storage.offsite_stale_check_failed', { detail: message })
    }
  }

  const ship = (snapshotFile: string): Promise<void> =>
    serialize(async () => {
      const startedAt = now()
      const snapshotPath = isAbsolute(snapshotFile) ? snapshotFile : join(paths.snapshots, snapshotFile)
      const fileLabel = basename(snapshotPath)
      try {
        const childEnv = prepareEnv()
        await ensureInitialized(childEnv)
        const targets = [snapshotPath, paths.files, paths.archive].filter((path) => existsSync(path))
        if (targets.length === 0) throw new Error('no backup paths exist')
        const result = await run('restic', ['backup', '--json', '--tag', 'aira', ...targets], childEnv)
        if (result.code !== 0) {
          if (isRepoMissing(result)) initialized = false
          throw new Error(formatResticError('restic backup failed', result))
        }
        const summary = parseBackupSummary(result.stdout)
        recordRun('offsite', 'ok', fileLabel, startedAt, summary)
        staleAlerted = false
        options.logger.info('storage.offsite', { file: fileLabel })
      } catch (error) {
        const safeMessage = scrub(error instanceof Error ? error.message : String(error))
        try {
          recordRun('offsite', 'failed', fileLabel, startedAt, { detail: safeMessage })
        } catch (recordError) {
          const safeRecordError = scrub(recordError instanceof Error ? recordError.message : String(recordError))
          options.logger.error('storage.offsite_record_failed', { detail: safeRecordError })
        }
        options.logger.error('storage.offsite_failed', { file: fileLabel, detail: safeMessage })
      } finally {
        checkStale()
      }
    })

  const check = (): Promise<void> =>
    serialize(async () => {
      const minGapMs = offsite.checkEveryHours * HOUR_MS
      const lastCheck = options.storage.read(
        (db) =>
          db
            .prepare(
              `SELECT COALESCE(ended_at, started_at) FROM backup_run
               WHERE reason = 'check'
               ORDER BY COALESCE(ended_at, started_at) DESC, id DESC LIMIT 1`
            )
            .pluck()
            .get() as string | undefined
      )
      if (lastCheck && now().getTime() - Date.parse(lastCheck) < minGapMs) return

      const startedAt = now()
      try {
        const childEnv = prepareEnv()
        const result = await run('restic', ['check'], childEnv)
        if (result.code !== 0) {
          throw new Error(formatResticError('restic check failed', result))
        }
        recordRun('check', 'ok', '', startedAt, { detail: result.stdout.trim() || null })
        options.logger.info('storage.offsite_check', {})
      } catch (error) {
        const safeMessage = scrub(error instanceof Error ? error.message : String(error))
        try {
          recordRun('check', 'failed', '', startedAt, { detail: safeMessage })
        } catch (recordError) {
          const safeRecordError = scrub(recordError instanceof Error ? recordError.message : String(recordError))
          options.logger.error('storage.offsite_record_failed', { detail: safeRecordError })
        }
        options.logger.error('storage.offsite_check_failed', { detail: safeMessage })
      }
    })

  const start = (): (() => Promise<void>) => {
    const timer = setInterval(() => {
      checkStale()
      void check()
    }, HOUR_MS)
    timer.unref()
    return async () => {
      clearInterval(timer)
      await inFlight
    }
  }

  return { ship, check, checkStale, start }
}
