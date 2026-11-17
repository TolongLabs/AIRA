import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { openReader } from '../storage/database.js'

// Operator summary report (docs/trd/records.md#operator-views, docs/trd/storage.md#analytics-and-the-archive).
// Reads a verified snapshot and the Parquet archive through DuckDB. Never opens the live database.

const SNAPSHOT_NAME = /^aira-[0-9TZ]+-\d+\.db$/

/**
 * The newest snapshot in the folder that passes an integrity check now. The check is made here, on the snapshot
 * itself, so a report never has to ask the live database which snapshot is good.
 */
export function newestSnapshotFile(snapshotsDir: string): string | undefined {
  if (!existsSync(snapshotsDir)) return undefined
  const names = readdirSync(snapshotsDir)
    .filter((name) => SNAPSHOT_NAME.test(name))
    .sort()
    .reverse()
  for (const name of names) {
    const file = join(snapshotsDir, name)
    try {
      const reader = openReader(file)
      try {
        if (reader.pragma('quick_check', { simple: true }) === 'ok') return file
      } finally {
        reader.close()
      }
    } catch {
      // A file that cannot be opened is not a snapshot to report from. Try the one before it.
    }
  }
  return undefined
}

export interface Report {
  from: string
  to: string
  /** Latency percentiles and counts by turn kind. */
  turns: { kind: string; count: number; p50Ms: number | null; p90Ms: number | null }[]
  failures: { kind: string; count: number }[]
  costUsd: number
  /** Share of delivered turns whose role is 'fallback'. */
  fallbackRate: number | null
}

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''")
}

