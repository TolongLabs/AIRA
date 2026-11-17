import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { searchMemory } from '../../src/memory/recall.js'
import { applyOperation } from '../../src/memory/store.js'
import { backupSources, manifestOf, readLegacyExport } from '../../src/migration/legacy.js'
import { formatReport, IMPORT_SOURCE, runMigration } from '../../src/migration/memory-import.js'
import { ensureChat, getChatByWaId } from '../../src/settings/chats.js'
import { openDatabase, type Storage } from '../../src/storage/database.js'
import { applyMigrations } from '../../src/storage/migrate.js'
import { itemsOf } from '../support/memory.js'
import { tmpDir } from '../support/tmp.js'

// The one-time memory migration (docs/trd/memory.md#migration), on invented data only.

const line = (record: Record<string, unknown>): string => JSON.stringify(record)

function world() {
  const root = tmpDir('aira-migrate-')
  const from = join(root, 'old')
  const out = join(root, 'private')
  const databaseFile = join(root, 'data', 'aira.db')
  mkdirSync(join(from, 'chats'), { recursive: true })
  mkdirSync(join(root, 'data'), { recursive: true })
  const storage = openDatabase(databaseFile)
  applyMigrations(storage)
  const group = ensureChat(storage, { waId: 'test-old-group', type: 'group' }).chatId
  const dm = ensureChat(storage, { waId: 'test-old-dm', type: 'dm' }).chatId
  storage.close()

  writeFileSync(
    join(from, 'chats', 'group.ndjson'),
    [
      line({
        kind: 'fact',
        chat: 'test-old-group',
        subject: 'test-old-alice',
        key: 'Home.Town',
        text: 'the old quarter',
        updatedAt: '2025-01-01T00:00:00Z'
      }),
      line({
        kind: 'fact',
        chat: 'test-old-group',
        subject: 'test-old-alice',
        key: 'home.town',
        text: 'the new quarter',
        updatedAt: '2026-01-01T00:00:00Z'
      }),
      line({
        kind: 'fact',
        chat: 'test-old-group',
        subject: 'test-old-alice',
        key: 'home.town',
        text: 'The  new quarter',
        updatedAt: '2026-02-01T00:00:00Z'
      }),
      line({ kind: 'fact', chat: 'test-old-group', key: 'trip.day', text: 'friday' }),
      line({
        kind: 'fact',
        chat: 'test-old-group',
        subject: 'test-old-bob',
        key: '!!',
        text: 'bob keeps bees on the roof'
      }),
      line({ kind: 'note', chat: 'test-old-group', subject: 'test-old-bob', text: 'bob keeps bees on the roof' }),
      line({ kind: 'note', chat: 'test-old-group', text: 'a note about nobody' }),
      line({ kind: 'lingo', chat: 'test-old-group', key: 'Lepak', text: 'to hang out' }),
      line({
        kind: 'lingo',
        chat: 'test-old-group',
        key: 'lepak',
        text: 'to hang out with friends',
        updatedAt: '2026-03-01T00:00:00Z'
      }),
      line({ kind: 'lingo', chat: 'test-old-group', text: 'a meaning with no word' }),
      '{"kind":"fact", this line is broken',
      line({ kind: 'fact', chat: 'test-old-group', key: 'a', text: 'x', colour: 'unknown field' }),
      line({ kind: 'fact', chat: 'test-old-group', key: 'long.text', text: 'x'.repeat(501) }),
      line({ kind: 'fact', chat: 'test-old-group', key: 'empty.text', text: '   ' }),
      ''
    ].join('\n')
  )
  writeFileSync(
    join(from, 'knowledge.ndjson'),
    [
      line({
        kind: 'fact',
        chat: 'test-old-dm',
        subject: 'test-old-alice',
        key: 'home.town',
        text: 'the dm only town'
      }),
      line({ kind: 'fact', subject: 'test-old-alice', key: 'pet', text: 'a cat with no chat' }),
      line({
        kind: 'fact',
        chat: 'test-chat-nobody-knows',
        subject: 'test-old-alice',
        key: 'pet',
        text: 'a cat of an unknown chat'
      })
    ].join('\n')
  )
  writeFileSync(join(from, 'state.txt'), 'not an export file: backed up, not read\n')
  const open = (): Storage => openDatabase(databaseFile)
  return { root, from, out, databaseFile, group, dm, open }
}

