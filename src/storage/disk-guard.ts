import { type Stats, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, statfsSync, unlinkSync } from 'node:fs'
import { join, sep } from 'node:path'
import { type Logger, createLogger } from '../records/logger.js'
import type { Storage } from './database.js'
import { insertFailure } from './failures.js'

// The disk guard (docs/trd/storage.md#disk-guard). Warn and critical come from free space; the error level is
// the storage module's own handling of a failed write.

const DEFAULT_CACHE_MAX_MB = 512
const BYTES_PER_MB = 1024 * 1024
const CACHE_TRIM_RATIO = 0.9

export type DiskLevel = 'ok' | 'warn' | 'critical'

export interface DiskState {
  level: DiskLevel
  freeMb: number
  /** Work that must not run at this level. Replies and turn records are never paused. */
  paused: { archive: boolean; mediaCache: boolean; memoryExtraction: boolean }
}

export interface CacheTrimResult {
  bytesFreed: number
  fileCount: number
}

export interface DiskGuardOptions {
  dataDir: string
  minFreeMb: number
  criticalFreeMb: number
  cacheMaxMb?: number
  storage?: Storage
  logger?: Logger
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

interface CacheFile {
  path: string
  size: number
  mtimeMs: number
}

function ignoreMissing<T>(fn: () => T): T | undefined {
  try {
    return fn()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function isInsideRoot(path: string, root: string): boolean {
  return path.startsWith(root === sep ? sep : `${root}${sep}`)
}

function walkCache(dir: string, cacheRoot: string, out: CacheFile[]): void {
  const realDir = ignoreMissing(() => realpathSync(dir))
  if (realDir === undefined || (realDir !== cacheRoot && !isInsideRoot(realDir, cacheRoot))) return
  const entries = ignoreMissing(() => readdirSync(dir, { withFileTypes: true }))
  if (entries === undefined) return

  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const fullPath = join(dir, entry.name)
    const stat = ignoreMissing(() => lstatSync(fullPath))
    if (stat === undefined || stat.isSymbolicLink()) continue
    if (stat.isDirectory()) {
      walkCache(fullPath, cacheRoot, out)
      continue
    }
    if (!stat.isFile()) continue
    const realFile = ignoreMissing(() => realpathSync(fullPath))
    if (realFile === undefined || !isInsideRoot(realFile, cacheRoot)) continue
    out.push({ path: fullPath, size: stat.size, mtimeMs: stat.mtimeMs })
  }
}

/**
 * Deletes the oldest regular files under `cacheDir` (by modification time) until the remaining total is under
 * 90% of `maxBytes`, or leaves the cache untouched when it does not exceed `maxBytes`. Symlinks are never followed.
 */
export function trimCache(cacheDir: string, maxBytes: number): CacheTrimResult {
  const rootStat = ignoreMissing(() => lstatSync(cacheDir))
  if (rootStat === undefined || rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    return { bytesFreed: 0, fileCount: 0 }
  }
  const cacheRoot = ignoreMissing(() => realpathSync(cacheDir))
  if (cacheRoot === undefined) return { bytesFreed: 0, fileCount: 0 }

  const files: CacheFile[] = []
  walkCache(cacheDir, cacheRoot, files)

  let totalBytes = 0
  for (const file of files) totalBytes += file.size
  if (totalBytes <= maxBytes) return { bytesFreed: 0, fileCount: 0 }

  files.sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path))
  const targetBytes = maxBytes * CACHE_TRIM_RATIO
  let bytesFreed = 0
  let fileCount = 0

  for (const file of files) {
    if (totalBytes < targetBytes) break
    const stat = ignoreMissing(() => lstatSync(file.path))
    // Re-check right before unlinking so a concurrent symlink swap cannot escape cache/.
    if (stat === undefined || stat.isSymbolicLink() || !stat.isFile()) continue
    const removed = ignoreMissing(() => {
      unlinkSync(file.path)
      return true
    })
    if (removed === undefined) continue
    totalBytes -= file.size
    bytesFreed += file.size
    fileCount += 1
  }

  return { bytesFreed, fileCount }
}

export function freeMegabytes(dir: string): number {
  const stats = statfsSync(dir)
  return Math.floor((stats.bavail * stats.bsize) / BYTES_PER_MB)
}

export function emptyDir(dir: string): void {
  const stat = ignoreMissing(() => lstatSync(dir))
  if (stat?.isSymbolicLink()) return
  mkdirSync(dir, { recursive: true })
  for (const entry of readdirSync(dir)) rmSync(join(dir, entry), { recursive: true, force: true })
}

export function createDiskGuard(options: DiskGuardOptions): DiskGuard {
  let onError = options.onError
  const measure = options.freeMb ?? freeMegabytes
  const cacheMaxBytes = (options.cacheMaxMb ?? DEFAULT_CACHE_MAX_MB) * BYTES_PER_MB
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
    } else {
      try {
        const trimmed = trimCache(join(options.dataDir, 'cache'), cacheMaxBytes)
        if (trimmed.fileCount > 0) {
          const log = options.logger ?? createLogger({ level: 'info', module: 'storage' })
          log.info('storage.cache_trimmed', { bytesFreed: trimmed.bytesFreed, fileCount: trimmed.fileCount })
        }
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
