import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CharacterFooterWriter } from '../../src/api/footer-writer.js'
import { dispatchGet } from '../../src/api/routes.js'
import {
  createStudioPack,
  getStudioFooter,
  getStudioPack,
  StudioPackError, 
  updateStudioFooter
} from '../../src/api/studio-packs.js'
import { dispatchWrite } from '../../src/api/writes.js'
import { loadPacks } from '../../src/character/loader.js'
import type { Storage } from '../../src/storage/database.js'
import { dataPaths } from '../../src/storage/startup.js'
import type { ToolRegistry } from '../../src/tools/registry.js'
import { tmpDir, tmpStorage } from '../support/tmp.js'

const FOX = 'fox-footer'

function makeCard(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    displayName: `Fictional ${id}`,
    languages: ['en'],
    coreIdentity: `You are fictional test character ${id}.`,
    speechRules: ['Speak briefly.'],
    defaultReplyLength: 'short',
    ...overrides
  }
}

function makeMoods(): Record<string, unknown> {
  return {
    default: 'calm',
    moods: {
      calm: {
        patterns: ['hello'],
        tone: 'a calm fictional tone',
        openers: ['Well,'],
        endings: ['Okay.'],
        faces: ['(^_^)'],
        stickers: []
      }
    }
  }
}

function makeLines(): Record<string, unknown> {
  return {
    error: 'Fictional error line.',
    limit: 'Fictional limit line.',
    refusal: 'Fictional refusal line.',
    busy: 'Fictional busy line.',
    slow: 'Fictional slow line.',
    unreadableMedia: 'Fictional unreadable line.',
    fallback: 'Fictional fallback line.',
    unavailable: 'Fictional unavailable line.'
  }
}

function fakeRegistry(): ToolRegistry {
  return {
    all: () => [{ name: 'recall' }, { name: 'web_search' }]
  } as unknown as ToolRegistry
}

function setup() {
  const root = tmpDir('aira-studio-footer-')
  const repositoryDir = tmpDir('aira-studio-footer-repo-')
  const storage = tmpStorage({ dir: root })
  const paths = dataPaths(root)
  const registry = fakeRegistry()
  const packs = () => loadPacks({ repositoryDir, dataDir: join(root, 'characters') })
  const deps = {
    storage,
    paths,
    packs,
    registry,
    version: 'test',
    ready: () => true,
    activeTurns: () => 0,
    roles: () => ({
      main: { configured: false, breakerOpen: false },
      fallback: { configured: false, breakerOpen: false },
      judge: { configured: false, breakerOpen: false },
      media: { configured: false, breakerOpen: false }
    })
  }
  return { root, repositoryDir, storage, paths, registry, packs, deps }
}

function packAudits(storage: Storage, id: string) {
  return storage.read(
    (db) =>
      db.prepare("SELECT * FROM setting_change WHERE target = 'pack' AND scope = ? ORDER BY id").all(id) as {
        key: string
        old_value: string | null
        new_value: string | null
        target: string
        actor: string
      }[]
  )
}

