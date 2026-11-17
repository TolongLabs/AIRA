import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createLogger } from '../../src/records/logger.js'
import { type Storage, StorageError, openDatabase } from '../../src/storage/database.js'
import { createDiskGuard } from '../../src/storage/disk-guard.js'
import { putFile, sweepFiles, writeFileAtomic } from '../../src/storage/files.js'
import {
  completeJob,
  enqueueJob,
  extendLease,
  failJob,
  leaseNextJob,
  reapExpiredLeases,
  releaseLeases
} from '../../src/storage/leases.js'
import { runRecovery } from '../../src/storage/recovery.js'
import { latestSnapshot, pruneSnapshots, takeSnapshot } from '../../src/storage/snapshot.js'
import { dataPaths, startStorage } from '../../src/storage/startup.js'
import { advanceTurn, closeTurn, closeTurnAsFailed, openTurn, receiveInbound } from '../../src/storage/turns.js'
import { tmpDir, tmpStorage } from '../support/tmp.js'

const key = { chatId: 'chat-1', mid: 'm-1', senderId: 'sender-1' }
const clockAt = (iso: string) => () => new Date(iso)
const one = <T>(storage: Storage, sql: string, ...args: unknown[]): T =>
  storage.read(
    (db) =>
      db
        .prepare(sql)
        .pluck()
        .get(...args) as T
  )

function open(storage: Storage, turnId: string, mids: string[] = [key.mid], chatId = key.chatId) {
  openTurn(storage, { turnId, chatId, senderId: key.senderId, kind: 'reply', mids })
}

