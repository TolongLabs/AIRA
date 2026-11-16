import { spawn } from 'node:child_process'
import { timingSafeEqual } from 'node:crypto'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'

const MAX_BODY_BYTES = 2 * 1024 * 1024
const LOOPBACK_URL_RE = /^http:\/\/(127\.0\.0\.1|localhost):\d+$/
const HEX_TOKEN_RE = /^[0-9a-fA-F]{16,128}$/

const runnerToken = process.env.RUNNER_TOKEN
if (typeof runnerToken !== 'string' || runnerToken.length < 16) {
  process.stderr.write('RUNNER_TOKEN is missing or shorter than 16 characters\n')
  process.exit(1)
}

const port = Number(process.env.RUNNER_PORT || 9882)

function parseProgram(raw) {
  if (!raw) return ['claude']
  if (raw.startsWith('[')) {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((item) => typeof item === 'string')) {
      return parsed
    }
  }
  return [raw]
}

const [program, ...leadingArgs] = parseProgram(process.env.RUNNER_PROGRAM)
const tokenBuffer = Buffer.from(runnerToken, 'utf8')
const activeChildren = new Set()

function isAuthorized(req) {
  const header = req.headers.authorization
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false
  const given = Buffer.from(header.slice('Bearer '.length), 'utf8')
  if (given.length !== tokenBuffer.length) return false
  return timingSafeEqual(given, tokenBuffer)
}

function readBody(req) {
  const contentLength = req.headers['content-length']
  if (contentLength !== undefined && Number(contentLength) > MAX_BODY_BYTES) {
    return Promise.resolve({ ok: false, status: 413 })
  }
  return new Promise((resolve) => {
    const chunks = []
    let total = 0
    let done = false
    req.on('data', (chunk) => {
      if (done) return
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        done = true
        req.destroy()
        resolve({ ok: false, status: 413 })
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (done) return
      done = true
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolve({ ok: true, body: parsed })
      } catch {
        resolve({ ok: false, status: 400 })
      }
    })
    req.on('error', () => {
      if (done) return
      done = true
      resolve({ ok: false, status: 400 })
    })
  })
}

// The program's effort levels (docs/trd/models.md#run-request).
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

function isValidRequest(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return false
  if (typeof body.system !== 'string' || typeof body.prompt !== 'string') return false
  if (body.model !== undefined && typeof body.model !== 'string') return false
  if (body.effort !== undefined && !EFFORTS.includes(body.effort)) return false
  if (body.tools === null || typeof body.tools !== 'object' || Array.isArray(body.tools)) return false
  if (typeof body.tools.url !== 'string' || !LOOPBACK_URL_RE.test(body.tools.url)) return false
  if (typeof body.tools.token !== 'string' || !HEX_TOKEN_RE.test(body.tools.token)) return false
  if (typeof body.timeoutMs !== 'number' || !Number.isFinite(body.timeoutMs)) return false
  if (body.timeoutMs < 1000 || body.timeoutMs > 600000) return false
  return true
}

function killChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  const force = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
    }
  }, 2000)
  force.unref()
}

async function handleRun(req, res) {
  if (!isAuthorized(req)) {
    res.writeHead(401).end()
    return
  }
  const read = await readBody(req)
  if (!read.ok) {
    res.writeHead(read.status).end()
    return
  }
  const body = read.body
  if (!isValidRequest(body)) {
    res.writeHead(400).end()
    return
  }

  const started = Date.now()
  const scratchDir = await mkdtemp(path.join(os.tmpdir(), 'aira-runner-'))
  const cleanup = () => rm(scratchDir, { recursive: true, force: true }).catch(() => {})
  const systemFile = path.join(scratchDir, 'system.txt')
  const mcpFile = path.join(scratchDir, 'mcp.json')
  try {
    await chmod(scratchDir, 0o700)
    // The system prompt holds recalled memory, and the tool server config holds this turn's token. Both go in
    // private files, so neither shows in the host's process list.
    await writeFile(systemFile, body.system, { encoding: 'utf8', mode: 0o600 })
    await writeFile(
      mcpFile,
      JSON.stringify({
        mcpServers: {
          aira: {
            type: 'http',
            url: `${body.tools.url}/mcp`,
            headers: { Authorization: `Bearer ${body.tools.token}` }
          }
        }
      }),
      { encoding: 'utf8', mode: 0o600 }
    )
  } catch (error) {
    await cleanup()
    throw error
  }

  const args = [
    ...leadingArgs,
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--system-prompt-file',
    systemFile,
    '--tools',
    '',
    '--setting-sources',
    '',
    '--no-session-persistence',
    '--disable-slash-commands',
    '--strict-mcp-config',
    '--mcp-config',
    mcpFile,
    '--allowedTools',
    'mcp__aira'
  ]
  if (body.model !== undefined && body.model !== '') {
    args.push('--model', body.model)
  }
  if (body.effort !== undefined) args.push('--effort', body.effort)

  res.writeHead(200, { 'content-type': 'application/x-ndjson' })

  // The program gets the service's environment, for the owner's login, but never the service's own secret.
  const { RUNNER_TOKEN: _secret, ...childEnv } = process.env
  const child = spawn(program, args, {
    cwd: scratchDir,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'ignore']
  })
  activeChildren.add(child)

  let timedOut = false
  let clientClosed = false
  let finished = false
  let buffer = ''

  const timer = setTimeout(() => {
    timedOut = true
    if (!res.writableEnded) {
      res.write(`${JSON.stringify({ type: 'runner_error', kind: 'timeout' })}\n`)
    }
    killChild(child)
  }, body.timeoutMs)
  timer.unref()

  res.on('close', () => {
    if (!finished) {
      clientClosed = true
      killChild(child)
    }
  })

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let nl = buffer.indexOf('\n')
    while (nl !== -1) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      if (!res.writableEnded) res.write(`${line}\n`)
      nl = buffer.indexOf('\n')
    }
  })

  child.on('error', async () => {
    finished = true
    clearTimeout(timer)
    activeChildren.delete(child)
    await cleanup()
    if (!res.writableEnded) {
      res.write(`${JSON.stringify({ type: 'runner_error', kind: 'spawn_failed' })}\n`)
      res.end()
    }
    process.stdout.write(`run ended code=spawn_failed ms=${Date.now() - started}\n`)
  })

  child.on('close', async (code) => {
    finished = true
    clearTimeout(timer)
    activeChildren.delete(child)
    if (buffer !== '' && !res.writableEnded) {
      res.write(`${buffer}\n`)
      buffer = ''
    }
    if (!timedOut && !clientClosed && code !== 0 && !res.writableEnded) {
      res.write(`${JSON.stringify({ type: 'runner_error', kind: 'exit', code: code ?? 1 })}\n`)
    }
    await cleanup()
    if (!res.writableEnded) res.end()
    process.stdout.write(`run ended code=${code ?? 'null'} ms=${Date.now() - started}\n`)
  })

  child.stdin.on('error', () => {})
  child.stdin.end(body.prompt)
}

const server = createServer((req, res) => {
  const reqPath = (req.url ?? '').split('?')[0]
  if (req.method === 'GET' && reqPath === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
    return
  }
  if (req.method === 'POST' && reqPath === '/run') {
    void handleRun(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500).end()
      else res.end()
    })
    return
  }
  res.writeHead(reqPath === '/run' || reqPath === '/health' ? 405 : 404).end()
})

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`runner listening on 127.0.0.1:${server.address().port}\n`)
})

function shutdown() {
  for (const child of activeChildren) {
    killChild(child)
  }
  server.close(() => {
    process.exit(0)
  })
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
