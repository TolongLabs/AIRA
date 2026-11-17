import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'
import { openDatabase, type Storage } from '../../src/storage/database.js'
import { applyMigrations } from '../../src/storage/migrate.js'

const cleanups: (() => void)[] = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

/** A scratch directory that is removed after the test. */
export function tmpDir(prefix = 'aira-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** A database file in a scratch directory, closed after the test. */
export function tmpStorage(options: { migrate?: boolean; dir?: string } = {}): Storage {
  const storage = openDatabase(join(options.dir ?? tmpDir(), 'aira.db'))
  cleanups.push(() => storage.close())
  if (options.migrate !== false) applyMigrations(storage)
  return storage
}
