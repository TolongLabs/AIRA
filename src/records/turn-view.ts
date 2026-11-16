import { type Db, type Storage } from '../storage/database.js'

// Operator view for one turn and its child records (docs/trd/records.md#operator-views).

export interface TurnView {
  turn: Record<string, unknown>
  modelCalls: Record<string, unknown>[]
  toolCalls: Record<string, unknown>[]
  failures: Record<string, unknown>[]
}

const STAGES: readonly [string, string][] = [
  ['received', 'received_at'],
  ['admitted', 'admitted_at'],
  ['built', 'built_at'],
  ['first_byte', 'first_byte_at'],
  ['model_done', 'model_done_at'],
  ['cleaned', 'cleaned_at'],
  ['returned', 'returned_at']
]

/** Reads one turn with its children on a read connection. Undefined for an unknown turn. */
export function readTurn(db: Db, turnId: string): TurnView | undefined {
  const turn = db.prepare('SELECT * FROM turn WHERE turn_id = ?').get(turnId) as Record<string, unknown> | undefined
  if (turn === undefined) return undefined
  const modelCalls = db
    .prepare('SELECT * FROM model_call WHERE turn_id = ? ORDER BY started_at, id')
    .all(turnId) as Record<string, unknown>[]
  const toolCalls = db
    .prepare('SELECT * FROM tool_call WHERE turn_id = ? ORDER BY started_at, id')
    .all(turnId) as Record<string, unknown>[]
  const failures = db.prepare('SELECT * FROM failure WHERE turn_id = ? ORDER BY created_at, id').all(turnId) as Record<
    string,
    unknown
  >[]
  return { turn, modelCalls, toolCalls, failures }
}

/** Milliseconds between consecutive stage stamps that are present: received, admitted, built, ... returned. */
export function stageDurations(turn: Record<string, unknown>): { stage: string; ms: number }[] {
  const out: { stage: string; ms: number }[] = []
  let prevMs: number | undefined
  for (const [stage, col] of STAGES) {
    const raw = turn[col]
    if (typeof raw !== 'string') continue
    const ts = Date.parse(raw)
    if (Number.isNaN(ts)) continue
    if (prevMs !== undefined) out.push({ stage, ms: ts - prevMs })
    prevMs = ts
  }
  return out
}

function val(value: unknown): string {
  if (value === null || value === undefined || value === '') return '-'
  return String(value)
}

function listVal(value: unknown): string {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      if (Array.isArray(parsed)) return parsed.length === 0 ? '-' : parsed.map(String).join(', ')
    } catch {
      return value
    }
  }
  if (Array.isArray(value)) return value.length === 0 ? '-' : value.map(String).join(', ')
  return '-'
}

/** One turn as plain text: a header, the stage durations, then model calls, tool calls and failures in time order. */
export function formatTurn(view: TurnView): string {
  const t = view.turn
  const lines = [
    `turn ${val(t['turn_id'])} ${val(t['kind'])} ${val(t['state'])} outcome=${val(t['outcome'])}`,
    `chat=${val(t['chat_id'])} sender=${val(t['sender_id'])} character=${val(t['character_id'])}`,
    `mood=${val(t['mood'])} (${val(t['mood_source'])})`,
    `model: transport=${val(t['transport'])} role=${val(t['role'])} model=${val(t['model'])} attempts=${val(t['attempts'])} in=${val(t['input_tokens'])} out=${val(t['output_tokens'])} cached=${val(t['cached_tokens'])} cost=${val(t['cost_usd'])}`,
    `delivery: chars=${val(t['reply_chars'])} bubbles=${val(t['bubble_count'])} sticker=${val(t['sticker_id'])} attachments=${listVal(t['attachments'])} receipts=${listVal(t['receipts'])}`,
    `cleaning: ${listVal(t['cleaning_steps'])}`,
    'stages:'
  ]

  for (const d of stageDurations(t)) {
    lines.push(`  ${d.stage} +${d.ms} ms`)
  }

  lines.push('events:')
  const events: { time: string; seq: number; line: string }[] = []
  let seq = 0

  for (const row of view.modelCalls) {
    const time = typeof row['started_at'] === 'string' ? row['started_at'] : ''
    events.push({
      time,
      seq: seq++,
      line: `  ${val(row['started_at'])} model role=${val(row['role'])} model=${val(row['model'])} transport=${val(row['transport'])} attempt=${val(row['attempt'])} duration=${val(row['duration_ms'])}ms in=${val(row['input_tokens'])} out=${val(row['output_tokens'])} cost=${val(row['cost_usd'])} failure=${val(row['failure_kind'])}`
    })
  }

  for (const row of view.toolCalls) {
    const time = typeof row['started_at'] === 'string' ? row['started_at'] : ''
    events.push({
      time,
      seq: seq++,
      line: `  ${val(row['started_at'])} tool name=${val(row['tool'])} source=${val(row['source'])} outcome=${val(row['outcome'])} duration=${val(row['duration_ms'])}ms receipt=${val(row['receipt_id'])}`
    })
  }

  for (const row of view.failures) {
    const time = typeof row['created_at'] === 'string' ? row['created_at'] : ''
    events.push({
      time,
      seq: seq++,
      line: `  ${val(row['created_at'])} failure stage=${val(row['stage'])} kind=${val(row['kind'])} handled_by=${val(row['handled_by'])} message=${val(row['message'])}`
    })
  }

  events.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : a.seq - b.seq))
  for (const event of events) lines.push(event.line)

  return lines.join('\n')
}

/** The tools that ran with outcome `ok` in a turn, in call order, for the reply footer. */
export function okToolsOfTurn(storage: Storage, turnId: string): string[] {
  const rows = storage.read(
    (db) =>
      db
        .prepare(`SELECT tool FROM tool_call WHERE turn_id = ? AND outcome = 'ok' ORDER BY started_at, id`)
        .all(turnId) as { tool: string }[]
  )
  return rows.map((row) => row.tool)
}
