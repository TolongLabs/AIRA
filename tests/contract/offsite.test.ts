import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatRestoreReport, restoreOffsite } from '../../scripts/restore-offsite.js'
import type { Config } from '../../src/config/schema.js'
import { createLogger } from '../../src/records/logger.js'
import { type ResticResult, type ResticRunner, createOffsite } from '../../src/storage/offsite.js'
import { startSnapshotTimer, takeSnapshot } from '../../src/storage/snapshot.js'
import { createAlerter } from '../../src/turn/alerts.js'
import { tmpDir, tmpStorage } from '../support/tmp.js'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function offsiteConfig(
  dataDir: string,
  offsite: Config['backup']['offsite'] = {
    kind: 'rest',
    repository: 'rest:http://offsite.invalid:8000/aira',
    checkEveryHours: 24,
    staleAlertMin: 60
  }
): Pick<Config, 'backup' | 'storage'> {
  return {
    storage: { path: dataDir, minFreeMb: 2048, criticalFreeMb: 512, checkEveryMin: 5, cacheMaxMb: 512 },
    backup: { everyMin: 15, keepDays: 14, offsite }
  }
}

function makeLogger(logs: Record<string, unknown>[] = []) {
  return createLogger({ level: 'debug', module: 'test', sink: (line) => logs.push(JSON.parse(line)) })
}

function backupSummaryJson(snapshotId = 'abc123456789def', bytes = 4096): string {
  return JSON.stringify({
    message_type: 'summary',
    snapshot_id: snapshotId,
    total_bytes_processed: bytes
  })
}

