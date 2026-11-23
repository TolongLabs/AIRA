import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
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
      db.prepare("SELECT * FROM setting_change WHERE target = 'pack' AND scope = ? ORDER BY id").all(id) as ChangeRow[]
  )
}

function revisionAudits(storage: Storage, id: string): ChangeRow[] {
  return packAudits(storage, id).filter((row) => row.key === 'revision' || row.key.startsWith('revision:'))
}

function expectRevision(value: unknown): string {
  expect(value).toMatch(/^[0-9a-f]{64}$/)
  return value as string
}

function makeStickerBytes(tail: number[] = []): Buffer {
  const head = Buffer.alloc(30, 0)
  head.write('RIFF', 0, 'ascii')
  head.writeUInt32LE(22 + tail.length, 4)
  head.write('WEBP', 8, 'ascii')
  head.write('VP8X', 12, 'ascii')
  head.writeUInt32LE(10, 16)
  head.writeUInt8(0, 20)
  head.writeUInt8(0, 21)
  head.writeUInt8(0, 22)
  head.writeUInt8(0, 23)
  head.writeUInt8(0xff, 24)
  head.writeUInt8(0x01, 25)
  head.writeUInt8(0x00, 26)
  head.writeUInt8(0xff, 27)
  head.writeUInt8(0x01, 28)
  head.writeUInt8(0x00, 29)
  return tail.length > 0 ? Buffer.concat([head, Buffer.from(tail)]) : head
}

function writeSticker(root: string, id: string, name: string, bytes: Buffer): void {
  const dir = join(root, 'characters', id, 'stickers')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), bytes)
}

