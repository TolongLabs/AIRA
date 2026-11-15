import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { loadPack } from '../../src/character/loader.js'
import { createLogger } from '../../src/records/logger.js'
import { createRedactor } from '../../src/records/redact.js'
import { ensureChat, setChatStatus } from '../../src/settings/chats.js'
import { resolveSettings, setSetting } from '../../src/settings/settings.js'
import type { Storage } from '../../src/storage/database.js'
import { openTurn, receiveInbound } from '../../src/storage/turns.js'
import { registerCoreTools } from '../../src/tools/core/index.js'
import { LESSON_TOOL_NAMES, registerLessonTools } from '../../src/tools/lessons/index.js'
import type { LyricsPort, ToolPorts } from '../../src/tools/ports.js'
import { createToolRegistry } from '../../src/tools/registry.js'
import type { TurnContext } from '../../src/turn/types.js'
import { tmpDir, tmpStorage } from '../support/tmp.js'

const pack = loadPack('characters/example', 'repository')

let seq = 0
function setup(ports: Partial<ToolPorts> = {}, options: { now?: () => Date } = {}) {
  const storage = tmpStorage()
  const filesDir = ports.filesDir ?? tmpDir('aira-lessons-files-')
  const registry = createToolRegistry({
    storage,
    config: { tools: { defaultTimeoutMs: 500 } },
    logger: createLogger({ level: 'error', module: 'lessons-tools-test', sink: () => {} }),
    redactor: createRedactor(),
    now: options.now
  })
  registerCoreTools(registry, { ...ports, filesDir })
  registerLessonTools(registry, { ...ports, filesDir })

  const makeCtx = (overrides: { waId?: string; senderId?: string; lessons?: boolean } = {}): TurnContext => {
    seq++
    const chat = ensureChat(storage, { waId: overrides.waId ?? `fake-lessons-chat-${seq}`, type: 'group' })
    setChatStatus(storage, { chatId: chat.chatId, status: 'active', actor: 'test' })
    if (overrides.lessons !== undefined) {
      setSetting(storage, {
        level: 'chat',
        scope: chat.chatId,
        key: 'features.lessons',
        value: overrides.lessons,
        actor: 'test'
      })
    }
    const senderId = overrides.senderId ?? `member-${seq}`
    const mid = `mid-${seq}`
    const turnId = `turn-${seq}`
    receiveInbound(storage, { chatId: chat.chatId, mid, senderId })
    openTurn(storage, { turnId, chatId: chat.chatId, senderId, kind: 'reply', mids: [mid] })
    return {
      turnId,
      chat,
      senderId,
      character: pack,
      settings: resolveSettings(storage, chat),
      kind: 'reply',
      delivery: { kind: 'reply' },
      deadline: Date.now() + 10_000
    }
  }

  return { storage, filesDir, registry, makeCtx }
}

function tableCounts(storage: Storage): Record<string, number> {
  const tables = [
    'lesson_song',
    'lesson_song_line',
    'lesson_word',
    'lesson_word_seen',
    'lesson_lyrics_candidate',
    'library_node',
    'library_link',
    'library_fts'
  ]
  return storage.read((db) => {
    const counts: Record<string, number> = {}
    for (const table of tables) {
      counts[table] = db.prepare(`SELECT count(*) FROM ${table}`).pluck().get() as number
    }
    return counts
  })
}

function snapshotChat(storage: Storage, chatId: string) {
  return storage.read((db) => ({
    songs: db.prepare('SELECT * FROM lesson_song WHERE chat_id = ? ORDER BY id').all(chatId),
    lines: db.prepare('SELECT * FROM lesson_song_line WHERE chat_id = ? ORDER BY song_id, position').all(chatId),
    words: db.prepare('SELECT * FROM lesson_word WHERE chat_id = ? ORDER BY id').all(chatId),
    seen: db
      .prepare('SELECT * FROM lesson_word_seen WHERE chat_id = ? ORDER BY word_id, song_id, position')
      .all(chatId),
    candidates: db.prepare('SELECT * FROM lesson_lyrics_candidate WHERE chat_id = ? ORDER BY id').all(chatId),
    nodes: db.prepare('SELECT * FROM library_node WHERE chat_id = ? ORDER BY id').all(chatId),
    links: db.prepare('SELECT * FROM library_link WHERE chat_id = ? ORDER BY node_id, target_key').all(chatId),
    fts: db.prepare('SELECT * FROM library_fts WHERE chat_id = ? ORDER BY node_id').all(chatId)
  }))
}

