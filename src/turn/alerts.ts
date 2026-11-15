import type { Logger } from '../records/logger.js'

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
  /** Sends the alert to the owner's own chat. Absent until a delivery path for alerts exists. */
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
      options.logger.error('alert', { kind, ...detail })
      try {
        options.send?.(kind, detail)
      } catch (error) {
        options.logger.error('alert.send_failed', { kind, error })
      }
      return true
    }
  }
}
