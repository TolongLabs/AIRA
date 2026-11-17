// One list of failure kinds for records, alerts and tests (docs/trd/records.md#failure-kinds).

export const FAILURE_KINDS = [
  'transient',
  'rate_limit',
  'auth',
  'refusal',
  'malformed',
  'budget',
  'tool_timeout',
  'tool_error',
  'tool_refused',
  'judge_unavailable',
  'media_unreadable',
  'memory_rejected',
  'memory_job_failed',
  'config_invalid',
  'binding_invalid',
  'gateway_malformed',
  'gateway_unmarked',
  'turn_interrupted',
  'storage_error',
  'storage_low_space',
  'backup_failed',
  'backup_stale',
  'internal'
] as const

export type FailureKind = (typeof FAILURE_KINDS)[number]

const FAILURE_KIND_SET: ReadonlySet<string> = new Set(FAILURE_KINDS)

export function isFailureKind(value: string): value is FailureKind {
  return FAILURE_KIND_SET.has(value)
}
