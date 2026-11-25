import { randomUUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'

// Standalone private state: never follow a symlink or change existing permissions to hide a fault.
function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function owned(stats: Stats, mode: number): boolean {
  return (typeof process.getuid !== 'function' || stats.uid === process.getuid()) && (stats.mode & 0o777) === mode
}

function checkFile(stats: Stats): void {
  if (!stats.isFile() || !owned(stats, 0o600))
    throw new Error('standalone private state must be an owned 0600 regular file')
}

export function ensurePrivateDirectory(path: string): void {
  try {
    mkdirSync(path, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const stats = lstatSync(path)
  if (!stats.isDirectory() || !owned(stats, 0o700))
    throw new Error('standalone private state directory must be owned and mode 0700')
}

export function readPrivateText(path: string, maxBytes = 65_536): string | undefined {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    if (missing(error)) return undefined
    throw new Error('standalone private state is unreadable')
  }
  try {
    const stats = fstatSync(fd)
    checkFile(stats)
    if (stats.size > maxBytes) throw new Error('standalone private state exceeds its size limit')
    const buffer = Buffer.alloc(maxBytes + 1)
    let offset = 0
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, null)
      if (count === 0) break
      offset += count
    }
    if (offset > maxBytes) throw new Error('standalone private state exceeds its size limit')
    return buffer.subarray(0, offset).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** Fully write a private temp file, then publish atomically. A no-clobber race returns false. */
export function writePrivateText(path: string, content: string, replace = false): boolean {
  const dir = dirname(path)
  ensurePrivateDirectory(dir)
  if (replace) {
    try {
      checkFile(lstatSync(path))
    } catch (error) {
      if (!missing(error)) throw error
    }
  }
  const temporary = join(dir, '.' + randomUUID() + '.tmp')
  const fd = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  )
  try {
    try {
      checkFile(fstatSync(fd))
      writeFileSync(fd, content, 'utf8')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    if (replace) {
      renameSync(temporary, path)
    } else {
      try {
        linkSync(temporary, path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
        throw error
      }
    }
    syncDirectory(dir)
    return true
  } finally {
    rmSync(temporary, { force: true })
  }
}
