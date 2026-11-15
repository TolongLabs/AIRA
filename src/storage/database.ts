import Database from 'better-sqlite3'

// The one storage module (docs/trd/storage.md#connection-rules).
// One write connection lives here. Every write goes through tx(). Readers are query_only.

export type Db = Database.Database

/** A failed storage operation. `kind` is a failure kind from docs/trd/records.md. */
export class StorageError extends Error {
  override name = 'StorageError'
  constructor(
    message: string,
    readonly kind: 'storage_error' | 'config_invalid' | 'internal' = 'storage_error',
    options?: ErrorOptions
  ) {
    super(message, options)
  }
}

export interface Storage {
  /** Path of the database file. */
  readonly file: string
  /**
   * Runs fn in one immediate transaction on the write connection and commits when it returns.
   * fn must be synchronous: a transaction never spans a model call, a tool call or a network call.
   */
  tx<T>(fn: (db: Db) => T): T
  /** Runs fn on the shared query_only connection. */
  read<T>(fn: (db: Db) => T): T
  /** Opens a new query_only connection. The caller closes it. */
  openReader(): Db
  /** Copies the live database to dest with SQLite's online backup. */
  backup(dest: string): Promise<void>
  /** Runs quick_check and foreign_key_check. Throws a StorageError on any finding. */
  check(): void
  close(): void
}

export interface OpenOptions {
  /** Called when a write fails with an I/O error, before the error is thrown. Must not throw. */
  onStorageError?: (error: StorageError) => void
}

const IO_CODES = /^SQLITE_(IOERR|FULL|CORRUPT|NOTADB|READONLY|CANTOPEN)/

function isThenable(value: unknown): boolean {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function'
}

/** Opens a query_only connection to a database file. For operator scripts and reports; the caller closes it. */
export function openReader(file: string): Db {
  return openReaderAt(file)
}

function openReaderAt(file: string): Db {
  const reader = new Database(file, { readonly: true, fileMustExist: true })
  reader.pragma('query_only = ON')
  reader.pragma('busy_timeout = 5000')
  reader.pragma('trusted_schema = OFF')
  return reader
}

export function openDatabase(file: string, options: OpenOptions = {}): Storage {
  let writer: Db
  try {
    writer = new Database(file)
    const mode = writer.pragma('journal_mode = WAL', { simple: true })
    if (mode !== 'wal') throw new Error(`journal_mode is ${String(mode)}, not wal`)
    writer.pragma('synchronous = FULL')
    writer.pragma('foreign_keys = ON')
    writer.pragma('busy_timeout = 5000')
    writer.pragma('trusted_schema = OFF')
    // A deleted or cleared value is overwritten on disk, so a forgotten fact does not stay in free pages.
    writer.pragma('secure_delete = ON')
  } catch (cause) {
    throw new StorageError(`cannot open the database at ${file}: ${(cause as Error).message}`, 'storage_error', {
      cause
    })
  }

  let sharedReader: Db | undefined

  const wrap = (cause: unknown): unknown => {
    if (cause instanceof StorageError) return cause
    const code = (cause as { code?: unknown } | null)?.code
    if (typeof code !== 'string' || !IO_CODES.test(code)) return cause
    const error = new StorageError(`storage write failed (${code})`, 'storage_error', { cause })
    try {
      options.onStorageError?.(error)
    } catch {
      // The hook reports the fault; it must never hide it.
    }
    return error
  }

  const tx = <T>(fn: (db: Db) => T): T => {
    const run = writer.transaction((): T => {
      const result = fn(writer)
      if (isThenable(result)) {
        throw new StorageError('a transaction callback must be synchronous and must not return a promise', 'internal')
      }
      return result
    })
    try {
      return run.immediate()
    } catch (cause) {
      throw wrap(cause)
    }
  }

  const read = <T>(fn: (db: Db) => T): T => {
    sharedReader ??= openReaderAt(file)
    return fn(sharedReader)
  }

  const check = (): void => {
    const quick = writer.pragma('quick_check') as { quick_check: string }[]
    if (quick.length !== 1 || quick[0]?.quick_check !== 'ok') {
      throw new StorageError(`quick_check failed: ${quick.map((row) => row.quick_check).join('; ')}`)
    }
    const orphans = writer.pragma('foreign_key_check') as { table: string }[]
    if (orphans.length > 0) {
      const tables = [...new Set(orphans.map((row) => row.table))].join(', ')
      throw new StorageError(`foreign_key_check found ${orphans.length} orphan rows in: ${tables}`)
    }
  }

  return {
    file,
    tx,
    read,
    openReader: () => openReaderAt(file),
    backup: async (dest) => {
      await writer.backup(dest)
    },
    check,
    close: () => {
      sharedReader?.close()
      sharedReader = undefined
      if (writer.open) writer.close()
    }
  }
}

/** The current time as the ISO-8601 UTC text every table stores. */
export function isoNow(now: () => Date = () => new Date()): string {
  return now().toISOString()
}
