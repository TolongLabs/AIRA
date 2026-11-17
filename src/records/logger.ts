import { createRedactor, type Redactor } from './redact.js'

// Structured JSON lines on standard output (docs/trd/records.md#logs).
// Every line has: time, level, module, event, and a turn id or job id when one applies.

export type LogLevel = 'error' | 'warn' | 'info' | 'debug'

const RANK: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 }

export interface LogContext {
  module: string
  turnId?: string
  jobId?: string
}

export type LogFields = Record<string, unknown>

export interface Logger {
  error(event: string, fields?: LogFields): void
  warn(event: string, fields?: LogFields): void
  info(event: string, fields?: LogFields): void
  debug(event: string, fields?: LogFields): void
  child(context: Partial<LogContext>): Logger
}

export interface LoggerOptions {
  level: LogLevel
  module: string
  redactor?: Redactor
  /** Receives one JSON line without a trailing newline. Defaults to standard output. */
  sink?: (line: string) => void
  now?: () => Date
}

function serialise(value: unknown, redactor: Redactor, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactor.scrub(value)
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'function' || typeof value === 'symbol') return undefined
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return '[circular]'
  seen.add(value)
  if (value instanceof Error) {
    const out: Record<string, unknown> = {
      name: value.name,
      message: redactor.scrub(value.message),
      stack: value.stack === undefined ? undefined : redactor.scrub(value.stack)
    }
    if ('code' in value) out['code'] = serialise(value.code, redactor, seen)
    if (value.cause !== undefined) out['cause'] = serialise(value.cause, redactor, seen)
    return out
  }
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map((item) => serialise(item, redactor, seen))
  return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, serialise(inner, redactor, seen)]))
}

/** A variable whose name marks it as a secret. Masking every value hid ordinary words such as `check` (#159). */
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIALS?)$/i

/** The values of the environment variables that hold secrets, for a logger built without its own redactor. */
export function secretEnvValues(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === 'string' && value !== '' && SECRET_NAME.test(name)) out[name] = value
  }
  return out
}

export function createLogger(options: LoggerOptions): Logger {
  const redactor = options.redactor ?? createRedactor({ secrets: secretEnvValues(process.env) })
  const sink = options.sink ?? ((line: string) => void process.stdout.write(line + '\n'))
  const now = options.now ?? (() => new Date())

  const build = (context: LogContext): Logger => {
    const write = (level: LogLevel, event: string, fields: LogFields = {}) => {
      if (RANK[level] > RANK[options.level]) return
      const { turnId, jobId, job, ...fieldsWithoutAliases } = fields
      const fieldTurnId = typeof turnId === 'string' ? turnId : undefined
      const fieldJobId = typeof jobId === 'string' ? jobId : typeof job === 'string' ? job : undefined
      const line = {
        ...(serialise(fieldsWithoutAliases, redactor, new WeakSet()) as LogFields),
        time: now().toISOString(),
        level,
        module: context.module,
        event,
        ...((context.turnId ?? fieldTurnId) === undefined ? {} : { turn_id: context.turnId ?? fieldTurnId }),
        ...((context.jobId ?? fieldJobId) === undefined ? {} : { job_id: context.jobId ?? fieldJobId })
      }
      sink(JSON.stringify(line))
    }
    return {
      error: (event, fields) => write('error', event, fields),
      warn: (event, fields) => write('warn', event, fields),
      info: (event, fields) => write('info', event, fields),
      debug: (event, fields) => write('debug', event, fields),
      child: (extra) => build({ ...context, ...extra })
    }
  }

  return build({ module: options.module })
}
