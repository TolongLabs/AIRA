// The core as its own process, for the Restart suite: the real storage, the real turn pipeline and the real
// gateway endpoint, with a scripted runner in place of a model. The suite kills it at any point and restarts it.
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { type IncomingMessage, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { loadPacks } from '../../src/character/loader.js'
import { parseConfig } from '../../src/config/loader.js'
import { createGatewayServer } from '../../src/gateway/server.js'
import { createLogger } from '../../src/records/logger.js'
import { createRedactor } from '../../src/records/redact.js'
import { ensureChat, setChatStatus } from '../../src/settings/chats.js'
import { resolveSetting, setSetting } from '../../src/settings/settings.js'
import { putFile, writeFileAtomic } from '../../src/storage/files.js'
import { completeJob, enqueueJob, leaseNextJob, releaseLeases } from '../../src/storage/leases.js'
import { takeSnapshot } from '../../src/storage/snapshot.js'
import { startStorage } from '../../src/storage/startup.js'
import { createAlerter } from '../../src/turn/alerts.js'
import { basicPromptBuilder, plainCleaner } from '../../src/turn/defaults.js'
import { createTurnService } from '../../src/turn/pipeline.js'

const dataDir = process.argv[2]
if (!dataDir) throw new Error('usage: core-process <data dir>')

// CRASH_AT=<point>:<n> kills the process, as a power cut would, at the nth time the named point is reached.
const [crashPoint, crashCount] = (process.env['CRASH_AT'] ?? ':0').split(':')
let crashHits = 0
function crash(point: string): void {
  if (point === crashPoint && ++crashHits === Number(crashCount)) process.kill(process.pid, 'SIGKILL')
}

const config = parseConfig(readFileSync('config.yml', 'utf8'))
config.turn.batchMs = 15
const logger = createLogger({ level: 'error', module: 'core-process', sink: () => {} })
const { storage, paths } = await startStorage({
  config: { storage: { ...config.storage, path: dataDir, minFreeMb: 2, criticalFreeMb: 1 } },
  logger
})

// What an operator does once: bind the default character and switch the test chats on. Safe to repeat.
if (resolveSetting(storage, { chatId: '-', type: 'group' }, 'character').level === 'unset') {
  setSetting(storage, { level: 'global', scope: '', key: 'character', value: 'example', actor: 'restart-suite' })
}
for (const waId of (process.env['ACTIVE_CHATS'] ?? '').split(',').filter(Boolean)) {
  const chat = ensureChat(storage, { waId, type: 'group' })
  setChatStatus(storage, { chatId: chat.chatId, status: 'active', actor: 'restart-suite' })
}

const owner = randomUUID()
const redactor = createRedactor()
const turns = createTurnService({
  storage,
  config,
  logger,
  redactor,
  packs: () => loadPacks({ repositoryDir: 'characters', dataDir: join(dataDir, 'characters') }),
  runner: {
    async run({ messages, context }) {
      // The model call. No transaction is open while it runs.
      await sleep(2 + Math.random() * 6)
      const asked = messages.filter((message) => message.role === 'user').at(-1)?.content ?? ''
      const usage = { inputTokens: 1, outputTokens: 1, cachedTokens: 0 }
      return {
        text: `reply to ${asked} from ${context.turnId}`,
        usage,
        costUsd: 0,
        model: 'scripted',
        role: 'main',
        transport: 'api',
        calls: [
          { role: 'main', model: 'scripted', transport: 'api', attempt: 1, startedAt: new Date(), durationMs: 1, usage }
        ],
        receipts: []
      }
    }
  },
  prompt: {
    build(input) {
      crash('after-open')
      return basicPromptBuilder.build(input)
    }
  },
  cleaner: {
    clean(input) {
      crash('before-close')
      return plainCleaner.clean(input)
    }
  },
  alerter: createAlerter({ minGapMs: config.alerts.minGapMs, logger }),
  hooks: {
    // Step 9: memory work is queued in the transaction that closes the turn.
    onDelivered: (db, context) =>
      enqueueJob(db, 'memory_job', {
        jobId: `job-${context.turnId}`,
        chatId: context.chat.chatId,
        payload: JSON.stringify({ turnId: context.turnId })
      })
  }
})

const gateway = createGatewayServer({
  turns: {
    ...turns,
    async handle(request) {
      const pending = turns.handle(request)
      // The inbound row is written; no turn is open yet.
      crash('after-receive')
      const reply = await pending
      // The reply is stored; the response has not left.
      crash('after-close')
      return reply
    }
  },
  storage,
  logger,
  redactor,
  ready: () => true
})

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

// A control port for the parts of the persistence layer that no chat message reaches.
async function control(path: string, body: Record<string, string>): Promise<unknown> {
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

const controlServer = createServer((request, response) => {
  readBody(request)
    .then((body) => control(request.url ?? '', body))
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

process.on('SIGTERM', async () => {
  clearInterval(worker)
  await turns.drain(config.shutdown.graceMs)
  for (const server of [gateway, controlServer]) {
    server.close()
    server.closeAllConnections()
  }
  releaseLeases(storage, 'memory_job', owner)
  storage.close()
  process.exit(0)
})

await Promise.all(
  [gateway, controlServer].map((server) => new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)))
)
const port = (server: typeof gateway) => (server.address() as AddressInfo).port
process.stdout.write(`READY ${port(gateway)} ${port(controlServer)}\n`)
