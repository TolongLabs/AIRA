import { type ChildProcess, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../../src/storage/database.js'
import { dataPaths } from '../../src/storage/startup.js'
import { tmpDir } from '../support/tmp.js'

// The Restart suite (docs/trd/storage.md#tests). It kills the core process at named points and at random
// moments during a scenario, restarts it, resends as the gateway does, and checks the invariants:
// no acknowledged write is missing, no reply is sent twice, no lease is stuck, and quick_check passes.

const FAKE_CORE = join(import.meta.dirname, 'fake-core.ts')
// The gateway sends the identical request up to six times with the same message id (spike S-3).
const GATEWAY_ATTEMPTS = 6

interface Core {
  proc: ChildProcess
  port: number
  exited: Promise<number | null>
  alive: boolean
}

const cores: Core[] = []

afterEach(() => {
  for (const core of cores.splice(0)) if (core.alive) core.proc.kill('SIGKILL')
})

function startCore(dataDir: string, crashAt?: string): Promise<Core> {
  const proc = spawn(process.execPath, ['--import', 'tsx', FAKE_CORE, dataDir], {
    env: { ...process.env, CRASH_AT: crashAt ?? '' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stderr = ''
  proc.stderr?.on('data', (chunk) => {
    stderr += chunk
  })
  return new Promise((resolve, reject) => {
    const core: Core = {
      proc,
      port: 0,
      alive: true,
      exited: new Promise((done) =>
        proc.on('exit', (code) => {
          core.alive = false
          done(code)
          reject(new Error(`the core exited before it was ready (code ${code}): ${stderr}`))
        })
      )
    }
    cores.push(core)
    let out = ''
    proc.stdout?.on('data', (chunk) => {
      out += chunk
      const ready = /READY (\d+)/.exec(out)
      if (ready) {
        core.port = Number(ready[1])
        resolve(core)
      }
    })
  })
}

async function post<T>(core: Core, path: string, body: unknown = {}): Promise<T | undefined> {
  if (!core.alive) return undefined
  try {
    const response = await fetch(`http://127.0.0.1:${core.port}${path}`, {
      method: 'POST',
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000)
    })
    if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`)
    return (await response.json()) as T
  } catch (error) {
    // A refused or dropped connection is what a killed core looks like to the gateway.
    if ((error as Error).message.includes('answered')) throw error
    return undefined
  }
}

async function stop(core: Core): Promise<void> {
  core.proc.kill('SIGTERM')
  expect(await core.exited).toBe(0)
}

async function drain(core: Core): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const state = await post<{ openJobs: number }>(core, '/state')
    if (state?.openJobs === 0) return
    await sleep(10)
  }
  throw new Error('jobs did not drain')
}

interface Message {
  chatId: string
  mid: string
  senderId: string
  text: string
}

interface Acks {
  replies: Map<string, { message: Message; reply: string }>
  files: Map<string, string>
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex')

/** Opens the data volume after a clean stop and checks every invariant against what was acknowledged. */
function checkInvariants(dataDir: string, acks: Acks): void {
  const paths = dataPaths(dataDir)
  const storage = openDatabase(paths.database)
  try {
    // quick_check and foreign_key_check pass.
    expect(() => storage.check()).not.toThrow()
    const all = <T>(sql: string, ...args: unknown[]) => storage.read((db) => db.prepare(sql).all(...args) as T[])
    const count = (sql: string, ...args: unknown[]) =>
      storage.read(
        (db) =>
          db
            .prepare(sql)
            .pluck()
            .get(...args) as number
      )

    // No acknowledged write is missing: every reply the gateway received is the stored reply of a delivered turn.
    for (const { message, reply } of acks.replies.values()) {
      const [row] = all<{ state: string; turn_state: string; content: string }>(
        `SELECT i.state, t.state AS turn_state, s.content FROM inbound_message i
         JOIN turn t ON t.turn_id = i.turn_id
         JOIN session_message s ON s.turn_id = t.turn_id AND s.role = 'assistant'
         WHERE i.chat_id = ? AND i.mid = ?`,
        message.chatId,
        message.mid
      )
      expect(row, `acknowledged reply for ${message.mid} is missing`).toEqual({
        state: 'answered',
        turn_state: 'delivered',
        content: reply
      })
      // No reply is sent twice: one message has exactly one stored reply, however often its turn ran.
      expect(
        count(
          "SELECT count(*) FROM session_message WHERE chat_id = ? AND role = 'assistant' AND content LIKE ?",
          message.chatId,
          `reply to ${message.mid} from %`
        )
      ).toBe(1)
      // The user's text and the memory job committed with the reply.
      expect(count('SELECT count(*) FROM memory_job WHERE job_id = ?', `job-${message.chatId}-${message.mid}`)).toBe(1)
    }
    // A reply never crosses into another chat.
    expect(
      count('SELECT count(*) FROM session_message s JOIN turn t ON t.turn_id = s.turn_id WHERE s.chat_id <> t.chat_id')
    ).toBe(0)

    // No work is stuck: no running turn, and every interrupted turn has its failure record.
    expect(count("SELECT count(*) FROM turn WHERE state = 'running'")).toBe(0)
    expect(
      count(
        `SELECT count(*) FROM turn t WHERE t.state = 'interrupted' AND NOT EXISTS
           (SELECT 1 FROM failure f WHERE f.turn_id = t.turn_id AND f.kind = 'turn_interrupted')`
      )
    ).toBe(0)

    // No lease is stuck, every job is done, and each job's effect exists exactly once.
    expect(all("SELECT job_id, state FROM memory_job WHERE state <> 'done'")).toEqual([])
    expect(count('SELECT count(*) FROM memory_job WHERE lease_owner IS NOT NULL')).toBe(0)
    expect(
      all(
        `SELECT j.job_id, count(s.id) AS effects FROM memory_job j
         LEFT JOIN session_message s ON s.chat_id = 'job-effects' AND s.sender_id = j.job_id
         GROUP BY j.job_id HAVING effects <> 1`
      )
    ).toEqual([])

    // Every acknowledged file has its row and its bytes. No file is left without a row, and no temporary file.
    for (const [hash, content] of acks.files) {
      const [file] = all<{ path: string }>('SELECT path FROM file WHERE sha256 = ?', hash)
      expect(file, `acknowledged file ${hash} has no row`).toBeDefined()
      expect(readFileSync(join(paths.files, file?.path ?? ''), 'utf8')).toBe(content)
    }
    const rows = new Set(all<{ path: string }>('SELECT path FROM file').map((file) => file.path))
    const onDisk = existsSync(paths.files)
      ? (readdirSync(paths.files, { recursive: true, withFileTypes: true }) as import('node:fs').Dirent[])
          .filter((entry) => entry.isFile())
          .map((entry) => join(entry.parentPath, entry.name).slice(paths.files.length + 1))
      : []
    expect(onDisk.filter((path) => !rows.has(path))).toEqual([])

    // No snapshot is half done. Every verified snapshot opens and passes integrity_check; nothing else is there.
    expect(count("SELECT count(*) FROM backup_run WHERE state = 'started'")).toBe(0)
    const verified = all<{ file: string }>("SELECT file FROM backup_run WHERE state = 'verified'").map(
      (run) => run.file
    )
    expect(readdirSync(paths.snapshots).sort()).toEqual([...verified].sort())
    for (const file of verified) {
      const copy = new Database(join(paths.snapshots, file), { readonly: true })
      try {
        expect(copy.pragma('integrity_check', { simple: true })).toBe('ok')
      } finally {
        copy.close()
      }
    }
  } finally {
    storage.close()
  }
}

/** Starts a clean core, waits for the queue to empty, repeats every answered message, stops, then checks. */
async function settleAndCheck(dataDir: string, acks: Acks): Promise<void> {
  const core = await startCore(dataDir)
  await drain(core)
  for (const { message, reply } of acks.replies.values()) {
    // A late duplicate from the gateway gets the stored reply and runs no turn.
    expect(await post(core, '/turn', message)).toEqual({ reply, replayed: true })
  }
  await drain(core)
  await stop(core)
  checkInvariants(dataDir, acks)
}

const message = (n: number, chatId = 'chat-a'): Message => ({
  chatId,
  mid: `mid-${n}`,
  senderId: 'member-1',
  text: `invented message ${n}`
})

describe('restart: a kill at each named point', () => {
  // Each point is hit by one request; the kill is a SIGKILL, as abrupt as a power cut for the process.
  const turnPoints: [point: string, turnsRun: number, why: string][] = [
    ['after-receive', 1, 'the inbound row exists and no turn started'],
    ['after-open', 2, 'the turn was running'],
    ['before-close', 2, 'the model answered and the reply was not stored'],
    ['after-close', 1, 'the reply was stored and the response never left']
  ]

  it.each(turnPoints)(
    '%s: the resent message is answered once',
    async (point, turnsRun) => {
      const dataDir = tmpDir()
      const acks: Acks = { replies: new Map(), files: new Map() }
      const doomed = await startCore(dataDir, `${point}:1`)
      expect(await post(doomed, '/turn', message(1))).toBeUndefined()
      expect(await doomed.exited).toBeNull()

      // The gateway resends the identical request with the same message id.
      const core = await startCore(dataDir)
      const answer = await post<{ reply: string; replayed: boolean }>(core, '/turn', message(1))
      expect(answer?.reply).toMatch(/^reply to mid-1 from turn /)
      // A reply stored before the kill is returned as it was. Any other kill means the turn runs again.
      expect(answer?.replayed).toBe(point === 'after-close')
      acks.replies.set('mid-1', { message: message(1), reply: answer?.reply ?? '' })
      await stop(core)

      const storage = openDatabase(dataPaths(dataDir).database)
      try {
        const states = storage.read((db) => db.prepare('SELECT state FROM turn ORDER BY received_at').pluck().all())
        expect(states).toHaveLength(turnsRun)
        expect(states.filter((state) => state === 'delivered')).toHaveLength(1)
        expect(states.filter((state) => state === 'interrupted')).toHaveLength(turnsRun - 1)
      } finally {
        storage.close()
      }
      await settleAndCheck(dataDir, acks)
    },
    60_000
  )

  it('mid-job: the job runs again after the restart and its effect exists once', async () => {
    const dataDir = tmpDir()
    const acks: Acks = { replies: new Map(), files: new Map() }
    const doomed = await startCore(dataDir, 'mid-job:1')
    const answer = await post<{ reply: string }>(doomed, '/turn', message(1))
    acks.replies.set('mid-1', { message: message(1), reply: answer?.reply ?? '' })
    expect(await doomed.exited).toBeNull()
    await settleAndCheck(dataDir, acks)
  }, 60_000)

  it('mid-file: a file renamed into place with no row is swept, and the write succeeds when repeated', async () => {
    const dataDir = tmpDir()
    const acks: Acks = { replies: new Map(), files: new Map() }
    const doomed = await startCore(dataDir, 'mid-file:1')
    expect(await post(doomed, '/file', { content: 'invented file' })).toBeUndefined()
    await doomed.exited
    const core = await startCore(dataDir)
    const stored = await post<{ sha256: string }>(core, '/file', { content: 'invented file' })
    expect(stored?.sha256).toBe(sha('invented file'))
    acks.files.set(sha('invented file'), 'invented file')
    await stop(core)
    await settleAndCheck(dataDir, acks)
  }, 60_000)

  it('mid-snapshot: an unfinished snapshot is failed and removed, and the next one is verified', async () => {
    const dataDir = tmpDir()
    const acks: Acks = { replies: new Map(), files: new Map() }
    const doomed = await startCore(dataDir, 'mid-snapshot:1')
    expect(await post(doomed, '/snapshot')).toBeUndefined()
    await doomed.exited
    const core = await startCore(dataDir)
    expect(await post<{ state: string }>(core, '/snapshot')).toMatchObject({ state: 'verified' })
    await stop(core)
    const storage = openDatabase(dataPaths(dataDir).database)
    try {
      expect(storage.read((db) => db.prepare('SELECT state FROM backup_run ORDER BY id').pluck().all())).toEqual([
        'failed',
        'verified'
      ])
    } finally {
      storage.close()
    }
    await settleAndCheck(dataDir, acks)
  }, 60_000)
})

// A small seeded generator, so a failing run can be repeated from its seed.
function generator(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const seeds = (process.env['RESTART_SEEDS'] ?? '11,23,47').split(',').map(Number)
const MAX_KILLS = GATEWAY_ATTEMPTS - 1

describe('restart: kills at random moments during a scenario', () => {
  it.each(seeds)(
    'seed %i keeps every invariant',
    async (seed) => {
      const random = generator(seed)
      const dataDir = tmpDir()
      const acks: Acks = { replies: new Map(), files: new Map() }
      let kills = 0
      let core = await startCore(dataDir)

      // The killer: after a random short time, SIGKILL whatever the core is doing.
      const armKiller = (target: Core) => {
        if (kills >= MAX_KILLS) return
        const timer = setTimeout(
          () => {
            if (target.alive) {
              kills++
              target.proc.kill('SIGKILL')
            }
          },
          5 + random() * 120
        )
        void target.exited.then(() => clearTimeout(timer))
      }
      armKiller(core)

      const ensureCore = async () => {
        if (core.alive) return
        await core.exited
        core = await startCore(dataDir)
        armKiller(core)
      }

      const messages = Array.from({ length: 14 }, (_, n) => message(n, n % 3 === 0 ? 'chat-b' : 'chat-a'))
      for (const [n, item] of messages.entries()) {
        // The gateway: the identical request, up to six times, then it gives up and sends its own failure line.
        for (let attempt = 1; attempt <= GATEWAY_ATTEMPTS; attempt++) {
          await ensureCore()
          const answer = await post<{ reply: string | null }>(core, '/turn', item)
          if (answer?.reply) {
            acks.replies.set(`${item.chatId}/${item.mid}`, { message: item, reply: answer.reply })
            break
          }
          // A failed attempt means the core is going down. The real gateway waits seconds between attempts;
          // here it is enough to wait until the killed process is gone.
          await Promise.race([core.exited, sleep(2000)])
        }
        expect(acks.replies.has(`${item.chatId}/${item.mid}`), `seed ${seed}: ${item.mid} got no reply`).toBe(true)

        if (n % 4 === 1) {
          await ensureCore()
          const content = `invented file ${seed}-${n}`
          if (await post(core, '/file', { content })) acks.files.set(sha(content), content)
        }
        if (n % 5 === 2) {
          await ensureCore()
          await post(core, '/snapshot')
        }
      }

      kills = MAX_KILLS
      if (core.alive) {
        core.proc.kill('SIGKILL')
        await core.exited
      }
      await settleAndCheck(dataDir, acks)
    },
    120_000
  )
})
