import { createHash, randomBytes } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  writeSync
} from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'
import { isoNow, type Storage } from './database.js'
import { insertFailure } from './failures.js'

// File writes (docs/trd/storage.md#what-a-write-promises): temporary name, flush, rename, then the row.

const TMP_SUFFIX = '.tmp'

function syncDir(dir: string): void {
  const fd = openSync(dir, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** Writes a file so that a reader sees the old content or the new content, never a part of either. */
export function writeFileAtomic(path: string, data: Buffer | string): void {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `.${basename(path)}.${randomBytes(6).toString('hex')}${TMP_SUFFIX}`)
  const fd = openSync(tmp, 'wx', 0o644)
  try {
    try {
      const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
      let offset = 0
      while (offset < bytes.length) offset += writeSync(fd, bytes, offset)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, path)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
  syncDir(dir)
}

export interface StoredFile {
  sha256: string
  /** Path relative to the files folder. */
  path: string
  bytes: number
}

/**
 * Stores content under its hash and writes its row after the rename. Storing the same content twice leaves one
 * file and one row.
 */
export function putFile(
  storage: Storage,
  filesDir: string,
  input: { data: Buffer; ext: string; kind: string },
  now: () => Date = () => new Date()
): StoredFile {
  if (!/^(\.[a-z0-9]{1,8})?$/.test(input.ext)) throw new Error(`unsupported file extension: ${input.ext}`)
  const sha256 = createHash('sha256').update(input.data).digest('hex')
  const path = `${sha256.slice(0, 2)}/${sha256}${input.ext}`
  const stored: StoredFile = { sha256, path, bytes: input.data.length }
  const known = storage.read((db) => db.prepare('SELECT 1 FROM file WHERE sha256 = ?').pluck().get(sha256))
  if (known !== undefined && existsSync(join(filesDir, path))) return stored
  writeFileAtomic(join(filesDir, path), input.data)
  storage.tx((db) =>
    db
      .prepare(
        `INSERT INTO file (sha256, path, bytes, kind, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (sha256) DO NOTHING`
      )
      .run(sha256, path, input.data.length, input.kind, isoNow(now))
  )
  return stored
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path, out)
    else out.push(path)
  }
  return out
}

export interface SweepResult {
  /** Files with no row, removed. Paths relative to the files folder. */
  removed: string[]
  /** Rows with no file. Each got a failure record. */
  missing: string[]
}

/** The start-up sweep: a file with no row is removed; a row with no file is a failure record. */
export function sweepFiles(storage: Storage, filesDir: string, now: () => Date = () => new Date()): SweepResult {
  mkdirSync(filesDir, { recursive: true })
  const rows = new Set(storage.read((db) => db.prepare('SELECT path FROM file').pluck().all() as string[]))
  const removed: string[] = []
  const onDisk = new Set<string>()
  for (const path of walk(filesDir)) {
    const rel = relative(filesDir, path).split(sep).join('/')
    if (rows.has(rel)) {
      onDisk.add(rel)
    } else {
      rmSync(path, { force: true })
      removed.push(rel)
    }
  }
  const missing = [...rows].filter((path) => !onDisk.has(path))
  if (missing.length > 0) {
    storage.tx((db) => {
      for (const path of missing) {
        insertFailure(
          db,
          {
            stage: 'file_sweep',
            kind: 'storage_error',
            message: `file row has no file: ${path}`,
            handledBy: 'recovery'
          },
          now
        )
      }
    })
  }
  return { removed, missing }
}
