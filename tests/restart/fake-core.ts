// A stand-in for the core process, for the Restart suite. It serves a tiny HTTP endpoint and stores everything
// through the real persistence layer, so the suite can kill it at any point and restart it.
// The gateway endpoint replaces this file's HTTP part when it exists; the storage calls stay the same.
import { randomUUID } from 'node:crypto'
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { createLogger } from '../../src/records/logger.js'
import { putFile, writeFileAtomic } from '../../src/storage/files.js'
import { completeJob, enqueueJob, leaseNextJob, releaseLeases } from '../../src/storage/leases.js'
import { takeSnapshot } from '../../src/storage/snapshot.js'
import { startStorage } from '../../src/storage/startup.js'
import { advanceTurn, closeTurn, openTurn, receiveInbound } from '../../src/storage/turns.js'

const dataDir = process.argv[2]
if (!dataDir) throw new Error('usage: fake-core <data dir>')

// CRASH_AT=<point>:<n> kills the process, as a power cut would, at the nth time the named point is reached.
const [crashPoint, crashCount] = (process.env['CRASH_AT'] ?? ':0').split(':')
let crashHits = 0
function crash(point: string): void {
  if (point === crashPoint && ++crashHits === Number(crashCount)) process.kill(process.pid, 'SIGKILL')
}

const logger = createLogger({ level: 'error', module: 'fake-core', sink: () => {} })
const { storage, paths } = await startStorage({
  config: { storage: { path: dataDir, minFreeMb: 2, criticalFreeMb: 1, checkEveryMin: 5, cacheMaxMb: 16 } },
  logger
})
const owner = randomUUID()
const running = new Map<string, Promise<string | null>>()

async function runTurn(chatId: string, mid: string, senderId: string, text: string): Promise<string | null> {
  const turnId = randomUUID()
  openTurn(storage, { turnId, chatId, senderId, kind: 'reply', mids: [mid] })
  crash('after-open')
  advanceTurn(storage, turnId, 'run')
  // The model call. No transaction is open while it runs.
  await sleep(2 + Math.random() * 6)
  const reply = `reply to ${mid} from turn ${turnId}`
  crash('before-close')
  closeTurn(storage, {
    turnId,
    state: 'delivered',
    reply,
    also: (db) => {
      db.prepare(
        "INSERT INTO session_message (chat_id, turn_id, role, sender_id, content, created_at) VALUES (?, ?, 'user', ?, ?, ?)"
      ).run(chatId, turnId, senderId, text, new Date().toISOString())
      enqueueJob(db, 'memory_job', { jobId: `job-${chatId}-${mid}`, chatId, payload: JSON.stringify({ turnId }) })
    }
  })
  crash('after-close')
  return reply
}

async function handleTurn(body: { chatId: string; mid: string; senderId: string; text: string }) {
  const key = `${body.chatId}\n${body.mid}`
  const status = receiveInbound(storage, body)
  crash('after-receive')
  if (status.status === 'answered') return { reply: status.reply, replayed: true }
  if (status.status === 'dropped') return { reply: null, replayed: true }
  let turn = running.get(key)
  if (status.status === 'running' && !turn) throw new Error('a running turn has no waiter in this process')
  if (!turn) {
    turn = runTurn(body.chatId, body.mid, body.senderId, body.text).finally(() => running.delete(key))
    running.set(key, turn)
  }
  return { reply: await turn, replayed: false }
}

async function handle(path: string, body: Record<string, string>): Promise<unknown> {
  if (path === '/turn') return handleTurn(body as Parameters<typeof handleTurn>[0])
  if (path === '/file') {
    const data = Buffer.from(body['content'] ?? '', 'utf8')
    if (crashPoint === 'mid-file') {
      // The window inside putFile: the file is renamed into place and the row is not yet written.
      writeFileAtomic(join(paths.files, 'zz', 'renamed-without-a-row.bin'), data)
      crash('mid-file')
    }
    return putFile(storage, paths.files, { data, ext: '.bin', kind: 'media' })
  }
  if (path === '/snapshot') {
    const snapshot = takeSnapshot(storage, paths.snapshots, 'manual')
    crash('mid-snapshot')
    return snapshot
  }
  if (path === '/state') {
    return storage.read((db) => ({
      openJobs: db.prepare("SELECT count(*) FROM memory_job WHERE state IN ('queued', 'leased')").pluck().get()
    }))
  }
  throw new Error(`unknown route ${path}`)
}

function readBody(request: IncomingMessage): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    let text = ''
    request.on('data', (chunk) => {
      text += chunk
    })
    request.on('end', () => resolve(text === '' ? {} : JSON.parse(text)))
    request.on('error', reject)
  })
}

const server = createServer((request: IncomingMessage, response: ServerResponse) => {
  readBody(request)
    .then((body) => handle(request.url ?? '', body))
    .then((result) => response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result)))
    .catch((error: Error) => response.writeHead(500).end(error.message))
})

// The memory worker: lease a job, work, then mark it done with its one effect row in the same transaction.
let working = false
const worker = setInterval(async () => {
  if (working) return
  working = true
  try {
    const job = leaseNextJob(storage, 'memory_job', { owner, leaseMs: 2000 })
    if (job) {
      await sleep(3)
      crash('mid-job')
      completeJob(storage, 'memory_job', {
        jobId: job.jobId,
        owner,
        apply: (db) =>
          db
            .prepare(
              "INSERT INTO session_message (chat_id, role, sender_id, content, created_at) VALUES ('job-effects', 'user', ?, 'effect', ?)"
            )
            .run(job.jobId, new Date().toISOString())
      })
    }
  } finally {
    working = false
  }
}, 5)

process.on('SIGTERM', () => {
  clearInterval(worker)
  server.close()
  server.closeAllConnections()
  releaseLeases(storage, 'memory_job', owner)
  storage.close()
  process.exit(0)
})

server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  process.stdout.write(`READY ${address.port}\n`)
})
