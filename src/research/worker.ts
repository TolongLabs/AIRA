import type { Config } from '../config/schema.js'
import { spendState } from '../models/spend.js'
import { type ModelClient, ModelError } from '../models/types.js'
import type { FailureKind } from '../records/kinds.js'
import type { Logger } from '../records/logger.js'
import { createRedactor, type Redactor } from '../records/redact.js'
import type { Storage } from '../storage/database.js'
import { insertFailure } from '../storage/failures.js'
import { completeJob, failJob, leaseNextJob } from '../storage/leases.js'
import type { PagePort, SearchPort } from '../tools/ports.js'
import { runResearch } from './job.js'

export type ResearchWorker = ReturnType<typeof createResearchWorker>

export function createResearchWorker(options: {
  storage: Storage
  config: Pick<Config, 'research' | 'llm'>
  client: ModelClient | ((jobId: string) => ModelClient)
  search: SearchPort
  page: PagePort
  schedule: { sync(): void }
  logger: Logger
  redactor?: Redactor
  now?: () => Date
  owner?: string
}) {
  const { storage, config } = options
  const now = options.now ?? (() => new Date())
  const owner = options.owner ?? `research-${process.pid}`
  const redactor = options.redactor ?? createRedactor()
  let busy = false
  const tick = async (): Promise<'idle' | 'done' | 'failed' | 'lost'> => {
    if (busy) return 'idle'
    busy = true
    let job: ReturnType<typeof leaseNextJob>
    let expired = false
    try {
      expired = storage.read((db) =>
        Boolean(
          db
            .prepare("SELECT 1 FROM research_job WHERE state = 'running' AND lease_expires_at <= ? LIMIT 1")
            .get(now().toISOString())
        )
      )
      job = leaseNextJob(storage, 'research_job', { owner, leaseMs: config.research.deadlineMs + 1000 }, now)
      if (!job) return 'idle'
      storage.tx((db) =>
        db.prepare('UPDATE research_job SET started_at = ? WHERE job_id = ?').run(now().toISOString(), job!.jobId)
      )
      const payload = JSON.parse(job.payload) as { topic: string }
      const client = typeof options.client === 'function' ? options.client(job.jobId) : options.client
      const findings = await runResearch({
        topic: payload.topic,
        client,
        model: config.llm.main.model,
        search: options.search,
        page: options.page,
        limits: config.research,
        spendAllows: () => spendState(storage, config.llm.monthlyBudgetUsd, now).repliesAllowed,
        now
      })
      const id = job.jobId
      return completeJob(
        storage,
        'research_job',
        {
          jobId: id,
          owner,
          apply: (db) => {
            db.prepare('UPDATE research_job SET findings = ?, ended_at = ? WHERE job_id = ?').run(
              JSON.stringify(findings),
              now().toISOString(),
              id
            )
          }
        },
        now
      )
        ? 'done'
        : 'lost'
    } catch (error) {
      if (!job) {
        options.logger.error('research.tick_failed', { error })
        return 'idle'
      }
      const state = failJob(
        storage,
        'research_job',
        { jobId: job.jobId, owner, error: 'research_failed', retryDelaysMs: [] },
        now
      )
      if (!state) return 'lost'
      const id = job.jobId
      const kind: FailureKind = error instanceof ModelError ? error.kind : 'internal'
      const rawMessage = error instanceof Error ? error.message : String(error)
      const message = redactor.scrub(rawMessage || 'research_failed')
      const stack = error instanceof Error && error.stack !== undefined ? redactor.scrub(error.stack) : undefined
      storage.tx((db) => {
        db.prepare('UPDATE research_job SET ended_at = ? WHERE job_id = ?').run(now().toISOString(), id)
        insertFailure(
          db,
          {
            jobId: id,
            stage: 'research',
            kind,
            message,
            ...(stack === undefined ? {} : { stack }),
            handledBy: 'line:researchFailed'
          },
          now
        )
      })
      options.logger.warn('research.job_failed', { jobId: id, kind, message })
      return 'failed'
    } finally {
      busy = false
      try {
        if (job || expired) options.schedule.sync()
      } catch (error) {
        options.logger.warn('research.schedule_failed', { error })
      }
    }
  }
  return {
    tick,
    start(everyMs: number): () => Promise<void> {
      let inFlight: Promise<unknown> | undefined
      const timer = setInterval(() => {
        if (!inFlight)
          inFlight = tick().finally(() => {
            inFlight = undefined
          })
      }, everyMs)
      timer.unref()
      return async () => {
        clearInterval(timer)
        await inFlight
      }
    }
  }
}
