import { execFile } from 'node:child_process'
import { copyFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { ModelError } from '../../src/models/types.js'
import { queueModel, startApp } from '../support/app.js'

it('edits a copy through the protected studio endpoint and rejects a stale draft', async () => {
  const host = createServer((req, res) => {
    const allowed = req.url === '/api/settings' && req.headers['x-tolongai-token'] === 'fixture-token'
    res
      .writeHead(allowed ? 200 : 401, { 'content-type': 'application/json' })
      .end(JSON.stringify(allowed ? { markets: {} } : {}))
  })
  await new Promise<void>((resolve) => host.listen(0, '127.0.0.1', resolve))
  try {
    const address = host.address()
    if (!address || typeof address === 'string') throw new Error('test listener unavailable')
    const { app, dataDir } = await startApp(queueModel([]), {
      env: { AIRA_OWNER_API_ORIGIN: 'http://127.0.0.1:' + address.port }
    })
    const site = await app.listenSite(0, '127.0.0.1')
    const origin = 'http://127.0.0.1:' + site.port
    const base = origin + '/owner-api/core/characters'
    const headers = { 'x-tolongai-token': 'fixture-token', 'content-type': 'application/json' }
    expect((await fetch(base + '/example/studio')).status).toBe(401)
    expect((await fetch(origin + '/api/characters/example/studio')).status).toBe(404)
    const copy = await fetch(base, {
      method: 'POST',
      headers,
      body: JSON.stringify({ sourceId: 'example', id: 'sample-copy' })
    })
    expect(copy.status).toBe(201)
    expect(copy.headers.get('x-request-id')).toMatch(/^[a-f0-9-]{36}$/)
    const url = base + '/sample-copy/studio'
    const read = await fetch(url, { headers })
    expect(read.headers.get('cache-control')).toBe('no-store')
    const { revision } = (await read.json()) as { revision: string }
    const update = () =>
      fetch(url, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ expectedRevision: revision, patch: { card: { displayName: 'Blue Comet' } } })
      })
    expect((await update()).status).toBe(200)
    expect((await update()).status).toBe(409)
    expect(app.packs().packs.get('sample-copy')?.card.displayName).toBe('Blue Comet')
    const collection = base + '/sample-copy/expressions'
    const listing = (await (await fetch(collection, { headers })).json()) as {
      revision: string
      expressions: unknown[]
    }
    expect(listing.expressions).toEqual([])
    const upload = (name: string, expectedRevision = listing.revision) =>
      fetch(collection, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          expectedRevision,
          name,
          description: 'A fictional greeting',
          mime: 'image/png',
          data: 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFUlEQVR4nGMU6kn5z4AEmBjQAGEBAINGAgnpC8uyAAAAAElFTkSuQmCC'
        })
      })
    const simultaneous = await Promise.all([upload('wave'), upload('wave')])
    expect(simultaneous.map((r) => r.status).sort()).toEqual([200, 409])
    const added = (await (await fetch(collection, { headers })).json()) as { expressions: unknown[] }
    expect(added.expressions).toEqual([{ name: 'wave', description: 'A fictional greeting' }])
    const asset = await fetch(collection + '/wave', { headers })
    expect(asset.headers.get('content-type')).toBe('image/webp')
    expect(asset.headers.get('cache-control')).toBe('no-store')
    expect(
      Buffer.from(await asset.arrayBuffer())
        .subarray(8, 12)
        .toString()
    ).toBe('WEBP')
    expect((await fetch(collection + '/wave')).status).toBe(401)
    const saved = (await (await fetch(url, { headers })).json()) as {
      card: Record<string, unknown>
      moods: { moods: Record<string, { stickers: string[] }> }
      lines: unknown
    }
    saved.moods.moods.neutral!.stickers = ['wave.webp']
    const stickerDraft = { card: saved.card, moods: saved.moods, lines: saved.lines }
    const check = (draft: unknown, existingId?: string) =>
      fetch(origin + '/owner-api/core/pack/check', {
        method: 'POST',
        headers,
        body: JSON.stringify({ draft, existingId })
      })
    expect(await (await check(stickerDraft, 'sample-copy')).json()).toMatchObject({ ok: true, stickers: 1 })
    expect(await (await check(stickerDraft)).json()).toMatchObject({ ok: false })
    const wrongId = { ...stickerDraft, card: { ...stickerDraft.card, id: 'other-fictional' } }
    expect(await (await check(wrongId, 'sample-copy')).json()).toMatchObject({ ok: false })
    const stickerDir = join(dataDir, 'characters', 'sample-copy', 'stickers')
    for (let n = 1; n <= 48; n++) copyFileSync(join(stickerDir, 'wave.webp'), join(stickerDir, 'pose-' + n + '.webp'))
    const readGallery = async () => {
      const response = await fetch(collection, { headers })
      expect(response.status).toBe(200)
      return (await response.json()) as { revision: string; expressions: { name: string }[] }
    }
    const almostFull = await readGallery()
    expect(almostFull.expressions).toHaveLength(49)
    const contenders = await Promise.all(['last-a', 'last-b'].map((name) => upload(name, almostFull.revision)))
    expect(contenders.map((r) => r.status).sort()).toEqual([200, 409])
    const full = await readGallery()
    expect(full.expressions).toHaveLength(50)
    expect((await upload('overflow', full.revision)).status).toBe(409)
    expect(await readGallery()).toEqual(full)
    writeFileSync(join(dataDir, 'characters', 'sample-copy', 'extra.txt'), 'fixture')
    expect((await fetch(url, { headers })).status).toBe(400)
    const docs = await fetch(url + '?view=documents', { headers })
    expect(docs.status).toBe(200)
    expect(await docs.json()).toMatchObject({ writable: false, card: { id: 'sample-copy', displayName: 'Blue Comet' } })
    expect((await fetch(url + '?view=documents')).status).toBe(401)
  } finally {
    host.closeAllConnections()
    await new Promise<void>((resolve) => host.close(() => resolve()))
  }
})

