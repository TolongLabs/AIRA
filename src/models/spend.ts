import { type Db, type Storage, isoNow } from '../storage/database.js'

type Clock = () => Date
const wallClock: Clock = () => new Date()

export function monthOf(date: Date): string {
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  return `${year}-${month}`
}

/** Adds one call to the month's total for a role. Call it inside a transaction. */
export function addSpend(
  db: Db,
  entry: { role: string; counted: boolean; costUsd: number; inputTokens: number; outputTokens: number },
  now: Clock = wallClock
): void {
  const month = monthOf(now())
  const at = isoNow(now)
  const counted = entry.counted ? 1 : 0
  db.prepare(
    `INSERT INTO spend (month, role, counted, cost_usd, calls, input_tokens, output_tokens, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?)
     ON CONFLICT (month, role, counted) DO UPDATE SET
       cost_usd = cost_usd + excluded.cost_usd,
       calls = calls + 1,
       input_tokens = input_tokens + excluded.input_tokens,
       output_tokens = output_tokens + excluded.output_tokens,
       updated_at = excluded.updated_at`
  ).run(month, entry.role, counted, entry.costUsd, entry.inputTokens, entry.outputTokens, at)
}

/** The month's cost that counts against the cap, over all roles. */
export function countedSpend(storage: Storage, month: string): number {
  return storage.read(
    (db) =>
      db
        .prepare('SELECT COALESCE(SUM(cost_usd), 0) FROM spend WHERE month = ? AND counted = 1')
        .pluck()
        .get(month) as number
  )
}

export interface SpendState {
  spentUsd: number
  budgetUsd: number
  /** False from 80% of the budget: memory extraction and the mood judge stop. */
  backgroundAllowed: boolean
  /** False from 100% of the budget: replies stop with the pack's limit line. */
  repliesAllowed: boolean
}

export function spendState(storage: Storage, budgetUsd: number, now: Clock = wallClock): SpendState {
  const spentUsd = countedSpend(storage, monthOf(now()))
  if (budgetUsd <= 0) {
    return {
      spentUsd,
      budgetUsd,
      backgroundAllowed: true,
      repliesAllowed: true
    }
  }
  return {
    spentUsd,
    budgetUsd,
    backgroundAllowed: spentUsd < budgetUsd * 0.8,
    repliesAllowed: spentUsd < budgetUsd
  }
}
