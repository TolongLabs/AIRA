import { appendFileSync } from 'node:fs'
import type { FailureKind } from '../records/kinds.js'
import type { Logger } from '../records/logger.js'
import type { Storage } from '../storage/database.js'
import { insertFailure } from '../storage/failures.js'

// Operator alerts (docs/trd/reliability.md#operator-alerts): rate limited per kind.

export type AlertKind =
  | 'binding_invalid'
  | 'pack_invalid'
  | 'model_auth'
  | 'breaker_open'
  | 'memory_job_failed'
  | 'spend'
  | 'deploy_health'
  | 'storage'
  | 'turn_interrupted'

export interface Alerter {
  /** Raises one alert. Returns false when the same kind was raised less than minGapMs ago. */
  raise(kind: AlertKind, detail: Record<string, unknown>): boolean
}

export function createAlerter(options: {
  minGapMs: number
  logger: Logger
  storage?: Storage
  /** Durable delivery on the data volume. */
  deliveryFile?: string
  /** Optional additional delivery sink. */
  send?: (kind: AlertKind, detail: Record<string, unknown>) => void
  now?: () => Date
}): Alerter {
  const last = new Map<AlertKind, number>()
  const now = options.now ?? (() => new Date())
  return {
    raise(kind, detail) {
      const at = now().getTime()
      const previous = last.get(kind)
      if (previous !== undefined && at - previous < options.minGapMs) return false
      last.set(kind, at)
      const failureKind: FailureKind =
        kind === 'spend'
          ? 'budget'
          : kind === 'model_auth'
            ? 'auth'
            : kind === 'storage'
              ? 'storage_error'
              : kind === 'pack_invalid' || kind === 'deploy_health'
                ? 'config_invalid'
                : kind === 'breaker_open'
                  ? 'rate_limit'
                  : kind
      options.storage?.tx((db) =>
        insertFailure(
          db,
          {
            turnId: typeof detail['turnId'] === 'string' ? detail['turnId'] : undefined,
            jobId: typeof detail['jobId'] === 'string' ? detail['jobId'] : undefined,
            stage: 'alert',
            kind: failureKind,
            message: `operator alert: ${kind}`,
            handledBy: 'operator'
          },
          now
        )
      )
      options.logger
        .child({ module: 'alerts', ...(typeof detail['turnId'] === 'string' ? { turnId: detail['turnId'] } : {}) })
        .error('alert', { kind, ...detail })
      try {
        if (options.deliveryFile)
          appendFileSync(options.deliveryFile, JSON.stringify({ kind, time: new Date(at).toISOString() }) + '\n', {
            mode: 0o600
          })
        options.send?.(kind, detail)
      } catch (error) {
        options.logger.error('alert.send_failed', { kind, error })
      }
      return true
    }
  }
}
