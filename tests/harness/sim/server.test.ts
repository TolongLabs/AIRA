import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { tmpDir } from '../../support/tmp.js'
import { type SimBackend, SimInputError } from './backend.js'
import { type SimServer, startSimServer } from './server.js'
import { findPhoto, findSticker } from './stickers.js'

// The sticker route serves a .webp from a pack's stickers folder, and nothing else (docs/trd/harness.md#chat-preview).

const servers: SimServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

function layout() {
  const dataDir = tmpDir('aira-sim-data-')
  const repositoryDir = tmpDir('aira-sim-repo-')
  const write = (base: string, path: string, content: string) => {
    mkdirSync(join(base, path, '..'), { recursive: true })
    writeFileSync(join(base, path), content)
  }
  write(dataDir, 'characters/pack/stickers/a.webp', 'data-sticker')
  write(dataDir, 'characters/pack/stickers/notes.txt', 'not an image')
  write(dataDir, 'characters/pack/other.webp', 'outside the stickers folder')
  write(dataDir, 'secret.webp', 'secret')
  write(dataDir, 'characters/same/stickers/x.webp', 'from the data folder')
  write(repositoryDir, 'characters/same/stickers/x.webp', 'from the repository')
  write(repositoryDir, 'characters/rpack/stickers/r.webp', 'repository-sticker')
  symlinkSync(join(dataDir, 'secret.webp'), join(dataDir, 'characters/pack/stickers/link.webp'))
  const hash = 'b'.repeat(64)
  write(dataDir, `files/ab/${hash}.png`, 'a picture')
  write(dataDir, 'files/ab/readme.txt', 'text')
  return { dataDir, repositoryDir, hash }
}

/** A backend that only has stickers. */
function stubBackend(roots: { dataDir: string; repositoryDir: string }): SimBackend {
  return {
    level: 1,
    stickerRoots: roots,
    info: () => ({ level: 1, chats: [], canReset: false, hasRecords: false }),
    messages: async () => {
      throw new SimInputError('unknown chat', 404)
    },
    send: async () => {
      throw new SimInputError('unknown chat', 404)
    },
    close: async () => {}
  }
}

/** A raw request: the path goes out exactly as written, which `fetch` would tidy (`/%2e%2e/` becomes `/../`). */
function raw(
  server: SimServer,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<{ status: number; type: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port: server.port, path, method: options.method ?? 'GET', headers: options.headers },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            type: String(res.headers['content-type'] ?? ''),
            body: Buffer.concat(chunks).toString()
          })
        )
      }
    )
    req.on('error', reject)
    req.end(options.body)
  })
}

async function serve() {
  const files = layout()
  const server = await startSimServer(stubBackend(files))
  servers.push(server)
  return { ...files, server }
}

describe('findSticker', () => {
  it('finds a sticker in the data folder, then in the repository, and prefers the data folder', () => {
    const { dataDir, repositoryDir } = layout()
    const roots = { dataDir, repositoryDir }
    expect(findSticker(roots, 'pack', 'a.webp')).toBe(join(dataDir, 'characters/pack/stickers/a.webp'))
    expect(findSticker(roots, 'rpack', 'r.webp')).toBe(join(repositoryDir, 'characters/rpack/stickers/r.webp'))
    expect(findSticker(roots, 'same', 'x.webp')).toBe(join(dataDir, 'characters/same/stickers/x.webp'))
  })

  it('refuses a name that is not a plain name', () => {
    const { dataDir, repositoryDir } = layout()
    const roots = { dataDir, repositoryDir }
    for (const [pack, file] of [
      ['pack', '../other.webp'],
      ['pack', '..'],
      ['pack', '/etc/passwd.webp'],
      ['pack', 'a.webp\0'],
      ['pack', 'a.png'],
      ['pack', 'notes.txt'],
      ['pack', '.hidden.webp'],
      ['..', 'a.webp'],
      ['../pack', 'a.webp'],
      ['pack/stickers', 'a.webp'],
      ['PACK', 'a.webp'],
      ['', 'a.webp']
    ] as const) {
      expect(findSticker(roots, pack, file), `${pack} / ${file}`).toBeUndefined()
    }
  })

  it('refuses a link that leaves the stickers folder, and a file that is not there', () => {
    const { dataDir, repositoryDir } = layout()
    expect(findSticker({ dataDir, repositoryDir }, 'pack', 'link.webp')).toBeUndefined()
    expect(findSticker({ dataDir, repositoryDir }, 'pack', 'missing.webp')).toBeUndefined()
    expect(findSticker({ dataDir, repositoryDir }, 'nopack', 'a.webp')).toBeUndefined()
  })
})