describe('inbound messages and turns', () => {
  it('a repeated id returns the stored reply and runs no second turn', () => {
    const storage = tmpStorage()
    expect(receiveInbound(storage, key)).toEqual({ status: 'new' })
    open(storage, 't-1')
    expect(receiveInbound(storage, key)).toEqual({ status: 'running', turnId: 't-1' })
    expect(closeTurn(storage, { turnId: 't-1', state: 'delivered', reply: 'hello' })).toBe(true)
    expect(receiveInbound(storage, key)).toEqual({ status: 'answered', turnId: 't-1', reply: 'hello' })
    expect(one(storage, 'SELECT count(*) FROM turn')).toBe(1)
  })

  it('the same message id in another chat is another message', () => {
    const storage = tmpStorage()
    receiveInbound(storage, key)
    open(storage, 't-1')
    closeTurn(storage, { turnId: 't-1', state: 'delivered', reply: 'for chat one only' })
    expect(receiveInbound(storage, { ...key, chatId: 'chat-2' })).toEqual({ status: 'new' })
  })

  it('an interrupted turn runs again when the gateway sends the message again, and replies once', () => {
    const storage = tmpStorage()
    const paths = dataPaths(tmpDir())
    receiveInbound(storage, key)
    open(storage, 't-1')
    advanceTurn(storage, 't-1', 'run')
    const report = runRecovery(storage, { filesDir: paths.files, snapshotsDir: paths.snapshots })
    expect(report.interruptedTurns).toEqual(['t-1'])
    expect(one(storage, "SELECT stage FROM failure WHERE turn_id = 't-1' AND kind = 'turn_interrupted'")).toBe('run')
    expect(closeTurn(storage, { turnId: 't-1', state: 'delivered', reply: 'late' })).toBe(false)
    expect(one(storage, 'SELECT count(*) FROM session_message')).toBe(0)

    expect(receiveInbound(storage, key)).toEqual({ status: 'retry' })
    open(storage, 't-2')
    closeTurn(storage, { turnId: 't-2', state: 'delivered', reply: 'second try' })
    expect(receiveInbound(storage, key)).toEqual({ status: 'answered', turnId: 't-2', reply: 'second try' })
    expect(one(storage, "SELECT count(*) FROM session_message WHERE role = 'assistant'")).toBe(1)
  })

  it('a declined turn drops its message, and a repeat stays dropped', () => {
    const storage = tmpStorage()
    receiveInbound(storage, key)
    open(storage, 't-1')
    closeTurn(storage, { turnId: 't-1', state: 'declined' })
    expect(receiveInbound(storage, key)).toEqual({ status: 'dropped' })
  })

  it('a failed turn that returned a line counts as answered', () => {
    const storage = tmpStorage()
    receiveInbound(storage, key)
    open(storage, 't-1')
    closeTurn(storage, { turnId: 't-1', state: 'failed', reply: 'the error line' })
    expect(receiveInbound(storage, key)).toMatchObject({ status: 'answered', reply: 'the error line' })
  })

  it('one turn answers every message batched into it', () => {
    const storage = tmpStorage()
    receiveInbound(storage, key)
    receiveInbound(storage, { ...key, mid: 'm-2' })
    open(storage, 't-1', ['m-1', 'm-2'])
    closeTurn(storage, { turnId: 't-1', state: 'delivered', reply: 'both' })
    expect(receiveInbound(storage, { ...key, mid: 'm-2' })).toMatchObject({ status: 'answered', reply: 'both' })
  })

  it('when merged messages share a turn, the reply is stored for one of them and the rest are dropped', () => {
    const storage = tmpStorage()
    receiveInbound(storage, key)
    receiveInbound(storage, { ...key, mid: 'm-2' })
    open(storage, 't-1', ['m-1', 'm-2'])
    closeTurn(storage, { turnId: 't-1', state: 'delivered', reply: 'one reply', replyMid: 'm-2' })
    expect(receiveInbound(storage, key)).toEqual({ status: 'dropped' })
    expect(receiveInbound(storage, { ...key, mid: 'm-2' })).toMatchObject({ status: 'answered', reply: 'one reply' })
  })

  it('stores what onNew writes with the first sight of a message, and never again', () => {
    const storage = tmpStorage()
    const store = (db: import('../../src/storage/database.js').Db) =>
      db
        .prepare(
          "INSERT INTO session_message (chat_id, role, sender_id, content, mid, created_at) VALUES ('chat-1', 'user', 'sender-1', 'hi', 'm-1', '2026-01-01')"
        )
        .run()
    expect(receiveInbound(storage, { ...key, onNew: store })).toEqual({ status: 'new' })
    expect(receiveInbound(storage, { ...key, onNew: store })).toEqual({ status: 'retry' })
    expect(one(storage, 'SELECT count(*) FROM session_message')).toBe(1)
  })

  it('refuses a second running turn for one message, and a turn for an unknown message', () => {
    const storage = tmpStorage()
    receiveInbound(storage, key)
    open(storage, 't-1')
    expect(() => open(storage, 't-2')).toThrow(StorageError)
    expect(() => open(storage, 't-3', ['never-received'])).toThrow(StorageError)
    expect(one(storage, 'SELECT count(*) FROM turn')).toBe(1)
  })

  it('commits the extra writes of a close with it, or not at all', () => {
    const storage = tmpStorage()
    receiveInbound(storage, key)
    open(storage, 't-1')
    expect(() =>
      closeTurn(storage, {
        turnId: 't-1',
        state: 'delivered',
        reply: 'never stored',
        also: () => {
          throw new Error('record write failed')
        }
      })
    ).toThrow('record write failed')
    expect(one(storage, "SELECT state FROM turn WHERE turn_id = 't-1'")).toBe('running')
    expect(one(storage, 'SELECT count(*) FROM session_message')).toBe(0)
  })

  it('refuses a delivered turn with no reply and a declined turn with one', () => {
    const storage = tmpStorage()
    expect(() => closeTurn(storage, { turnId: 't', state: 'delivered' })).toThrow(StorageError)
    expect(() => closeTurn(storage, { turnId: 't', state: 'declined', reply: 'x' })).toThrow(StorageError)
  })

  it('closeTurnAsFailed passes reached stage and can leave inbound messages open for retry', () => {
    const storage = tmpStorage()
    expect(closeTurnAsFailed(storage, { turnId: 'missing' })).toBe(false)
    receiveInbound(storage, key)
    open(storage, 't-1')
    advanceTurn(storage, 't-1', 'clean')
    let reachedStage = ''
    expect(
      closeTurnAsFailed(storage, {
        turnId: 't-1',
        closeInbound: false,
        also: (_, stage) => {
          reachedStage = stage
        }
      })
    ).toBe(true)
    expect(reachedStage).toBe('clean')
    expect(one(storage, "SELECT state FROM turn WHERE turn_id = 't-1'")).toBe('failed')
    expect(receiveInbound(storage, key)).toEqual({ status: 'retry' })
  })
})

