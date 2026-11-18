import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import type { Logger } from '../records/logger.js'
import type { Redactor } from '../records/redact.js'
import type { Storage } from '../storage/database.js'
import { insertFailure } from '../storage/failures.js'
import { classifyFeedbackSubmission, type FeedbackSubmission, feedbackCursor, hasOpenFeedback } from './store.js'

const BATCH_LIMIT = 100
const TIMEOUT_MS = 10_000
const MAX_RESPONSE_BYTES = 1024 * 1024
const MAX_REDIRECTS = 5
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

const answersSchema = z.strictObject({
  whatWentWrong: z.string().max(4000),
  expected: z.string().max(4000),
  kind: z.string().max(200),
  when: z.string().max(200),
  severity: z.string().max(200)
})

const rowSchema = z.strictObject({
  seq: z.number().int().positive().safe(),
  ref: z.string().max(512),
  submittedAt: z.iso.datetime({ offset: true }).max(40),
  answers: answersSchema
})

const batchSchema = z.strictObject({
  rows: z.array(rowSchema).max(BATCH_LIMIT),
  after: z.number().int().nonnegative().safe()
})

const errorSchema = z.strictObject({ error: z.enum(['denied', 'invalid_request', 'unavailable']) })

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
type RemoteError = z.infer<typeof errorSchema>['error']
type SyncFailureReason = RemoteError | 'http' | 'malformed' | 'network' | 'timeout' | 'too_large'

export interface FeedbackSync {
  tick(): Promise<void>
  start(intervalMs: number): () => Promise<void>
}

export interface FeedbackSyncOptions {
  storage: Storage
  url: string
  secret: string
  enabled(): boolean
  redactor: Redactor
  logger: Logger
  now?: () => Date
  fetch?: Fetch
  onFailure?: () => void
}

class SyncFailure extends Error {
  constructor(readonly reason: SyncFailureReason) {
    super(`feedback sync failed: ${reason}`)
  }
}

async function readBoundedBody(response: Response): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const parts: string[] = []
  let bytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel()
        throw new SyncFailure('too_large')
      }
      parts.push(decoder.decode(chunk.value, { stream: true }))
    }
    parts.push(decoder.decode())
    return parts.join('')
  } finally {
    reader.releaseLock()
  }
}

function validateBatch(value: unknown, cursor: number): { rows: FeedbackSubmission[]; after: number } {
  const parsed = batchSchema.safeParse(value)
  if (!parsed.success) throw new SyncFailure('malformed')
  let previous = 0
  for (const row of parsed.data.rows) {
    if (row.seq <= previous) throw new SyncFailure('malformed')
    previous = row.seq
  }
  if (parsed.data.after < cursor || (previous > 0 && parsed.data.after < previous)) {
    throw new SyncFailure('malformed')
  }
  return parsed.data
}

function failureReason(error: unknown): SyncFailureReason {
  if (error instanceof SyncFailure) return error.reason
  if (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) return 'timeout'
  return 'network'
}

async function fetchBatch(options: FeedbackSyncOptions, cursor: number, fetcher: Fetch): Promise<FeedbackSubmission[]> {
  let endpoint: URL
  try {
    endpoint = new URL(options.url)
  } catch {
    throw new SyncFailure('invalid_request')
  }
  if (endpoint.protocol !== 'https:') throw new SyncFailure('invalid_request')

  const signal = AbortSignal.timeout(TIMEOUT_MS)
  let method = 'POST'
  let headers: RequestInit['headers'] = { 'content-type': 'application/json' }
  let body: string | undefined = JSON.stringify({ secret: options.secret, after: cursor, limit: BATCH_LIMIT })
  let response: Response | undefined

  for (let redirects = 0; ; redirects++) {
    try {
      response = await fetcher(endpoint, { method, headers, body, signal, redirect: 'manual' })
    } catch (error) {
      throw new SyncFailure(failureReason(error))
    }

    if (!REDIRECT_STATUSES.has(response.status)) break
    await response.body?.cancel()
    if (redirects >= MAX_REDIRECTS) throw new SyncFailure('http')

    const location = response.headers.get('location')
    if (!location) throw new SyncFailure('http')
    let next: URL
    try {
      next = new URL(location, endpoint)
    } catch {
      throw new SyncFailure('invalid_request')
    }
    if (next.protocol !== 'https:') throw new SyncFailure('invalid_request')

    endpoint = next
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
      method = 'GET'
      headers = undefined
      body = undefined
    }
  }

  if (!response.ok) throw new SyncFailure('http')

  const text = await readBoundedBody(response)
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch {
    throw new SyncFailure('malformed')
  }
  const remoteError = errorSchema.safeParse(value)
  if (remoteError.success) throw new SyncFailure(remoteError.data.error)
  return validateBatch(value, cursor).rows
}

