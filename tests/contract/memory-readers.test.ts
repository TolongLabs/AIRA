import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { legacyRecord } from '../../src/migration/legacy.js'
import { runMigration } from '../../src/migration/memory-import.js'
import { readOldBrain, waIdOfFolder, waIdOfPerson, writeExport } from '../../src/migration/readers.js'
import { ensureChat } from '../../src/settings/chats.js'
import { openDatabase } from '../../src/storage/database.js'
import { applyMigrations } from '../../src/storage/migrate.js'
import { tmpDir } from '../support/tmp.js'

// The readers of the old memory stores (docs/trd/memory.md#migration), on an invented old brain folder only.

const NOW = new Date('2026-11-16T12:00:00.000Z')
const jsonl = (lines: (Record<string, unknown> | string)[]) =>
  lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n') + '\n'

function oldBrain(): string {
  const root = tmpDir('aira-old-brain-')
  const dm = join(root, 'dm', 'whatsapp', 'test-dm-1.lid')
  const group = join(root, 'group', 'whatsapp', 'test-group-1.g.us')
  for (const dir of [dm, group, join(root, 'group', 'whatsapp', 'not-a-chat'), join(root, 'library', 'songs')]) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(
    join(dm, 'memories.jsonl'),
    jsonl([
      { id: 'a', ts: 1_790_000_000.5, text: 'works night shifts at the clinic', pinned: false, kind: 'work' },
      { id: 'b', ts: 1_790_000_100, text: '   ', pinned: false },
      { id: 'c', ts: 1_790_000_200, text: 'trip to the coast this week', until: '2026-11-01T00:00:00Z', pinned: false },
      { id: 'd', ts: 1_790_000_300, text: 'exam on Friday', until: '2026-12-01T00:00:00Z', pinned: false },
      'not json'
    ])
  )
  writeFileSync(
    join(group, 'memories.jsonl'),
    jsonl([
      { id: 'e', ts: 1_790_000_400, text: 'prefers tea to coffee', about: 'Member', about_id: '1234', pinned: true },
      { id: 'f', ts: 1_790_000_500, text: 'the group meets on Sundays', pinned: false }
    ])
  )
  writeFileSync(
    join(group, 'lingo.json'),
    JSON.stringify({
      words: [
        { term: 'brb', meaning: 'be right back', confirmed: true, last_seen: 1_790_000_600 },
        { term: 'xd', meaning: 'laughing', confirmed: false },
        { term: 'gg', meaning: '', confirmed: true }
      ]
    })
  )
  // Read by nobody: the index, retired facts, saved posts and the library.
  writeFileSync(join(root, 'brain.db'), 'not read')
  writeFileSync(join(dm, 'memories.retired.jsonl'), jsonl([{ id: 'z', text: 'retired' }]))
  writeFileSync(join(root, 'library', 'songs', 'song.md'), '---\ntitle: x\n---\n')
  return root
}

describe('old memory readers', () => {
  it('maps chat folders and person ids back to WhatsApp ids', () => {
    expect(waIdOfFolder('test-dm-1.lid')).toBe('test-dm-1@lid')
    expect(waIdOfFolder('test-group-1.g.us')).toBe('test-group-1@g.us')
    expect(waIdOfFolder('test-person.s.whatsapp.net')).toBe('test-person@s.whatsapp.net')
    expect(waIdOfFolder('not-a-chat')).toBeUndefined()
    expect(waIdOfFolder('.lid')).toBeUndefined()
    expect(waIdOfPerson('1234')).toBe('1234@lid')
    expect(waIdOfPerson('test-person.lid')).toBe('test-person@lid')
    expect(waIdOfPerson('Member')).toBeUndefined()
  })

  it('reads facts and confirmed words, and counts what it skips', () => {
    const result = readOldBrain(oldBrain(), NOW)
    expect(result.chats).toBe(2)
    expect(result.facts).toEqual([
      {
        kind: 'fact',
        chat: 'test-dm-1@lid',
        subject: 'test-dm-1@lid',
        text: 'works night shifts at the clinic',
        updatedAt: '2026-09-21T14:13:20.500Z'
      },
      {
        kind: 'fact',
        chat: 'test-dm-1@lid',
        subject: 'test-dm-1@lid',
        text: 'exam on Friday',
        updatedAt: '2026-09-21T14:18:20.000Z'
      },
      {
        kind: 'fact',
        chat: 'test-group-1@g.us',
        subject: '1234@lid',
        text: 'prefers tea to coffee',
        updatedAt: '2026-09-21T14:20:00.000Z'
      },
      {
        kind: 'fact',
        chat: 'test-group-1@g.us',
        text: 'the group meets on Sundays',
        updatedAt: '2026-09-21T14:21:40.000Z'
      }
    ])
    expect(result.lingo).toEqual([
      {
        kind: 'lingo',
        chat: 'test-group-1@g.us',
        key: 'brb',
        text: 'be right back',
        updatedAt: '2026-09-21T14:23:20.000Z'
      }
    ])
    expect(result.skipped).toEqual({
      folder_not_a_chat: 1,
      fact_empty: 1,
      fact_expired: 1,
      fact_unreadable: 1,
      lingo_unconfirmed: 1,
      lingo_empty: 1
    })
    expect(result.rejects).toEqual([
      { source: 'dm/whatsapp/test-dm-1.lid/memories.jsonl', line: 5, reason: 'fact_unreadable', raw: 'not json' }
    ])
    for (const record of [...result.facts, ...result.lingo]) expect(legacyRecord.safeParse(record).success).toBe(true)
  })

  it('writes a private export that the dry run reads, without touching the old folder', async () => {
    const from = oldBrain()
    const before = readFileSync(join(from, 'dm', 'whatsapp', 'test-dm-1.lid', 'memories.jsonl'), 'utf8')
    const root = tmpDir('aira-export-')
    const exportDir = join(root, 'export')
    expect(writeExport(exportDir, readOldBrain(from, NOW))).toEqual([
      'facts.ndjson',
      'lingo.ndjson',
      'export-rejects.jsonl'
    ])
    expect(statSync(exportDir).mode & 0o777).toBe(0o700)
    expect(statSync(join(exportDir, 'facts.ndjson')).mode & 0o777).toBe(0o600)
    expect(readFileSync(join(from, 'dm', 'whatsapp', 'test-dm-1.lid', 'memories.jsonl'), 'utf8')).toBe(before)

    mkdirSync(join(root, 'data'))
    const databaseFile = join(root, 'data', 'aira.db')
    const storage = openDatabase(databaseFile)
    applyMigrations(storage)
    ensureChat(storage, { waId: 'test-dm-1@lid', type: 'dm' })
    ensureChat(storage, { waId: 'test-group-1@g.us', type: 'group' })
    storage.close()
    const report = await runMigration({ from: exportDir, out: join(root, 'private'), databaseFile })
    expect(report.dryRun).toBe(true)
    // Four facts, each kept as a note of its person, except the group fact about no one; one word.
    expect(report.counts).toMatchObject({ kept: 4, rejected: 1, unassigned: 0 })
    expect(report.reasons).toMatchObject({ 'kept:kept_as_note': 3, 'rejected:no_subject': 1 })
  })
})