describe('job leases', () => {
  const queue = (storage: Storage, jobId: string, chatId = 'chat-1', at = '2026-01-01T00:00:00.000Z') =>
    storage.tx((db) => enqueueJob(db, 'memory_job', { jobId, chatId, payload: '{}' }, clockAt(at)))
  const t0 = clockAt('2026-01-01T00:01:00.000Z')
  const lease = { owner: 'worker-a', leaseMs: 60_000 }

  it('queues a job id once', () => {
    const storage = tmpStorage()
    expect(queue(storage, 'j-1')).toBe(true)
    expect(queue(storage, 'j-1')).toBe(false)
    expect(one(storage, 'SELECT count(*) FROM memory_job')).toBe(1)
  })

  it('runs one chat in order and never two of its jobs together', () => {
    const storage = tmpStorage()
    queue(storage, 'j-1', 'chat-1', '2026-01-01T00:00:01.000Z')
    queue(storage, 'j-2', 'chat-1', '2026-01-01T00:00:02.000Z')
    queue(storage, 'j-3', 'chat-2', '2026-01-01T00:00:03.000Z')
    expect(leaseNextJob(storage, 'memory_job', lease, t0)?.jobId).toBe('j-1')
    expect(leaseNextJob(storage, 'memory_job', lease, t0)?.jobId).toBe('j-3')
    expect(leaseNextJob(storage, 'memory_job', lease, t0)).toBeUndefined()
    completeJob(storage, 'memory_job', { jobId: 'j-1', owner: 'worker-a' }, t0)
    expect(leaseNextJob(storage, 'memory_job', lease, t0)?.jobId).toBe('j-2')
  })

  it('a lease past its time returns to the queue, and its old owner can no longer finish it', () => {
    const storage = tmpStorage()
    queue(storage, 'j-1')
    leaseNextJob(storage, 'memory_job', lease, t0)
    const later = clockAt('2026-01-01T00:03:00.000Z')
    expect(extendLease(storage, 'memory_job', { jobId: 'j-1', ...lease }, later)).toBe(false)
    expect(reapExpiredLeases(storage, 'memory_job', later)).toBe(1)
    const again = leaseNextJob(storage, 'memory_job', { owner: 'worker-b', leaseMs: 60_000 }, later)
    expect(again).toMatchObject({ jobId: 'j-1', attempts: 2 })
    expect(completeJob(storage, 'memory_job', { jobId: 'j-1', owner: 'worker-a' }, later)).toBe(false)
    expect(completeJob(storage, 'memory_job', { jobId: 'j-1', owner: 'worker-b' }, later)).toBe(true)
  })

  it('a worker that extends its lease keeps it', () => {
    const storage = tmpStorage()
    queue(storage, 'j-1')
    leaseNextJob(storage, 'memory_job', lease, t0)
    expect(extendLease(storage, 'memory_job', { jobId: 'j-1', ...lease }, clockAt('2026-01-01T00:01:50.000Z'))).toBe(
      true
    )
    expect(reapExpiredLeases(storage, 'memory_job', clockAt('2026-01-01T00:02:30.000Z'))).toBe(0)
  })

  it('completing a job commits the handler writes with it, so a second run changes nothing', () => {
    const storage = tmpStorage()
    queue(storage, 'j-1')
    const apply = vi.fn()
    leaseNextJob(storage, 'memory_job', lease, t0)
    expect(completeJob(storage, 'memory_job', { jobId: 'j-1', owner: 'worker-a', apply }, t0)).toBe(true)
    expect(completeJob(storage, 'memory_job', { jobId: 'j-1', owner: 'worker-a', apply }, t0)).toBe(false)
    expect(apply).toHaveBeenCalledOnce()
    expect(one(storage, "SELECT state FROM memory_job WHERE job_id = 'j-1'")).toBe('done')
  })

  it('a handler write that fails leaves the job leased, not done', () => {
    const storage = tmpStorage()
    queue(storage, 'j-1')
    leaseNextJob(storage, 'memory_job', lease, t0)
    const apply = () => {
      throw new Error('apply failed')
    }
    expect(() => completeJob(storage, 'memory_job', { jobId: 'j-1', owner: 'worker-a', apply }, t0)).toThrow()
    expect(one(storage, "SELECT state FROM memory_job WHERE job_id = 'j-1'")).toBe('leased')
  })

  it('a failed job retries on the given delays, then stays failed', () => {
    const storage = tmpStorage()
    queue(storage, 'j-1')
    const failed = { jobId: 'j-1', owner: 'worker-a', error: 'judge down', retryDelaysMs: [60_000] }
    leaseNextJob(storage, 'memory_job', lease, t0)
    expect(failJob(storage, 'memory_job', failed, t0)).toBe('queued')
    expect(leaseNextJob(storage, 'memory_job', lease, t0)).toBeUndefined()
    const afterDelay = clockAt('2026-01-01T00:02:00.000Z')
    expect(leaseNextJob(storage, 'memory_job', lease, afterDelay)?.attempts).toBe(2)
    expect(failJob(storage, 'memory_job', failed, afterDelay)).toBe('failed')
    expect(one(storage, "SELECT last_error FROM memory_job WHERE job_id = 'j-1'")).toBe('judge down')
    expect(failJob(storage, 'memory_job', failed, afterDelay)).toBeUndefined()
  })

  it('shutdown gives back only its own leases; start-up recovery gives back all', () => {
    const storage = tmpStorage()
    const paths = dataPaths(tmpDir())
    queue(storage, 'j-1', 'chat-1')
    queue(storage, 'j-2', 'chat-2')
    leaseNextJob(storage, 'memory_job', { owner: 'worker-a', leaseMs: 3_600_000 }, t0)
    leaseNextJob(storage, 'memory_job', { owner: 'worker-b', leaseMs: 3_600_000 }, t0)
    expect(releaseLeases(storage, 'memory_job', 'worker-a')).toBe(1)
    expect(one(storage, "SELECT attempts FROM memory_job WHERE job_id = 'j-1'")).toBe(0)
    const report = runRecovery(storage, { filesDir: paths.files, snapshotsDir: paths.snapshots })
    expect(report.releasedLeases).toBe(1)
    expect(one(storage, "SELECT count(*) FROM memory_job WHERE state = 'leased'")).toBe(0)
    expect(one(storage, "SELECT attempts FROM memory_job WHERE job_id = 'j-2'")).toBe(1)
  })
})

