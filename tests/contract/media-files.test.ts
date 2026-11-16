import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type GatewayDir, contentTypeOf, loadGatewayFile, mapGatewayPath } from '../../src/media/files.js'
import { tmpDir } from '../support/tmp.js'

// Finding and reading the file a gateway note names (docs/trd/models.md#media-watching). The host paths here are
// invented; the container side is a temporary folder.

const HOST_CACHE = '/home/user/.hermes/cache'
const HOST_AUDIO = '/home/user/.hermes/audio_cache'

describe('mapGatewayPath', () => {
  const dirs: GatewayDir[] = [
    { host: HOST_CACHE, container: '/gateway/cache' },
    { host: `${HOST_AUDIO}/`, container: '/gateway/audio_cache/' }
  ]

  it('maps a path under a host folder to the same place under its container folder', () => {
    expect(mapGatewayPath(`${HOST_CACHE}/images/img_a1b2.jpg`, dirs)).toMatchObject({
      ok: true,
      containerPath: '/gateway/cache/images/img_a1b2.jpg'
    })
    expect(mapGatewayPath(`${HOST_AUDIO}/aud_c3.ogg`, dirs)).toMatchObject({
      ok: true,
      containerPath: '/gateway/audio_cache/aud_c3.ogg'
    })
  })

  it('resolves .. before it decides, so a path cannot climb out of a folder', () => {
    expect(mapGatewayPath(`${HOST_CACHE}/images/../../.env`, dirs)).toEqual({ ok: false })
    expect(mapGatewayPath(`${HOST_CACHE}/../secrets/key.pem`, dirs)).toEqual({ ok: false })
    // A path that climbs and comes back is the same file.
    expect(mapGatewayPath(`${HOST_CACHE}/images/../audio/aud_c3.ogg`, dirs)).toMatchObject({
      ok: true,
      containerPath: '/gateway/cache/audio/aud_c3.ogg'
    })
  })

  it('refuses a path outside every folder, a sibling that shares a prefix, and the folder itself', () => {
    expect(mapGatewayPath('/home/user/.ssh/id_ed25519', dirs)).toEqual({ ok: false })
    expect(mapGatewayPath(`${HOST_CACHE}-old/images/img_a1b2.jpg`, dirs)).toEqual({ ok: false })
    expect(mapGatewayPath(HOST_CACHE, dirs)).toEqual({ ok: false })
    expect(mapGatewayPath('/etc/passwd', [])).toEqual({ ok: false })
  })

  it('refuses a relative path and a path with a NUL', () => {
    expect(mapGatewayPath('images/img_a1b2.jpg', dirs)).toEqual({ ok: false })
    expect(mapGatewayPath(`${HOST_CACHE}/images/img_a1b2.jpg\0.png`, dirs)).toEqual({ ok: false })
  })

  it('lets the nearest folder win when one folder holds another', () => {
    const nested: GatewayDir[] = [
      { host: HOST_CACHE, container: '/gateway/cache' },
      { host: `${HOST_CACHE}/documents`, container: '/gateway/documents' }
    ]
    expect(mapGatewayPath(`${HOST_CACHE}/documents/doc_d4.pdf`, nested)).toMatchObject({
      containerPath: '/gateway/documents/doc_d4.pdf'
    })
  })
})

describe('contentTypeOf', () => {
  it('reads the type from the extension, in any case', () => {
    expect(contentTypeOf('/x/img_a1.JPG')).toBe('image/jpeg')
    expect(contentTypeOf('/x/aud_c3.ogg')).toBe('audio/ogg')
    expect(contentTypeOf('/x/vid_e5.mp4')).toBe('video/mp4')
    expect(contentTypeOf('/x/doc_d4_notes.pdf')).toBe('application/pdf')
    expect(contentTypeOf('/x/archive.zip')).toBeUndefined()
    expect(contentTypeOf('/x/no-extension')).toBeUndefined()
  })

  it('reads an .mp4 the gateway filed as audio as audio', () => {
    expect(contentTypeOf('/x/clip.mp4', 'audio')).toBe('audio/mp4')
    expect(contentTypeOf('/x/clip.mp4', 'video')).toBe('video/mp4')
  })
})

