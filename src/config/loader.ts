import { readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { parse } from 'yaml'
import { type Logger, createLogger } from '../records/logger.js'
import { type Config, configSchema } from './schema.js'

/** A deployment fault in config.yml. Start-up stops with this one message. */
export class ConfigError extends Error {
  override name = 'ConfigError'
}

export interface LoadConfigOptions {
  origin?: string
  logger?: Logger
}

const IGNORED_TURN_KEYS = new Set(['mediaWaitMs'])
const IGNORED_DEPLOY_KEYS = new Set(['checkEveryMin', 'waitForIdleMs', 'healthTimeoutMs'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function withoutKeys(
  obj: Record<string, unknown>,
  drop: ReadonlySet<string>
): { rest: Record<string, unknown>; removed: string[] } {
  const rest: Record<string, unknown> = {}
  const removed: string[] = []
  for (const [key, value] of Object.entries(obj)) {
    if (drop.has(key)) removed.push(key)
    else rest[key] = value
  }
  return { rest, removed }
}

function stripIgnoredKeys(raw: unknown): { value: unknown; ignored: string[] } {
  if (!isRecord(raw)) return { value: raw, ignored: [] }
  const ignored: string[] = []
  let cleaned: Record<string, unknown> = { ...raw }

  if (isRecord(cleaned['turn'])) {
    const { rest, removed } = withoutKeys(cleaned['turn'], IGNORED_TURN_KEYS)
    if (removed.length > 0) {
      cleaned['turn'] = rest
      for (const key of removed) ignored.push(`turn.${key}`)
    }
  }

  if (isRecord(cleaned['deploy'])) {
    const { rest, removed } = withoutKeys(cleaned['deploy'], IGNORED_DEPLOY_KEYS)
    for (const key of removed) ignored.push(`deploy.${key}`)
    if (removed.length > 0 && Object.keys(rest).length === 0) {
      const { deploy: _deploy, ...withoutDeploy } = cleaned
      cleaned = withoutDeploy
    } else {
      cleaned['deploy'] = rest
    }
  }

  return { value: cleaned, ignored }
}

export function parseConfig(source: string, originOrOptions: string | LoadConfigOptions = 'config.yml'): Config {
  const origin = typeof originOrOptions === 'string' ? originOrOptions : (originOrOptions.origin ?? 'config.yml')
  const logger = typeof originOrOptions === 'string' ? undefined : originOrOptions.logger
  let raw: unknown
  try {
    raw = parse(source)
  } catch (cause) {
    throw new ConfigError(`${origin} is not valid YAML: ${(cause as Error).message}`)
  }
  const { value, ignored } = stripIgnoredKeys(raw)
  const result = configSchema.safeParse(value)
  if (!result.success) {
    const lines = result.error.issues.map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    throw new ConfigError(`${origin} is invalid:\n${lines.join('\n')}`)
  }
  if (ignored.length > 0) {
    const log = logger ?? createLogger({ level: 'warn', module: 'config' })
    for (const key of ignored) log.warn('config.ignored_key', { key })
  }
  return result.data
}

export function loadConfig(path: string, options: { logger?: Logger } = {}): Config {
  let source: string
  try {
    source = readFileSync(path, 'utf8')
  } catch (cause) {
    throw new ConfigError(`cannot read ${path}: ${(cause as Error).message}`)
  }
  return parseConfig(source, { origin: path, ...(options.logger ? { logger: options.logger } : {}) })
}

/**
 * Checks the values that are empty in the repository and set at install.
 * The service calls this at start-up; tests and the harness load the file without it.
 */
export function requireDeployable(config: Config): void {
  if (!isAbsolute(config.gateway.hostDataDir)) {
    throw new ConfigError('gateway.hostDataDir must be set to the absolute path of the data volume on the host')
  }
  if (config.llm.transport === 'api') {
    for (const key of ['provider', 'model', 'baseUrl'] as const) {
      if (config.llm.main[key] === '') throw new ConfigError(`llm.main.${key} must be set for the api transport`)
    }
  }
}
