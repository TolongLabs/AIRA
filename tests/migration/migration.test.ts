import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Storage } from '../../src/storage/database.js'
import { applyMigrations, planMigrations, readMigrations } from '../../src/storage/migrate.js'
import { tmpDir, tmpStorage } from '../support/tmp.js'

// The Migration suite (docs/trd/storage.md#tests). It runs in CI on every change.

interface Baseline {
  releasedVersion: number
}

const baseline = JSON.parse(readFileSync(join(import.meta.dirname, 'baseline.json'), 'utf8')) as Baseline

// Statements that break a previous release that is still running on the same file.
const REMOVES = /\b(DROP\s+(TABLE|COLUMN|INDEX|VIEW|TRIGGER)|RENAME\s+(TO|COLUMN)|ALTER\s+TABLE\s+\w+\s+DROP)\b/i

function addFirstFaults(sql: string): string[] {
  if (/^--\s*manual\b/i.test(sql)) return []
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .filter((line) => REMOVES.test(line))
}

function tables(storage: Storage): { name: string; strict: number }[] {
  return storage.read(
    (db) =>
      db
        .prepare(
          // A full-text index is a virtual table with shadow tables. SQLite does not let either be strict.
          `SELECT name, strict FROM pragma_table_list
           WHERE schema = 'main' AND name NOT LIKE 'sqlite_%' AND type = 'table' AND name NOT LIKE 'memory_fts%'`
        )
        .all() as { name: string; strict: number }[]
  )
}

function scratchMigrations(files: Record<string, string>): string {
  const dir = join(tmpDir(), 'migrations')
  mkdirSync(dir)
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql)
  return dir
}

describe('migrations from an empty file', () => {
  it('applies every migration and records each with its checksum', () => {
    const storage = tmpStorage({ migrate: false })
    const migrations = readMigrations()
    expect(migrations.length).toBeGreaterThan(0)
    expect(applyMigrations(storage)).toEqual(migrations.map((migration) => migration.version))
    const rows = storage.read((db) => db.prepare('SELECT version, checksum FROM schema_migration').all())
    expect(rows).toEqual(migrations.map(({ version, checksum }) => ({ version, checksum })))
    expect(() => storage.check()).not.toThrow()
  })

  it('declares every table strict', () => {
    const storage = tmpStorage()
    const loose = tables(storage).filter((table) => table.strict !== 1)
    expect(loose).toEqual([])
  })

  it('creates the tables the persistence contract names', () => {
    const storage = tmpStorage()
    const names = tables(storage).map((table) => table.name)
    for (const name of [
      'inbound_message',
      'turn',
      'memory_job',
      'backup_run',
      'schema_migration',
      'file',
      'chat',
      'identity',
      'setting',
      'setting_change',
      'chat_state',
      'model_call',
      'tool_call',
      'job_run',
      'failure_diagnostics',
      'tool_result',
      'receipt',
      'reminder',
      'spend',
      'memory_item',
      'memory_embedding',
      'memory_cursor',
      'memory_event'
    ]) {
      expect(names).toContain(name)
    }
  })

  it('does nothing on a second run', () => {
    const storage = tmpStorage()
    expect(applyMigrations(storage)).toEqual([])
    expect(planMigrations(storage)).toEqual({ pending: [], newer: [] })
  })
})

describe('migration ledger', () => {
  const first = 'CREATE TABLE note (id INTEGER PRIMARY KEY, body TEXT NOT NULL) STRICT;'

  it('stops when an applied migration file changed', () => {
    const storage = tmpStorage({ migrate: false })
    applyMigrations(storage, readMigrations(scratchMigrations({ '0001_note.sql': first })))
    const changed = readMigrations(scratchMigrations({ '0001_note.sql': first + '\n-- edited' }))
    expect(() => applyMigrations(storage, changed)).toThrow(/0001_note changed after it was applied/)
  })

  it('applies a failing migration not at all, and records nothing for it', () => {
    const storage = tmpStorage({ migrate: false })
    const dir = scratchMigrations({
      '0001_note.sql': first,
      '0002_broken.sql': 'CREATE TABLE half (id INTEGER PRIMARY KEY) STRICT; INSERT INTO missing VALUES (1);'
    })
    expect(() => applyMigrations(storage, readMigrations(dir))).toThrow(/no such table: missing/)
    expect(storage.read((db) => db.prepare('SELECT version FROM schema_migration').pluck().all())).toEqual([1])
    expect(tables(storage).map((table) => table.name)).not.toContain('half')
  })

  it('refuses a gap or a badly named file', () => {
    expect(() => readMigrations(scratchMigrations({ '0001_a.sql': first, '0003_c.sql': first }))).toThrow(/no gap/)
    expect(() => readMigrations(scratchMigrations({ 'first.sql': first }))).toThrow(/NNNN_name\.sql/)
  })

  it('lets an older release start on a schema a newer release migrated', () => {
    const storage = tmpStorage({ migrate: false })
    const newer = scratchMigrations({
      '0001_note.sql': first,
      '0002_more.sql': "ALTER TABLE note ADD COLUMN tag TEXT NOT NULL DEFAULT '';"
    })
    applyMigrations(storage, readMigrations(newer))
    const older = readMigrations(scratchMigrations({ '0001_note.sql': first }))
    expect(planMigrations(storage, older)).toEqual({ pending: [], newer: [2] })
    expect(applyMigrations(storage, older)).toEqual([])
  })

  it('treats line endings as equal when it checks a checksum', () => {
    const unix = readMigrations(scratchMigrations({ '0001_note.sql': first + '\n' }))
    const windows = readMigrations(scratchMigrations({ '0001_note.sql': first + '\r\n' }))
    expect(unix[0]?.checksum).toBe(windows[0]?.checksum)
  })
})