function hasParquetFiles(tableDir: string): boolean {
  if (!existsSync(tableDir)) return false
  for (const entry of readdirSync(tableDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const monthDir = join(tableDir, entry.name)
    for (const file of readdirSync(monthDir)) {
      if (file.endsWith('.parquet')) return true
    }
  }
  return false
}

function turnSourceSql(archiveDir: string): string {
  const turnDir = join(archiveDir, 'turn')
  const columns =
    'turn_id, kind, state, role, CAST(cost_usd AS DOUBLE) AS cost_usd, CAST(COALESCE(arrived_at, received_at) AS TIMESTAMPTZ) AS received_at, CAST(returned_at AS TIMESTAMPTZ) AS returned_at'
  const base = `SELECT ${columns} FROM snap.turn`
  if (!hasParquetFiles(turnDir)) return base
  const glob = escapeSqlLiteral(join(turnDir, '*', '*.parquet'))
  return `SELECT ${columns} FROM (SELECT * FROM snap.turn UNION ALL BY NAME
    SELECT * FROM read_parquet('${glob}', union_by_name = true))`
}

function failureSourceSql(archiveDir: string): string {
  const failureDir = join(archiveDir, 'failure')
  const columns = 'CAST(id AS BIGINT) AS id, kind, CAST(created_at AS TIMESTAMPTZ) AS created_at'
  const base = `SELECT ${columns} FROM snap.failure`
  if (!hasParquetFiles(failureDir)) return base
  const glob = escapeSqlLiteral(join(failureDir, '*', '*.parquet'))
  return `${base}
    UNION ALL
    SELECT ${columns}
    FROM read_parquet('${glob}', union_by_name = true)`
}

/** Reads the snapshot file and the Parquet archive together through DuckDB. Never the live database. */
export async function buildReport(input: {
  snapshotFile: string
  archiveDir: string
  from: string
  to: string
}): Promise<Report> {
  const { DuckDBInstance } = await import('@duckdb/node-api')
  const instance = await DuckDBInstance.create(':memory:')
  const conn = await instance.connect()

  try {
    // The snapshot's rows are copied into DuckDB. No extension is installed, so a report needs no network.
    await conn.run('CREATE SCHEMA snap')
    await conn.run(
      `CREATE TABLE snap.turn (turn_id VARCHAR, kind VARCHAR, state VARCHAR, role VARCHAR, cost_usd DOUBLE,
         received_at VARCHAR, returned_at VARCHAR, arrived_at VARCHAR)`
    )
    await conn.run('CREATE TABLE snap.failure (id BIGINT, kind VARCHAR, created_at VARCHAR)')
    const reader = openReader(input.snapshotFile)
    try {
      const turns = await conn.createAppender('turn', 'snap')
      const hasArrival = (reader.prepare('PRAGMA table_info(turn)').all() as { name: string }[]).some(
        (column) => column.name === 'arrived_at'
      )
      const turnRows = reader
        .prepare(
          `SELECT turn_id, kind, state, role, cost_usd, received_at, returned_at,
          ${hasArrival ? 'arrived_at' : 'NULL'} FROM turn`
        )
        .raw()
        .iterate() as IterableIterator<(string | number | null)[]>
      for (const row of turnRows) {
        row.forEach((value, column) => {
          if (value === null) turns.appendNull()
          else if (column === 4) turns.appendDouble(Number(value))
          else turns.appendVarchar(String(value))
        })
        turns.endRow()
      }
      turns.closeSync()
      const failures = await conn.createAppender('failure', 'snap')
      const failureRows = reader
        .prepare('SELECT id, kind, created_at FROM failure')
        .raw()
        .iterate() as IterableIterator<[number, string, string]>
      for (const [id, kind, createdAt] of failureRows) {
        failures.appendBigInt(BigInt(id))
        failures.appendVarchar(kind)
        failures.appendVarchar(createdAt)
        failures.endRow()
      }
      failures.closeSync()
    } finally {
      reader.close()
    }

    const turnsCte = `
      WITH all_turns AS (${turnSourceSql(input.archiveDir)}),
      dedup_turns AS (
        SELECT DISTINCT ON (turn_id)
          turn_id,
          kind,
          state,
          role,
          CAST(cost_usd AS DOUBLE) AS cost_usd,
          CASE
            WHEN received_at IS NOT NULL AND returned_at IS NOT NULL
            THEN date_diff('millisecond', received_at, returned_at)::DOUBLE
            ELSE NULL
          END AS latency_ms
        FROM all_turns
        WHERE received_at >= CAST($1 AS TIMESTAMPTZ) AND received_at < CAST($2 AS TIMESTAMPTZ)
      )`

    const byKindRes = await conn.runAndReadAll(
      `${turnsCte}
       SELECT
         kind,
         count(*) AS count,
         quantile_cont(latency_ms, 0.5) AS p50_ms,
         quantile_cont(latency_ms, 0.9) AS p90_ms
       FROM dedup_turns
       GROUP BY kind
       ORDER BY kind`,
      [input.from, input.to]
    )

    const summaryRes = await conn.runAndReadAll(
      `${turnsCte}
       SELECT
         COALESCE(SUM(cost_usd), 0.0) AS cost_usd,
         COUNT(*) FILTER (WHERE state = 'delivered' AND role = 'fallback')::DOUBLE
           / NULLIF(COUNT(*) FILTER (WHERE state = 'delivered'), 0)::DOUBLE AS fallback_rate
       FROM dedup_turns`,
      [input.from, input.to]
    )

    const failureRes = await conn.runAndReadAll(
      `WITH all_failures AS (${failureSourceSql(input.archiveDir)}),
       dedup_failures AS (
         SELECT DISTINCT ON (id) id, kind
         FROM all_failures
         WHERE created_at >= CAST($1 AS TIMESTAMPTZ) AND created_at < CAST($2 AS TIMESTAMPTZ)
       )
       SELECT kind, count(*) AS count
       FROM dedup_failures
       GROUP BY kind
       ORDER BY count DESC, kind ASC`,
      [input.from, input.to]
    )

    const turns = byKindRes.getRowObjectsJS().map((row) => ({
      kind: String(row['kind']),
      count: Number(row['count']),
      p50Ms: row['p50_ms'] === null || row['p50_ms'] === undefined ? null : Number(row['p50_ms']),
      p90Ms: row['p90_ms'] === null || row['p90_ms'] === undefined ? null : Number(row['p90_ms'])
    }))

    const summaryRow = summaryRes.getRowObjectsJS()[0]
    const costUsd = summaryRow ? Number(summaryRow['cost_usd'] ?? 0) : 0
    const rawFallback = summaryRow?.['fallback_rate']
    const fallbackRate = rawFallback === null || rawFallback === undefined ? null : Number(rawFallback)

    const failures = failureRes.getRowObjectsJS().map((row) => ({
      kind: String(row['kind']),
      count: Number(row['count'])
    }))

    return {
      from: input.from,
      to: input.to,
      turns,
      failures,
      costUsd,
      fallbackRate
    }
  } finally {
    conn.closeSync()
    instance.closeSync()
  }
}

export function formatReport(report: Report): string {
  const lines = [`report ${report.from} .. ${report.to}`, 'turns:']
  for (const turn of report.turns) {
    const p50 = turn.p50Ms === null ? '-' : `${Math.round(turn.p50Ms)}ms`
    const p90 = turn.p90Ms === null ? '-' : `${Math.round(turn.p90Ms)}ms`
    lines.push(`  ${turn.kind}: count=${turn.count} p50=${p50} p90=${p90}`)
  }
  lines.push('failures:')
  for (const failure of report.failures) {
    lines.push(`  ${failure.kind}: count=${failure.count}`)
  }
  const fallback = report.fallbackRate === null ? '-' : `${(report.fallbackRate * 100).toFixed(1)}%`
  lines.push(`cost: $${report.costUsd.toFixed(4)}`)
  lines.push(`fallback_rate: ${fallback}`)
  return lines.join('\n')
}
