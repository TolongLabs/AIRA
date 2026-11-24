import { execFile } from 'node:child_process'
import { timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { forwardRouter, legacyStatus } from './dashboard-router-bridge.js'
import { DashboardSettingsStore, type RouterStatus, SettingsError } from './dashboard-settings-store.js'
import { acquireDeployLock } from './updater/ops.js'

const exec = promisify(execFile)
const root = process.env.AIRA_SETTINGS_INSTALL_DIR || join(homedir(), 'aira')
const tokenFile = process.env.AIRA_SETTINGS_TOKEN_FILE || join(homedir(), '.hermes/brain/.site-token')
const base = ['compose', '-f', join(root, 'compose.yml')]
async function docker(args: string[], env = process.env, timeout = 10000) {
  try {
    return (await exec('docker', args, { cwd: root, env, timeout, maxBuffer: 128 * 1024 })).stdout.trim()
  } catch {
    throw new SettingsError(503, 'Could not complete the requested container operation')
  }
}
async function container() {
  const id = await docker([...base, 'ps', '-aq', 'aira'])
  if (!/^[0-9a-f]{12,64}$/.test(id)) throw new SettingsError(503, 'Core container unavailable')
  return id
}
async function coreRunnerStatus(): Promise<RouterStatus> {
  try {
    // Probe from the core network. The token stays inside that process and only a fixed status is returned.
    const code =
      "import {runnerStatus} from '/app/dist/src/models/dashboard-runner-status.js';import {loadConfig} from '/app/dist/src/config/loader.js';const c=loadConfig(process.env.AIRA_CONFIG||'/app/config.yml');console.log(JSON.stringify(await runnerStatus(c.llm.subscription.runnerUrl,process.env.RUNNER_TOKEN)))"
    const reply = JSON.parse(await docker(['exec', await container(), 'node', '--input-type=module', '-e', code]))
    if (typeof reply.available === 'boolean' && typeof reply.status === 'string') return reply
  } catch {}
  return { available: false, status: 'Runner unavailable' }
}
async function routerStatus(): Promise<RouterStatus> {
  const [core, legacy] = await Promise.all([coreRunnerStatus(), legacyStatus()])
  return { ...core, legacy }
}
async function prepareRecreate() {
  const image = await docker(['inspect', '--format', '{{.Config.Image}}', await container()])
  const split = image.lastIndexOf(':')
  if (split <= image.lastIndexOf('/')) throw new SettingsError(503, 'Cannot identify the installed image')
  const env = { ...process.env, AIRA_IMAGE: image.slice(0, split), AIRA_VERSION: image.slice(split + 1) }
  return async () => {
    await docker(
      [
        ...base,
        'up',
        '-d',
        '--no-deps',
        '--force-recreate',
        '--pull',
        'never',
        '--wait',
        '--wait-timeout',
        '90',
        'aira'
      ],
      env,
      110000
    )
  }
}

async function readBody(req: IncomingMessage) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) throw new SettingsError(415, 'Send JSON')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 192 * 1024) throw new SettingsError(413, 'Request too large')
    chunks.push(chunk)
  }
  try {
    const input = JSON.parse(Buffer.concat(chunks).toString())
    if (input && typeof input === 'object' && !Array.isArray(input)) return input
  } catch {}
  throw new SettingsError(400, 'Invalid request')
}
function respond(res: ServerResponse, status: number, data: unknown) {
  res
    .writeHead(status, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    })
    .end(JSON.stringify(data))
}
async function handle(req: IncomingMessage, res: ServerResponse) {
  // This fixed inference path is reachable only over the owner-mode Unix socket, never from the dashboard proxy.
  if (req.method === 'POST' && req.url === '/internal/aira_router') return forwardRouter(req, res)
  const token = readFileSync(tokenFile, 'utf8').trim()
  const supplied = Buffer.from(String(req.headers['x-tolongai-token'] ?? ''))
  if (!token || supplied.length !== Buffer.byteLength(token) || !timingSafeEqual(supplied, Buffer.from(token)))
    throw new SettingsError(401, 'Owner token required')
  const store = new DashboardSettingsStore(root, Buffer.from(token))
  if (req.url === '/api/settings/core_config' && req.method === 'GET')
    return respond(res, 200, store.snapshot(await routerStatus()))
  if (req.method !== 'POST' || !['/api/settings/core_save', '/api/settings/core_apply'].includes(req.url ?? ''))
    throw new SettingsError(404, 'Unknown settings operation')
  const input = await readBody(req)
  const lock = await acquireDeployLock(join(root, 'deploy.lock'))
  if (!lock) throw new SettingsError(409, 'A deployment is in progress. Retry after it finishes.')
  let background = false
  try {
    if (req.url === '/api/settings/core_apply') {
      const snapshot = store.snapshot(await routerStatus())
      if (input.revision !== snapshot.revision)
        throw new SettingsError(409, 'Settings changed. Refresh before applying.')
      if (snapshot.state === 'current' || snapshot.state === 'restored')
        return respond(res, 200, { state: snapshot.state })
      // Acknowledge before replacing the container that forwarded this HTTP request.
      store.pendingForApply(input.revision)
      store.checkPendingRoutes(snapshot.router)
      const recreate = await prepareRecreate()
      background = true
      respond(res, 202, { state: 'applying' })
      void store
        .apply(input.revision, recreate)
        .catch(() => {})
        .finally(() => lock.release())
    } else {
      const router = await routerStatus()
      store.save(input, router)
      respond(res, 200, store.snapshot(router))
    }
  } finally {
    if (!background) await lock.release()
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (process.argv[2] === 'serve') {
    const server = createServer((req, res) => {
      void handle(req, res).catch((error) =>
        respond(res, error instanceof SettingsError ? error.status : 503, {
          error: error instanceof SettingsError ? error.message : 'Settings middleware unavailable'
        })
      )
    })
    server.requestTimeout = 15000
    // Resume an interrupted activation under the same lock used by releases.
    const startup = async () => {
      const lock = await acquireDeployLock(join(root, 'deploy.lock'))
      if (!lock) return
      try {
        const store = new DashboardSettingsStore(root, Buffer.from(readFileSync(tokenFile, 'utf8').trim()))
        store.recoverPrepared()
        const current = store.snapshot({ available: false, status: 'Unchecked' })
        if (current.state === 'applying') await store.apply(current.revision, await prepareRecreate())
      } finally {
        await lock.release()
      }
    }
    void startup().catch(() => {})
    server.listen({ fd: 3 })
  } else {
    // Local operator CLI. Credential input uses stdin and is never placed in the process arguments.
    const command = process.argv[2]
    if (!['status', 'save', 'apply'].includes(command ?? '')) {
      process.stderr.write('Use status, save, or apply. Supply JSON on stdin for writes.\n')
      process.exitCode = 2
    } else {
      const { request } = await import('node:http')
      const data = command === 'status' ? '' : readFileSync(0, 'utf8')
      const req = request(
        {
          socketPath:
            process.env.AIRA_SETTINGS_SOCKET || join(homedir(), '.local/share/aira/gateway-directory/settings.sock'),
          path: '/api/settings/core_' + (command === 'status' ? 'config' : command),
          method: command === 'status' ? 'GET' : 'POST',
          headers: { 'x-tolongai-token': readFileSync(tokenFile, 'utf8').trim(), 'content-type': 'application/json' }
        },
        (res) => {
          if ((res.statusCode ?? 500) >= 400) process.exitCode = 1
          res.pipe(process.stdout)
        }
      )
      req.on('error', () => {
        process.stderr.write('Settings middleware unavailable\n')
        process.exitCode = 1
      })
      req.end(data)
    }
  }
}
