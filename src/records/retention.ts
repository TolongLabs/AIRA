import { type Db, type Storage } from '../storage/database.js'

// Retention pruning by table (docs/trd/records.md#retention).

const MS_PER_HOUR = 3_600_000
const MS_PER_DAY = 86_400_000

export interface RetentionConfig {
  retentionDays: number
  diagnosticsHours: number
  windowDays: number
}

export interface RetentionResult {
  counts: Record<string, number>
  jobRunId: number
}

function deleteRows(
  db: Db,
  table: string,
  whereSql: string,
  params: unknown[],
  beforeDelete?: (table: string, rows: Record<string, unknown>[]) => void
): number {
  const rows = db.prepare(`SELECT * FROM ${table} WHERE ${whereSql}`).all(...params) as Record<string, unknown>[]
  if (rows.length === 0) return 0
  beforeDelete?.(table, rows)
  return db.prepare(`DELETE FROM ${table} WHERE ${whereSql}`).run(...params).changes
}

/**
 * Prunes by table and writes its own job_run row with the counts. `beforeDelete` is called inside the
 * transaction with each table's rows before they are deleted, so a later archive job can export them.
 */
export function pruneRecords(
  storage: Storage,
  config: RetentionConfig,
  options?: { beforeDelete?: (table: string, rows: Record<string, unknown>[]) => void; now?: () => Date }
): RetentionResult {
  const nowDate = (options?.now ?? (() => new Date()))()
  const nowIso = nowDate.toISOString()
  const retentionCutoff = new Date(nowDate.getTime() - config.retentionDays * MS_PER_DAY).toISOString()
  const diagnosticsCutoff = new Date(nowDate.getTime() - config.diagnosticsHours * MS_PER_HOUR).toISOString()
  const windowCutoff = new Date(nowDate.getTime() - config.windowDays * MS_PER_DAY).toISOString()
  const beforeDelete = options?.beforeDelete

  return storage.tx((db) => {
    const counts = {
      failure_diagnostics: 0,
      session_message: 0,
      inbound_message: 0,
      model_call: 0,
      tool_call: 0,
      failure: 0,
      turn: 0,
      job_run: 0
    }

    counts.failure_diagnostics = db
      .prepare('DELETE FROM failure_diagnostics WHERE created_at < ?')
      .run(diagnosticsCutoff).changes

    counts.session_message = db.prepare('DELETE FROM session_message WHERE created_at < ?').run(windowCutoff).changes

    const oldTurnsWhere = "state <> 'running' AND received_at < ?"
    const oldTurnSubquery = `turn_id IN (SELECT turn_id FROM turn WHERE ${oldTurnsWhere})`

    counts.failure_diagnostics += db
      .prepare(`DELETE FROM failure_diagnostics WHERE ${oldTurnSubquery}`)
      .run(retentionCutoff).changes
    counts.session_message += db
      .prepare(`DELETE FROM session_message WHERE ${oldTurnSubquery}`)
      .run(retentionCutoff).changes
    counts.inbound_message += deleteRows(db, 'inbound_message', oldTurnSubquery, [retentionCutoff], beforeDelete)
    counts.model_call += deleteRows(db, 'model_call', oldTurnSubquery, [retentionCutoff], beforeDelete)
    counts.tool_call += deleteRows(db, 'tool_call', oldTurnSubquery, [retentionCutoff], beforeDelete)
    counts.failure += deleteRows(db, 'failure', oldTurnSubquery, [retentionCutoff], beforeDelete)
    counts.turn += deleteRows(db, 'turn', oldTurnsWhere, [retentionCutoff], beforeDelete)

    counts.failure += deleteRows(db, 'failure', 'turn_id IS NULL AND created_at < ?', [retentionCutoff], beforeDelete)
    counts.model_call += deleteRows(
      db,
      'model_call',
      'turn_id IS NULL AND started_at < ?',
      [retentionCutoff],
      beforeDelete
    )
    counts.job_run += deleteRows(db, 'job_run', 'started_at < ?', [retentionCutoff], beforeDelete)
    counts.inbound_message += deleteRows(
      db,
      'inbound_message',
      "state <> 'received' AND turn_id IS NULL AND received_at < ?",
      [retentionCutoff],
      beforeDelete
    )

    const inserted = db
      .prepare(
        `INSERT INTO job_run (kind, started_at, ended_at, outcome, counts)
         VALUES ('retention', ?, ?, 'ok', ?)`
      )
      .run(nowIso, nowIso, JSON.stringify(counts))

    return { counts, jobRunId: Number(inserted.lastInsertRowid) }
  })
}
