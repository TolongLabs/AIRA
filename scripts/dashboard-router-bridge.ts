import { execFile } from 'node:child_process'
import { readdir, readFile, readlink } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

// The old gateway and the current core can use the same port. Identify the listening process before forwarding.
async function endpoint() {
  const { stdout } = await exec(
    'systemctl',
    ['--user', 'show', 'aira-router.service', '--property=MainPID', '--value'],
    { timeout: 2000 }
  )
  const pid = stdout.trim()
  if (!/^[1-9]\d*$/.test(pid)) return null
  const fdDir = '/proc/' + pid + '/fd'
  const sockets = new Set(
    await Promise.all((await readdir(fdDir)).map((fd) => readlink(join(fdDir, fd)).catch(() => '')))
  )
  for (const line of (await readFile('/proc/net/tcp', 'utf8')).trim().split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/)
    if (fields[3] !== '0A' || !fields[1]?.startsWith('0100007F:') || !sockets.has('socket:[' + fields[9] + ']'))
      continue
    const origin = 'http://127.0.0.1:' + parseInt(fields[1].split(':')[1]!, 16)
    const r = await fetch(origin + '/v1/models', { redirect: 'error', signal: AbortSignal.timeout(1500) })
    const result = (await r.json()) as { data?: { id?: string; owned_by?: string }[] }
    if (r.ok && result.data?.some((m) => m.id === 'aira' && m.owned_by === 'local')) return origin
  }
  return null
}
export async function legacyStatus() {
  try {
    if (!(await endpoint())) return { available: false, status: 'Stopped or not listening' }
    // Check the host login without sending a prompt. Never return identity or raw CLI output.
    for (const binary of [
      process.env.CLAUDE_BIN,
      'claude',
      '/usr/local/bin/claude',
      join(homedir(), '.local/bin/claude')
    ]) {
      if (!binary) continue
      try {
        const { stdout } = await exec(binary, ['auth', 'status', '--json'], { timeout: 4000, maxBuffer: 65536 })
        if (JSON.parse(stdout).loggedIn === true) return { available: true, status: 'Available' }
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') break
      }
    }
  } catch {}
  return { available: false, status: 'Claude login or router unavailable' }
}
export async function forwardRouter(req: IncomingMessage, res: ServerResponse) {
  const limit = 2 * 1024 * 1024
  const chunks: Buffer[] = []
  let size = 0
  for await (const b of req) {
    size += b.length
    if (size > limit) {
      res.writeHead(413).end()
      return
    }
    chunks.push(b)
  }
  const origin = await endpoint()
  if (!origin) {
    res.writeHead(503).end()
    return
  }
  const abort = new AbortController()
  res.once('close', () => abort.abort())
  const reply = await fetch(origin + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: Buffer.concat(chunks).toString(),
    redirect: 'error',
    signal: AbortSignal.any([abort.signal, AbortSignal.timeout(120000)])
  })
  if (!reply.ok) {
    await reply.body?.cancel()
    res.writeHead(reply.status).end()
    return
  }
  const body: Uint8Array[] = []
  size = 0
  const reader = reply.body!.getReader()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    size += value.length
    if (size > limit) {
      await reader.cancel()
      res.writeHead(502).end()
      return
    }
    body.push(value)
  }
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(Buffer.concat(body))
}