describe('add first, remove later', () => {
  it('no migration removes or renames what a running release may still use', () => {
    const faults = readMigrations().flatMap((migration) =>
      addFirstFaults(migration.sql).map((line) => `${migration.version}: ${line.trim()}`)
    )
    expect(faults).toEqual([])
  })

  it('the check catches a removal and accepts a release marked manual', () => {
    expect(addFirstFaults('ALTER TABLE turn DROP COLUMN stage;')).toHaveLength(1)
    expect(addFirstFaults('ALTER TABLE turn RENAME TO turns;')).toHaveLength(1)
    expect(addFirstFaults('DROP TABLE turn;')).toHaveLength(1)
    expect(addFirstFaults('-- manual: rehearsed restore\nDROP TABLE turn;')).toEqual([])
    expect(addFirstFaults('ALTER TABLE turn ADD COLUMN note TEXT; -- we do not DROP TABLE here')).toEqual([])
  })

  it('rows written by the previous release survive every later migration', () => {
    // The seed holds rows as the released schema stored them. There is no seed before the first release.
    const seedFile = join(import.meta.dirname, `seed-${String(baseline.releasedVersion).padStart(4, '0')}.sql`)
    const migrations = readMigrations()
    expect(baseline.releasedVersion).toBeLessThanOrEqual(migrations.length)
    expect(existsSync(seedFile)).toBe(baseline.releasedVersion > 0)

    const storage = tmpStorage({ migrate: false })
    applyMigrations(storage, migrations.slice(0, baseline.releasedVersion))
    const before = new Map<string, number>()
    if (baseline.releasedVersion > 0) {
      storage.tx((db) => db.exec(readFileSync(seedFile, 'utf8')))
      for (const { name } of tables(storage)) {
        before.set(name, storage.read((db) => db.prepare(`SELECT count(*) FROM "${name}"`).pluck().get()) as number)
      }
    }

    applyMigrations(storage, migrations)
    expect(() => storage.check()).not.toThrow()
    for (const [name, count] of before) {
      if (name === 'schema_migration') continue
      expect(storage.read((db) => db.prepare(`SELECT count(*) FROM "${name}"`).pluck().get())).toBe(count)
    }
    // The previous release must still be able to write the rows it knows.
    if (baseline.releasedVersion > 0)
      expect(() => storage.tx((db) => db.exec(readFileSync(seedFile, 'utf8')))).toThrow(/UNIQUE|PRIMARY/)
  })

  it('migration 0011 keeps every backup_run row and accepts offsite and check', () => {
    const migrations = readMigrations()
    const before11 = migrations.filter((migration) => migration.version < 11)
    const migration11 = migrations.filter((migration) => migration.version === 11)
    expect(migration11).toHaveLength(1)

    const storage = tmpStorage({ migrate: false })
    applyMigrations(storage, before11)
    storage.tx((db) => {
      db.prepare(
        "INSERT INTO backup_run (id, reason, state, file, bytes, detail, started_at, ended_at) VALUES (1, 'timer', 'verified', 'aira-1.db', 1024, null, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z')"
      ).run()
      db.prepare(
        "INSERT INTO backup_run (id, reason, state, file, bytes, detail, started_at, ended_at) VALUES (2, 'manual', 'failed', 'aira-2.db', null, 'disk fault', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:01.000Z')"
      ).run()
    })

    expect(applyMigrations(storage, [...before11, ...migration11])).toEqual([11])
    expect(() => storage.check()).not.toThrow()

    const preserved = storage.read((db) =>
      db.prepare('SELECT id, reason, state, file, bytes, detail FROM backup_run ORDER BY id').all()
    )
    expect(preserved).toEqual([
      { id: 1, reason: 'timer', state: 'verified', file: 'aira-1.db', bytes: 1024, detail: null },
      { id: 2, reason: 'manual', state: 'failed', file: 'aira-2.db', bytes: null, detail: 'disk fault' }
    ])

    storage.tx((db) => {
      db.prepare(
        "INSERT INTO backup_run (reason, state, file, started_at, ended_at) VALUES ('offsite', 'ok', 'aira-1.db', '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:02.000Z')"
      ).run()
      db.prepare(
        "INSERT INTO backup_run (reason, state, file, started_at, ended_at) VALUES ('check', 'ok', '', '2026-01-03T01:00:00.000Z', '2026-01-03T01:00:05.000Z')"
      ).run()
    })
    expect(storage.read((db) => db.prepare('SELECT count(*) FROM backup_run').pluck().get())).toBe(4)
  })

  it('upgrades the schema with 0012_think by applying exactly 0013_feedback', () => {
    const storage = tmpStorage({ migrate: false })
    const migrations = readMigrations().filter((migration) => migration.version <= 13)
    const previous = applyMigrations(
      storage,
      migrations.filter((migration) => migration.version < 13)
    )
    expect(previous.at(-1)).toBe(12)
    expect(applyMigrations(storage, migrations)).toEqual([13])
    expect(tables(storage).map((table) => table.name)).toEqual(
      expect.arrayContaining(['feedback_report', 'feedback_cursor'])
    )
    expect(() => storage.check()).not.toThrow()
  })
})