const active = (storage: Storage, chatId: string) =>
  itemsOf(storage, chatId)
    .filter((item) => item.status === 'active')
    .map((item) => `${item.key?.startsWith('note.') ? 'note' : item.key}=${item.value}`)
    .sort()

describe('reading and backing up the old stores', () => {
  it('reads every export line, and keeps a line it cannot read as a reject, word for word', () => {
    const { from } = world()
    const read = readLegacyExport(from)
    expect(read.files).toEqual(['chats/group.ndjson', 'knowledge.ndjson'])
    expect(read.records).toHaveLength(15)
    expect(read.rejects.map((reject) => [reject.source, reject.line, reject.reason])).toEqual([
      ['chats/group.ndjson', 11, 'not_json'],
      ['chats/group.ndjson', 12, 'invalid_record']
    ])
    expect(read.rejects[0]?.raw).toBe('{"kind":"fact", this line is broken')
  })

  it('copies every file with checksums, and fails when a copy differs', () => {
    const { from, root } = world()
    const to = join(root, 'copy')
    const manifest = backupSources(from, to)
    expect(manifest.lines).toHaveLength(3)
    expect(readFileSync(join(to, 'SHA256SUMS'), 'utf8').trim().split('\n')).toEqual(manifest.lines)
    expect(manifestOf(to).lines.filter((entry) => !entry.endsWith('SHA256SUMS'))).toEqual(manifest.lines)
    expect(readFileSync(join(to, 'state.txt'), 'utf8')).toContain('backed up')
    expect(manifestOf(from).digest).toBe(manifest.digest)
  })
})

describe('the dry run', () => {
  it('imports nothing, leaves the old stores untouched, and reports kept, merged, rejected and unassigned', async () => {
    const { from, out, databaseFile, group, dm, open } = world()
    const before = manifestOf(from).digest
    const report = await runMigration({ from, out, databaseFile })

    expect(report.dryRun).toBe(true)
    expect(report.counts).toEqual({ kept: 5, merged: 4, rejected: 6, unassigned: 2 })
    expect(report.reasons).toEqual({
      'kept:kept_as_note': 1,
      'merged:duplicate': 2,
      'merged:older_version': 2,
      'rejected:empty_text': 1,
      'rejected:invalid_record': 1,
      'rejected:no_subject': 1,
      'rejected:no_word': 1,
      'rejected:not_json': 1,
      'rejected:too_long': 1,
      'unassigned:no_chat': 1,
      'unassigned:unknown_chat': 1
    })
    expect(report.lines).toBe(17)

    const storage = open()
    expect(itemsOf(storage, group)).toEqual([])
    expect(itemsOf(storage, dm)).toEqual([])
    expect(getChatByWaId(storage, 'test-chat-nobody-knows')).toBeUndefined()
    storage.close()
    expect(manifestOf(from).digest).toBe(before)
    expect(existsSync(join(out, 'scratch.db'))).toBe(false)
    expect(readdirSync(out).sort()).toEqual(['backup', 'rejects.ndjson', 'report.json', 'report.txt', 'review.ndjson'])

    // The report names lines and reason codes. The text of a memory is only in the private reject and review files.
    const text = formatReport(report)
    expect(text).toContain('DRY RUN')
    expect(text).toContain('knowledge.ndjson:2 unassigned no_chat')
    for (const file of ['report.json', 'report.txt']) {
      const content = readFileSync(join(out, file), 'utf8')
      for (const secret of ['quarter', 'bees', 'a cat', 'hang out']) expect(content).not.toContain(secret)
    }
    expect(readFileSync(join(out, 'review.ndjson'), 'utf8')).toContain('a cat with no chat')
    expect(readFileSync(join(out, 'rejects.ndjson'), 'utf8')).toContain('this line is broken')
  })
})

