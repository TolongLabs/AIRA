import { describe, expect, it, vi } from 'vitest'
import { StorageError, openDatabase } from '../../src/storage/database.js'
import { tmpDir, tmpStorage } from '../support/tmp.js'

const TURN = `INSERT INTO turn (turn_id, chat_id, sender_id, kind, state, stage, received_at)
  VALUES (?, 'chat-1', 'sender-1', 'reply', 'running', 'receive', '2026-01-01T00:00:00.000Z')`

describe('storage connection rules', () => {
  it('opens the write connection with the pragmas the contract lists', () => {
    const storage = tmpStorage({ migrate: false })
    const pragmas = storage.tx((db) => ({
      journal: db.pragma('journal_mode', { simple: true }),
      synchronous: db.pragma('synchronous', { simple: true }),
      foreignKeys: db.pragma('foreign_keys', { simple: true }),
      busyTimeout: db.pragma('busy_timeout', { simple: true }),
      trustedSchema: db.pragma('trusted_schema', { simple: true }),
      secureDelete: db.pragma('secure_delete', { simple: true })
    }))
    // synchronous 2 is FULL.
    expect(pragmas).toEqual({
      journal: 'wal',
      synchronous: 2,
      foreignKeys: 1,
      busyTimeout: 5000,
      trustedSchema: 0,
      secureDelete: 1
    })
  })

  it('commits a transaction and rolls back all of it when the callback throws', () => {
    const storage = tmpStorage()
    storage.tx((db) => db.prepare(TURN).run('t-1'))
    expect(() =>
      storage.tx((db) => {
        db.prepare(TURN).run('t-2')
        throw new Error('stop')
      })
    ).toThrow('stop')
    expect(storage.read((db) => db.prepare('SELECT turn_id FROM turn').pluck().all())).toEqual(['t-1'])
  })

  it('refuses a transaction callback that returns a promise, and rolls back', () => {
    const storage = tmpStorage()
    expect(() =>
      storage.tx((db) => {
        db.prepare(TURN).run('t-async')
        return Promise.resolve()
      })
    ).toThrow(/synchronous/)
    expect(storage.read((db) => db.prepare('SELECT count(*) FROM turn').pluck().get())).toBe(0)
  })

  it('gives readers a query_only connection that still sees committed writes', () => {
    const storage = tmpStorage()
    storage.tx((db) => db.prepare(TURN).run('t-1'))
    const reader = storage.openReader()
    try {
      expect(reader.prepare('SELECT count(*) FROM turn').pluck().get()).toBe(1)
      expect(() => reader.prepare("DELETE FROM turn WHERE turn_id = 't-1'").run()).toThrow(/readonly|query_only/i)
    } finally {
      reader.close()
    }
    expect(() => storage.read((db) => db.prepare('DELETE FROM turn').run())).toThrow(/readonly|query_only/i)
  })

  it('refuses an orphan row', () => {
    const storage = tmpStorage()
    expect(() =>
      storage.tx((db) =>
        db
          .prepare(
            `INSERT INTO failure (turn_id, stage, kind, message, created_at)
             VALUES ('no-such-turn', 'run', 'internal', 'x', '2026-01-01T00:00:00.000Z')`
          )
          .run()
      )
    ).toThrow(/FOREIGN KEY/)
  })

  it('refuses a value of the wrong type, because every table is strict', () => {
    const storage = tmpStorage()
    expect(() =>
      storage.tx((db) =>
        db
          .prepare(
            "INSERT INTO file (sha256, path, bytes, kind, created_at) VALUES ('a', 'a', 'many', 'media', '2026-01-01')"
          )
          .run()
      )
    ).toThrow(/cannot store TEXT value in INTEGER column/)
  })

  it('refuses a state the contract does not list', () => {
    const storage = tmpStorage()
    expect(() => storage.tx((db) => db.prepare(TURN.replace("'running'", "'paused'")).run('t-1'))).toThrow(
      /CHECK constraint/
    )
  })

  it('passes quick_check and foreign_key_check on a healthy file', () => {
    const storage = tmpStorage()
    expect(() => storage.check()).not.toThrow()
  })

  it('reports an I/O failure as a storage_error and tells the hook', () => {
    const onStorageError = vi.fn()
    const storage = openDatabase(`${tmpDir()}/aira.db`, { onStorageError })
    try {
      const full = Object.assign(new Error('database or disk is full'), { code: 'SQLITE_FULL' })
      let thrown: unknown
      try {
        storage.tx(() => {
          throw full
        })
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(StorageError)
      expect((thrown as StorageError).kind).toBe('storage_error')
      expect((thrown as StorageError).cause).toBe(full)
      expect(onStorageError).toHaveBeenCalledOnce()
    } finally {
      storage.close()
    }
  })

  it('fails with a StorageError when the file cannot be opened', () => {
    expect(() => openDatabase(`${tmpDir()}/missing-folder/aira.db`)).toThrow(StorageError)
  })

  it('copies the live file with the online backup', async () => {
    const dir = tmpDir()
    const storage = tmpStorage({ dir })
    storage.tx((db) => db.prepare(TURN).run('t-1'))
    await storage.backup(`${dir}/copy.db`)
    const copy = openDatabase(`${dir}/copy.db`)
    try {
      expect(copy.read((db) => db.prepare('SELECT turn_id FROM turn').pluck().all())).toEqual(['t-1'])
    } finally {
      copy.close()
    }
  })
})
