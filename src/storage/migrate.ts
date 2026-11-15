import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Storage, StorageError, isoNow } from './database.js'

// Numbered SQL files, applied in order, each in one transaction, each recorded with a checksum
// (docs/trd/storage.md#migrations).

export interface Migration {
  version: number
  name: string
  sql: string
  checksum: string
}

export interface MigrationPlan {
  /** Migrations not yet applied to this database, in order. */
  pending: Migration[]
  /** Versions the database has that this release does not know. A newer release applied them. */
  newer: number[]
}

export const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations', import.meta.url))

const FILE_NAME = /^(\d{4})_([a-z0-9_]+)\.sql$/

export function checksumOf(sql: string): string {
  // Line endings are normalised so a checkout on another system does not change the checksum.
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex')
}

export function readMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const migrations = readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => {
      const match = FILE_NAME.exec(file)
      if (!match) throw new StorageError(`migration file name is not NNNN_name.sql: ${file}`, 'config_invalid')
      const sql = readFileSync(join(dir, file), 'utf8')
      return { version: Number(match[1]), name: match[2] as string, sql, checksum: checksumOf(sql) }
    })
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new StorageError(
        `migrations must be numbered 0001, 0002, ... with no gap: found ${migration.version} at position ${index + 1}`,
        'config_invalid'
      )
    }
  })
  return migrations
}

interface AppliedRow {
  version: number
  name: string
  checksum: string
}

const CREATE_LEDGER = `CREATE TABLE IF NOT EXISTS schema_migration (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
) STRICT`

function appliedRows(storage: Storage): AppliedRow[] {
  return storage.tx((db) => {
    db.exec(CREATE_LEDGER)
    return db.prepare('SELECT version, name, checksum FROM schema_migration ORDER BY version').all() as AppliedRow[]
  })
}

/** Compares the database with the migration files. Throws when an applied migration's checksum changed. */
export function planMigrations(storage: Storage, migrations: Migration[] = readMigrations()): MigrationPlan {
  const applied = appliedRows(storage)
  const known = new Map(migrations.map((migration) => [migration.version, migration]))
  const newer: number[] = []
  applied.forEach((row, index) => {
    if (row.version !== index + 1) {
      throw new StorageError(`schema_migration has a gap before version ${row.version}`, 'config_invalid')
    }
    const file = known.get(row.version)
    if (!file) {
      // An image rollback runs an older release on a newer schema. Add-first migrations keep that safe.
      newer.push(row.version)
      return
    }
    if (file.checksum !== row.checksum) {
      throw new StorageError(
        `migration ${String(row.version).padStart(4, '0')}_${row.name} changed after it was applied: ` +
          `recorded checksum ${row.checksum.slice(0, 12)}, file checksum ${file.checksum.slice(0, 12)}`,
        'config_invalid'
      )
    }
  })
  return { pending: migrations.filter((migration) => migration.version > applied.length), newer }
}

/** Applies every pending migration. Returns the versions applied. */
export function applyMigrations(
  storage: Storage,
  migrations: Migration[] = readMigrations(),
  now: () => Date = () => new Date()
): number[] {
  const { pending } = planMigrations(storage, migrations)
  for (const migration of pending) {
    storage.tx((db) => {
      db.exec(migration.sql)
      db.prepare('INSERT INTO schema_migration (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)').run(
        migration.version,
        migration.name,
        migration.checksum,
        isoNow(now)
      )
    })
  }
  return pending.map((migration) => migration.version)
}