describe('file writes', () => {
  it('replaces a file whole and leaves no temporary file', () => {
    const dir = tmpDir()
    writeFileAtomic(join(dir, 'note.txt'), 'first')
    writeFileAtomic(join(dir, 'note.txt'), 'second')
    expect(readFileSync(join(dir, 'note.txt'), 'utf8')).toBe('second')
    expect(readdirSync(dir)).toEqual(['note.txt'])
  })

  it('stores content under its hash with one row, however often it is stored', () => {
    const storage = tmpStorage()
    const files = join(tmpDir(), 'files')
    const data = Buffer.from('sticker bytes')
    const first = putFile(storage, files, { data, ext: '.webp', kind: 'sticker' })
    const second = putFile(storage, files, { data, ext: '.webp', kind: 'sticker' })
    expect(second).toEqual(first)
    expect(first.sha256).toBe(createHash('sha256').update(data).digest('hex'))
    expect(readFileSync(join(files, first.path))).toEqual(data)
    expect(one(storage, 'SELECT count(*) FROM file')).toBe(1)
    expect(() => putFile(storage, files, { data, ext: '/../x', kind: 'sticker' })).toThrow(/extension/)
  })

  it('the sweep removes a file with no row and records a row with no file', () => {
    const storage = tmpStorage()
    const files = join(tmpDir(), 'files')
    const kept = putFile(storage, files, { data: Buffer.from('kept'), ext: '.bin', kind: 'media' })
    const lost = putFile(storage, files, { data: Buffer.from('lost'), ext: '.bin', kind: 'media' })
    mkdirSync(join(files, 'zz'), { recursive: true })
    writeFileSync(join(files, 'zz', 'orphan.bin'), 'no row')
    writeFileSync(join(files, 'zz', '.half.abc.tmp'), 'half a write')
    rmSync(join(files, lost.path))

    const result = sweepFiles(storage, files)
    expect(result.removed.sort()).toEqual(['zz/.half.abc.tmp', 'zz/orphan.bin'])
    expect(result.missing).toEqual([lost.path])
    expect(existsSync(join(files, kept.path))).toBe(true)
    expect(one(storage, "SELECT count(*) FROM failure WHERE kind = 'storage_error' AND stage = 'file_sweep'")).toBe(1)
  })
})

