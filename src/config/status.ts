import { createHash } from 'node:crypto'
import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs'
import { parseConfig } from './loader.js'
import type { Config } from './schema.js'

// Deployment configuration activation readback
// (docs/trd/dashboard-state.md#deployment-activation-readback). The running
// process keeps the revision of exactly the Config it parsed at start-up,
// including normalization, and rereads the same authoritative path on demand.
// The endpoint returns only opaque tokens and status/timestamps.

export type ConfigReadStatus = 'current' | 'pending_restart' | 'invalid' | 'inaccessible' | 'memory_only'

export interface ConfigStatusSnapshot {
  appliedRevision: string | null
  currentRevision: string | null
  status: ConfigReadStatus
  checkedAt: string
  appliedAt: string
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (typeof value === 'object' && value !== null) {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key])
    }
    return sorted
  }
  return value
}

/** The opaque revision token for a parsed Config: SHA-256 hex of canonical JSON. */
export function revisionForConfig(config: Config): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(config)))
    .digest('hex')
}

export interface ConfigStatusOptions {
  config: Config
  /** The exact path parsed at start-up. Absent means injected in-memory config with no source file. */
  configPath?: string
  appliedAt?: Date
  now?: () => Date
}

export interface ConfigStatus {
  readonly appliedRevision: string
  readonly appliedAt: string
  read(): ConfigStatusSnapshot
}

/** Capture the applied revision once; `read` rereads the same path on demand. */
export function createConfigStatus(options: ConfigStatusOptions): ConfigStatus {
  const now = options.now ?? (() => new Date())
  const appliedRevision = revisionForConfig(options.config)
  const appliedAt = (options.appliedAt ?? now()).toISOString()
  const configPath = options.configPath
  return {
    appliedRevision,
    appliedAt,
    read(): ConfigStatusSnapshot {
      const checkedAt = now().toISOString()
      if (!configPath) {
        return { appliedRevision, currentRevision: null, status: 'memory_only', checkedAt, appliedAt }
      }
      let source: string
      try {
        const fd = openSync(configPath, 'r')
        try {
          source = readFileSync(fd, 'utf8')
          if (fstatSync(fd).nlink === 0) {
            return { appliedRevision, currentRevision: null, status: 'inaccessible', checkedAt, appliedAt }
          }
        } finally {
          closeSync(fd)
        }
      } catch {
        return { appliedRevision, currentRevision: null, status: 'inaccessible', checkedAt, appliedAt }
      }
      let current: Config
      try {
        current = parseConfig(source, { origin: 'config' })
      } catch {
        return { appliedRevision, currentRevision: null, status: 'invalid', checkedAt, appliedAt }
      }
      const currentRevision = revisionForConfig(current)
      if (currentRevision !== appliedRevision) {
        return { appliedRevision, currentRevision, status: 'pending_restart', checkedAt, appliedAt }
      }
      return { appliedRevision, currentRevision, status: 'current', checkedAt, appliedAt }
    }
  }
}
