import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pruneRecords, type RetentionConfig, type RetentionResult } from '../records/retention.js'
import type { Storage } from './database.js'

// Daily retention export to Parquet (docs/trd/storage.md#analytics-and-the-archive).
// Collects rows in a rolled-back pass, exports to Parquet, and prunes only after every file succeeds.

export interface ArchiveResult {
  retention: RetentionResult
  /** Files written, relative to the archive folder. */
  files: string[]
}

const VERBATIM_TABLES = new Set(['session_message', 'failure_diagnostics', 'feedback_report'])
const TABLE_PATTERN = /^[a-z_]+$/
const MONTH_PATTERN = /^\d{4}-\d{2}$/
const STAMP_PATTERN = /^[A-Za-z0-9_-]+$/
const ROLLBACK_MARKER = Symbol('archive-collect-rollback')

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''")
}

function assertNotVerbatim(table: string): void {
  if (VERBATIM_TABLES.has(table)) {
    throw new Error(`refusing to archive verbatim table ${table}`)
  }
}

function rowMonth(table: string, row: Record<string, unknown>): string {
  const stamp = row['received_at'] ?? row['started_at'] ?? row['created_at']
  if (typeof stamp !== 'string' || stamp.length < 7) {
    throw new Error(`cannot determine archive month for row in ${table}`)
  }
  const month = stamp.slice(0, 7)
  if (!MONTH_PATTERN.test(month)) {
    throw new Error(`invalid archive month ${month} for row in ${table}`)
  }
  return month
}

/** Writes rows of one table to <archiveDir>/<table>/<YYYY-MM>/<table>-<stamp>.parquet. Returns the relative path. */
export async function writeParquet(
  archiveDir: string,
  table: string,
  month: string,
  rows: Record<string, unknown>[],
  stamp: string
): Promise<string> {
  assertNotVerbatim(table)
  if (!TABLE_PATTERN.test(table)) throw new Error(`invalid archive table name: ${table}`)
  if (!MONTH_PATTERN.test(month)) throw new Error(`invalid archive month: ${month}`)
  if (!STAMP_PATTERN.test(stamp)) throw new Error(`invalid archive stamp: ${stamp}`)
  if (rows.length === 0) return ''

  const relDir = join(table, month)
  const fullDir = join(archiveDir, relDir)
  mkdirSync(fullDir, { recursive: true })

  const fileName = `${table}-${stamp}.parquet`
  const relPath = join(relDir, fileName)
  const finalPath = join(archiveDir, relPath)
  const tmpParquet = join(fullDir, `${fileName}.tmp`)
  const tmpJson = join(fullDir, `.${table}-${stamp}.${process.pid}.ndjson.tmp`)

  writeFileSync(tmpJson, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')

  const { DuckDBInstance } = await import('@duckdb/node-api')
  const instance = await DuckDBInstance.create(':memory:')
  const conn = await instance.connect()
  try {
    const sql = `COPY (SELECT * FROM read_json_auto('${escapeSqlLiteral(tmpJson)}')) TO '${escapeSqlLiteral(tmpParquet)}' (FORMAT PARQUET)`
    await conn.run(sql)
    renameSync(tmpParquet, finalPath)
  } finally {
    conn.closeSync()
    instance.closeSync()
    rmSync(tmpJson, { force: true })
    rmSync(tmpParquet, { force: true })
  }

  return relPath
}

/**
 * The daily retention job with its archive: rows are exported to Parquet, by table and month, before they are
 * deleted. If the export fails, nothing is deleted.
 */
export async function archiveAndPrune(
  storage: Storage,
  options: {
    archiveDir: string
    config: RetentionConfig
    /** False while the disk guard has paused the archive job: nothing is exported and nothing is pruned. */
    enabled: boolean
    now?: () => Date
  }
): Promise<ArchiveResult | undefined> {
  if (!options.enabled) return undefined

  const runAt = (options.now ?? (() => new Date()))()
  const fixedNow = () => runAt
  const stamp = runAt
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')

  // Pass 1: collect rows inside a transaction that always rolls back so nothing is deleted yet.
  const grouped = new Map<string, Map<string, Record<string, unknown>[]>>()
  try {
    storage.tx(() => {
      pruneRecords(storage, options.config, {
        now: fixedNow,
        beforeDelete: (table, rows) => {
          assertNotVerbatim(table)
          let byMonth = grouped.get(table)
          if (!byMonth) {
            byMonth = new Map()
            grouped.set(table, byMonth)
          }
          for (const row of rows) {
            const month = rowMonth(table, row)
            let bucket = byMonth.get(month)
            if (!bucket) {
              bucket = []
              byMonth.set(month, bucket)
            }
            bucket.push({ ...row })
          }
        }
      })
      throw ROLLBACK_MARKER
    })
  } catch (error) {
    if (error !== ROLLBACK_MARKER) throw error
  }

  // Pass 2: export each (table, month) group to Parquet. Clean up any written files on failure.
  const files: string[] = []
  try {
    for (const [table, byMonth] of grouped) {
      for (const [month, rows] of byMonth) {
        if (rows.length === 0) continue
        const rel = await writeParquet(options.archiveDir, table, month, rows, stamp)
        if (rel !== '') files.push(rel)
      }
    }
  } catch (error) {
    for (const rel of files) {
      rmSync(join(options.archiveDir, rel), { force: true })
    }
    throw error
  }

  // Pass 3: prune for real with the same clock.
  const retention = pruneRecords(storage, options.config, {
    now: fixedNow,
    beforeDelete: (table) => {
      assertNotVerbatim(table)
    }
  })

  return { retention, files }
}