describe('loadGatewayFile', () => {
  function setup() {
    const root = tmpDir('aira-media-')
    const cache = join(root, 'cache')
    const outside = join(root, 'outside')
    mkdirSync(join(cache, 'images'), { recursive: true })
    mkdirSync(outside)
    writeFileSync(join(cache, 'images', 'img_a1b2.jpg'), 'jpeg-bytes')
    writeFileSync(join(outside, 'secret.jpg'), 'not for the model')
    const dirs: GatewayDir[] = [{ host: HOST_CACHE, container: cache }]
    return { root, cache, outside, dirs }
  }
  const image = (path: string) => ({ kind: 'image' as const, path })
  const MAX = 1000

  it('reads a file under the folder at its container path', async () => {
    const { dirs } = setup()
    const loaded = await loadGatewayFile(image(`${HOST_CACHE}/images/img_a1b2.jpg`), dirs, MAX)
    expect(loaded).toMatchObject({ ok: true, kind: 'image', file: { contentType: 'image/jpeg' } })
    if (loaded.ok) expect(loaded.file.data.toString()).toBe('jpeg-bytes')
  })

  it('refuses a path outside the folders, and one that climbs out with ..', async () => {
    const { dirs } = setup()
    expect(await loadGatewayFile(image('/home/user/.ssh/id_ed25519.jpg'), dirs, MAX)).toEqual({
      ok: false,
      reason: 'refused'
    })
    expect(await loadGatewayFile(image(`${HOST_CACHE}/../secret.jpg`), dirs, MAX)).toEqual({
      ok: false,
      reason: 'refused'
    })
    expect(await loadGatewayFile(image(`${HOST_CACHE}/images/../../outside/secret.jpg`), dirs, MAX)).toEqual({
      ok: false,
      reason: 'refused'
    })
  })

  it('refuses a symlink that points outside the folder, and reads one that stays inside', async () => {
    const { cache, outside, dirs } = setup()
    symlinkSync(join(outside, 'secret.jpg'), join(cache, 'images', 'link_out.jpg'))
    symlinkSync(join(cache, 'images', 'img_a1b2.jpg'), join(cache, 'images', 'link_in.jpg'))
    expect(await loadGatewayFile(image(`${HOST_CACHE}/images/link_out.jpg`), dirs, MAX)).toEqual({
      ok: false,
      reason: 'refused'
    })
    expect(await loadGatewayFile(image(`${HOST_CACHE}/images/link_in.jpg`), dirs, MAX)).toMatchObject({ ok: true })
  })

  it('refuses a folder that is a symlink to somewhere else in the middle of the path', async () => {
    const { cache, outside, dirs } = setup()
    symlinkSync(outside, join(cache, 'photos'))
    expect(await loadGatewayFile(image(`${HOST_CACHE}/photos/secret.jpg`), dirs, MAX)).toEqual({
      ok: false,
      reason: 'refused'
    })
  })

  it('names a missing file, a directory, an unsupported type and a file over the size limit', async () => {
    const { cache, dirs } = setup()
    mkdirSync(join(cache, 'images', 'folder.jpg'))
    writeFileSync(join(cache, 'images', 'notes.txt'), 'text')
    writeFileSync(join(cache, 'images', 'big.jpg'), Buffer.alloc(MAX + 1))
    expect(await loadGatewayFile(image(`${HOST_CACHE}/images/gone.jpg`), dirs, MAX)).toEqual({
      ok: false,
      reason: 'missing'
    })
    expect(await loadGatewayFile(image(`${HOST_CACHE}/images/folder.jpg`), dirs, MAX)).toEqual({
      ok: false,
      reason: 'refused'
    })
    expect(await loadGatewayFile({ kind: 'document', path: `${HOST_CACHE}/images/notes.txt` }, dirs, MAX)).toEqual({
      ok: false,
      reason: 'unsupported type'
    })
    expect(await loadGatewayFile(image(`${HOST_CACHE}/images/big.jpg`), dirs, MAX)).toEqual({
      ok: false,
      reason: 'too large'
    })
  })

  it('reads nothing when no folder is configured', async () => {
    expect(await loadGatewayFile(image(`${HOST_CACHE}/images/img_a1b2.jpg`), [], MAX)).toEqual({
      ok: false,
      reason: 'refused'
    })
  })
})
