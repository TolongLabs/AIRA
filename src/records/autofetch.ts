import { createHash, randomUUID } from 'node:crypto'
import type { SocialLookupTrace, SocialPostLookup } from '../social/types.js'
import type { SocialPostTarget } from '../social/urls.js'
import type { Db, Storage } from '../storage/database.js'

const ATTEMPT_IDS = new Set([
  'x.fxtwitter',
  'bluesky.api',
  'threads.page',
  'instagram.page',
  'facebook.page',
  'reddit.feed',
  'youtube.oembed',
  'yt_dlp'
])
const REASONS = new Set([
  'timeout',
  'redirect',
  'binary_missing',
  'network_error',
  'missing_post',
  'no_post_data',
  'cache_hit',
  'repeat',
  'platform_excluded',
  'no_verified_attachment'
])
const receiptLifetimeMs = 10 * 60_000

function safeReason(reason?: string): string | null {
  if (!reason) return null
  if (REASONS.has(reason)) return reason
  if (reason === 'http_429') return 'rate_limited'
  if (reason === 'http_401' || reason === 'http_403') return 'access_refused'
  return 'unknown'
}

function elapsed(started: number, ended: number, limit: number): number {
  return Math.min(limit, Math.max(0, Math.round(ended - started) || 0))
}

export function recordAutofetchLookup(
  db: Db,
  data: {
    runId: number
    ordinal: number
    target: SocialPostTarget
    started: Date
    ended: Date
    lookup?: SocialPostLookup
    trace?: SocialLookupTrace
    skip?: 'repeat' | 'platform_excluded'
    eligible: number
    downloaded: number
  }
): void {
  const { runId, ordinal, target, started, ended, lookup, trace, skip, eligible, downloaded } = data
  const outcome = skip
    ? 'skipped'
    : lookup?.status === 'found'
      ? lookup.missing?.length
        ? 'partial'
        : 'readable'
      : 'failed'
  const reason =
    skip ??
    (lookup?.status === 'failed' ? lookup.reason : trace?.reason) ??
    (lookup?.status === 'found' && eligible === 0 ? 'no_verified_attachment' : undefined)
  const attempts = (trace?.attempts ?? []).slice(0, 4).map((attempt) => ({
    reader: ATTEMPT_IDS.has(attempt.readerId) ? attempt.readerId : 'unknown',
    ok: attempt.ok,
    reason: safeReason(attempt.reason),
    ms: elapsed(0, attempt.ms, 6_000)
  }))
  const inputForm =
    target.needsRedirect || target.lookupKey.includes(':share:') || target.lookupKey.includes('-share:')
      ? 'share'
      : 'direct'
  db.prepare(
    `INSERT INTO social_lookup
      (job_run_id, ordinal, started_at, elapsed_ms, platform, input_form, outcome, reason, attempts, eligible_files, downloaded_files)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    runId,
    ordinal,
    started.toISOString(),
    elapsed(started.getTime(), ended.getTime(), 60_000),
    target.platform,
    inputForm,
    outcome,
    safeReason(reason),
    JSON.stringify(attempts),
    eligible,
    downloaded
  )
}

function digest(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

export function recordAutofetchHandoff(
  db: Db,
  runId: number,
  slots: readonly ('image' | 'video')[],
  now: Date
): string {
  const key = randomUUID()
  db.prepare('DELETE FROM autofetch_delivery_key WHERE expires_at <= ?').run(now.toISOString())
  db.prepare('INSERT INTO autofetch_delivery (job_run_id, started_at, slots) VALUES (?, ?, ?)').run(
    runId,
    now.toISOString(),
    JSON.stringify(slots)
  )
  db.prepare('INSERT INTO autofetch_delivery_key (job_run_id, digest, expires_at) VALUES (?, ?, ?)').run(
    runId,
    digest(key),
    new Date(now.getTime() + receiptLifetimeMs).toISOString()
  )
  return key
}

const VALID_JOB = '(SELECT job_run_id FROM autofetch_delivery_key WHERE digest = ? AND expires_at > ?)'

export function claimAutofetchDelivery(storage: Storage, key: string, now: Date): boolean {
  const at = now.toISOString()
  return storage.tx(
    (db) =>
      db
        .prepare(`UPDATE autofetch_delivery SET claimed_at = ? WHERE job_run_id = ${VALID_JOB} AND claimed_at IS NULL`)
        .run(at, digest(key), at).changes === 1
  )
}

export function completeAutofetchDelivery(storage: Storage, key: string, outcomes: boolean[], now: Date): boolean {
  const at = now.toISOString()
  return storage.tx(
    (db) =>
      db
        .prepare(
          `UPDATE autofetch_delivery SET completed_at = ?, outcomes = ?
     WHERE job_run_id = ${VALID_JOB} AND claimed_at IS NOT NULL AND completed_at IS NULL
     AND json_array_length(slots) = ?`
        )
        .run(at, JSON.stringify(outcomes), digest(key), at, outcomes.length).changes === 1
  )
}