function walkTs(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...walkTs(full))
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(full)
    }
  }
  return out
}

describe('lessons and library tools', () => {
  it('hides all ten tools and their three commands when features.lessons is off and exposes them when on', async () => {
    const { registry, makeCtx } = setup()
    const offCtx = makeCtx({ lessons: false })
    const onCtx = makeCtx({ lessons: true })

    expect(LESSON_TOOL_NAMES).toHaveLength(10)

    const offOffered = registry.offered(offCtx).map((t) => t.schema.name)
    const offCmds = registry.commands(offCtx).map((c) => c.name)
    for (const name of LESSON_TOOL_NAMES) {
      expect(offOffered).not.toContain(name)
    }
    expect(offCmds).not.toContain('lyrics')
    expect(offCmds).not.toContain('song')
    expect(offCmds).not.toContain('word')

    for (const name of LESSON_TOOL_NAMES) {
      const res = await registry.call(name, {}, offCtx, { callId: `c-off-${name}`, source: 'model' })
      expect(res).toMatchObject({ ok: false, kind: 'refused' })
    }

    const onOffered = registry.offered(onCtx).map((t) => t.schema.name)
    const onCmds = registry.commands(onCtx).map((c) => c.name)
    for (const name of LESSON_TOOL_NAMES) {
      expect(onOffered).toContain(name)
    }
    expect(onCmds).toContain('lyrics')
    expect(onCmds).toContain('song')
    expect(onCmds).toContain('word')
  })

  it('files a song, fetches it by title, sets a gloss and looks up the word with its line', async () => {
    const { registry, makeCtx } = setup()
    const ctx = makeCtx({ lessons: true })

    const saved = await registry.call(
      'song_save',
      {
        title: 'Blue Bird',
        artist: 'Ikimono',
        language: 'ja',
        lines: [
          { text: 'Habataitara modoranai', reading: 'はばたいたら もどらない', meaning: 'If I spread my wings' },
          { text: 'Mezashita no wa aoi sora', reading: 'めざしたのは あおい そら', meaning: 'Aimed for the blue sky' }
        ],
        words: [
          { kind: 'word', word: 'aoi', reading: 'あおい', lines: [2] },
          { kind: 'pattern', word: '-tara', reading: 'たら', lines: [1] }
        ]
      },
      ctx,
      { callId: 'c-save-1', source: 'model' }
    )
    expect(saved).toMatchObject({
      ok: true,
      data: { replaced: false, lines: 2, words: 2 },
      receipt: { kind: 'lesson.song_saved' }
    })

    const fetched = await registry.call('song_get', { title: 'blue bird' }, ctx, {
      callId: 'c-get-1',
      source: 'command'
    })
    expect(fetched).toMatchObject({
      ok: true,
      data: {
        title: 'Blue Bird',
        artist: 'Ikimono',
        lines: [
          { position: 1, text: 'Habataitara modoranai' },
          { position: 2, text: 'Mezashita no wa aoi sora' }
        ],
        words: [
          { kind: 'pattern', word: '-tara', meaning: '', lines: [1] },
          { kind: 'word', word: 'aoi', reading: 'あおい', meaning: '', lines: [2] }
        ]
      }
    })

    const glossed = await registry.call('gloss_set', { word: 'aoi', meaning: 'blue', reading: 'あおい' }, ctx, {
      callId: 'c-gloss-1',
      source: 'model'
    })
    expect(glossed).toMatchObject({
      ok: true,
      data: { created: false },
      receipt: { kind: 'lesson.gloss_set' }
    })

    const looked = await registry.call('vocab_lookup', { word: 'AOI' }, ctx, {
      callId: 'c-vocab-1',
      source: 'command'
    })
    expect(looked).toEqual({
      ok: true,
      data: {
        entries: [
          {
            word: 'aoi',
            kind: 'word',
            reading: 'あおい',
            meaning: 'blue',
            seen: [{ songTitle: 'Blue Bird', artist: 'Ikimono', position: 2, line: 'Mezashita no wa aoi sora' }]
          }
        ]
      }
    })
  })

  it('replaces songs in place, preserves glosses, deduplicates callIds and writes one receipt per mutating tool', async () => {
    const { storage, registry, makeCtx } = setup()
    const ctx = makeCtx({ lessons: true })

    await registry.call(
      'song_save',
      {
        title: 'Haru',
        artist: 'Singer A',
        lines: [{ text: 'Line one' }],
        words: [{ word: 'haru', reading: 'はる', lines: [1] }]
      },
      ctx,
      { callId: 'c-s1', source: 'model' }
    )

    await registry.call('gloss_set', { word: 'haru', meaning: 'spring' }, ctx, {
      callId: 'c-g1',
      source: 'model'
    })

    const resaved = await registry.call(
      'song_save',
      {
        title: 'HARU',
        artist: 'singer a',
        lines: [{ text: 'Updated line one' }, { text: 'Line two' }],
        words: [{ word: 'haru', lines: [1, 2] }]
      },
      ctx,
      { callId: 'c-s2', source: 'model' }
    )
    expect(resaved).toMatchObject({ ok: true, data: { replaced: true, lines: 2, words: 1 } })

    const counts = tableCounts(storage)
    expect(counts.lesson_song).toBe(1)
    expect(counts.lesson_song_line).toBe(2)

    const looked = await registry.call('vocab_lookup', { word: 'haru' }, ctx, {
      callId: 'c-v1',
      source: 'model'
    })
    expect(looked).toMatchObject({
      ok: true,
      data: { entries: [{ word: 'haru', meaning: 'spring', reading: 'はる' }] }
    })

    // Same callId twice returns stored result and writes nothing again
    const written1 = await registry.call('library_write', { title: 'Note A', body: 'Body A' }, ctx, {
      callId: 'c-lib-dup',
      source: 'model'
    })
    const written2 = await registry.call('library_write', { title: 'Note A', body: 'Changed' }, ctx, {
      callId: 'c-lib-dup',
      source: 'model'
    })
    expect(written2).toEqual(written1)
    const opened = await registry.call('library_open', { title: 'Note A' }, ctx, {
      callId: 'c-lib-open',
      source: 'model'
    })
    expect(opened).toMatchObject({ ok: true, data: { body: 'Body A' } })

    const receipts = storage.read(
      (db) =>
        db.prepare('SELECT call_id, kind FROM receipt WHERE chat_id = ? ORDER BY rowid').all(ctx.chat.chatId) as {
          call_id: string
          kind: string
        }[]
    )
    expect(receipts).toEqual([
      { call_id: 'c-s1', kind: 'lesson.song_saved' },
      { call_id: 'c-g1', kind: 'lesson.gloss_set' },
      { call_id: 'c-s2', kind: 'lesson.song_saved' },
      { call_id: 'c-lib-dup', kind: 'library.written' }
    ])

    // Ambiguity check: second song with same title and different artist
    await registry.call('song_save', { title: 'Haru', artist: 'Singer B', lines: [{ text: 'Another song' }] }, ctx, {
      callId: 'c-s3',
      source: 'model'
    })
    expect(await registry.call('song_get', { title: 'Haru' }, ctx, { callId: 'c-amb', source: 'model' })).toMatchObject(
      {
        ok: false,
        kind: 'invalid'
      }
    )
    expect(
      await registry.call('song_get', { title: 'Haru', artist: 'Singer B' }, ctx, {
        callId: 'c-disamb',
        source: 'model'
      })
    ).toMatchObject({ ok: true, data: { artist: 'Singer B' } })
  })

  it('refuses texts and line counts over schema limits without writing anything', async () => {
    const { storage, registry, makeCtx } = setup()
    const ctx = makeCtx({ lessons: true })
    const before = tableCounts(storage)

    const tooManyLines = Array.from({ length: 201 }, (_, i) => ({ text: `line ${i + 1}` }))
    expect(
      await registry.call('song_save', { title: 'Long Song', lines: tooManyLines }, ctx, {
        callId: 'c-lim-1',
        source: 'model'
      })
    ).toMatchObject({ ok: false, kind: 'invalid' })

    expect(
      await registry.call('song_save', { title: 'Long Line', lines: [{ text: 'a'.repeat(501) }] }, ctx, {
        callId: 'c-lim-2',
        source: 'model'
      })
    ).toMatchObject({ ok: false, kind: 'invalid' })

    expect(
      await registry.call('library_write', { title: 't'.repeat(121), body: 'ok' }, ctx, {
        callId: 'c-lim-3',
        source: 'model'
      })
    ).toMatchObject({ ok: false, kind: 'invalid' })

    expect(
      await registry.call('library_write', { title: 'Valid Title', body: 'b'.repeat(8001) }, ctx, {
        callId: 'c-lim-4',
        source: 'model'
      })
    ).toMatchObject({ ok: false, kind: 'invalid' })

    expect(tableCounts(storage)).toEqual(before)
  })

  it('handles lyrics_search and lyrics_fetch availability, candidate scoping, truncation and no-store rule', async () => {
    const noPort = setup()
    const noPortCtx = noPort.makeCtx({ lessons: true })
    expect(
      await noPort.registry.call('lyrics_search', { query: 'hello' }, noPortCtx, {
        callId: 'c-np-1',
        source: 'model'
      })
    ).toMatchObject({ ok: false, kind: 'unavailable', reason: 'lyrics are not available' })

    const fetchSpy = vi.fn(async () => ({
      title: 'Test Song',
      artist: 'Test Artist',
      lines: Array.from({ length: 205 }, (_, i) => (i === 0 ? 'x'.repeat(510) : `line ${i + 1}`))
    }))
    const lyrics: LyricsPort = {
      name: 'fake-lyrics',
      async search() {
        return Array.from({ length: 7 }, (_, i) => ({
          ref: `ref-${i + 1}`,
          title: `Song ${i + 1}`,
          artist: `Artist ${i + 1}`
        }))
      },
      fetch: fetchSpy
    }

    const { storage, registry, makeCtx } = setup({ lyrics })
    const ctxA = makeCtx({ lessons: true })
    const ctxB = makeCtx({ lessons: true })

    const searchRes = await registry.call('lyrics_search', { query: 'song' }, ctxA, {
      callId: 'c-ls-1',
      source: 'model'
    })
    expect(searchRes.ok).toBe(true)
    if (!searchRes.ok) throw new Error('expected search ok')
    const searchData = searchRes.data as {
      untrusted: boolean
      source: string
      candidates: { candidateId: string; title: string; artist: string }[]
    }
    expect(searchData.untrusted).toBe(true)
    expect(searchData.source).toBe('lyrics')
    expect(searchData.candidates).toHaveLength(5)
    expect(tableCounts(storage).lesson_lyrics_candidate).toBe(5)

    const candId = searchData.candidates[0]?.candidateId ?? ''
    const crossFetch = await registry.call('lyrics_fetch', { candidateId: candId }, ctxB, {
      callId: 'c-lf-cross',
      source: 'model'
    })
    expect(crossFetch).toMatchObject({ ok: false, kind: 'refused' })
    expect(fetchSpy).not.toHaveBeenCalled()

    const beforeFetch = tableCounts(storage)
    const fetchRes = await registry.call('lyrics_fetch', { candidateId: candId }, ctxA, {
      callId: 'c-lf-ok',
      source: 'model'
    })
    expect(fetchRes.ok).toBe(true)
    if (!fetchRes.ok) throw new Error('expected fetch ok')
    const fetchData = fetchRes.data as {
      untrusted: boolean
      source: string
      lines: string[]
      truncated: boolean
    }
    expect(fetchData.untrusted).toBe(true)
    expect(fetchData.source).toBe('lyrics')
    expect(fetchData.truncated).toBe(true)
    expect(fetchData.lines).toHaveLength(200)
    expect(fetchData.lines[0]).toHaveLength(500)
    expect(tableCounts(storage)).toEqual(beforeFetch)

    const failingSetup = setup({
      lyrics: {
        name: 'broken',
        async search() {
          throw new Error('boom')
        },
        async fetch() {
          throw new Error('boom')
        }
      }
    })
    const failCtx = failingSetup.makeCtx({ lessons: true })
    expect(
      await failingSetup.registry.call('lyrics_search', { query: 'x' }, failCtx, {
        callId: 'c-fail-s',
        source: 'model'
      })
    ).toMatchObject({ ok: false, kind: 'unavailable', reason: 'the lyrics provider failed' })
  })

  it('tracks wiki links, FTS search with 1-hop via, safe queries, and library gaps', async () => {
    const { registry, makeCtx } = setup()
    const ctx = makeCtx({ lessons: true })

    const w1 = await registry.call(
      'library_write',
      {
        title: 'Particles',
        body: 'Intro to [[Wa vs Ga]], [[Particles]], [[Wa vs Ga]] and [[Missing Topic]].'
      },
      ctx,
      { callId: 'c-lw-1', source: 'model' }
    )
    expect(w1).toMatchObject({
      ok: true,
      data: { replaced: false, links: ['Wa vs Ga', 'Missing Topic'] },
      receipt: { kind: 'library.written' }
    })

    await registry.call('library_write', { title: 'Wa vs Ga', body: 'Contrast between topic and subject.' }, ctx, {
      callId: 'c-lw-2',
      source: 'model'
    })

    // Replace with another case
    const w3 = await registry.call(
      'library_write',
      {
        title: 'PARTICLES',
        body: 'Updated intro to [[Wa vs Ga]] and [[Missing Topic]].'
      },
      ctx,
      { callId: 'c-lw-3', source: 'model' }
    )
    expect(w3).toMatchObject({ ok: true, data: { replaced: true } })

    const openRes = await registry.call('library_open', { title: 'particles' }, ctx, {
      callId: 'c-lo-1',
      source: 'model'
    })
    expect(openRes).toEqual({
      ok: true,
      data: {
        title: 'PARTICLES',
        body: 'Updated intro to [[Wa vs Ga]] and [[Missing Topic]].',
        links: [
          { title: 'Missing Topic', exists: false },
          { title: 'Wa vs Ga', exists: true }
        ],
        linkedFrom: []
      }
    })

    const searchRes = await registry.call('library_search', { query: 'Updated' }, ctx, {
      callId: 'c-lsearch-1',
      source: 'model'
    })
    expect(searchRes).toEqual({
      ok: true,
      data: {
        results: [
          { title: 'PARTICLES', excerpt: 'Updated intro to [[Wa vs Ga]] and [[Missing Topic]].' },
          { title: 'Wa vs Ga', excerpt: 'Contrast between topic and subject.', via: 'PARTICLES' }
        ]
      }
    })

    // Punctuation and reserved FTS operator words never throw
    expect(
      await registry.call('library_search', { query: '??? !!!' }, ctx, { callId: 'c-ls-punct', source: 'model' })
    ).toEqual({ ok: true, data: { results: [] } })
    expect(
      await registry.call('library_search', { query: 'AND' }, ctx, { callId: 'c-ls-and', source: 'model' })
    ).toMatchObject({ ok: true })

    // Word without meaning + missing note show up in gaps
    await registry.call(
      'song_save',
      {
        title: 'Gap Song',
        lines: [{ text: 'Line' }],
        words: [{ word: 'unexplained', lines: [1] }]
      },
      ctx,
      { callId: 'c-gap-song', source: 'model' }
    )
    const gaps1 = await registry.call('library_gaps', {}, ctx, { callId: 'c-gaps-1', source: 'model' })
    expect(gaps1).toEqual({
      ok: true,
      data: {
        missingNotes: [{ title: 'Missing Topic', linkedFrom: ['PARTICLES'] }],
        wordsWithoutMeaning: [{ kind: 'word', word: 'unexplained' }]
      }
    })

    // Fill both gaps
    await registry.call('library_write', { title: 'Missing Topic', body: 'Now explained.' }, ctx, {
      callId: 'c-fill-note',
      source: 'model'
    })
    await registry.call('gloss_set', { word: 'unexplained', meaning: 'now glossed' }, ctx, {
      callId: 'c-fill-word',
      source: 'model'
    })

    const gaps2 = await registry.call('library_gaps', {}, ctx, { callId: 'c-gaps-2', source: 'model' })
    expect(gaps2).toEqual({
      ok: true,
      data: { missingNotes: [], wordsWithoutMeaning: [] }
    })
  })

  it('isolates all songs, words, candidates and library notes between chats', async () => {
    const { storage, registry, makeCtx } = setup()
    const ctxA = makeCtx({ lessons: true })
    const ctxB = makeCtx({ lessons: true })

    await registry.call(
      'song_save',
      {
        title: 'Shared Title',
        artist: 'Artist A',
        lines: [{ text: 'Line alphaonly' }],
        words: [{ word: 'alphaonly', lines: [1] }]
      },
      ctxA,
      { callId: 'c-iso-sa', source: 'model' }
    )
    await registry.call(
      'song_save',
      {
        title: 'Shared Title',
        artist: 'Artist B',
        lines: [{ text: 'Line betaonly' }],
        words: [{ word: 'betaonly', lines: [1] }]
      },
      ctxB,
      { callId: 'c-iso-sb', source: 'model' }
    )

    await registry.call('library_write', { title: 'Shared Note', body: 'Body alphaonly [[GapA]]' }, ctxA, {
      callId: 'c-iso-na',
      source: 'model'
    })
    await registry.call('library_write', { title: 'Shared Note', body: 'Body betaonly [[GapB]]' }, ctxB, {
      callId: 'c-iso-nb',
      source: 'model'
    })

    const outA = JSON.stringify([
      await registry.call('song_get', { title: 'Shared Title' }, ctxA, { callId: 'c-iso-ga', source: 'model' }),
      await registry.call('vocab_lookup', { word: 'betaonly' }, ctxA, { callId: 'c-iso-va', source: 'model' }),
      await registry.call('library_open', { title: 'Shared Note' }, ctxA, { callId: 'c-iso-oa', source: 'model' }),
      await registry.call('library_search', { query: 'betaonly' }, ctxA, { callId: 'c-iso-fa', source: 'model' }),
      await registry.call('library_gaps', {}, ctxA, { callId: 'c-iso-xa', source: 'model' })
    ])
    expect(outA).not.toContain('betaonly')
    expect(outA).not.toContain('GapB')

    const outB = JSON.stringify([
      await registry.call('song_get', { title: 'Shared Title' }, ctxB, { callId: 'c-iso-gb', source: 'model' }),
      await registry.call('vocab_lookup', { word: 'alphaonly' }, ctxB, { callId: 'c-iso-vb', source: 'model' }),
      await registry.call('library_open', { title: 'Shared Note' }, ctxB, { callId: 'c-iso-ob', source: 'model' }),
      await registry.call('library_search', { query: 'alphaonly' }, ctxB, { callId: 'c-iso-fb', source: 'model' }),
      await registry.call('library_gaps', {}, ctxB, { callId: 'c-iso-xb', source: 'model' })
    ])
    expect(outB).not.toContain('alphaonly')
    expect(outB).not.toContain('GapA')

    const bBefore = snapshotChat(storage, ctxB.chat.chatId)
    await registry.call(
      'song_save',
      { title: 'Shared Title', artist: 'Artist A', lines: [{ text: 'Changed' }] },
      ctxA,
      {
        callId: 'c-iso-wa1',
        source: 'model'
      }
    )
    await registry.call('gloss_set', { word: 'betaonly', meaning: 'hacked' }, ctxA, {
      callId: 'c-iso-wa2',
      source: 'model'
    })
    await registry.call('library_write', { title: 'Shared Note', body: 'Updated A' }, ctxA, {
      callId: 'c-iso-wa3',
      source: 'model'
    })
    expect(snapshotChat(storage, ctxB.chat.chatId)).toEqual(bBefore)
  })

  it('SQL gate: lessons tables appear only in src/tools/lessons and src/storage, and every SQL statement filters by chat_id', () => {
    const tables = [
      'lesson_song',
      'lesson_song_line',
      'lesson_word',
      'lesson_word_seen',
      'lesson_lyrics_candidate',
      'library_node',
      'library_link',
      'library_fts'
    ]
    const tableRe = new RegExp(`\\b(${tables.join('|')})\\b`)
    const sqlVerbRe = /\b(SELECT|UPDATE|DELETE|INSERT)\b/i

    for (const file of walkTs('src')) {
      const normalized = file.replaceAll('\\', '/')
      const content = readFileSync(file, 'utf8')
      const inLessons = normalized.startsWith('src/tools/lessons/')
      const inStorage = normalized.startsWith('src/storage/')

      if (!inLessons && !inStorage) {
        for (const table of tables) {
          expect(content, `${file} references ${table}`).not.toMatch(new RegExp(`\\b${table}\\b`))
        }
        continue
      }

      if (inLessons) {
        const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, content)
        let token = scanner.scan()
        while (token !== ts.SyntaxKind.EndOfFileToken) {
          if (
            token === ts.SyntaxKind.StringLiteral ||
            token === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
            token === ts.SyntaxKind.TemplateHead ||
            token === ts.SyntaxKind.TemplateMiddle ||
            token === ts.SyntaxKind.TemplateTail
          ) {
            const literal = scanner.getTokenValue()
            if (tableRe.test(literal) && sqlVerbRe.test(literal)) {
              expect(literal, `${file}: missing chat_id in SQL: ${literal}`).toContain('chat_id')
            }
          }
          token = scanner.scan()
        }
      }
    }
  })
})
