import { modelRecordContext } from '../judge/systemone.js'
import { spendState } from '../models/spend.js'
import { type ModelClient, ModelError } from '../models/types.js'
import type { Logger } from '../records/logger.js'
import { type Redactor, createRedactor } from '../records/redact.js'
import { endJobRun, recordFailure, startJobRun } from '../records/turn-record.js'
import { getChat } from '../settings/chats.js'
import { resolveSetting } from '../settings/settings.js'
import type { Db, Storage } from '../storage/database.js'
import { type Job, completeJob, failJob, leaseNextJob } from '../storage/leases.js'
import type { Alerter } from '../turn/alerts.js'
import { type EpisodePayload, closeDueEpisodes } from './episodes.js'
import { episodeText, extract } from './extract.js'
import { addSummary, applyOperation, expireUpcoming, forgetEpoch, recordEvent } from './store.js'
import type { MemoryJudge, MemoryOperation } from './types.js'
import { type EpisodeMessage, memberLabels, precheck, validateOperation, validateSummary } from './validate.js'

// The memory worker (docs/trd/memory.md#write-path). One worker takes one job at a time, and the lease rule gives
// one chat's jobs in order. No transaction spans a model call: the job reads, asks the models, then applies
// everything in the one transaction that also marks it done.

/** A failed job retries after 1, 5, 20 and 60 minutes, then stays in the table as failed. */
export const RETRY_DELAYS_MS = [60_000, 300_000, 1_200_000, 3_600_000] as const
const LEASE_MS = 300_000
const EXTRACT_TIMEOUT_MS = 60_000

export interface MemoryWorkerOptions {
  storage: Storage
  config: {
    memory: { episodeIdleMs: number; episodeMaxMessages: number }
    judge: { memoryAdmit: number; memoryVerify: number; timeoutMs: number }
    llm: { main: { model: string }; monthlyBudgetUsd: number }
  }
  /** The routed client, so extraction retries, falls back and counts its spend like any other call. */
  client: ModelClient
  /** Absent means nothing is admitted: the judge fails closed. */
  judge?: MemoryJudge
  redactor?: Redactor
  logger: Logger
  alerter?: Alerter
  /** True while background work must wait, such as a critical disk level. */
  paused?: () => boolean
  owner?: string
  now?: () => Date
}

export type TickResult = 'idle' | 'paused' | 'done' | 'skipped' | 'retry' | 'failed' | 'lost'

export interface MemoryWorker {
  /** Closes due episodes, then runs at most one job. Never throws. */
  tick(): Promise<TickResult>
  /** Runs tick on a timer, one at a time. Returns the function that stops it. */
  start(everyMs: number): () => void
}

type Event = Parameters<typeof recordEvent>[2]

/** A job that cannot succeed on a retry. */
class Terminal extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

function memoryEnabled(storage: Storage, chatId: string): boolean {
  const chat = getChat(storage, chatId)
  return !chat || resolveSetting(storage, chat, 'features.memory').value !== false
}

