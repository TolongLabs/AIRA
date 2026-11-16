import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { loadConfig } from '../src/config/loader.js'
import type { SimBackend } from '../tests/harness/sim/backend.js'
import { startLevel1 } from '../tests/harness/sim/level1.js'
import { startLevel2 } from '../tests/harness/sim/level2.js'
import { startSimServer } from '../tests/harness/sim/server.js'

// The WhatsApp simulator (docs/trd/harness.md#whatsapp-simulator).
//   bun run sim                       level 1: the core in this process, and the chat preview
//   bun run sim --gateway             level 2: a fake bridge for a staging gateway, and the preview of its calls
//   bun run sim --gateway --bridge U  level 2 against a fake bridge that is already running at U

const USAGE = `usage: bun run sim [options]

  --port <n>          preview port (default 9900)
  --character <id>    character both chats are bound to (default: the data folder's global binding, else example)
  --data <dir>        data folder (default: a scratch folder that is removed on exit). Its characters/ folder holds packs
  --gateway           level 2: do not start a core; draw the calls a staging gateway makes to a fake bridge
  --bridge <url>      level 2: use the fake bridge already running at <url> (default: start one)
  --bridge-port <n>   level 2: port of the fake bridge the sim starts (default 3000)
  --media-root <dir>  level 2: a folder sent files may come from (repeat; others are recorded, never read)
  --dm-id <id>        level 2: the id the gateway knows the direct chat by (default sim-dm-0001)
  --group-id <id>     level 2: the id the gateway knows the group by (default sim-group-0001)
`

const root = fileURLToPath(new URL('..', import.meta.url))

function fail(message: string): never {
  process.stderr.write(`sim: ${message}\n`)
  process.exit(2)
}

let values: ReturnType<typeof parseArgs>['values']
try {
  values = parseArgs({
    options: {
      port: { type: 'string' },
      character: { type: 'string' },
      data: { type: 'string' },
      gateway: { type: 'boolean', default: false },
      bridge: { type: 'string' },
      'bridge-port': { type: 'string' },
      'dm-id': { type: 'string' },
      'group-id': { type: 'string' },
      'media-root': { type: 'string', multiple: true },
      help: { type: 'boolean', short: 'h', default: false }
    }
  }).values
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n\n${USAGE}`)
  process.exit(2)
}
if (values['help']) {
  process.stdout.write(USAGE)
  process.exit(0)
}

const port = (name: string, fallback: number): number => {
  const raw = values[name]
  if (raw === undefined) return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0 || n > 65535) fail(`--${name} must be a port number`)
  return n
}
const text = (name: string): string | undefined =>
  typeof values[name] === 'string' ? (values[name] as string) : undefined
if (!values['gateway'] && (values['bridge'] !== undefined || values['bridge-port'] !== undefined)) {
  fail('--bridge and --bridge-port belong to level 2: add --gateway')
}

// Keys come from the environment; a .env file in the repository fills in what the shell has not set.
if (existsSync(`${root}.env`)) process.loadEnvFile(`${root}.env`)

let backend: SimBackend
let banner: string[]
try {
  if (values['gateway']) {
    const level2 = await startLevel2({
      ...(text('bridge') !== undefined ? { bridgeUrl: text('bridge') as string } : {}),
      bridgePort: port('bridge-port', 3000),
      ...(text('dm-id') !== undefined ? { dmId: text('dm-id') as string } : {}),
      ...(text('group-id') !== undefined ? { groupId: text('group-id') as string } : {}),
      mediaRoots: (values['media-root'] as string[] | undefined) ?? []
    })
    backend = level2
    const ids = level2.info().chats.map((chat) => `${chat.kind} ${chat.id}`)
    banner = [
      `level 2: the preview reads the fake bridge at ${level2.bridgeUrl}`,
      `chats the gateway must accept: ${ids.join(', ')}`
    ]
  } else {
    const config = loadConfig(process.env['AIRA_CONFIG'] ?? 'config.yml')
    const dataDir = text('data')
    const level1 = await startLevel1({
      config,
      env: process.env,
      repositoryDir: root,
      ...(dataDir !== undefined ? { dataDir } : {}),
      ...(text('character') !== undefined ? { character: text('character') as string } : {})
    })
    backend = level1
    banner = [
      `level 1: the core runs in this process, character ${level1.character}`,
      `data folder: ${level1.dataDir}${dataDir === undefined ? ' (scratch, removed on exit)' : ''}`
    ]
  }
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code
  fail(
    code === 'EADDRINUSE'
      ? 'that port is already in use: pick another with --port or --bridge-port'
      : (error as Error).message
  )
}

let server: Awaited<ReturnType<typeof startSimServer>>
try {
  server = await startSimServer(backend, { port: port('port', 9900) })
} catch (error) {
  await backend.close()
  const code = (error as NodeJS.ErrnoException).code
  fail(
    code === 'EADDRINUSE' ? 'the preview port is already in use: pick another with --port' : (error as Error).message
  )
}

process.stdout.write(`\nAIRA chat preview: ${server.url}\n${banner.join('\n')}\nPress Ctrl+C to stop.\n\n`)

let stopping = false
const stop = (): void => {
  if (stopping) return
  stopping = true
  void server
    .close()
    .then(() => backend.close())
    .then(() => process.exit(0))
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
