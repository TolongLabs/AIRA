import { mkdirSync, readdirSync, rmSync, statfsSync } from 'node:fs'
import { join } from 'node:path'
import type { Storage } from './database.js'
import { insertFailure } from './failures.js'

// The disk guard (docs/trd/storage.md#disk-guard). Warn and critical come from free space; the error level is
// the storage module's own handling of a failed write.

export type DiskLevel = 'ok' | 'warn' | 'critical'

export interface DiskState {
  level: DiskLevel
  freeMb: number
  /** Work that must not run at this level. Replies and turn records are never paused. */
  paused: { archive: boolean; mediaCache: boolean; memoryExtraction: boolean }
}

export interface DiskGuardOptions {
  dataDir: string
  minFreeMb: number
  criticalFreeMb: number
  storage?: Storage
  /** Called once each time the level changes to warn or critical. */
  onAlert?: (state: DiskState) => void
  onError?: (error: unknown) => void
  /** Free space in megabytes. Replaced in tests. */
  freeMb?: (dir: string) => number
  now?: () => Date
}

export interface DiskGuard {
  /** Measures free space, applies the level's actions and returns the new state. */
  check(): DiskState
  state(): DiskState
  /** Checks every intervalMs until the returned function is called. */
  start(intervalMs: number, onError?: (error: unknown) => void): () => void
}

export function freeMegabytes(dir: string): number {
  const stats = statfsSync(dir)
  return Math.floor((stats.bavail * stats.bsize) / (1024 * 1024))
}

export function emptyDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
  for (const entry of readdirSync(dir)) rmSync(join(dir, entry), { recursive: true, force: true })
}

export function createDiskGuard(options: DiskGuardOptions): DiskGuard {
  let onError = options.onError
  const measure = options.freeMb ?? freeMegabytes
  let current: DiskState = {
    level: 'ok',
    freeMb: Number.POSITIVE_INFINITY,
    paused: { archive: false, mediaCache: false, memoryExtraction: false }
  }

  const check = (): DiskState => {
    const freeMb = measure(options.dataDir)
    const level: DiskLevel = freeMb < options.criticalFreeMb ? 'critical' : freeMb < options.minFreeMb ? 'warn' : 'ok'
    const next: DiskState = {
      level,
      freeMb,
      paused: { archive: level !== 'ok', mediaCache: level !== 'ok', memoryExtraction: level === 'critical' }
    }
    const changed = next.level !== current.level
    current = next
    if (level !== 'ok') {
      // The cache is rebuilt on demand, so it is the first thing emptied.
      try {
        emptyDir(join(options.dataDir, 'cache'))
      } catch (error) {
        onError?.(error)
      }
    }
    if (changed && level !== 'ok') {
      try {
        options.storage?.tx((db) =>
          insertFailure(
            db,
            {
              stage: 'disk_guard',
              kind: 'storage_low_space',
              message: `free space is ${freeMb} MB, level ${level}`,
              handledBy: 'disk_guard'
            },
            options.now
          )
        )
      } catch (error) {
        onError?.(error)
      }
      options.onAlert?.(next)
    }
    return next
  }

  return {
    check,
    state: () => current,
    start: (intervalMs, reportError = options.onError) => {
      onError = reportError
      const timer = setInterval(() => {
        try {
          check()
        } catch (error) {
          onError?.(error)
        }
      }, intervalMs)
      timer.unref()
      return () => clearInterval(timer)
    }
  }
}