describe('the real run', () => {
  it('needs the confirmation flag, a dry-run report, and the same inputs as that report', async () => {
    const { from, out, databaseFile, group, open } = world()
    await expect(runMigration({ from, out, databaseFile, confirm: true })).rejects.toThrow(/no dry-run report/)
    await runMigration({ from, out, databaseFile })
    writeFileSync(
      join(from, 'knowledge.ndjson'),
      line({ kind: 'fact', chat: 'test-old-group', key: 'late', text: 'added later' })
    )
    await expect(runMigration({ from, out, databaseFile, confirm: true })).rejects.toThrow(/changed since the dry run/)
    const storage = open()
    expect(itemsOf(storage, group)).toEqual([])
    storage.close()
  })

  it('imports what the dry run reported, each fact in its own chat, and a second run changes nothing', async () => {
    const { from, out, databaseFile, group, dm, open } = world()
    const dry = await runMigration({ from, out, databaseFile })
    const real = await runMigration({ from, out, databaseFile, confirm: true })
    expect(real.dryRun).toBe(false)
    expect(real.counts).toEqual(dry.counts)
    expect(real.detail).toEqual(dry.detail)

    let storage = open()
    expect(active(storage, group)).toEqual([
      'home.town=the new quarter',
      'lingo.lepak=to hang out with friends',
      'note=bob keeps bees on the roof',
      'trip.day=friday'
    ])
    expect(active(storage, dm)).toEqual(['home.town=the dm only town'])
    // The older version is kept as superseded, not lost. Unassigned facts are in no chat.
    expect(
      itemsOf(storage, group)
        .filter((item) => item.status === 'superseded')
        .map((item) => item.value)
        .sort()
    ).toEqual(['the old quarter', 'to hang out'])
    expect(itemsOf(storage, group).every((item) => item.source_job === IMPORT_SOURCE)).toBe(true)
    const everything = JSON.stringify([itemsOf(storage, group), itemsOf(storage, dm)])
    expect(everything).not.toContain('a cat')
    // The same person in two chats has two separate facts, and recall finds each in its own chat only.
    expect(searchMemory(storage, group, 'dm only', 5)).toEqual([])
    expect(searchMemory(storage, dm, 'home town', 5).map((item) => item.value)).toEqual(['the dm only town'])
    storage.check()
    const rowsBefore = itemsOf(storage, group).length + itemsOf(storage, dm).length
    storage.close()

    const again = await runMigration({ from, out, databaseFile, confirm: true })
    expect(again.counts.kept).toBe(0)
    expect(again.reasons['merged:already_imported']).toBeGreaterThan(0)
    storage = open()
    expect(itemsOf(storage, group).length + itemsOf(storage, dm).length).toBe(rowsBefore)
    storage.close()
  })

  it('never replaces a fact the new core already learned', async () => {
    const { from, out, databaseFile, group, open } = world()
    let storage: Storage
    await runMigration({ from, out, databaseFile })
    storage = open()
    storage.tx((db) => applyOperation(db, group, { op: 'add', key: 'trip.day', value: 'sunday', quote: '' }, {}))
    storage.close()
    const report = await runMigration({ from, out, databaseFile, confirm: true })
    expect(report.reasons['merged:newer_exists']).toBe(1)
    storage = open()
    expect(active(storage, group)).toContain('trip.day=sunday')
    expect(active(storage, group)).not.toContain('trip.day=friday')
    storage.close()
  })

  it('imports everything or nothing', async () => {
    const { from, out, databaseFile, group, open } = world()
    await runMigration({ from, out, databaseFile })
    // The import fails part way: a trigger refuses the chat word, after the facts before it were written.
    let storage = open()
    storage.tx((db) =>
      db.exec(
        `CREATE TRIGGER refuse_word BEFORE INSERT ON memory_item WHEN NEW.key LIKE 'lingo.%'
         BEGIN SELECT RAISE(ABORT, 'refused'); END`
      )
    )
    storage.close()
    await expect(runMigration({ from, out, databaseFile, confirm: true })).rejects.toThrow()
    storage = open()
    expect(itemsOf(storage, group)).toEqual([])
    storage.close()
  })
})
