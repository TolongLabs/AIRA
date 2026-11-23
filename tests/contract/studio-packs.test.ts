import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { stringify } from 'yaml'
import {
  createStudioPack,
  getStudioPack,
  recoverStudioPacks,
  StudioPackError,
  updateStudioPack
} from '../../src/api/studio-packs.js'
import { loadPacks } from '../../src/character/loader.js'
import type { Storage } from '../../src/storage/database.js'
import { dataPaths } from '../../src/storage/startup.js'
import { tmpDir, tmpStorage } from '../support/tmp.js'

const FOX = 'fox-test'
const BADGER = 'badger-test'
const REPO_FOX = 'repo-fox'

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

function setup() {
  const root = tmpDir('aira-studio-')
  const repositoryDir = tmpDir('aira-studio-repo-')
  const storage = tmpStorage({ dir: root })
  const paths = dataPaths(root)
  const packs = () => loadPacks({ repositoryDir, dataDir: join(root, 'characters') })
  const deps = { storage, paths, packs }
  return { root, repositoryDir, storage, paths, packs, deps }
}

function writeRepoPack(repositoryDir: string, id: string): void {
  const dir = join(repositoryDir, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'card.yml'), stringify(makeCard(id)))
  writeFileSync(join(dir, 'moods.yml'), stringify(makeMoods()))
  writeFileSync(join(dir, 'lines.yml'), stringify(makeLines()))
}

function readBytes(root: string, id: string): Record<string, Buffer> {
  const dir = join(root, 'characters', id)
  return {
    card: readFileSync(join(dir, 'card.yml')),
    moods: readFileSync(join(dir, 'moods.yml')),
    lines: readFileSync(join(dir, 'lines.yml'))
  }
}

interface ChangeRow {
  target: string
  actor: string
  level: string | null
  scope: string | null
  key: string
  old_value: string | null
  new_value: string | null
  changed_at: string
}

function packAudits(storage: Storage, id: string): ChangeRow[] {
  return storage.read(
    (db) =>
      db
        .prepare("SELECT * FROM setting_change WHERE target = 'pack' AND scope = ? ORDER BY id")
        .all(id) as ChangeRow[]
  )
}

function expectRevision(value: unknown): string {
  expect(value).toMatch(/^[0-9a-f]{64}$/)
  return value as string
}