describe('offsite shipper', () => {
  it('offsite off runs nothing', async () => {
    const dir = tmpDir()
    const storage = tmpStorage({ dir })
    const logs: Record<string, unknown>[] = []
    const run = vi.fn<ResticRunner>()
    const alerts: { kind: string; detail: Record<string, unknown> }[] = []
    let ms = Date.parse('2026-11-17T00:00:00.000Z')
    const offsite = createOffsite({
      config: offsiteConfig(dir, { kind: 'off', checkEveryHours: 24, staleAlertMin: 60 }),
      env: {},
      run,
      storage,
      alerter: {
        raise(kind, detail) {
          alerts.push({ kind, detail })
          return true
        }
      },
      logger: makeLogger(logs),
      now: () => new Date(ms)
    })

    const snap = await takeSnapshot(storage, join(dir, 'snapshots'), 'timer')
    const stop = offsite.start()
    await offsite.ship(snap.file)
    await offsite.check()
    ms += 120 * 60_000
    offsite.checkStale()
    await stop()

    expect(run).not.toHaveBeenCalled()
    expect(logs).toEqual([])
    expect(alerts).toEqual([])
    expect(
      storage.read((db) =>
        db.prepare("SELECT count(*) FROM backup_run WHERE reason IN ('offsite', 'check')").pluck().get()
      )
    ).toBe(0)
  })

  it('a verified snapshot is shipped with secrets only in the environment', async () => {
    const dir = tmpDir()
    const storage = tmpStorage({ dir })
    mkdirSync(join(dir, 'files'), { recursive: true })
    // Intentionally omit archive/ to verify only existing paths are passed.
    const snap = await takeSnapshot(storage, join(dir, 'snapshots'), 'timer')

    const repoSecret = 'invented-repo-password-99'
    const restUser = 'testuser'
    const restPass = 'invented-rest-password-88'
    const awsKey = 'invented-aws-key-77' // gitleaks:allow (invented test value)
    const awsSecret = 'invented-aws-secret-66' // gitleaks:allow (invented test value)

    const calls: { command: string; args: string[]; env: NodeJS.ProcessEnv }[] = []
    const run: ResticRunner = async (command, args, env) => {
      calls.push({ command, args, env })
      if (args[0] === 'cat') return { code: 0, stdout: '{}', stderr: '' }
      return { code: 0, stdout: backupSummaryJson('snap0011223344', 8192), stderr: '' }
    }

    const logs: Record<string, unknown>[] = []
    const offsite = createOffsite({
      config: offsiteConfig(dir),
      env: {
        AIRA_BACKUP_PASSWORD: repoSecret,
        RESTIC_REST_USERNAME: restUser,
        RESTIC_REST_PASSWORD: restPass,
        AWS_ACCESS_KEY_ID: awsKey,
        AWS_SECRET_ACCESS_KEY: awsSecret,
        LLM_API_KEY: 'unrelated-llm-secret'
      },
      run,
      storage,
      alerter: { raise: () => true },
      logger: makeLogger(logs),
      now: () => new Date('2026-11-17T01:00:00.000Z')
    })

    await offsite.ship(snap.file)

    expect(calls).toHaveLength(2)
    expect(calls[0]?.args).toEqual(['cat', 'config'])
    expect(calls[1]?.command).toBe('restic')
    expect(calls[1]?.args).toEqual([
      'backup',
      '--json',
      '--tag',
      'aira',
      join(dir, 'snapshots', snap.file),
      join(dir, 'files')
    ])

    for (const call of calls) {
      const joinedArgs = call.args.join(' ')
      expect(joinedArgs).not.toContain(repoSecret)
      expect(joinedArgs).not.toContain(restPass)
      expect(joinedArgs).not.toContain(restUser)
      expect(joinedArgs).not.toContain(awsKey)
      expect(joinedArgs).not.toContain(awsSecret)
      expect(call.env['RESTIC_REPOSITORY']).toBe('rest:http://offsite.invalid:8000/aira')
      expect(call.env['RESTIC_PASSWORD']).toBe(repoSecret)
      expect(call.env['RESTIC_REST_USERNAME']).toBe(restUser)
      expect(call.env['RESTIC_REST_PASSWORD']).toBe(restPass)
      expect(call.env['AWS_ACCESS_KEY_ID']).toBeUndefined()
      expect(call.env['AWS_SECRET_ACCESS_KEY']).toBeUndefined()
      expect(call.env['LLM_API_KEY']).toBeUndefined()
    }

    const row = storage.read((db) =>
      db.prepare("SELECT reason, state, file, bytes, detail FROM backup_run WHERE reason = 'offsite'").get()
    ) as Record<string, unknown>
    expect(row).toEqual({
      reason: 'offsite',
      state: 'ok',
      file: snap.file,
      bytes: 8192,
      detail: 'snapshot snap00112233'
    })

    const serializedLogs = JSON.stringify(logs)
    expect(serializedLogs).not.toContain(repoSecret)
    expect(serializedLogs).not.toContain(restPass)
  })

  it('passes only S3 credentials for kind s3 and ships only after snapshot verification', async () => {
    const dir = tmpDir()
    const storage = tmpStorage({ dir })
    const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = []
    const offsite = createOffsite({
      config: offsiteConfig(dir, {
        kind: 's3',
        repository: 's3:https://r2.invalid/bucket/aira',
        checkEveryHours: 24,
        staleAlertMin: 60
      }),
      env: {
        AIRA_BACKUP_PASSWORD: 's3-repo-password',
        RESTIC_REST_USERNAME: 'rest-user',
        RESTIC_REST_PASSWORD: 'rest-password',
        AWS_ACCESS_KEY_ID: 'aws-access-key',
        AWS_SECRET_ACCESS_KEY: 'aws-secret-key'
      },
      run: async (_cmd, args, env) => {
        calls.push({ args, env })
        if (args[0] === 'cat') return { code: 0, stdout: '{}', stderr: '' }
        return { code: 0, stdout: backupSummaryJson(), stderr: '' }
      },
      storage,
      alerter: { raise: () => true },
      logger: makeLogger()
    })

    // Unverified snapshot must NOT trigger onVerified / offsite.ship.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    const brokenStorage = {
      ...storage,
      backup: async (dest: string) => writeFileSync(dest, 'corrupt snapshot bytes')
    }
    const stopBad = startSnapshotTimer(brokenStorage, join(dir, 'snapshots'), {
      everyMin: 1,
      keepDays: 14,
      onVerified: (file) => offsite.ship(file)
    })
    await vi.advanceTimersByTimeAsync(60_000)
    await stopBad()
    expect(calls).toEqual([])

    // Verified snapshot DOES trigger offsite.ship with S3 env.
    const stopGood = startSnapshotTimer(storage, join(dir, 'snapshots'), {
      everyMin: 1,
      keepDays: 14,
      onVerified: (file) => offsite.ship(file)
    })
    await vi.advanceTimersByTimeAsync(60_000)
    await stopGood()
    expect(calls.map((call) => call.args[0])).toEqual(['cat', 'backup'])
    expect(calls[1]?.env['AWS_ACCESS_KEY_ID']).toBe('aws-access-key')
    expect(calls[1]?.env['AWS_SECRET_ACCESS_KEY']).toBe('aws-secret-key')
    expect(calls[1]?.env['RESTIC_REST_USERNAME']).toBeUndefined()
    expect(calls[1]?.env['RESTIC_REST_PASSWORD']).toBeUndefined()
  })

  it('a failed ship writes a failed offsite row and a backup_failed failure, and does not throw', async () => {
    const dir = tmpDir()
    const storage = tmpStorage({ dir })
    const snap = await takeSnapshot(storage, join(dir, 'snapshots'), 'timer')
    const logs: Record<string, unknown>[] = []
    const repoSecret = 'super-secret-repo-pw'
    const restPass = 'super-secret-rest-pw'

    const offsite = createOffsite({
      config: offsiteConfig(dir),
      env: {
        AIRA_BACKUP_PASSWORD: repoSecret,
        RESTIC_REST_USERNAME: 'aira',
        RESTIC_REST_PASSWORD: restPass
      },
      run: async (_cmd, args) => {
        if (args[0] === 'cat') return { code: 0, stdout: '{}', stderr: '' }
        return { code: 1, stdout: '', stderr: `upload refused for ${repoSecret} and ${restPass}` }
      },
      storage,
      alerter: { raise: () => true },
      logger: makeLogger(logs),
      now: () => new Date('2026-11-17T02:00:00.000Z')
    })

    await expect(offsite.ship(snap.file)).resolves.toBeUndefined()

    const runRow = storage.read((db) =>
      db.prepare("SELECT reason, state, file, detail FROM backup_run WHERE reason = 'offsite'").get()
    ) as { reason: string; state: string; file: string; detail: string }
    expect(runRow.reason).toBe('offsite')
    expect(runRow.state).toBe('failed')
    expect(runRow.file).toBe(snap.file)
    expect(runRow.detail).not.toContain(repoSecret)
    expect(runRow.detail).not.toContain(restPass)
    expect(runRow.detail).toContain('[secret]')

    const failures = storage.read((db) =>
      db.prepare("SELECT stage, kind, message, handled_by FROM failure WHERE kind = 'backup_failed'").all()
    ) as { stage: string; kind: string; message: string; handled_by: string }[]
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({ stage: 'offsite', kind: 'backup_failed', handled_by: 'offsite' })
    expect(failures[0]?.message).not.toContain(repoSecret)
    expect(failures[0]?.message).not.toContain(restPass)

    const logText = JSON.stringify(logs)
    expect(logText).not.toContain(repoSecret)
    expect(logText).not.toContain(restPass)
  })

  it('the repository is initialised once when it does not exist', async () => {
    const dir = tmpDir()
    const storage = tmpStorage({ dir })
    const snap1 = await takeSnapshot(storage, join(dir, 'snapshots'), 'timer')
    const snap2 = await takeSnapshot(storage, join(dir, 'snapshots'), 'timer')

    const commands: string[] = []
    let repoExists = false
    const run: ResticRunner = async (_cmd, args): Promise<ResticResult> => {
      commands.push(args.slice(0, 2).join(' '))
      if (args[0] === 'cat') {
        return repoExists
          ? { code: 0, stdout: '{}', stderr: '' }
          : { code: 10, stdout: '', stderr: 'Fatal: repository does not exist' }
      }
      if (args[0] === 'init') {
        repoExists = true
        return { code: 0, stdout: 'created restic repository', stderr: '' }
      }
      return { code: 0, stdout: backupSummaryJson(), stderr: '' }
    }

    const offsite = createOffsite({
      config: offsiteConfig(dir),
      env: { AIRA_BACKUP_PASSWORD: 'repo-password-123' },
      run,
      storage,
      alerter: { raise: () => true },
      logger: makeLogger()
    })

    await offsite.ship(snap1.file)
    await offsite.ship(snap2.file)

    expect(commands).toEqual(['cat config', 'init', 'backup --json', 'backup --json'])
    expect(commands.filter((cmd) => cmd === 'init')).toHaveLength(1)
  })

  it('check runs at most once per checkEveryHours and is recorded', async () => {
    const dir = tmpDir()
    const storage = tmpStorage({ dir })
    let nowMs = Date.parse('2026-11-17T00:00:00.000Z')
    const calls: string[][] = []

    const offsite = createOffsite({
      config: offsiteConfig(dir, {
        kind: 'rest',
        repository: 'rest:http://offsite.invalid:8000/aira',
        checkEveryHours: 24,
        staleAlertMin: 60
      }),
      env: { AIRA_BACKUP_PASSWORD: 'repo-password-123' },
      run: async (_cmd, args) => {
        calls.push(args)
        return { code: 0, stdout: 'no errors were found', stderr: '' }
      },
      storage,
      alerter: { raise: () => true },
      logger: makeLogger(),
      now: () => new Date(nowMs)
    })

    await offsite.check()
    expect(calls).toEqual([['check']])

    // 12 hours later: skipped.
    nowMs += 12 * 3_600_000
    await offsite.check()
    expect(calls).toHaveLength(1)

    // 24 hours after first check: runs again.
    nowMs += 12 * 3_600_000
    await offsite.check()
    expect(calls).toEqual([['check'], ['check']])

    const checkRows = storage.read((db) =>
      db.prepare("SELECT reason, state, file FROM backup_run WHERE reason = 'check' ORDER BY id").all()
    )
    expect(checkRows).toEqual([
      { reason: 'check', state: 'ok', file: '' },
      { reason: 'check', state: 'ok', file: '' }
    ])
  })

  it('a stale off-host copy raises backup_stale once until a run succeeds', async () => {
    const dir = tmpDir()
    const storage = tmpStorage({ dir })
    const snap = await takeSnapshot(storage, join(dir, 'snapshots'), 'timer')
    const alertsFile = join(dir, 'alerts.jsonl')
    const logs: Record<string, unknown>[] = []
    let nowMs = Date.parse('2026-11-17T00:00:00.000Z')
    let shouldSucceed = false

    const alerter = createAlerter({
      minGapMs: 60_000,
      logger: makeLogger(logs),
      storage,
      deliveryFile: alertsFile,
      now: () => new Date(nowMs)
    })

    const offsite = createOffsite({
      config: offsiteConfig(dir, {
        kind: 'rest',
        repository: 'rest:http://offsite.invalid:8000/aira',
        checkEveryHours: 24,
        staleAlertMin: 60
      }),
      env: { AIRA_BACKUP_PASSWORD: 'repo-password-123' },
      run: async (_cmd, args) => {
        if (args[0] === 'cat') return { code: 0, stdout: '{}', stderr: '' }
        return shouldSucceed
          ? { code: 0, stdout: backupSummaryJson(), stderr: '' }
          : { code: 1, stdout: '', stderr: 'connection refused' }
      },
      storage,
      alerter,
      logger: makeLogger(logs),
      now: () => new Date(nowMs)
    })

    // Before staleAlertMin passes: failing ship does not raise backup_stale yet.
    nowMs += 30 * 60_000
    await offsite.ship(snap.file)
    expect(
      storage.read((db) => db.prepare("SELECT count(*) FROM failure WHERE kind = 'backup_stale'").pluck().get())
    ).toBe(0)

    // After staleAlertMin passes: raises backup_stale once, not twice on repeated failures.
    nowMs += 35 * 60_000
    await offsite.ship(snap.file)
    nowMs += 15 * 60_000
    await offsite.ship(snap.file)
    expect(
      storage.read((db) => db.prepare("SELECT count(*) FROM failure WHERE kind = 'backup_stale'").pluck().get())
    ).toBe(1)
    expect(readFileSync(alertsFile, 'utf8').trim().split('\n')).toHaveLength(1)
    expect(JSON.parse(readFileSync(alertsFile, 'utf8').trim())).toMatchObject({ kind: 'backup_stale' })

    // A run succeeds -> resets stale state.
    nowMs += 15 * 60_000
    shouldSucceed = true
    await offsite.ship(snap.file)

    // Failing immediately after success is not stale yet; only after another staleAlertMin does it raise again.
    shouldSucceed = false
    nowMs += 30 * 60_000
    await offsite.ship(snap.file)
    expect(
      storage.read((db) => db.prepare("SELECT count(*) FROM failure WHERE kind = 'backup_stale'").pluck().get())
    ).toBe(1)

    nowMs += 35 * 60_000
    await offsite.ship(snap.file)
    expect(
      storage.read((db) => db.prepare("SELECT count(*) FROM failure WHERE kind = 'backup_stale'").pluck().get())
    ).toBe(2)
    expect(readFileSync(alertsFile, 'utf8').trim().split('\n')).toHaveLength(2)
  })

  it('checks staleness and runs check on the hourly timer', async () => {
    vi.useFakeTimers()
    const dir = tmpDir()
    const storage = tmpStorage({ dir })
    const startMs = Date.parse('2026-11-17T00:00:00.000Z')
    vi.setSystemTime(startMs)

    const raised: string[] = []
    const commands: string[][] = []
    const offsite = createOffsite({
      config: offsiteConfig(dir),
      env: { AIRA_BACKUP_PASSWORD: 'repo-password-123' },
      run: async (_cmd, args) => {
        commands.push(args)
        return { code: 0, stdout: '', stderr: '' }
      },
      storage,
      alerter: {
        raise(kind) {
          raised.push(kind)
          return true
        }
      },
      logger: makeLogger(),
      now: () => new Date()
    })

    const stop = offsite.start()
    await vi.advanceTimersByTimeAsync(3_600_000)
    await vi.advanceTimersByTimeAsync(3_600_000)
    await stop()

    expect(raised).toEqual(['backup_stale'])
    expect(commands).toEqual([['check']])
  })
})