describe('findPhoto', () => {
  it('serves only a content-addressed picture under files/', () => {
    const { dataDir, hash } = layout()
    expect(findPhoto(dataDir, `ab/${hash}.png`)).toBe(join(dataDir, `files/ab/${hash}.png`))
    for (const path of [
      'ab/readme.txt',
      '../secret.webp',
      'ab/../../secret.webp',
      `ab/${hash}.svg`,
      '',
      `x/${hash}.png`
    ]) {
      expect(findPhoto(dataDir, path), path).toBeUndefined()
    }
  })
})

describe('the sticker route', () => {
  it('serves a sticker as image/webp, from the data folder or the repository', async () => {
    const { server } = await serve()
    expect(await raw(server, '/sticker/pack/a.webp')).toMatchObject({
      status: 200,
      type: 'image/webp',
      body: 'data-sticker'
    })
    expect(await raw(server, '/sticker/rpack/r.webp')).toMatchObject({ status: 200, body: 'repository-sticker' })
    expect((await raw(server, '/sticker/same/x.webp')).body).toBe('from the data folder')
  })

  it('refuses a path that climbs out, in every spelling', async () => {
    const { server } = await serve()
    for (const path of [
      '/sticker/pack/..%2Fother.webp',
      '/sticker/pack/%2e%2e%2fother.webp',
      '/sticker/pack/%2e%2e/other.webp',
      '/sticker/pack/../other.webp',
      '/sticker/..%2Fsecret.webp/a.webp',
      '/sticker/pack/%2Fetc%2Fpasswd.webp',
      '/sticker/pack/..%5Cother.webp',
      '/sticker/pack/a.webp%00',
      '/sticker/pack/%zz.webp',
      '/sticker/%2e%2e/%2e%2e/etc/passwd',
      '/sticker//a.webp'
    ]) {
      const result = await raw(server, path)
      expect(result.status, path).toBe(404)
      expect(result.body, path).not.toContain('secret')
      expect(result.body, path).not.toContain('outside')
    }
  })

  it('refuses a file that is not a .webp, a link to a file outside, and a file outside the stickers folder', async () => {
    const { server } = await serve()
    expect((await raw(server, '/sticker/pack/notes.txt')).status).toBe(404)
    const link = await raw(server, '/sticker/pack/link.webp')
    expect(link.status).toBe(404)
    expect(link.body).not.toContain('secret')
    expect((await raw(server, '/sticker/pack/other.webp')).status).toBe(404)
  })

  it('serves a picture a tool made, and no other file in files/', async () => {
    const { server, hash } = await serve()
    expect(await raw(server, `/photo/ab/${hash}.png`)).toMatchObject({ status: 200, type: 'image/png' })
    expect((await raw(server, '/photo/ab/readme.txt')).status).toBe(404)
    expect((await raw(server, '/photo/ab/..%2Freadme.txt')).status).toBe(404)
  })
})

describe('who may call the server', () => {
  it('answers a request that names this address, and refuses one that names another host', async () => {
    const { server } = await serve()
    expect((await raw(server, '/api/info')).status).toBe(200)
    expect((await raw(server, '/api/info', { headers: { host: `localhost:${server.port}` } })).status).toBe(200)
    // A page on another site that reaches this port by rebinding its own name to 127.0.0.1 names its own host.
    expect((await raw(server, '/api/info', { headers: { host: `evil.test:${server.port}` } })).status).toBe(403)
    expect((await raw(server, '/api/info', { headers: { host: '127.0.0.1:1' } })).status).toBe(403)
  })

  it('refuses a request that came from another origin, and a body that is not JSON', async () => {
    const { server } = await serve()
    const post = { method: 'POST', body: '{"sender":"a","text":"b"}' }
    expect(
      (
        await raw(server, '/api/chats/x/send', {
          ...post,
          headers: { 'content-type': 'application/json', origin: 'http://evil.test' }
        })
      ).status
    ).toBe(403)
    // A cross-site form can send text/plain without a preflight, so the server asks for JSON.
    expect(
      (await raw(server, '/api/chats/x/send', { ...post, headers: { 'content-type': 'text/plain' } })).status
    ).toBe(415)
    // The same call from this page's own origin gets as far as the backend, which does not know the chat.
    expect(
      (
        await raw(server, '/api/chats/x/send', {
          ...post,
          headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${server.port}` }
        })
      ).status
    ).toBe(404)
  })

  it('serves the page with a policy that allows no outside script or image', async () => {
    const { server } = await serve()
    const page = await new Promise<{ csp: string; body: string }>((resolve) => {
      request({ host: '127.0.0.1', port: server.port, path: '/' }, (res) => {
        let body = ''
        res.on('data', (chunk: Buffer) => {
          body += chunk
        })
        res.on('end', () => resolve({ csp: String(res.headers['content-security-policy']), body }))
      }).end()
    })
    expect(page.csp).toContain("default-src 'none'")
    expect(page.csp).toContain("img-src 'self' data:")
    expect(page.body).toContain('<title>AIRA Chat Preview</title>')
    // No external asset: nothing is fetched from another host.
    expect(page.body).not.toMatch(/(?:src|href)="https?:\/\//)
  })
})