/** A single non-overlapping outbound puller. It performs no call when no usable report is open. */
export function createFeedbackSync(options: FeedbackSyncOptions): FeedbackSync {
  const now = options.now ?? (() => new Date())
  const fetcher = options.fetch ?? fetch
  const log = options.logger.child({ module: 'feedback_sync' })
  let inFlight: Promise<void> | undefined

  const run = async (): Promise<void> => {
    if (!options.enabled() || options.url === '' || options.secret === '') return
    const startedAt = now().toISOString()
    if (!options.storage.read((db) => hasOpenFeedback(db, startedAt))) return

    const jobId = `feedback_${randomBytes(6).toString('hex')}`
    const runId = options.storage.tx((db) => {
      const result = db
        .prepare("INSERT INTO job_run (kind, job_id, started_at) VALUES ('feedback_sync', ?, ?)")
        .run(jobId, startedAt)
      return Number(result.lastInsertRowid)
    })

    let counts = { rows: 0, received: 0, rejected: 0, replayed: 0 }
    try {
      const cursor = options.storage.read((db) => feedbackCursor(db))
      const rows = await fetchBatch(options, cursor, fetcher)
      counts = { ...counts, rows: rows.length }
      for (const row of rows) {
        const classification = options.storage.tx((db) =>
          classifyFeedbackSubmission(db, row, { nowIso: now().toISOString(), jobId })
        )
        if (classification === 'received') counts.received += 1
        else if (classification === 'rejected') counts.rejected += 1
        else counts.replayed += 1
      }
      const endedAt = now().toISOString()
      options.storage.tx((db) => {
        db.prepare("UPDATE job_run SET ended_at = ?, outcome = 'ok', counts = ? WHERE id = ?").run(
          endedAt,
          JSON.stringify(counts),
          runId
        )
      })
      log.info('feedback.synced', { jobId, ...counts })
    } catch (error) {
      const reason = failureReason(error)
      const endedAt = now().toISOString()
      const message = options.redactor.scrub(`feedback sync failed: ${reason}`)
      try {
        options.storage.tx((db) => {
          db.prepare("UPDATE job_run SET ended_at = ?, outcome = 'failed', counts = ? WHERE id = ?").run(
            endedAt,
            JSON.stringify(counts),
            runId
          )
          insertFailure(
            db,
            {
              jobId,
              stage: 'feedback_sync',
              kind: 'feedback_sync_failed',
              message,
              handledBy: 'feedback_sync'
            },
            () => new Date(endedAt)
          )
        })
      } catch (recordError) {
        log.error('feedback.record_failed', { jobId, reason, error: recordError })
      }
      log.warn('feedback.sync_failed', { jobId, reason })
      try {
        options.onFailure?.()
      } catch (alertError) {
        log.error('feedback.alert_failed', { jobId, error: alertError })
      }
    }
  }

  const tick = (): Promise<void> => {
    if (inFlight) return inFlight
    inFlight = run().finally(() => {
      inFlight = undefined
    })
    return inFlight
  }

  return {
    tick,
    start(intervalMs) {
      const timer = setInterval(() => void tick(), intervalMs)
      timer.unref()
      return async () => {
        clearInterval(timer)
        await inFlight
      }
    }
  }
}
