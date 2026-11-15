import { constants, accessSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Config } from '../config/schema.js'
import type { Logger } from '../records/logger.js'
import { type Storage, StorageError, openDatabase } from './database.js'
import { type DiskGuard, type DiskState, createDiskGuard } from './disk-guard.js'
import { applyMigrations, planMigrations, readMigrations } from './migrate.js'
import { type RecoveryReport, runRecovery } from './recovery.js'
import { takeSnapshot } from './snapshot.js'

// Steps 1 to 4 of the start-up sequence (docs/trd/storage.md#start-up-sequence).
// Any failure throws, so the process exits non-zero and the updater returns to the previous image.

export interface DataPaths {
  root: string
  database: string
  files: string
  snapshots: string
  archive: string
  cache: string
}

export function dataPaths(root: string): DataPaths {
  return {
    root,
    database: join(root, 'aira.db'),
    files: join(root, 'files'),
    snapshots: join(root, 'snapshots'),
    archive: join(root, 'archive'),
    cache: join(root, 'cache')
  }
}

export interface StartedStorage {
  storage: Storage
  paths: DataPaths
  diskGuard: DiskGuard
  recovery: RecoveryReport
  appliedMigrations: number[]
}

export interface StartOptions {
  config: Pick<Config, 'storage'>
  logger: Logger
  onDiskAlert?: (state: DiskState) => void
  /** Called when a write fails with an I/O error (the disk guard's error level), after it is logged. */
  onStorageError?: () => void
  reconcileReminders?: () => number
  /** Free space in megabytes. Replaced in tests. */
  freeMb?: (dir: string) => number
  now?: () => Date
}

export async function startStorage(options: StartOptions): Promise<StartedStorage> {
  const { config, logger } = options
  const paths = dataPaths(config.storage.path)

  // 1. The data volume is writable and free space is above the critical level.
  try {
    for (const dir of [paths.root, paths.files, paths.snapshots, paths.archive, paths.cache]) {
      mkdirSync(dir, { recursive: true })
    }
    accessSync(paths.root, constants.W_OK | constants.R_OK)
  } catch (cause) {
    throw new StorageError(
      `the data volume at ${paths.root} is not writable: ${(cause as Error).message}`,
      'storage_error',
      {
        cause
      }
    )
  }

  let storage: Storage | undefined
  try {
    const diskGuard = createDiskGuard({
      dataDir: paths.root,
      minFreeMb: config.storage.minFreeMb,
      criticalFreeMb: config.storage.criticalFreeMb,
      freeMb: options.freeMb,
      now: options.now,
      onAlert: (state) => {
        logger.error('storage.low_space', { level: state.level, freeMb: state.freeMb })
        options.onDiskAlert?.(state)
      },
      // The guard writes its failure record through the storage opened below.
      get storage() {
        return storage
      }
    })
    const disk = diskGuard.check()
    if (disk.level === 'critical') {
      throw new StorageError(
        `free space on ${paths.root} is ${disk.freeMb} MB, under storage.criticalFreeMb (${config.storage.criticalFreeMb})`
      )
    }

    // 2. Open the database. Run quick_check and foreign_key_check.
    storage = openDatabase(paths.database, {
      onStorageError: (error) => {
        // The record of a failed write is this log line: the database that failed cannot be asked to hold it.
        logger.error('storage.write_failed', { kind: 'storage_error', error })
        options.onStorageError?.()
      }
    })
    storage.check()

    // 3. Take a verified snapshot if a migration is pending on a database that holds data. Apply migrations.
    const migrations = readMigrations()
    const plan = planMigrations(storage, migrations)
    if (plan.newer.length > 0) logger.warn('storage.newer_schema', { versions: plan.newer })
    if (plan.pending.length > 0 && plan.pending.length < migrations.length) {
      const snapshot = await takeSnapshot(storage, paths.snapshots, 'migration', options.now)
      if (snapshot.state !== 'verified') {
        throw new StorageError(`no verified snapshot before the migration: ${snapshot.detail ?? 'unknown fault'}`)
      }
      logger.info('storage.snapshot', { reason: 'migration', file: snapshot.file })
    }
    const appliedMigrations = applyMigrations(storage, migrations, options.now)
    if (appliedMigrations.length > 0) logger.info('storage.migrated', { versions: appliedMigrations })

    // 4. The recovery pass.
    const recovery = runRecovery(storage, {
      filesDir: paths.files,
      snapshotsDir: paths.snapshots,
      reconcileReminders: options.reconcileReminders,
      now: options.now
    })
    logger.info('storage.recovered', {
      interruptedTurns: recovery.interruptedTurns.length,
      releasedLeases: recovery.releasedLeases,
      remindersRecreated: recovery.remindersRecreated,
      failedSnapshots: recovery.failedSnapshots.length,
      filesRemoved: recovery.files.removed.length,
      filesMissing: recovery.files.missing.length
    })
    for (const turnId of recovery.interruptedTurns) {
      logger.child({ turnId }).error('turn.interrupted', { handledBy: 'recovery' })
    }

    return { storage, paths, diskGuard, recovery, appliedMigrations }
  } catch (error) {
    storage?.close()
    throw error
  }
}