export function createMemoryWorker(options: MemoryWorkerOptions): MemoryWorker {
  const { storage, config, client, judge, logger } = options
  const redactor = options.redactor ?? createRedactor()
  const now = options.now ?? (() => new Date())
  const owner = options.owner ?? `memory-${process.pid}`

  const timed = async <T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const controller = new AbortController()
    let timer: NodeJS.Timeout | undefined
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new ModelError('transient', 'timeout'))
      }, ms)
    })
    try {
      return await Promise.race([run(controller.signal), late])
    } finally {
      clearTimeout(timer)
    }
  }

  const readEpisode = (job: Job, payload: EpisodePayload): { messages: EpisodeMessage[]; epoch: number } =>
    storage.read((db) => {
      const rows = db
        .prepare(
          `SELECT id, role, sender_id, content, memory_skip FROM session_message
           WHERE chat_id = ? AND id >= ? AND id <= ? ORDER BY id`
        )
        .all(job.chatId, payload.fromId, payload.throughId) as {
        id: number
        role: 'user' | 'assistant'
        sender_id: string | null
        content: string
        memory_skip: number
      }[]
      return {
        epoch: forgetEpoch(db, job.chatId),
        messages: rows.map((row) => ({
          id: row.id,
          role: row.role,
          ...(row.sender_id === null ? {} : { senderId: row.sender_id }),
          content: row.content,
          skip: row.memory_skip === 1
        }))
      }
    })

  /** Ends the job as done and writes its events, in one transaction. False when the lease was lost. */
  const finish = (job: Job, events: Event[], apply?: (db: Db) => Event[]): boolean =>
    completeJob(
      storage,
      'memory_job',
      {
        jobId: job.jobId,
        owner,
        apply: (db) => {
          const all = [...events, ...(apply?.(db) ?? [])]
          for (const event of all) recordEvent(db, job.chatId, { ...event, jobId: job.jobId }, now)
        }
      },
      now
    )

  const describe = (operation: MemoryOperation, label: string): string =>
    operation.op === 'retire'
      ? `retire the fact "${operation.key}" about ${label}`
      : `${operation.op} the fact "${operation.key}" about ${label}: ${operation.value ?? ''}`

  const run = async (job: Job): Promise<TickResult> => {
    const skipped = (step: Event['step'], reason: string): TickResult =>
      finish(job, [{ step, outcome: 'skipped', reason }]) ? 'skipped' : 'lost'

    if (!memoryEnabled(storage, job.chatId)) return skipped('job', 'memory_off')

    let payload: EpisodePayload
    try {
      payload = JSON.parse(job.payload) as EpisodePayload
    } catch {
      throw new Terminal('invalid_payload')
    }
    const { messages, epoch } = readEpisode(job, payload)

    if (epoch !== payload.forgetEpoch) return skipped('job', 'forget_barrier')
    // A job never ends as done on a part of its episode.
    if (messages.length < payload.count) throw new Terminal('episode_pruned')
    if (!precheck(messages)) return skipped('precheck', 'nothing_to_extract')
    if (!judge) return skipped('admit', 'judge_unavailable')

    const labels = memberLabels(messages)
    const episode = episodeText(messages, labels)
    const admitted = await timed(config.judge.timeoutMs, (signal) => judge.admit({ episode }, signal))
    if (!(admitted >= config.judge.memoryAdmit)) return skipped('admit', 'below_threshold')

    const proposal = await timed(EXTRACT_TIMEOUT_MS, (signal) =>
      extract(client, { model: config.llm.main.model, episode }, signal)
    )

    const events: Event[] = []
    const accepted: MemoryOperation[] = []
    for (const proposed of proposal.operations) {
      const checked = validateOperation(proposed, messages, labels)
      if (!checked.ok) {
        events.push({ step: 'validate', outcome: 'rejected', op: proposed.op, reason: checked.reason })
        continue
      }
      const operation = checked.operation
      const label = operation.subjectId === undefined ? 'the chat' : (labels.get(operation.subjectId) ?? 'a member')
      // The judge fails closed: a no, a timeout or an error rejects this operation alone.
      let reason: string | undefined
      try {
        const supported = await timed(config.judge.timeoutMs, (signal) =>
          judge.verify({ operation: describe(operation, label), quote: operation.quote, episode }, signal)
        )
        if (!(supported >= config.judge.memoryVerify)) reason = 'not_supported'
      } catch {
        reason = 'judge_unavailable'
      }
      if (reason === undefined) accepted.push(operation)
      else events.push({ step: 'verify', outcome: 'rejected', op: operation.op, reason })
    }

    let summary: string | undefined
    if (proposal.summary !== undefined) {
      const text = proposal.summary.trim()
      let reason: string | undefined
      if (!validateSummary(text, messages)) reason = 'invalid_summary'
      else {
        try {
          const supported = await timed(config.judge.timeoutMs, (signal) =>
            judge.verify({ operation: 'store this one-sentence summary of the excerpt', quote: text, episode }, signal)
          )
          if (!(supported >= config.judge.memoryVerify)) reason = 'not_supported'
        } catch {
          reason = 'judge_unavailable'
        }
      }
      if (reason === undefined) summary = text
      else events.push({ step: 'verify', outcome: 'rejected', op: 'summary', reason })
    }

    if (!memoryEnabled(storage, job.chatId)) return skipped('job', 'memory_off')

    let barrier = false
    const done = finish(job, [], (db) => {
      // A forget in this chat after the job started: the whole job applies nothing.
      if (forgetEpoch(db, job.chatId) !== payload.forgetEpoch) {
        barrier = true
        return [{ step: 'job', outcome: 'skipped', reason: 'forget_barrier' }]
      }
      expireUpcoming(db, job.chatId, now)
      const applied: Event[] = [...events]
      let stored = 0
      for (const operation of accepted) {
        const outcome = applyOperation(db, job.chatId, operation, { jobId: job.jobId }, now)
        if (outcome.accepted) {
          stored += 1
          applied.push({ step: 'apply', outcome: 'accepted', op: operation.op, itemId: outcome.itemId })
        } else {
          applied.push({ step: 'apply', outcome: 'rejected', op: operation.op, reason: outcome.reason })
        }
      }
      // A summary is kept only beside a fact: an episode with nothing lasting leaves nothing.
      if (summary !== undefined && stored > 0) {
        const itemId = addSummary(db, job.chatId, { kind: 'episode', value: summary, jobId: job.jobId }, now)
        applied.push({ step: 'apply', outcome: 'accepted', op: 'summary', itemId })
      }
      applied.push({ step: 'job', outcome: 'done' })
      return applied
    })
    if (!done) return 'lost'
    return barrier ? 'skipped' : 'done'
  }

  const fail = (job: Job, code: string, retry: boolean, error: unknown): TickResult => {
    const state = failJob(
      storage,
      'memory_job',
      { jobId: job.jobId, owner, error: code, retryDelaysMs: retry ? RETRY_DELAYS_MS : [] },
      now
    )
    if (state === undefined) return 'lost'
    // Events keep reason codes; the failure keeps the redacted error and stack for every attempt.
    storage.tx((db) => {
      recordEvent(db, job.chatId, { jobId: job.jobId, step: 'job', outcome: 'failed', reason: code }, now)
      recordFailure(
        db,
        { jobId: job.jobId, stage: 'memory', kind: 'memory_job_failed', error, handledBy: state },
        redactor,
        now
      )
    })
    logger.warn('memory.job_failed', {
      job: job.jobId,
      code,
      state,
      error: error instanceof Terminal ? undefined : error
    })
    if (state === 'failed') options.alerter?.raise('memory_job_failed', { job: job.jobId, code })
    return state === 'failed' ? 'failed' : 'retry'
  }

  const tick = async (): Promise<TickResult> => {
    let job: Job | undefined
    let runId: number | undefined
    let outcome: TickResult = 'lost'
    try {
      // From 80% of the monthly budget, background work stops before replies do. Jobs wait in the queue.
      if (options.paused?.() || !spendState(storage, config.llm.monthlyBudgetUsd, now).backgroundAllowed) {
        return 'paused'
      }
      closeDueEpisodes(
        storage,
        { idleMs: config.memory.episodeIdleMs, maxMessages: config.memory.episodeMaxMessages },
        now
      )
      job = leaseNextJob(storage, 'memory_job', { owner, leaseMs: LEASE_MS }, now)
      if (!job) return 'idle'
      const leased = job
      runId = storage.tx((db) => startJobRun(db, { kind: 'memory', jobId: leased.jobId, chatId: leased.chatId }, now))
      outcome = await modelRecordContext.run({ jobId: leased.jobId }, () => run(leased))
      return outcome
    } catch (error) {
      if (!job) {
        logger.error('memory.tick_failed', { error })
        return 'idle'
      }
      try {
        outcome =
          error instanceof Terminal
            ? fail(job, error.code, false, error)
            : fail(job, error instanceof ModelError ? `model_${error.kind}` : 'internal', true, error)
        return outcome
      } catch (inner) {
        logger.error('memory.fail_failed', { job: job.jobId, error: inner })
        return 'lost'
      }
    } finally {
      if (runId !== undefined) {
        const id = runId
        try {
          storage.tx((db) => endJobRun(db, id, { outcome }, now))
        } catch (error) {
          logger.error('memory.run_record_failed', { error })
        }
      }
    }
  }

  return {
    tick,
    start(everyMs) {
      let busy = false
      const timer = setInterval(() => {
        if (busy) return
        busy = true
        void tick().finally(() => {
          busy = false
        })
      }, everyMs)
      timer.unref()
      return () => clearInterval(timer)
    }
  }
}