describe('studio packs', () => {
  it('reads an existing data pack with id, source, writable and revision', () => {
    const { deps } = setup()
    const created = createStudioPack(deps, { id: FOX, card: makeCard(FOX), moods: makeMoods(), lines: makeLines() })
    expect(created.changed).toBe(true)
    const read = getStudioPack(deps, FOX)
    expect(read.id).toBe(FOX)
    expect(read.source).toBe('data')
    expect(read.writable).toBe(true)
    expectRevision(read.revision)
    expect(read.revision).toBe(created.revision)
    expect(read.card.displayName).toBe(`Fictional ${FOX}`)
    expect(read.moods.default).toBe('calm')
    expect(read.lines.error).toBe('Fictional error line.')
  })

  it('updates card and lines in both directions with one audit per publish', () => {
    const { deps, storage } = setup()
    createStudioPack(deps, { id: FOX, card: makeCard(FOX), moods: makeMoods(), lines: makeLines() })
    const before = packAudits(storage, FOX).length
    const r0 = getStudioPack(deps, FOX).revision
    const first = updateStudioPack(deps, FOX, {
      expectedRevision: r0,
      card: { displayName: 'Fictional Fox Revised' }
    })
    expect(first.changed).toBe(true)
    expect(first.revision).not.toBe(r0)
    expect(packAudits(storage, FOX).length).toBe(before + 1)
    const r1 = first.revision
    const second = updateStudioPack(deps, FOX, { expectedRevision: r1, lines: { error: 'Revised fictional error.' } })
    expect(second.changed).toBe(true)
    const read = getStudioPack(deps, FOX)
    expect(read.card.displayName).toBe('Fictional Fox Revised')
    expect(read.lines.error).toBe('Revised fictional error.')
    expect(read.moods.default).toBe('calm')
    expect(packAudits(storage, FOX).length).toBe(before + 2)
  })

  it('keeps two drafts isolated', () => {
    const { deps } = setup()
    createStudioPack(deps, { id: FOX, card: makeCard(FOX), moods: makeMoods(), lines: makeLines() })
    createStudioPack(deps, { id: BADGER, card: makeCard(BADGER), moods: makeMoods(), lines: makeLines() })
    const fox = getStudioPack(deps, FOX)
    const revised = updateStudioPack(deps, FOX, {
      expectedRevision: fox.revision,
      card: { displayName: 'Fox draft two' }
    })
    expect(revised.changed).toBe(true)
    const badger = getStudioPack(deps, BADGER)
    expect(badger.card.displayName).toBe(`Fictional ${BADGER}`)
    expect(badger.revision).not.toBe(revised.revision)
    const foxAgain = getStudioPack(deps, FOX)
    expect(foxAgain.card.displayName).toBe('Fox draft two')
  })

  it('preserves comments and unchanged bytes through Document editing', () => {
    const { deps, root } = setup()
    createStudioPack(deps, { id: FOX, card: makeCard(FOX), moods: makeMoods(), lines: makeLines() })
    const cardPath = join(root, 'characters', FOX, 'card.yml')
    const withComment = `# fictional owner comment\n${readFileSync(cardPath, 'utf8')}`
    writeFileSync(cardPath, withComment)
    const before = readBytes(root, FOX)
    const r0 = getStudioPack(deps, FOX).revision
    const updated = updateStudioPack(deps, FOX, {
      expectedRevision: r0,
      card: { displayName: 'Comment kept fictional fox' }
    })
    expect(updated.changed).toBe(true)
    const afterText = readFileSync(cardPath, 'utf8')
    expect(afterText).toContain('# fictional owner comment')
    expect(readFileSync(join(root, 'characters', FOX, 'moods.yml'))).toEqual(before.moods)
    expect(readFileSync(join(root, 'characters', FOX, 'lines.yml'))).toEqual(before.lines)
  })

  it('preserves invalid bytes on a failed patch', () => {
    const { deps, root, storage } = setup()
    createStudioPack(deps, { id: FOX, card: makeCard(FOX), moods: makeMoods(), lines: makeLines() })
    const before = readBytes(root, FOX)
    const audits = packAudits(storage, FOX).length
    const r0 = getStudioPack(deps, FOX).revision
    expect(() =>
      updateStudioPack(deps, FOX, { expectedRevision: r0, card: { displayName: '' } })
    ).toThrow(StudioPackError)
    expect(readBytes(root, FOX).card).toEqual(before.card)
    expect(readBytes(root, FOX).moods).toEqual(before.moods)
    expect(readBytes(root, FOX).lines).toEqual(before.lines)
    expect(packAudits(storage, FOX).length).toBe(audits)
  })

  it('copies a repository pack under a new id and rejects existing ids', () => {
    const { deps, repositoryDir } = setup()
    writeRepoPack(repositoryDir, REPO_FOX)
    const copied = createStudioPack(deps, { sourceId: REPO_FOX, newId: 'copy-fox' })
    expect(copied.changed).toBe(true)
    const read = getStudioPack(deps, 'copy-fox')
    expect(read.source).toBe('data')
    expect(read.card.id).toBe('copy-fox')
    expect(() => createStudioPack(deps, { sourceId: REPO_FOX, newId: 'copy-fox' })).toThrow(
      expect.objectContaining({ code: 'conflict' })
    )
    expect(() =>
      createStudioPack(deps, { sourceId: REPO_FOX, newId: REPO_FOX })
    ).toThrow(expect.objectContaining({ code: 'conflict' }))
    expect(() =>
      createStudioPack(deps, { id: 'copy-fox', card: makeCard('copy-fox'), moods: makeMoods(), lines: makeLines() })
    ).toThrow(expect.objectContaining({ code: 'conflict' }))
  })

  it('refuses repository writes, stale revisions, traversal, symlinks and oversized files', () => {
    const { deps, root, repositoryDir } = setup()
    writeRepoPack(repositoryDir, REPO_FOX)
    expect(() =>
      updateStudioPack(deps, REPO_FOX, { expectedRevision: '0'.repeat(64), card: { displayName: 'x' } })
    ).toThrow(expect.objectContaining({ code: 'pack_read_only' }))
    expect(() => getStudioPack(deps, '../escape')).toThrow(expect.objectContaining({ code: 'invalid_id' }))
    createStudioPack(deps, { id: FOX, card: makeCard(FOX), moods: makeMoods(), lines: makeLines() })
    const r0 = getStudioPack(deps, FOX).revision
    expect(() =>
      updateStudioPack(deps, FOX, { expectedRevision: '0'.repeat(64), card: { displayName: 'stale' } })
    ).toThrow(expect.objectContaining({ code: 'stale_revision' }))
    expect(r0).toBe(getStudioPack(deps, FOX).revision)
    const linkTarget = join(root, 'outside.txt')
    writeFileSync(linkTarget, 'outside')
    const linkPath = join(root, 'characters', FOX, 'card-link.yml')
    try {
      symlinkSync(linkTarget, linkPath)
    } catch {
      // A volume without symlink rights still proves traversal is refused above.
    }
    if (existsSync(linkPath)) {
      expect(lstatSync(linkPath).isSymbolicLink()).toBe(true)
      expect(() => getStudioPack(deps, FOX)).toThrow(StudioPackError)
      rmSync(linkPath, { force: true })
    }
    const bigPath = join(root, 'characters', FOX, 'card.yml')
    const bigBytes = readFileSync(bigPath)
    writeFileSync(bigPath, Buffer.concat([bigBytes, Buffer.alloc(300 * 1024, 'x')]))
    expect(() => getStudioPack(deps, FOX)).toThrow(expect.objectContaining({ code: 'too_large' }))
  })

  it('no-ops without an audit when nothing changes', () => {
    const { deps, storage } = setup()
    createStudioPack(deps, { id: FOX, card: makeCard(FOX), moods: makeMoods(), lines: makeLines() })
    const r0 = getStudioPack(deps, FOX).revision
    const audits = packAudits(storage, FOX).length
    const same = updateStudioPack(deps, FOX, { expectedRevision: r0, card: {} })
    expect(same).toEqual({ id: FOX, revision: r0, changed: false })
    const repeat = updateStudioPack(deps, FOX, {
      expectedRevision: r0,
      card: { displayName: `Fictional ${FOX}` }
    })
    expect(repeat.changed).toBe(false)
    expect(packAudits(storage, FOX).length).toBe(audits)
  })

  it('recovers an interrupted publish and keeps the audit redacted', () => {
    const { deps, root, storage } = setup()
    createStudioPack(deps, { id: FOX, card: makeCard(FOX), moods: makeMoods(), lines: makeLines() })
    const r0 = getStudioPack(deps, FOX).revision
    const updated = updateStudioPack(deps, FOX, {
      expectedRevision: r0,
      card: { displayName: 'Recovered fictional fox' }
    })
    const r1 = updated.revision
    storage.tx((db) => {
      db.prepare("DELETE FROM setting_change WHERE target = 'pack' AND scope = ? AND new_value = ?").run(FOX, r1)
    })
    expect(packAudits(storage, FOX).find((row) => row.new_value === r1)).toBeUndefined()
    const journalPath = join(root, '.studio-stage', `${FOX}.journal.json`)
    mkdirSync(join(root, '.studio-stage'), { recursive: true })
    writeFileSync(journalPath, JSON.stringify({ id: FOX, oldRevision: r0, newRevision: r1, extraPath: '/tmp/evil' }))
    const recovered = recoverStudioPacks(deps)
    expect(recovered.recovered).toContain(FOX)
    expect(getStudioPack(deps, FOX).revision).toBe(r1)
    expect(getStudioPack(deps, FOX).card.displayName).toBe('Recovered fictional fox')
    const rows = packAudits(storage, FOX)
    const latest = rows.find((row) => row.new_value === r1)
    expect(latest).toBeDefined()
    expect(latest?.target).toBe('pack')
    expect(latest?.actor).toBe('site')
    expect(latest?.key).toBe('revision')
    expect(latest?.old_value).toMatch(/^[0-9a-f]{64}$/)
    expect(latest?.new_value).toMatch(/^[0-9a-f]{64}$/)
    const serialized = JSON.stringify(rows)
    expect(serialized).not.toContain('Recovered fictional fox')
    expect(serialized).not.toContain('You are fictional')
    expect(serialized).not.toContain('/tmp/evil')
  })
})