it('checks JSON drafts and previews via authenticated pack routes without publishing or delivering', async () => {
  const host = createServer((req, res) => {
    const allowed = req.url === '/api/settings' && req.headers['x-tolongai-token'] === 'fixture-token'
    res
      .writeHead(allowed ? 200 : 401, { 'content-type': 'application/json' })
      .end(JSON.stringify(allowed ? { markets: {} } : {}))
  })
  await new Promise<void>((resolve) => host.listen(0, '127.0.0.1', resolve))
  try {
    const address = host.address()
    if (!address || typeof address === 'string') throw new Error('test listener unavailable')
    const model = queueModel([{ text: 'Example: hello there.' }, new ModelError('transient', 'fixture failure')])
    const fallback = queueModel([{ text: 'Fictional fallback reply.' }])
    const { app, dataDir } = await startApp(model, {
      fallback,
      config: (value) => {
        value.llm.maxRetries = 0
        value.llm.monthlyBudgetUsd = 0.02
      },
      env: { AIRA_OWNER_API_ORIGIN: 'http://127.0.0.1:' + address.port }
    })
    const site = await app.listenSite(0, '127.0.0.1')
    const origin = 'http://127.0.0.1:' + site.port
    const base = origin + '/owner-api/core/'
    const headers = { 'x-tolongai-token': 'fixture-token', 'content-type': 'application/json' }
    const post = (route: string, body: unknown) =>
      fetch(base + route, { method: 'POST', headers, body: JSON.stringify(body) })
    expect((await fetch(base + 'pack/schema')).status).toBe(401)
    expect((await fetch(origin + '/api/pack/schema', { headers })).status).toBe(404)
    const schema = await fetch(base + 'pack/schema', { headers })
    expect(schema.status).toBe(200)
    expect(await schema.json()).toEqual(
      expect.objectContaining({ setupPrompt: expect.stringContaining('privateInstructions') })
    )
    const read = await fetch(base + 'characters/example/studio', { headers })
    const { card, moods, lines } = (await read.json()) as {
      card: Record<string, unknown>
      moods: unknown
      lines: unknown
    }
    const draft = { card: { ...card, id: 'preview-fictional' }, moods, lines }
    expect((await post('pack/check', {})).status).toBe(400)
    expect((await post('pack/try', { message: 'hello' })).status).toBe(400)
    const absent = await post('pack/try', { id: 'missing-fictional', message: 'hello' })
    expect(absent.status).toBe(404)
    expect(await absent.json()).toEqual({ error: 'pack_not_found' })
    const badTry = await post('pack/try', { draft: {}, message: 'hello' })
    expect(badTry.status).toBe(400)
    expect(await badTry.json()).toMatchObject({ error: 'invalid_pack', faults: expect.any(Array) })
    const checked = await post('pack/check', { draft })
    expect(await checked.json()).toEqual(expect.objectContaining({ ok: true, promptTokens: expect.any(Number) }))
    const largeEnvelope = await post('pack/check', { draft: { ...draft, extra: 'x'.repeat(768 * 1024 - 100) } })
    expect(largeEnvelope.status).toBe(200)
    expect(await largeEnvelope.json()).toMatchObject({ ok: false })
    const invalid = await post('pack/check', { draft: { ...draft, card: { ...draft.card, displayName: '' } } })
    expect(await invalid.json()).toEqual(expect.objectContaining({ ok: false, faults: expect.any(Array) }))
    const oversize = await post('characters', {
      ...draft,
      id: draft.card.id,
      card: { ...draft.card, privateInstructions: 'x'.repeat(40_000) }
    })
    expect(oversize.status).toBe(400)
    const scripted = await post('pack/try', { draft, message: 'hello', live: false })
    expect(scripted.status).toBe(200)
    expect(await scripted.json()).toEqual(
      expect.objectContaining({
        mood: expect.any(String),
        shape: expect.any(Object),
        reply: expect.any(String),
        live: false
      })
    )
    expect(model.requests).toHaveLength(0)
    const live = await post('pack/try', { id: 'example', message: 'hello', live: true })
    expect(live.status).toBe(200)
    expect(await live.json()).toEqual(expect.objectContaining({ reply: 'Hello there.', live: true }))
    expect(model.requests).toHaveLength(1)
    expect(model.requests[0]?.tools).toEqual([])
    expect(app.packs().packs.has('preview-fictional')).toBe(false)
    expect(app.storage.read((db) => db.prepare('SELECT COUNT(*) FROM turn').pluck().get())).toBe(0)
    expect(
      app.storage.read((db) => db.prepare("SELECT COUNT(*) FROM setting_change WHERE target = 'pack'").pluck().get())
    ).toBe(0)

    // Exercise the shipped Python command over the actual authenticated core listener.
    // Only installation discovery and operation logging are substituted; the HTTP client is real.
    const script = [
      'import sys',
      'from deploy.cli import configure, main, operations',
      'configure.selected_api = lambda *a, **k: {"base": sys.argv[1], "token": "fixture-token", "state": {}}',
      'operations.log_event = lambda *a, **k: "fixture-operation"',
      'sys.exit(main.main(sys.argv[2:]))'
    ].join('\n')
    const cli = async (...args: string[]) => {
      const { stdout } = await promisify(execFile)('python3', ['-c', script, origin, 'pack', ...args, '--json'])
      return JSON.parse(stdout) as { pack: Record<string, unknown> }
    }
    const file = join(dataDir, 'fixture-draft.json')
    writeFileSync(file, JSON.stringify(draft))
    expect((await cli('check', file)).pack.ok).toBe(true)
    expect((await cli('schema')).pack.setupPrompt).toContain('aira pack check')
    expect((await cli('import', file, '--dry-run')).pack.wouldCreate).toBe(true)
    expect(app.packs().packs.has('preview-fictional')).toBe(false)
    expect((await cli('import', file)).pack.changed).toBe(true)
    const got = (await cli('get', 'preview-fictional')).pack
    const revision = String(got.revision)
    expect(got.card).toEqual(draft.card)
    const changed = { ...draft, card: { ...draft.card, privateInstructions: 'A fictional private instruction.' } }
    writeFileSync(file, JSON.stringify(changed))
    const plan = (await cli('update', file, '--expected-revision', revision, '--dry-run')).pack
    expect(plan.diff).toEqual([{ path: 'card.privateInstructions', old: null, new: changed.card.privateInstructions }])
    expect(app.packs().packs.get('preview-fictional')?.card.privateInstructions).toBeUndefined()
    const published = (await cli('update', file, '--expected-revision', revision)).pack
    expect(published.changed).toBe(true)
    expect(app.packs().packs.get('preview-fictional')?.card.privateInstructions).toBe(changed.card.privateInstructions)
    expect((await cli('update', file, '--expected-revision', String(published.revision))).pack.changed).toBe(false)
    writeFileSync(file, JSON.stringify(draft))
    const removed = (await cli('update', file, '--expected-revision', String(published.revision))).pack
    expect(removed.diff).toEqual([
      { path: 'card.privateInstructions', old: changed.card.privateInstructions, new: null }
    ])
    expect(app.packs().packs.get('preview-fictional')?.card.privateInstructions).toBeUndefined()
    expect((await cli('try', 'preview-fictional', 'hello')).pack.live).toBe(false)
    expect(model.requests).toHaveLength(1)
    expect(
      app.storage.read((db) => db.prepare("SELECT COUNT(*) FROM setting_change WHERE target = 'pack'").pluck().get())
    ).toBe(3)
    const fallbackPreview = await post('pack/try', { id: 'example', message: 'hello', live: true })
    expect(fallbackPreview.status).toBe(200)
    expect(await fallbackPreview.json()).toMatchObject({ reply: 'Fictional fallback reply.', live: true })
    expect(fallback.requests).toHaveLength(1)
    const capped = await post('pack/try', { id: 'example', message: 'hello', live: true })
    expect(capped.status).toBe(200)
    expect(await capped.json()).toMatchObject({ reply: app.packs().packs.get('example')?.lines.limit })
    expect(model.requests).toHaveLength(2)
    expect(fallback.requests).toHaveLength(1)
    expect(app.storage.read((db) => db.prepare('SELECT COUNT(*) FROM turn').pluck().get())).toBe(0)
  } finally {
    await new Promise<void>((resolve) => host.close(() => resolve()))
  }
})