function readJournal(root: string, id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, '.studio-stage', `${id}.journal.json`), 'utf8')) as Record<string, unknown>
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
    const before = revisionAudits(storage, FOX).length
    const r0 = getStudioPack(deps, FOX).revision
    const first = updateStudioPack(deps, FOX, {
      expectedRevision: r0,
      card: { displayName: 'Fictional Fox Revised' }
    })
    expect(first.changed).toBe(true)
    expect(first.revision).not.toBe(r0)
    expect(revisionAudits(storage, FOX).length).toBe(before + 1)
    const r1 = first.revision
    const second = updateStudioPack(deps, FOX, { expectedRevision: r1, lines: { error: 'Revised fictional error.' } })
    expect(second.changed).toBe(true)
    const read = getStudioPack(deps, FOX)
    expect(read.card.displayName).toBe('Fictional Fox Revised')
    expect(read.lines.error).toBe('Revised fictional error.')
    expect(read.moods.default).toBe('calm')
    expect(revisionAudits(storage, FOX).length).toBe(before + 2)
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
    const audits = revisionAudits(storage, FOX).length
    const r0 = getStudioPack(deps, FOX).revision
    expect(() => updateStudioPack(deps, FOX, { expectedRevision: r0, card: { displayName: '' } })).toThrow(
      StudioPackError
    )
    expect(readBytes(root, FOX).card).toEqual(before.card)
    expect(readBytes(root, FOX).moods).toEqual(before.moods)
    expect(readBytes(root, FOX).lines).toEqual(before.lines)
    expect(revisionAudits(storage, FOX).length).toBe(audits)
    expect(existsSync(join(root, '.studio-stage', `${FOX}.journal.json`))).toBe(false)
  })

  it('copies a repository pack under a new id and rejects existing ids', () => {
    const { deps, repositoryDir, root, storage } = setup()
    writeRepoPack(repositoryDir, REPO_FOX)
    const sourceBefore = getStudioPack(deps, REPO_FOX)
    const sourceBytes = {
      card: readFileSync(join(repositoryDir, REPO_FOX, 'card.yml')),
      moods: readFileSync(join(repositoryDir, REPO_FOX, 'moods.yml')),
      lines: readFileSync(join(repositoryDir, REPO_FOX, 'lines.yml'))
    }
    const copied = createStudioPack(deps, { sourceId: REPO_FOX, newId: 'copy-fox' })
    expect(copied.changed).toBe(true)
    const read = getStudioPack(deps, 'copy-fox')
    expect(read.source).toBe('data')
    expect(read.card.id).toBe('copy-fox')
    expect(getStudioPack(deps, REPO_FOX).revision).toBe(sourceBefore.revision)
    expect(readFileSync(join(repositoryDir, REPO_FOX, 'card.yml'))).toEqual(sourceBytes.card)
    expect(readFileSync(join(repositoryDir, REPO_FOX, 'moods.yml'))).toEqual(sourceBytes.moods)
    expect(readFileSync(join(repositoryDir, REPO_FOX, 'lines.yml'))).toEqual(sourceBytes.lines)
    expect(readFileSync(join(root, 'characters', 'copy-fox', 'card.yml')).toString('utf8')).toContain('copy-fox')
    expect(() => createStudioPack(deps, { sourceId: REPO_FOX, newId: 'copy-fox' })).toThrow(
      expect.objectContaining({ code: 'conflict' })
    )
    expect(() => createStudioPack(deps, { sourceId: REPO_FOX, newId: REPO_FOX })).toThrow(
      expect.objectContaining({ code: 'conflict' })
    )
    expect(() =>
      createStudioPack(deps, { id: 'copy-fox', card: makeCard('copy-fox'), moods: makeMoods(), lines: makeLines() })
    ).toThrow(expect.objectContaining({ code: 'conflict' }))
    expect(revisionAudits(storage, 'copy-fox').length).toBe(1)
  })

  it('refuses repository writes, traversal, symlinks and oversized files', () => {
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

  it('refuses symlinks in staging parents and the journal', () => {
    const { deps, root } = setup()
    createStudioPack(deps, { id: FOX, card: makeCard(FOX), moods: makeMoods(), lines: makeLines() })
    const r0 = getStudioPack(deps, FOX).revision
    const stageLink = join(root, '.studio-stage', `${FOX}.staging`)
    rmSync(stageLink, { recursive: true, force: true })
    symlinkSync(join(root, 'characters', FOX), stageLink)
    expect(() =>
      updateStudioPack(deps, FOX, { expectedRevision: r0, card: { displayName: 'staged symlink' } })
    ).toThrow(StudioPackError)
    rmSync(stageLink, { force: true })
    expect(getStudioPack(deps, FOX).revision).toBe(r0)
    const journalPath = join(root, '.studio-stage', `${FOX}.journal.json`)
    rmSync(journalPath, { force: true })
    symlinkSync(join(root, 'characters', FOX, 'card.yml'), journalPath)
    expect(() =>
      updateStudioPack(deps, FOX, { expectedRevision: r0, card: { displayName: 'journal symlink' } })
    ).toThrow(StudioPackError)
    rmSync(journalPath, { force: true })
    expect(getStudioPack(deps, FOX).revision).toBe(r0)
  })

  it('no-ops without an audit when nothing changes', () => {
    const { deps, storage } = setup()
    createStudioPack(deps, { id: FOX, card: makeCard(FOX), moods: makeMoods(), lines: makeLines() })
    const r0 = getStudioPack(deps, FOX).revision
    const audits = revisionAudits(storage, FOX).length
    const same = updateStudioPack(deps, FOX, { expectedRevision: r0, card: {} })
    expect(same).toEqual({ id: FOX, revision: r0, changed: false })
    const repeat = updateStudioPack(deps, FOX, {
      expectedRevision: r0,
      card: { displayName: `Fictional ${FOX}` }
    })
    expect(repeat.changed).toBe(false)
    expect(revisionAudits(storage, FOX).length).toBe(audits)
  })

  it('includes sorted sticker names and bytes in the opaque revision', () => {
    const { deps, root } = setup()
    createStudioPack(deps, { id: FOX, card: makeCard(FOX), moods: makeMoods(), lines: makeLines() })
    const r0 = getStudioPack(deps, FOX).revision
    writeSticker(root, FOX, 'calm_00.webp', makeStickerBytes())
    const r1 = getStudioPack(deps, FOX).revision
    expect(r1).not.toBe(r0)
    writeSticker(root, FOX, 'calm_01.webp', makeStickerBytes([1, 2, 3]))
    const r2 = getStudioPack(deps, FOX).revision
    expect(r2).not.toBe(r1)
    expect(r2).not.toBe(r0)
    writeSticker(root, FOX, 'calm_01.webp', makeStickerBytes([4, 5, 6]))
    const r3 = getStudioPack(deps, FOX).revision
    expect(r3).not.toBe(r2)
    rmSync(join(root, 'characters', FOX, 'stickers'), { recursive: true, force: true })
    expect(getStudioPack(deps, FOX).revision).toBe(r0)
  })

  it('revisits the same revision with a new audit row instead of deduping by revision', () => {
    const { deps, storage } = setup()
    const created = createStudioPack(deps, {
      id: FOX,
      card: makeCard(FOX),
      moods: makeMoods(),
      lines: makeLines()
    })
    const rA = created.revision
    const toB = updateStudioPack(deps, FOX, {
      expectedRevision: rA,
      card: { displayName: 'Fictional Fox B' }
    })
    expect(toB.revision).not.toBe(rA)
    const back = updateStudioPack(deps, FOX, {
      expectedRevision: toB.revision,
      card: { displayName: `Fictional ${FOX}` }
    })
    expect(back.changed).toBe(true)
    expect(back.revision).toBe(rA)
    const rows = revisionAudits(storage, FOX)
    expect(rows.length).toBe(3)
    expect(rows.map((row) => row.new_value)).toEqual([rA, toB.revision, rA])
    const keys = rows.map((row) => row.key)
    expect(new Set(keys).size).toBe(3)
    for (const row of rows) {
      expect(row.target).toBe('pack')
      expect(row.actor).toBe('site')
      expect(row.old_value === null || /^[0-9a-f]{64}$/.test(row.old_value ?? '')).toBe(true)
      expect(row.new_value).toMatch(/^[0-9a-f]{64}$/)
    }
    const serialized = JSON.stringify(rows)
    expect(serialized).not.toContain(`Fictional ${FOX}`)
    expect(serialized).not.toContain('You are fictional')
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
    const opRow = revisionAudits(storage, FOX).find((row) => row.new_value === r1)
    expect(opRow).toBeDefined()
    const opId = (opRow?.key ?? '').split(':')[1] ?? ''
    expect(opId).toMatch(/^[0-9a-f]{32}$/)
    storage.tx((db) => {
      db.prepare("DELETE FROM setting_change WHERE target = 'pack' AND scope = ? AND key = ?").run(FOX, opRow?.key)
    })
    expect(revisionAudits(storage, FOX).find((row) => row.key === opRow?.key)).toBeUndefined()
    expect(revisionAudits(storage, FOX).find((row) => row.new_value === r1)).toBeUndefined()
    const journalPath = join(root, '.studio-stage', `${FOX}.journal.json`)
    mkdirSync(join(root, '.studio-stage'), { recursive: true })
    writeFileSync(
      journalPath,
      JSON.stringify({
        version: 2,
        id: FOX,
        opId,
        oldRevision: r0,
        newRevision: r1,
        phase: 'swapped',
        at: new Date().toISOString(),
        extraPath: '/tmp/evil'
      })
    )
    const recovered = recoverStudioPacks(deps)
    expect(recovered.recovered).toContain(FOX)
    expect(getStudioPack(deps, FOX).revision).toBe(r1)
    expect(getStudioPack(deps, FOX).card.displayName).toBe('Recovered fictional fox')
    expect(existsSync(journalPath)).toBe(false)
    const rows = revisionAudits(storage, FOX)
    const latest = rows.find((row) => row.key === `revision:${opId}`)
    expect(latest).toBeDefined()
    expect(latest?.target).toBe('pack')
    expect(latest?.actor).toBe('site')
    expect(latest?.key).toBe(`revision:${opId}`)
    expect(latest?.old_value).toMatch(/^[0-9a-f]{64}$/)
    expect(latest?.new_value).toBe(r1)
    const serialized = JSON.stringify(rows)
    expect(serialized).not.toContain('Recovered fictional fox')
    expect(serialized).not.toContain('You are fictional')
    expect(serialized).not.toContain('/tmp/evil')
  })

  it('completes a create interrupted before its one directory rename', () => {
    const { deps, root, storage } = setup()
    const charactersDir = join(root, 'characters')
    mkdirSync(charactersDir, { recursive: true })
    chmodSync(charactersDir, 0o555)
    let failed = false
    try {
      createStudioPack(deps, { id: FOX, card: makeCard(FOX), moods: makeMoods(), lines: makeLines() })
    } catch {
      failed = true
    } finally {
      chmodSync(charactersDir, 0o755)
    }
    expect(failed).toBe(true)
    expect(existsSync(join(charactersDir, FOX))).toBe(false)
    const journalPath = join(root, '.studio-stage', `${FOX}.journal.json`)
    expect(existsSync(journalPath)).toBe(true)
    const journal = readJournal(root, FOX)
    expect(journal['id']).toBe(FOX)
    expect(journal['oldRevision']).toBe('')
    expectRevision(journal['newRevision'])
    const recovered = recoverStudioPacks(deps)
    expect(recovered.recovered).toContain(FOX)
    expect(existsSync(journalPath)).toBe(false)
    const read = getStudioPack(deps, FOX)
    expect(read.revision).toBe(journal['newRevision'])
    expect(revisionAudits(storage, FOX).length).toBe(1)
    expect(revisionAudits(storage, FOX)[0]?.key).toBe(`revision:${String(journal['opId'])}`)
  })

  it('restores exact sticker bytes across a backup and rename recovery', () => {
    const { deps, root, storage } = setup()
    createStudioPack(deps, { id: FOX, card: makeCard(FOX), moods: makeMoods(), lines: makeLines() })
    const sticker = makeStickerBytes([9, 9, 9])
    writeSticker(root, FOX, 'calm_00.webp', sticker)
    const r0 = getStudioPack(deps, FOX).revision
    const beforeBytes = readFileSync(join(root, 'characters', FOX, 'stickers', 'calm_00.webp'))
    let attempt = 0
    const realTx = deps.storage.tx.bind(deps.storage)
    const failingStorage = {
      ...deps.storage,
      tx: ((fn: unknown) => {
        attempt += 1
        if (attempt === 1) throw new Error('injected audit failure')
        return (realTx as (fn: unknown) => unknown)(fn)
      }) as unknown as Storage['tx']
    }
    const failing = { ...deps, storage: failingStorage }
    let failed = false
    try {
      updateStudioPack(failing, FOX, { expectedRevision: r0, card: { displayName: 'Sticker exact fox' } })
    } catch {
      failed = true
    }
    expect(failed).toBe(true)
    const journalPath = join(root, '.studio-stage', `${FOX}.journal.json`)
    expect(existsSync(journalPath)).toBe(true)
    const readNoStorage = { paths: deps.paths, packs: deps.packs }
    expect(getStudioPack(readNoStorage, FOX).card.displayName).toBe('Sticker exact fox')
    expect(readFileSync(join(root, 'characters', FOX, 'stickers', 'calm_00.webp'))).toEqual(beforeBytes)
    const auditsBefore = revisionAudits(storage, FOX).length
    const recovered = recoverStudioPacks(deps)
    expect(recovered.recovered).toContain(FOX)
    expect(existsSync(journalPath)).toBe(false)
    expect(revisionAudits(storage, FOX).length).toBe(auditsBefore + 1)
    expect(getStudioPack(deps, FOX).card.displayName).toBe('Sticker exact fox')
    expect(readFileSync(join(root, 'characters', FOX, 'stickers', 'calm_00.webp'))).toEqual(sticker)
    const second = recoverStudioPacks(deps)
    expect(second.recovered).toEqual([])
    expect(revisionAudits(storage, FOX).length).toBe(auditsBefore + 1)
  })

  it('preserves a source changed between the final read and the backup rename', () => {
    const { deps, root } = setup()
    const pack = createStudioPack(deps, { id: FOX, card: makeCard(FOX), moods: makeMoods(), lines: makeLines() })
    const path = join(root, 'characters', FOX, 'lines.yml')
    const external = Buffer.concat([readFileSync(path), Buffer.from('\n# external edit\n')])
    const late = {
      ...deps,
      now: () => {
        writeFileSync(path, external)
        return new Date()
      }
    }
    expect(() =>
      updateStudioPack(late, FOX, { expectedRevision: pack.revision, card: { displayName: 'Later' } })
    ).toThrow(StudioPackError)
    expect(readFileSync(path)).toEqual(external)
  })

  it('restores a verified backup when a pre-audit stage is unavailable', () => {
    const { deps, root } = setup()
    const pack = createStudioPack(deps, { id: FOX, card: makeCard(FOX), moods: makeMoods(), lines: makeLines() })
    const stage = join(root, '.studio-stage')
    const parent = join(stage, FOX + '.backup')
    mkdirSync(parent, { recursive: true })
    renameSync(join(root, 'characters', FOX), join(parent, FOX))
    writeFileSync(
      join(stage, FOX + '.journal.json'),
      JSON.stringify({
        version: 2,
        id: FOX,
        opId: '1'.repeat(32),
        oldRevision: pack.revision,
        newRevision: '2'.repeat(64),
        phase: 'backed-up',
        at: new Date().toISOString()
      })
    )
    expect(recoverStudioPacks(deps).recovered).toContain(FOX)
    expect(getStudioPack(deps, FOX).revision).toBe(pack.revision)
  })

  it('refuses recovery over a newer external edit and preserves it', () => {
    const { deps, root, storage } = setup()
    createStudioPack(deps, { id: FOX, card: makeCard(FOX), moods: makeMoods(), lines: makeLines() })
    const r0 = getStudioPack(deps, FOX).revision
    const charactersDir = join(root, 'characters')
    chmodSync(charactersDir, 0o555)
    try {
      updateStudioPack(deps, FOX, { expectedRevision: r0, card: { displayName: 'Interrupted fox' } })
    } catch {
      // The rename cannot complete inside a read-only parent: the journal stays behind.
    } finally {
      chmodSync(charactersDir, 0o755)
    }
    const journalPath = join(root, '.studio-stage', `${FOX}.journal.json`)
    expect(existsSync(journalPath)).toBe(true)
    const journal = readJournal(root, FOX)
    const auditsBefore = revisionAudits(storage, FOX).length
    const cardPath = join(root, 'characters', FOX, 'card.yml')
    const external = readFileSync(cardPath, 'utf8').replace(`Fictional ${FOX}`, 'External owner fox')
    writeFileSync(cardPath, external)
    const externalRevision = getStudioPack({ paths: deps.paths, packs: deps.packs }, FOX).revision
    expect(externalRevision).not.toBe(r0)
    expect(externalRevision).not.toBe(journal['newRevision'])
    expect(() => recoverStudioPacks(deps)).toThrow(expect.objectContaining({ code: 'conflict' }))
    expect(readFileSync(cardPath, 'utf8')).toContain('External owner fox')
    expect(existsSync(journalPath)).toBe(true)
    expect(revisionAudits(storage, FOX).length).toBe(auditsBefore)
    expect(getStudioPack({ paths: deps.paths, packs: deps.packs }, FOX).revision).toBe(externalRevision)
  })

  it('keeps an invalid journal instead of deleting it', () => {
    const { deps, root, storage } = setup()
    createStudioPack(deps, { id: FOX, card: makeCard(FOX), moods: makeMoods(), lines: makeLines() })
    const r0 = getStudioPack(deps, FOX).revision
    const auditsBefore = revisionAudits(storage, FOX).length
    mkdirSync(join(root, '.studio-stage'), { recursive: true })
    const journalPath = join(root, '.studio-stage', `${FOX}.journal.json`)
    writeFileSync(journalPath, '{ not json')
    expect(() => recoverStudioPacks(deps)).toThrow(StudioPackError)
    expect(existsSync(journalPath)).toBe(true)
    expect(getStudioPack({ paths: deps.paths, packs: deps.packs }, FOX).revision).toBe(r0)
    expect(revisionAudits(storage, FOX).length).toBe(auditsBefore)
    writeFileSync(
      journalPath,
      JSON.stringify({
        version: 2,
        id: FOX,
        opId: '0'.repeat(32),
        oldRevision: r0,
        newRevision: 'bad',
        phase: 'staged'
      })
    )
    expect(() => recoverStudioPacks(deps)).toThrow(StudioPackError)
    expect(existsSync(journalPath)).toBe(true)
    expect(revisionAudits(storage, FOX).length).toBe(auditsBefore)
  })
})