describe('restore script', () => {
  it('restore refuses a non-empty folder', async () => {
    const target = tmpDir()
    writeFileSync(join(target, 'existing.txt'), 'keep')
    const run = vi.fn<ResticRunner>()

    await expect(
      restoreOffsite({
        to: target,
        repository: 'rest:http://offsite.invalid:8000/aira',
        env: { AIRA_BACKUP_PASSWORD: 'repo-password-123' },
        run
      })
    ).rejects.toThrow(/not empty/)
    expect(run).not.toHaveBeenCalled()
  })

  it('restores into an empty folder, runs integrity_check read-only, and prints time and table row counts', async () => {
    const sourceDir = tmpDir()
    const storage = tmpStorage({ dir: sourceDir })
    storage.tx((db) =>
      db
        .prepare(
          "INSERT INTO chat (chat_id, wa_id, type, status, created_at) VALUES ('c_1', 'test-chat-restore', 'group', 'active', '2026-11-17T00:00:00.000Z')"
        )
        .run()
    )
    const snap = await takeSnapshot(storage, join(sourceDir, 'snapshots'), 'manual')
    expect(snap.state).toBe('verified')

    const restoreTarget = tmpDir()
    const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = []
    const run: ResticRunner = async (_cmd, args, env) => {
      calls.push({ args, env })
      if (args[0] === 'snapshots') {
        return {
          code: 0,
          stdout: JSON.stringify([{ id: 'deadbeef1234', time: '2026-11-17T03:00:00.000Z' }]),
          stderr: ''
        }
      }
      if (args[0] === 'restore') {
        const destSnapDir = join(restoreTarget, 'data', 'snapshots')
        mkdirSync(destSnapDir, { recursive: true })
        copyFileSync(join(sourceDir, 'snapshots', snap.file), join(destSnapDir, snap.file))
        return { code: 0, stdout: '', stderr: '' }
      }
      return { code: 1, stdout: '', stderr: 'unexpected command' }
    }

    const report = await restoreOffsite({
      to: restoreTarget,
      repository: 'rest:http://offsite.invalid:8000/aira',
      env: { AIRA_BACKUP_PASSWORD: 'repo-password-123' },
      run
    })

    expect(calls[0]?.args).toEqual(['snapshots', '--json', '--latest', '1'])
    expect(calls[1]?.args).toEqual(['restore', 'deadbeef1234', '--target', restoreTarget])
    expect(report.snapshotId).toBe('deadbeef1234')
    expect(report.snapshotTime).toBe('2026-11-17T03:00:00.000Z')
    expect(report.counts.find((entry) => entry.table === 'chat')?.rows).toBe(1)

    const formatted = formatRestoreReport(report)
    expect(formatted).toContain('2026-11-17T03:00:00.000Z')
    expect(formatted).toContain('integrity_check: ok')
    expect(formatted).toContain('chat: 1')
  })
})
