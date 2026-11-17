import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { loadConfig } from '../src/config/loader.js'
import { openReader } from '../src/storage/database.js'
import { type ResticRunner, buildResticEnv, createSecretScrubber, defaultResticRun } from '../src/storage/offsite.js'

// Restores an off-host restic snapshot into an empty folder, checks SQLite integrity, and prints row counts
// (docs/trd/storage.md#snapshots-and-the-off-host-copy).

export interface RestoreOptions {
  to: string
  snapshot?: string
  repository?: string
  configPath?: string
  env?: NodeJS.ProcessEnv
  run?: ResticRunner
}

export interface RestoreReport {
  snapshotId: string
  snapshotTime: string
  database: string
  counts: { table: string; rows: number }[]
}

interface SnapshotSummary {
  id?: unknown
  time?: unknown
}

function ensureEmptyTarget(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    return
  }
  if (!statSync(dir).isDirectory()) {
    throw new Error(`restore target is not a directory: ${dir}`)
  }
  if (readdirSync(dir).length > 0) {
    throw new Error(`restore target folder is not empty: ${dir}`)
  }
}

function findDatabases(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      found.push(...findDatabases(fullPath))
    } else if (entry.isFile() && entry.name.endsWith('.db')) {
      found.push(fullPath)
    }
  }
  return found.sort().reverse()
}

function parseSnapshotMetadata(stdout: string): { id: string; time: string } {
  const parsed = JSON.parse(stdout) as unknown
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('no matching restic snapshot found')
  }
  const sorted = (parsed as SnapshotSummary[])
    .filter(
      (item): item is { id: string; time: string } => typeof item.id === 'string' && typeof item.time === 'string'
    )
    .sort((a, b) => Date.parse(b.time) - Date.parse(a.time))
  const newest = sorted[0]
  if (!newest) throw new Error('restic snapshot output did not include id and time')
  return newest
}

export async function restoreOffsite(options: RestoreOptions): Promise<RestoreReport> {
  ensureEmptyTarget(options.to)

  const env = options.env ?? process.env
  const scrub = createSecretScrubber(env)
  const run = options.run ?? defaultResticRun
  const repository =
    options.repository ||
    env['RESTIC_REPOSITORY'] ||
    loadConfig(options.configPath ?? env['AIRA_CONFIG'] ?? 'config.yml').backup.offsite.repository ||
    ''
  if (!repository)
    throw new Error('no offsite repository configured (set RESTIC_REPOSITORY or backup.offsite.repository)')
  const password = env['AIRA_BACKUP_PASSWORD'] || env['RESTIC_PASSWORD']
  if (!password) throw new Error('AIRA_BACKUP_PASSWORD or RESTIC_PASSWORD is not set')

  const kind = repository.startsWith('s3:') ? 's3' : repository.startsWith('rest:') ? 'rest' : 'all'
  const childEnv = buildResticEnv(repository, kind, env, password)

  const listArgs =
    options.snapshot && options.snapshot !== 'latest'
      ? ['snapshots', '--json', options.snapshot]
      : ['snapshots', '--json', '--latest', '1']
  const listRes = await run('restic', listArgs, childEnv)
  if (listRes.code !== 0) {
    throw new Error(scrub(`restic snapshots failed (code ${listRes.code}): ${listRes.stderr || listRes.stdout}`))
  }
  const snapshot = parseSnapshotMetadata(listRes.stdout)

  const restoreRes = await run('restic', ['restore', snapshot.id, '--target', options.to], childEnv)
  if (restoreRes.code !== 0) {
    throw new Error(scrub(`restic restore failed (code ${restoreRes.code}): ${restoreRes.stderr || restoreRes.stdout}`))
  }

  const dbs = findDatabases(options.to)
  const dbPath = dbs.find((path) => /^aira-.*\.db$/.test(basename(path))) ?? dbs[0]
  if (!dbPath) throw new Error(`no restored database file found in ${options.to}`)

  const db = openReader(dbPath)
  try {
    const integrity = db.pragma('integrity_check') as { integrity_check: string }[]
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
      throw new Error(`integrity_check failed: ${integrity.map((row) => row.integrity_check).join('; ')}`)
    }
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .pluck()
      .all() as string[]
    const counts = tables.map((table) => ({
      table,
      rows: db
        .prepare(`SELECT count(*) FROM "${table.replace(/"/g, '""')}"`)
        .pluck()
        .get() as number
    }))
    return { snapshotId: snapshot.id, snapshotTime: snapshot.time, database: dbPath, counts }
  } finally {
    db.close()
  }
}

export function formatRestoreReport(report: RestoreReport): string {
  const lines = [
    `snapshot: ${report.snapshotId}`,
    `time: ${report.snapshotTime}`,
    `database: ${report.database}`,
    'integrity_check: ok',
    'tables:'
  ]
  for (const { table, rows } of report.counts) {
    lines.push(`  ${table}: ${rows}`)
  }
  return lines.join('\n')
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain) {
  const { values } = parseArgs({
    options: {
      to: { type: 'string' },
      snapshot: { type: 'string' },
      config: { type: 'string' }
    }
  })
  if (!values.to) {
    process.stderr.write('usage: restore-offsite --to <empty folder> [--snapshot <id>]\n')
    process.exit(2)
  }
  const report = await restoreOffsite({
    to: values.to,
    ...(values.snapshot ? { snapshot: values.snapshot } : {}),
    ...(values.config ? { configPath: values.config } : {})
  })
  process.stdout.write(`${formatRestoreReport(report)}\n`)
}
