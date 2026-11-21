import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript-api'
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
import { createTurnSources } from '../../src/turn/sources.js'
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

  const makeCtx = (
    overrides: { waId?: string; senderId?: string; lessons?: boolean; language?: string } = {}
  ): TurnContext => {
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
    if (overrides.language !== undefined) {
      setSetting(storage, {
        level: 'chat',
        scope: chat.chatId,
        key: 'language',
        value: overrides.language,
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
      deadline: Date.now() + 10_000,
      sources: createTurnSources()
    }
  }

  return { storage, filesDir, registry, makeCtx }
}

function tableCounts(storage: Storage): Record<string, number> {
  const tables = [
    'lesson_song',
    'lesson_song_line',
    'lesson_song_line_meaning',
    'lesson_word',
    'lesson_word_meaning',
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
          {
            text: 'Habataitara modoranai',
            reading: 'はばたいたら もどらない',
            meanings: { en: 'If I spread my wings', zh: '如果展翅高飞' }
          },
          {
            text: 'Mezashita no wa aoi sora',
            reading: 'めざしたのは あおい そら',
            meanings: { en: 'Aimed for the blue sky', zh: '目标是蔚蓝的天空' }
          }
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
          {
            position: 1,
            text: 'Habataitara modoranai',
            meanings: { en: 'If I spread my wings', zh: '如果展翅高飞' }
          },
          {
            position: 2,
            text: 'Mezashita no wa aoi sora',
            meanings: { en: 'Aimed for the blue sky', zh: '目标是蔚蓝的天空' }
          }
        ],
        words: [
          { kind: 'pattern', word: '-tara', meanings: [], lines: [1] },
          { kind: 'word', word: 'aoi', reading: 'あおい', meanings: [], lines: [2] }
        ]
      }
    })

    const glossed = await registry.call(
      'gloss_set',
      { word: 'aoi', language: 'en', meaning: 'blue', reading: 'あおい' },
      ctx,
      {
        callId: 'c-gloss-1',
        source: 'model'
      }
    )
    expect(glossed).toMatchObject({
      ok: true,
      data: { created: false },
      receipt: { kind: 'lesson.gloss_set' }
    })

    const looked = await registry.call('vocab_lookup', { word: 'AOI' }, ctx, {
      callId: 'c-vocab-1',
      source: 'command'
    })
    expect(looked).toMatchObject({
      ok: true,
      data: {
        entries: [
          {
            word: 'aoi',
            kind: 'word',
            reading: 'あおい',
            level: '',
            pos: '',
            forms: [],
            example: '',
            meanings: [{ language: 'en', meaning: 'blue' }],
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

    await registry.call('gloss_set', { word: 'haru', language: 'en', meaning: 'spring' }, ctx, {
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
      data: { entries: [{ word: 'haru', meanings: [{ language: 'en', meaning: 'spring' }], reading: 'はる' }] }
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
    await registry.call('gloss_set', { word: 'unexplained', language: 'en', meaning: 'now glossed' }, ctx, {
      callId: 'c-fill-word',
      source: 'model'
    })

    const gaps2 = await registry.call('library_gaps', {}, ctx, { callId: 'c-gaps-2', source: 'model' })
    expect(gaps2).toEqual({
      ok: true,
      data: { missingNotes: [], wordsWithoutMeaning: [] }
    })
  })

  it('shares songs, words and library notes across chats with lessons on, and orders meanings by chat language', async () => {
    const { registry, makeCtx } = setup()
    const ctxA = makeCtx({ lessons: true, language: 'en' })
    const ctxB = makeCtx({ lessons: true, language: 'zh' })

    await registry.call(
      'song_save',
      {
        title: 'Yozora',
        artist: 'Band X',
        lines: [{ text: 'Yozora wo miageru', meanings: { en: 'Look up at the night sky', zh: '仰望夜空' } }],
        words: [{ word: 'yozora', reading: 'よぞら', lines: [1] }]
      },
      ctxA,
      { callId: 'c-sh-s1', source: 'model' }
    )
    await registry.call('gloss_set', { word: 'yozora', language: 'en', meaning: 'night sky' }, ctxA, {
      callId: 'c-sh-g1',
      source: 'model'
    })
    await registry.call('gloss_set', { word: 'yozora', language: 'zh', meaning: '夜空' }, ctxA, {
      callId: 'c-sh-g2',
      source: 'model'
    })
    await registry.call(
      'library_write',
      { title: 'Night Vocabulary', body: 'Words for the night sky, such as yozora.' },
      ctxA,
      { callId: 'c-sh-n1', source: 'model' }
    )

    const songB = await registry.call('song_get', { title: 'Yozora' }, ctxB, { callId: 'c-sh-sg', source: 'model' })
    expect(songB).toMatchObject({
      ok: true,
      data: {
        title: 'Yozora',
        lines: [{ meanings: { en: 'Look up at the night sky', zh: '仰望夜空' } }],
        words: [
          {
            word: 'yozora',
            meanings: [
              { language: 'zh', meaning: '夜空' },
              { language: 'en', meaning: 'night sky' }
            ]
          }
        ]
      }
    })
    if (songB.ok) {
      const lineMeanings = (songB.data as { lines: { meanings: Record<string, string> }[] }).lines[0]?.meanings
      expect(Object.keys(lineMeanings ?? {})).toEqual(['zh', 'en'])
    }

    const vocabB = await registry.call('vocab_lookup', { word: 'yozora' }, ctxB, { callId: 'c-sh-vl', source: 'model' })
    expect(vocabB).toMatchObject({
      ok: true,
      data: {
        entries: [
          {
            word: 'yozora',
            meanings: [
              { language: 'zh', meaning: '夜空' },
              { language: 'en', meaning: 'night sky' }
            ]
          }
        ]
      }
    })

    const searchB = await registry.call('library_search', { query: 'yozora' }, ctxB, {
      callId: 'c-sh-ls',
      source: 'model'
    })
    expect(searchB).toMatchObject({
      ok: true,
      data: { results: [{ title: 'Night Vocabulary' }] }
    })

    const openB = await registry.call('library_open', { title: 'Night Vocabulary' }, ctxB, {
      callId: 'c-sh-lo',
      source: 'model'
    })
    expect(openB).toMatchObject({
      ok: true,
      data: { title: 'Night Vocabulary', body: 'Words for the night sky, such as yozora.' }
    })
  })

  it('states in mutating tool descriptions that the library is shared and holds study notes only', () => {
    const { registry, makeCtx } = setup()
    const ctx = makeCtx({ lessons: true })
    const offered = new Map(registry.offered(ctx).map((t) => [t.schema.name, t.schema.description]))
    for (const name of ['song_save', 'library_write', 'gloss_set']) {
      const desc = offered.get(name) ?? ''
      expect(desc).toContain('shared by every chat with lessons on')
      expect(desc).toContain('study notes only, never anything about a member')
    }
  })

  it('SQL gate: lessons tables appear only in src/tools/lessons and src/storage, candidate SQL filters by chat_id, and shared tables do not', () => {
    const sharedTables = [
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
    const allTables = [...sharedTables, 'lesson_lyrics_candidate']
    const sharedRe = new RegExp(`\\b(${sharedTables.join('|')})\\b`)
    const candidateRe = /\blesson_lyrics_candidate\b/
    const sqlVerbRe = /\b(SELECT|UPDATE|DELETE|INSERT)\b/i

    for (const file of walkTs('src')) {
      const normalized = file.replaceAll('\\', '/')
      const content = readFileSync(file, 'utf8')
      const inLessons = normalized.startsWith('src/tools/lessons/')
      const inStorage = normalized.startsWith('src/storage/')

      if (!inLessons && !inStorage) {
        for (const table of allTables) {
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
            if (sqlVerbRe.test(literal)) {
              if (candidateRe.test(literal)) {
                expect(literal, `${file}: candidate SQL must filter by chat_id: ${literal}`).toContain('chat_id')
              } else if (sharedRe.test(literal)) {
                expect(literal, `${file}: shared SQL must not filter by chat_id: ${literal}`).not.toContain('chat_id')
              }
            }
          }
          token = scanner.scan()
        }
      }
    }
  })
})