describe('disk guard', () => {
  function guard(storage: Storage, dataDir: string, free: { mb: number }) {
    const onAlert = vi.fn()
    return {
      onAlert,
      guard: createDiskGuard({ dataDir, minFreeMb: 2048, criticalFreeMb: 512, storage, onAlert, freeMb: () => free.mb })
    }
  }

  it('pauses nothing while space is free', () => {
    const { guard: g, onAlert } = guard(tmpStorage(), tmpDir(), { mb: 5000 })
    expect(g.check()).toMatchObject({
      level: 'ok',
      paused: { archive: false, mediaCache: false, memoryExtraction: false }
    })
    expect(onAlert).not.toHaveBeenCalled()
  })

  it('warn: alerts, empties the cache, pauses the archive and media caching', () => {
    const storage = tmpStorage()
    const dataDir = tmpDir()
    mkdirSync(join(dataDir, 'cache', 'pages'), { recursive: true })
    writeFileSync(join(dataDir, 'cache', 'pages', 'a.html'), 'cached')
    const { guard: g, onAlert } = guard(storage, dataDir, { mb: 1000 })
    expect(g.check()).toMatchObject({
      level: 'warn',
      paused: { archive: true, mediaCache: true, memoryExtraction: false }
    })
    expect(readdirSync(join(dataDir, 'cache'))).toEqual([])
    expect(onAlert).toHaveBeenCalledOnce()
    expect(one(storage, "SELECT count(*) FROM failure WHERE kind = 'storage_low_space'")).toBe(1)
  })

  it('critical: also pauses memory extraction, and alerts once per change of level', () => {
    const storage = tmpStorage()
    const free = { mb: 1000 }
    const { guard: g, onAlert } = guard(storage, tmpDir(), free)
    g.check()
    free.mb = 100
    expect(g.check()).toMatchObject({ level: 'critical', paused: { memoryExtraction: true } })
    g.check()
    expect(onAlert).toHaveBeenCalledTimes(2)
    free.mb = 9000
    expect(g.check().level).toBe('ok')
    expect(g.state().paused.memoryExtraction).toBe(false)
  })

  it('still alerts when the failure record cannot be written', () => {
    const storage = tmpStorage()
    storage.close()
    const { guard: g, onAlert } = guard(storage, tmpDir(), { mb: 100 })
    expect(g.check().level).toBe('critical')
    expect(onAlert).toHaveBeenCalledOnce()
  })
})

describe('snapshots', () => {
  it('takes a snapshot that opens, passes integrity_check and holds the rows', async () => {
    const dir = tmpDir()
    const storage = tmpStorage({ dir })
    receiveInbound(storage, key)
    const result = await takeSnapshot(storage, join(dir, 'snapshots'), 'manual')
    expect(result.state).toBe('verified')
    const copy = openDatabase(join(dir, 'snapshots', result.file))
    try {
      expect(copy.read((db) => db.prepare('SELECT mid FROM inbound_message').pluck().all())).toEqual(['m-1'])
    } finally {
      copy.close()
    }
    expect(latestSnapshot(storage)).toBe(result.file)
    expect(one(storage, 'SELECT bytes FROM backup_run WHERE id = ?', result.id)).toBeGreaterThan(0)
  })

  it('deletes and records a snapshot that fails verification', async () => {
    const dir = tmpDir()
    const storage = tmpStorage({ dir })
    const broken: Storage = {
      ...storage,
      backup: async (dest) => writeFileSync(dest, 'this is not a database, however long it is')
    }
    const result = await takeSnapshot(broken, join(dir, 'snapshots'), 'timer')
    expect(result.state).toBe('failed')
    expect(readdirSync(join(dir, 'snapshots'))).toEqual([])
    expect(one(storage, 'SELECT state FROM backup_run WHERE id = ?', result.id)).toBe('failed')
    expect(one(storage, "SELECT count(*) FROM failure WHERE kind = 'backup_failed'")).toBe(1)
    expect(latestSnapshot(storage)).toBeUndefined()
  })

  it('fails a snapshot whose row counts are not those of the live file', async () => {
    const dir = tmpDir()
    const storage = tmpStorage({ dir })
    receiveInbound(storage, key)
    const emptyDir = tmpDir()
    const empty = tmpStorage({ dir: emptyDir })
    const stale: Storage = { ...storage, backup: (dest) => empty.backup(dest) }
    const result = await takeSnapshot(stale, join(dir, 'snapshots'), 'timer')
    expect(result).toMatchObject({ state: 'failed' })
    expect(result.detail).toMatch(/has 0 rows, live has 1/)
  })

  it('keeps verified snapshots for keepDays, and always the newest', async () => {
    const dir = tmpDir()
    const snapshots = join(dir, 'snapshots')
    const storage = tmpStorage({ dir })
    const old = await takeSnapshot(storage, snapshots, 'timer', clockAt('2026-01-01T00:00:00.000Z'))
    const recent = await takeSnapshot(storage, snapshots, 'timer', clockAt('2026-01-10T00:00:00.000Z'))
    const now = clockAt('2026-02-20T00:00:00.000Z')
    expect(pruneSnapshots(storage, snapshots, 14, now)).toEqual([old.file])
    expect(readdirSync(snapshots)).toEqual([recent.file])
    expect(pruneSnapshots(storage, snapshots, 14, now)).toEqual([])
  })

  it('recovery fails a snapshot that never finished and removes its file', () => {
    const dir = tmpDir()
    const paths = dataPaths(dir)
    const storage = tmpStorage({ dir })
    mkdirSync(paths.snapshots, { recursive: true })
    writeFileSync(join(paths.snapshots, 'aira-half.db'), 'half')
    storage.tx((db) =>
      db
        .prepare(
          "INSERT INTO backup_run (reason, state, file, started_at) VALUES ('timer', 'started', 'aira-half.db', '2026-01-01')"
        )
        .run()
    )
    const report = runRecovery(storage, { filesDir: paths.files, snapshotsDir: paths.snapshots })
    expect(report.failedSnapshots).toEqual(['aira-half.db'])
    expect(readdirSync(paths.snapshots)).toEqual([])
    expect(one(storage, 'SELECT state FROM backup_run')).toBe('failed')
  })
})

