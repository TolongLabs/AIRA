import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { openDatabase, openReader } from '../src/storage/database.js'
import { applyMigrations, planMigrations, readMigrations } from '../src/storage/migrate.js'
import { takeSnapshot } from '../src/storage/snapshot.js'
import {
  applyLibraryImport,
  formatLibraryReport,
  planLibraryImport,
  previewLibraryImport
} from '../src/tools/lessons/import.js'

// One-time library migration (docs/trd/tools.md#library-migration). Run with the core stopped or idle.
//   bun run migrate:library --from <folder> --db <file>           dry run
//   bun run migrate:library --from <folder> --db <file> --apply   real run

export interface CliResult {
  exitCode: number
  stdout: string
  stderr: string
}

export async function runMigrateLibraryCli(args: string[]): Promise<CliResult> {
  let values: { from?: string; db?: string; apply: boolean }
  try {
    values = parseArgs({
      args,
      options: { from: { type: 'string' }, db: { type: 'string' }, apply: { type: 'boolean', default: false } }
    }).values
  } catch (error) {
    return { exitCode: 2, stdout: '', stderr: `${(error as Error).message}\n` }
  }

  if (!values.from || !values.db) {
    return { exitCode: 2, stdout: '', stderr: 'usage: migrate:library --from <folder> --db <file> [--apply]\n' }
  }

  try {
    const from = resolve(values.from)
    const dbPath = resolve(values.db)
    const plan = planLibraryImport(from)

    if (!values.apply) {
      let report = plan.report
      if (existsSync(dbPath)) {
        const reader = openReader(dbPath)
        try {
          report = previewLibraryImport(reader, plan)
        } finally {
          reader.close()
        }
      }
      return { exitCode: 0, stdout: `${formatLibraryReport(report)}\n`, stderr: '' }
    }

    mkdirSync(dirname(dbPath), { recursive: true })
    const migrations = readMigrations()
    const storage = openDatabase(dbPath)
    try {
      const migrationPlan = planMigrations(storage, migrations)
      if (migrationPlan.pending.length < migrations.length) {
        const snapshot = await takeSnapshot(storage, join(dirname(dbPath), 'snapshots'), 'migration')
        if (snapshot.state !== 'verified') {
          throw new Error(`no verified snapshot before the migration: ${snapshot.detail ?? 'unknown fault'}`)
        }
      }
      applyMigrations(storage, migrations)
      const report = applyLibraryImport(storage, plan)
      return { exitCode: 0, stdout: `${formatLibraryReport(report)}\n`, stderr: '' }
    } finally {
      storage.close()
    }
  } catch (error) {
    return { exitCode: 1, stdout: '', stderr: `${(error as Error).message}\n` }
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain) {
  const result = await runMigrateLibraryCli(process.argv.slice(2))
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  process.exit(result.exitCode)
}
