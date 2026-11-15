import { readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { parse } from 'yaml'
import { type Config, configSchema } from './schema.js'

/** A deployment fault in config.yml. Start-up stops with this one message. */
export class ConfigError extends Error {
  override name = 'ConfigError'
}

export function parseConfig(source: string, origin = 'config.yml'): Config {
  let raw: unknown
  try {
    raw = parse(source)
  } catch (cause) {
    throw new ConfigError(`${origin} is not valid YAML: ${(cause as Error).message}`)
  }
  const result = configSchema.safeParse(raw)
  if (!result.success) {
    const lines = result.error.issues.map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    throw new ConfigError(`${origin} is invalid:\n${lines.join('\n')}`)
  }
  return result.data
}

export function loadConfig(path: string): Config {
  let source: string
  try {
    source = readFileSync(path, 'utf8')
  } catch (cause) {
    throw new ConfigError(`cannot read ${path}: ${(cause as Error).message}`)
  }
  return parseConfig(source, path)
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