describe('snapshot folder sweep', () => {
  it('recovery leaves only verified snapshots in the folder, and notes a verified one that is gone', async () => {
    const dir = tmpDir()
    const paths = dataPaths(dir)
    const storage = tmpStorage({ dir })
    const kept = await takeSnapshot(storage, paths.snapshots, 'manual')
    const gone = await takeSnapshot(storage, paths.snapshots, 'manual')
    rmSync(join(paths.snapshots, gone.file))
    writeFileSync(join(paths.snapshots, `${kept.file}-journal`), 'left by a kill during verification')
    writeFileSync(join(paths.snapshots, 'aira-part.db'), 'left by a kill during the copy')

    runRecovery(storage, { filesDir: paths.files, snapshotsDir: paths.snapshots })
    expect(readdirSync(paths.snapshots)).toEqual([kept.file])
    expect(latestSnapshot(storage)).toBe(kept.file)
    expect(one(storage, "SELECT count(*) FROM failure WHERE kind = 'backup_failed'")).toBe(1)
  })
})

describe('start-up sequence', () => {
  const logger = createLogger({ level: 'error', module: 'test', sink: () => {} })
  const config = (path: string) => ({
    storage: { path, minFreeMb: 2048, criticalFreeMb: 512, checkEveryMin: 5, cacheMaxMb: 512 }
  })

  it('creates the folders, migrates an empty file and reports a clean recovery', async () => {
    const dir = tmpDir()
    const started = await startStorage({ config: config(dir), logger, freeMb: () => 9000 })
    try {
      expect(started.appliedMigrations.length).toBeGreaterThan(0)
      expect(started.recovery.interruptedTurns).toEqual([])
      expect(readdirSync(dir).sort()).toEqual(
        expect.arrayContaining(['aira.db', 'archive', 'cache', 'files', 'snapshots'])
      )
      // An empty file has nothing to protect, so no snapshot is taken before its first migration.
      expect(readdirSync(started.paths.snapshots)).toEqual([])
    } finally {
      started.storage.close()
    }
  })

  it('stops when free space is under the critical level', async () => {
    await expect(startStorage({ config: config(tmpDir()), logger, freeMb: () => 100 })).rejects.toThrow(
      /criticalFreeMb/
    )
  })

  it('stops when the data volume cannot be written', async () => {
    const dir = tmpDir()
    writeFileSync(join(dir, 'not-a-folder'), '')
    await expect(startStorage({ config: config(join(dir, 'not-a-folder')), logger })).rejects.toThrow(StorageError)
  })

  it('stops when the database file is damaged', async () => {
    const dir = tmpDir()
    writeFileSync(join(dir, 'aira.db'), 'x'.repeat(8192))
    await expect(startStorage({ config: config(dir), logger, freeMb: () => 9000 })).rejects.toThrow(StorageError)
  })

  it('interrupts turns left running by the previous process', async () => {
    const dir = tmpDir()
    const first = await startStorage({ config: config(dir), logger, freeMb: () => 9000 })
    receiveInbound(first.storage, key)
    open(first.storage, 't-1')
    first.storage.close()
    const second = await startStorage({ config: config(dir), logger, freeMb: () => 9000 })
    try {
      expect(second.recovery.interruptedTurns).toEqual(['t-1'])
      expect(second.appliedMigrations).toEqual([])
    } finally {
      second.storage.close()
    }
  })
})
