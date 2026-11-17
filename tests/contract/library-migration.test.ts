import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runMigrateLibraryCli } from '../../scripts/migrate-library.js'
import { openDatabase } from '../../src/storage/database.js'
import { applyMigrations } from '../../src/storage/migrate.js'
import { applyLibraryImport, formatLibraryReport, planLibraryImport } from '../../src/tools/lessons/import.js'
import {
  getSong,
  lookupWord,
  openNode,
  saveSong,
  searchLibrary,
  setGloss,
  writeNode
} from '../../src/tools/lessons/store.js'
import { tmpDir, tmpStorage } from '../support/tmp.js'

const FIXTURE_DIR = 'tests/fixtures/library'
const NOW = new Date('2026-11-17T12:00:00.000Z')

function hashTree(dir: string): string {
  const entries: string[] = []
  const walk = (current: string): void => {
    const items = readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    )
    for (const item of items) {
      const full = join(current, item.name)
      const rel = relative(dir, full).replaceAll('\\', '/')
      if (item.isDirectory()) {
        entries.push(`D:${rel}`)
        walk(full)
      } else {
        const digest = createHash('sha256').update(readFileSync(full)).digest('hex')
        entries.push(`F:${rel}:${digest}`)
      }
    }
  }
  walk(dir)
  return createHash('sha256').update(entries.join('\n')).digest('hex')
}

function tableCounts(dbFileOrStorage: ReturnType<typeof tmpStorage>): Record<string, number> {
  const tables = [
    'lesson_song',
    'lesson_song_line',
    'lesson_song_line_meaning',
    'lesson_word',
    'lesson_word_meaning',
    'lesson_word_seen',
    'library_node',
    'library_link',
    'library_fts'
  ]
  return dbFileOrStorage.read((db) => {
    const out: Record<string, number> = {}
    for (const table of tables) {
      out[table] = db.prepare(`SELECT count(*) FROM ${table}`).pluck().get() as number
    }
    return out
  })
}

function writeMd(dir: string, relPath: string, content: string): void {
  const full = join(dir, relPath)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content, 'utf8')
}