describe('studio footer owner preview flow', () => {
  it('validates icon, labels and kinds before any write', () => {
    const { deps, storage } = setup()
    createStudioPack(deps, { id: FOX, card: makeCard(FOX), moods: makeMoods(), lines: makeLines() })
    const r0 = getStudioPack(deps, FOX).revision
    const audits = packAudits(storage, FOX).length

    expect(() => updateStudioFooter(deps, FOX, { expectedRevision: r0, icon: 'hi' })).toThrow(
      expect.objectContaining({ code: 'invalid_footer' })
    )
    expect(() => updateStudioFooter(deps, FOX, { expectedRevision: r0, labels: { recall: 'bad_label' } })).toThrow(
      expect.objectContaining({ code: 'invalid_footer' })
    )
    expect(() => updateStudioFooter(deps, FOX, { expectedRevision: r0, labels: { nope_unknown_kind: 'x' } })).toThrow(
      expect.objectContaining({ code: 'unknown_footer_kind' })
    )
    expect(() => updateStudioFooter(deps, FOX, { expectedRevision: '0'.repeat(64), labels: { recall: 'ok' } })).toThrow(
      expect.objectContaining({ code: 'stale_revision' })
    )
    expect(() => updateStudioFooter(deps, FOX, { expectedRevision: '', labels: { recall: 'ok' } } as never)).toThrow(
      expect.objectContaining({ code: 'revision_required' })
    )
    expect(getStudioPack(deps, FOX).revision).toBe(r0)
    expect(packAudits(storage, FOX).length).toBe(audits)
  })

  it('keeps a stale draft out with no write and no audit', () => {
    const { deps, storage } = setup()
    createStudioPack(deps, { id: FOX, card: makeCard(FOX), moods: makeMoods(), lines: makeLines() })
    const r0 = getStudioPack(deps, FOX).revision
    const first = updateStudioFooter(deps, FOX, { expectedRevision: r0, labels: { recall: 'checked memory' } })
    expect(first.changed).toBe(true)
    const audits = packAudits(storage, FOX).length
    expect(() => updateStudioFooter(deps, FOX, { expectedRevision: r0, labels: { recall: 'stale draft' } })).toThrow(
      expect.objectContaining({ code: 'stale_revision' })
    )
    const read = getStudioFooter(deps, FOX)
    expect(read.revision).toBe(first.revision)
    expect(read.toolFooter.labels?.['recall']).toBe('checked memory')
    expect(packAudits(storage, FOX).length).toBe(audits)
  })

  it('reads back the written footer with its revision', () => {
    const { deps } = setup()
    createStudioPack(deps, { id: FOX, card: makeCard(FOX), moods: makeMoods(), lines: makeLines() })
    const r0 = getStudioPack(deps, FOX).revision
    const written = updateStudioFooter(deps, FOX, {
      expectedRevision: r0,
      icon: '✨',
      labels: { recall: 'did recall' }
    })
    expect(written.changed).toBe(true)
    expect(written.revision).not.toBe(r0)
    const read = getStudioFooter(deps, FOX)
    expect(read.revision).toBe(written.revision)
    expect(read.toolFooter.icon).toBe('✨')
    expect(read.toolFooter.labels?.['recall']).toBe('did recall')
  })

  it('no-ops without an audit when nothing changes', () => {
    const { deps, storage } = setup()
    createStudioPack(deps, { id: FOX, card: makeCard(FOX), moods: makeMoods(), lines: makeLines() })
    const r0 = getStudioPack(deps, FOX).revision
    const first = updateStudioFooter(deps, FOX, { expectedRevision: r0, labels: { recall: 'same label' } })
    expect(first.changed).toBe(true)
    const audits = packAudits(storage, FOX).length
    const second = updateStudioFooter(deps, FOX, { expectedRevision: first.revision, labels: { recall: 'same label' } })
    expect(second.changed).toBe(false)
    expect(second.revision).toBe(first.revision)
    expect(packAudits(storage, FOX).length).toBe(audits)
  })

  it('writes a single redacted audit row per publish', () => {
    const { deps, storage } = setup()
    createStudioPack(deps, { id: FOX, card: makeCard(FOX), moods: makeMoods(), lines: makeLines() })
    const before = packAudits(storage, FOX).length
    const r0 = getStudioPack(deps, FOX).revision
    const written = updateStudioFooter(deps, FOX, { expectedRevision: r0, labels: { recall: 'audited recall' } })
    const rows = packAudits(storage, FOX)
    expect(rows.length).toBe(before + 1)
    const latest = rows[rows.length - 1]!
    expect(latest.key).toMatch(/^revision:[0-9a-f]{32}$/)
    expect(latest.new_value).toBe(written.revision)
    expect(latest.old_value).toBe(r0)
    expect(latest.target).toBe('pack')
    expect(latest.actor).toBe('site')
    const serialized = JSON.stringify(rows)
    expect(serialized).not.toContain('audited recall')
    expect(serialized).not.toContain('You are fictional')
  })

  it('preserves legacy callers without a revision', () => {
    const { deps, storage } = setup()
    createStudioPack(deps, { id: FOX, card: makeCard(FOX), moods: makeMoods(), lines: makeLines() })
    const legacy = new CharacterFooterWriter(deps).write(FOX, { labels: { recall: 'legacy label' } })
    expect(legacy.status).toBe(200)
    const body = legacy.body as { changed: boolean; toolFooter: { labels?: Record<string, string> } }
    expect(body.changed).toBe(true)
    expect(body.toolFooter.labels?.['recall']).toBe('legacy label')
    expect((body as { revision?: string }).revision).toBeUndefined()
    const rows = packAudits(storage, FOX)
    expect(rows.some((row) => row.key === 'toolFooter.labels.recall')).toBe(true)
  })

  it('routes footer writes by revision and reads back through the API', async () => {
    const { deps } = setup()
    createStudioPack(deps, { id: FOX, card: makeCard(FOX), moods: makeMoods(), lines: makeLines() })
    const read = await dispatchGet(deps, new URL('http://localhost/api/characters/fox-footer/footer'))
    expect(read.status).toBe(200)
    const state = read.body as { id: string; revision: string; toolFooter: Record<string, unknown> }
    expect(state.id).toBe(FOX)
    expect(state.revision).toMatch(/^[0-9a-f]{64}$/)

    const legacy = dispatchWrite(deps, 'PUT', '/api/characters/fox-footer/footer', { labels: { recall: 'legacy' } })
    expect(legacy.status).toBe(200)
    expect((legacy.body as { changed: boolean }).changed).toBe(true)

    const fresh = (await dispatchGet(deps, new URL('http://localhost/api/characters/fox-footer/footer'))).body as {
      revision: string
    }
    const preview = dispatchWrite(deps, 'PUT', '/api/characters/fox-footer/footer', {
      expectedRevision: fresh.revision,
      labels: { recall: 'preview label' }
    })
    expect(preview.status).toBe(200)
    const previewBody = preview.body as {
      revision: string
      changed: boolean
      toolFooter: { labels?: Record<string, string> }
    }
    expect(previewBody.changed).toBe(true)
    expect(previewBody.revision).toMatch(/^[0-9a-f]{64}$/)
    expect(previewBody.toolFooter.labels?.['recall']).toBe('preview label')

    const stale = dispatchWrite(deps, 'PUT', '/api/characters/fox-footer/footer', {
      expectedRevision: fresh.revision,
      labels: { recall: 'stale' }
    })
    expect(stale.status).toBe(409)
    expect((stale.body as { error: string }).error).toBe('stale_revision')
  })
})