describe('library migration', () => {
  it('dry run reports counts and writes nothing', () => {
    const storage = tmpStorage()
    const plan = planLibraryImport(FIXTURE_DIR)
    const report = applyLibraryImport(storage, plan, { dryRun: true })

    expect(report.dryRun).toBe(true)
    expect(report.folders).toEqual({
      vocab: { read: 3, kept: 2, merged: 0, rejected: 1 },
      grammar: { read: 1, kept: 1, merged: 0, rejected: 0 },
      songs: { read: 1, kept: 1, merged: 0, rejected: 1 },
      artists: { read: 2, kept: 1, merged: 0, rejected: 1 }
    })
    expect(report.totals).toEqual({ read: 7, kept: 5, merged: 0, rejected: 3 })
    expect(report.lines).toEqual({ read: 3, kept: 2, rejected: 1 })
    expect(report.seen).toBe(3)
    expect(report.rejections).toHaveLength(3)

    expect(tableCounts(storage)).toEqual({
      lesson_song: 0,
      lesson_song_line: 0,
      lesson_song_line_meaning: 0,
      lesson_word: 0,
      lesson_word_meaning: 0,
      lesson_word_seen: 0,
      library_node: 0,
      library_link: 0,
      library_fts: 0
    })

    const text = formatLibraryReport(report)
    expect(text).toContain('DRY RUN, nothing was imported')
  })

  it('apply writes words, patterns, songs, lines, meanings, seen rows and nodes in one transaction', () => {
    const storage = tmpStorage()
    const plan = planLibraryImport(FIXTURE_DIR)
    const report = applyLibraryImport(storage, plan, { now: () => NOW })

    expect(report.dryRun).toBe(false)
    expect(report.folders).toEqual({
      vocab: { read: 3, kept: 2, merged: 0, rejected: 1 },
      grammar: { read: 1, kept: 1, merged: 0, rejected: 0 },
      songs: { read: 1, kept: 1, merged: 0, rejected: 1 },
      artists: { read: 2, kept: 1, merged: 0, rejected: 1 }
    })
    expect(report.seen).toBe(3)

    expect(lookupWord(storage, '夜空', 'en')).toEqual([
      expect.objectContaining({
        kind: 'word',
        word: '夜空',
        reading: 'よぞら',
        level: 'N3',
        pos: 'noun',
        forms: ['よぞら', 'ヨゾラ'],
        example: '夜空を見上げる',
        meanings: [
          { language: 'en', meaning: 'night sky' },
          { language: 'zh', meaning: '夜空' }
        ],
        seen: [{ songTitle: '夜空のうた', artist: 'Hoshi Band', position: 1, line: '夜空を見上げたら' }]
      })
    ])

    expect(lookupWord(storage, 'かける', 'en')).toEqual([
      expect.objectContaining({
        kind: 'word',
        word: 'かける',
        reading: 'かける',
        level: 'N4',
        pos: 'verb',
        forms: ['かけた'],
        example: '願いをかける',
        meanings: [
          { language: 'en', meaning: 'to make (a wish); to place (a call)' },
          { language: 'zh', meaning: '许愿; 打电话' }
        ],
        seen: [{ songTitle: '夜空のうた', artist: 'Hoshi Band', position: 2, line: '願いをかける' }]
      })
    ])

    expect(lookupWord(storage, '〜たら', 'en')).toEqual([
      expect.objectContaining({
        kind: 'pattern',
        word: '〜たら',
        level: 'N4',
        meanings: [
          { language: 'en', meaning: 'conditional if or when' },
          { language: 'zh', meaning: '如果……的话' }
        ],
        seen: [{ songTitle: '夜空のうた', artist: 'Hoshi Band', position: 1, line: '夜空を見上げたら' }]
      })
    ])

    const song = getSong(storage, '夜空のうた', 'Hoshi Band', 'en')
    expect(song).toMatchObject({
      title: '夜空のうた',
      artist: 'Hoshi Band',
      source: 'synthetic-lyrics:track-1',
      lines: [
        {
          position: 1,
          text: '夜空を見上げたら',
          meanings: { en: 'When I look up at the night sky', zh: '当我仰望夜空时' }
        },
        { position: 2, text: '願いをかける', meanings: { en: 'Make a wish', zh: '许下心愿' } }
      ]
    })

    expect(openNode(storage, 'hoshi band')).toEqual({
      title: 'Hoshi Band',
      body: 'Synthetic band formed for testing [[Night Sky]].',
      links: [{ title: 'Night Sky', exists: false }],
      linkedFrom: []
    })
    expect(searchLibrary(storage, 'Synthetic band', 5)).toEqual([
      { title: 'Hoshi Band', excerpt: 'Synthetic band formed for testing [[Night Sky]].' }
    ])
    expect(searchLibrary(storage, 'raw-only-marker', 5)).toEqual([])
    expect(lookupWord(storage, 'raw-only-marker')).toEqual([])
    storage.check()

    // Atomicity: a failure near the end of the transaction rolls back every insert.
    const atomicStorage = tmpStorage()
    atomicStorage.tx((db) =>
      db.exec(
        `CREATE TRIGGER refuse_node BEFORE INSERT ON library_node
         BEGIN SELECT RAISE(ABORT, 'refused'); END`
      )
    )
    expect(() => applyLibraryImport(atomicStorage, plan, { now: () => NOW })).toThrow()
    expect(tableCounts(atomicStorage)).toEqual({
      lesson_song: 0,
      lesson_song_line: 0,
      lesson_song_line_meaning: 0,
      lesson_word: 0,
      lesson_word_meaning: 0,
      lesson_word_seen: 0,
      library_node: 0,
      library_link: 0,
      library_fts: 0
    })
  })

  it('an existing word, song or node key is merged, never overwritten', () => {
    const storage = tmpStorage()
    storage.tx((db) => {
      setGloss(
        db,
        { kind: 'word', word: '夜空', language: 'en', meaning: 'existing sky', reading: 'old-reading' },
        () => NOW
      )
      saveSong(
        db,
        {
          title: '夜空のうた',
          artist: 'hoshi  band',
          language: 'ja',
          source: 'existing-source',
          lines: [{ text: 'Existing line', reading: '', meanings: { en: 'existing line meaning' } }],
          words: []
        },
        () => NOW
      )
      writeNode(db, { title: 'hoshi band', body: 'Existing artist note.' }, () => NOW)
    })

    const plan = planLibraryImport(FIXTURE_DIR)
    const dryReport = applyLibraryImport(storage, plan, { dryRun: true })
    const realReport = applyLibraryImport(storage, plan, { now: () => NOW })

    expect(dryReport.folders).toEqual(realReport.folders)
    expect(dryReport.seen).toBe(realReport.seen)
    expect(realReport.folders).toEqual({
      vocab: { read: 3, kept: 1, merged: 1, rejected: 1 },
      grammar: { read: 1, kept: 1, merged: 0, rejected: 0 },
      songs: { read: 1, kept: 0, merged: 1, rejected: 1 },
      artists: { read: 2, kept: 0, merged: 1, rejected: 1 }
    })
    expect(realReport.seen).toBe(0)

    expect(lookupWord(storage, '夜空', 'en')).toEqual([
      expect.objectContaining({
        reading: 'old-reading',
        meanings: [{ language: 'en', meaning: 'existing sky' }]
      })
    ])
    expect(getSong(storage, '夜空のうた', 'Hoshi Band', 'en')).toMatchObject({
      artist: 'hoshi  band',
      source: 'existing-source',
      lines: [{ position: 1, text: 'Existing line', meanings: { en: 'existing line meaning' } }]
    })
    expect(openNode(storage, 'Hoshi Band')).toMatchObject({
      title: 'hoshi band',
      body: 'Existing artist note.'
    })

    const secondRun = applyLibraryImport(storage, plan, { now: () => NOW })
    expect(secondRun.totals).toEqual({ read: 7, kept: 0, merged: 5, rejected: 3 })
    expect(secondRun.seen).toBe(0)
  })

  it('senses fill empty fields and join glosses with "; " up to 500 characters', () => {
    const dir = tmpDir('aira-lib-senses-')
    writeMd(
      dir,
      'vocab/fill.md',
      [
        '---',
        'title: 走る',
        'senses:',
        '  - pos: godan verb',
        '    example: 公園を走る',
        '    gloss_en: to run',
        '    gloss_zh: 跑',
        '  - pos: noun',
        '    example: another example',
        '    gloss_en: to dash',
        '    gloss_zh: 奔跑',
        '---',
        ''
      ].join('\n')
    )
    writeMd(
      dir,
      'vocab/keep-top.md',
      [
        '---',
        'title: 飛ぶ',
        'pos: top-pos',
        'example: top-example',
        'senses:',
        '  - pos: sense-pos',
        '    example: sense-example',
        '    gloss_en: to fly',
        '  - gloss_en: to jump',
        '---',
        ''
      ].join('\n')
    )
    const partA = 'a'.repeat(240)
    const partB = 'b'.repeat(240)
    const partC = 'c'.repeat(240)
    writeMd(
      dir,
      'vocab/long-senses.md',
      [
        '---',
        'title: 長い',
        'senses:',
        `  - gloss_en: ${partA}`,
        `  - gloss_en: ${partB}`,
        `  - gloss_en: ${partC}`,
        '---',
        ''
      ].join('\n')
    )

    const storage = tmpStorage()
    const report = applyLibraryImport(storage, planLibraryImport(dir), { now: () => NOW })
    expect(report.folders.vocab).toEqual({ read: 3, kept: 3, merged: 0, rejected: 0 })

    expect(lookupWord(storage, '走る', 'en')).toEqual([
      expect.objectContaining({
        pos: 'godan verb',
        example: '公園を走る',
        meanings: [
          { language: 'en', meaning: 'to run; to dash' },
          { language: 'zh', meaning: '跑; 奔跑' }
        ]
      })
    ])

    expect(lookupWord(storage, '飛ぶ', 'en')).toEqual([
      expect.objectContaining({
        pos: 'top-pos',
        example: 'top-example',
        meanings: [{ language: 'en', meaning: 'to fly; to jump' }]
      })
    ])

    const longWord = lookupWord(storage, '長い', 'en')[0]
    expect(longWord?.meanings[0]?.meaning).toBe(`${partA}; ${partB}; ${partC}`.slice(0, 500))
    expect(longWord?.meanings[0]?.meaning.length).toBe(500)
  })

  it('a file with broken front matter is rejected with its file name and reason, and the rest imports', () => {
    const dir = tmpDir('aira-lib-broken-')
    writeMd(dir, 'vocab/good.md', '---\ntitle: 光\ngloss_en: light\n---\n')
    writeMd(dir, 'vocab/no-close.md', '---\ntitle: broken\n')
    writeMd(dir, 'grammar/not-map.md', '---\n- list item\n---\n')

    const storage = tmpStorage()
    const report = applyLibraryImport(storage, planLibraryImport(dir), { now: () => NOW })

    expect(report.folders.vocab).toEqual({ read: 2, kept: 1, merged: 0, rejected: 1 })
    expect(report.folders.grammar).toEqual({ read: 1, kept: 0, merged: 0, rejected: 1 })
    expect(report.rejections).toEqual([
      { folder: 'vocab', file: 'vocab/no-close.md', reason: 'invalid_front_matter' },
      { folder: 'grammar', file: 'grammar/not-map.md', reason: 'invalid_front_matter' }
    ])
    expect(lookupWord(storage, '光', 'en')).toHaveLength(1)

    const fixtureReport = applyLibraryImport(tmpStorage(), planLibraryImport(FIXTURE_DIR), { now: () => NOW })
    expect(fixtureReport.rejections).toContainEqual({
      folder: 'vocab',
      file: 'vocab/broken.md',
      reason: 'invalid_front_matter'
    })
    expect(formatLibraryReport(fixtureReport)).toContain('vocab/broken.md invalid_front_matter')
  })

  it('a line past position 200 is rejected', () => {
    const dir = tmpDir('aira-lib-lines-')
    const linesYaml = Array.from({ length: 202 }, (_, idx) => [`  - i: ${idx + 1}`, `    ja: line ${idx + 1}`]).flat()
    writeMd(
      dir,
      'songs/band/long-song.md',
      ['---', 'title: Long Song', 'artist: Band', 'lines:', ...linesYaml, '---', ''].join('\n')
    )

    const storage = tmpStorage()
    const report = applyLibraryImport(storage, planLibraryImport(dir), { now: () => NOW })

    expect(report.lines).toEqual({ read: 202, kept: 200, rejected: 2 })
    expect(report.rejections).toEqual([
      { folder: 'songs', file: 'songs/band/long-song.md', reason: 'line_past_200', position: 201 },
      { folder: 'songs', file: 'songs/band/long-song.md', reason: 'line_past_200', position: 202 }
    ])
    const song = getSong(storage, 'Long Song', 'Band')
    if (!song || song === 'ambiguous') throw new Error('expected song')
    expect(song.lines).toHaveLength(200)
    expect(song.lines.at(-1)?.position).toBe(200)

    const outOfRangeCount = storage.read(
      (db) => db.prepare('SELECT count(*) FROM lesson_song_line WHERE position > 200').pluck().get() as number
    )
    expect(outOfRangeCount).toBe(0)
  })

  it('a seen row is written only for a word or pattern that exists after the import', () => {
    const dir = tmpDir('aira-lib-seen-')
    writeMd(dir, 'vocab/imported-word.md', '---\ntitle: 星\ngloss_en: star\n---\n')
    writeMd(dir, 'grammar/imported-pattern.md', '---\ntitle: 〜ながら\nexplanation: while doing\n---\n')
    writeMd(
      dir,
      'songs/band/star-song.md',
      [
        '---',
        'title: Star Song',
        'artist: Band',
        'lines:',
        '  - i: 1',
        '    ja: 星を見ながら',
        '    vocab:',
        '      - 既存語',
        '      - 星',
        '      - 〜ながら',
        '      - 未登録語',
        '---',
        ''
      ].join('\n')
    )

    const storage = tmpStorage()
    storage.tx((db) => {
      setGloss(db, { kind: 'word', word: '既存語', language: 'en', meaning: 'preexisting' }, () => NOW)
    })

    const dry = applyLibraryImport(storage, planLibraryImport(dir), { dryRun: true })
    const real = applyLibraryImport(storage, planLibraryImport(dir), { now: () => NOW })
    expect(dry.seen).toBe(3)
    expect(real.seen).toBe(3)

    const song = getSong(storage, 'Star Song', 'Band')
    if (!song || song === 'ambiguous') throw new Error('expected song')
    expect(song.words.map((w) => w.word).sort()).toEqual(['〜ながら', '既存語', '星'])
    expect(lookupWord(storage, '未登録語')).toEqual([])
  })

  it('a line lists its words as wiki links, as the old library writes them', () => {
    const dir = tmpDir('aira-lib-links-')
    writeMd(dir, 'vocab/moon.md', '---\ntitle: 月\ngloss_en: moon\n---\n')
    writeMd(dir, 'grammar/while.md', '---\ntitle: 〜ながら\nexplanation: while doing\n---\n')
    writeMd(
      dir,
      'songs/band/moon-song.md',
      [
        '---',
        'title: Moon Song',
        'artist: Band',
        'lines:',
        '  - i: 1',
        '    ja: 月を見ながら',
        '    vocab:',
        "      - '[[月]]'",
        "      - '[[〜ながら|while]]'",
        '---',
        ''
      ].join('\n')
    )
    const storage = tmpStorage()
    const real = applyLibraryImport(storage, planLibraryImport(dir), { now: () => NOW })
    expect(real.seen).toBe(2)
    const song = getSong(storage, 'Moon Song', 'Band')
    if (!song || song === 'ambiguous') throw new Error('expected song')
    expect(song.words.map((w) => w.word).sort()).toEqual(['〜ながら', '月'])
  })

  it('the report never holds file contents', () => {
    const dir = tmpDir('aira-lib-secret-')
    const secrets = [
      'SECRET_BROKEN_YAML_VALUE',
      'SECRET_TOO_LONG_WORD_VALUE',
      'SECRET_GLOSS_EN',
      'SECRET_GLOSS_ZH',
      'SECRET_GRAMMAR_EXPL',
      'SECRET_SONG_LYRIC',
      'SECRET_ARTIST_BODY',
      'SECRET_EMPTY_ARTIST_TITLE'
    ]
    writeMd(dir, 'vocab/broken.md', '---\ntitle: [SECRET_BROKEN_YAML_VALUE\n---\n')
    writeMd(dir, 'vocab/toolong.md', `---\ntitle: SECRET_TOO_LONG_WORD_VALUE_${'x'.repeat(120)}\n---\n`)
    writeMd(dir, 'vocab/ok.md', '---\ntitle: 風\ngloss_en: SECRET_GLOSS_EN\ngloss_zh: SECRET_GLOSS_ZH\n---\n')
    writeMd(dir, 'grammar/ok.md', '---\ntitle: 〜ば\nexplanation: SECRET_GRAMMAR_EXPL\n---\n')
    writeMd(
      dir,
      'songs/b/s.md',
      ['---', 'title: S', 'artist: B', 'lines:', '  - i: 201', '    ja: SECRET_SONG_LYRIC', '---', ''].join('\n')
    )
    writeMd(dir, 'artists/ok.md', '---\ntitle: A\n---\n\nSECRET_ARTIST_BODY\n')
    writeMd(dir, 'artists/empty.md', '---\ntitle: SECRET_EMPTY_ARTIST_TITLE\n---\n')

    const storage = tmpStorage()
    const plan = planLibraryImport(dir)
    const dryReport = applyLibraryImport(storage, plan, { dryRun: true })
    const realReport = applyLibraryImport(storage, plan, { now: () => NOW })

    for (const serialized of [
      JSON.stringify(plan.report),
      JSON.stringify(dryReport),
      JSON.stringify(realReport),
      formatLibraryReport(dryReport),
      formatLibraryReport(realReport)
    ]) {
      for (const secret of secrets) {
        expect(serialized).not.toContain(secret)
      }
    }
  })

  it('the source folder is not changed', async () => {
    const before = hashTree(FIXTURE_DIR)
    const storage = tmpStorage()
    const plan = planLibraryImport(FIXTURE_DIR)
    applyLibraryImport(storage, plan, { dryRun: true })
    applyLibraryImport(storage, plan, { now: () => NOW })

    const cliDir = tmpDir('aira-lib-cli-')
    const dbFile = join(cliDir, 'aira.db')

    const dryCli = await runMigrateLibraryCli(['--from', FIXTURE_DIR, '--db', dbFile])
    expect(dryCli.exitCode).toBe(0)
    expect(dryCli.stdout).toContain('DRY RUN, nothing was imported')
    expect(existsSync(dbFile)).toBe(false)

    // Pre-create an existing migrated database so --apply takes a verified backup snapshot first.
    const existing = openDatabase(dbFile)
    applyMigrations(existing)
    existing.close()

    const applyCli = await runMigrateLibraryCli(['--from', FIXTURE_DIR, '--db', dbFile, '--apply'])
    expect(applyCli.exitCode).toBe(0)
    expect(applyCli.stdout).toContain('APPLIED')
    expect(existsSync(join(cliDir, 'snapshots'))).toBe(true)

    const dryAfter = await runMigrateLibraryCli(['--from', FIXTURE_DIR, '--db', dbFile])
    expect(dryAfter.exitCode).toBe(0)
    expect(dryAfter.stdout).toContain('vocab: read 3, kept 0, merged 2, rejected 1')

    expect(hashTree(FIXTURE_DIR)).toBe(before)
  })
})
