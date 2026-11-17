import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { type Db, type Storage, isoNow } from '../../storage/database.js'
import { extractLinks, keyOf, songKeyOf } from './store.js'

// One-time import of the old Markdown+YAML library (docs/trd/tools.md#library-migration).
// Pure planner reads the source into a plan with a report; the applier writes in one transaction and never overwrites.

export type FolderName = 'vocab' | 'grammar' | 'songs' | 'artists'
const WIKI_LINK = /^\s*\[\[([^\]|]+)(?:\|[^\]]*)?\]\]\s*$/
const FOLDERS: readonly FolderName[] = ['vocab', 'grammar', 'songs', 'artists']

const MAX_TITLE_CHARS = 120
const MAX_READING_CHARS = 200
const MAX_LEVEL_CHARS = 20
const MAX_POS_CHARS = 40
const MAX_EXAMPLE_CHARS = 500
const MAX_MEANING_CHARS = 500
const MAX_LINE_POSITION = 200
const MAX_LINE_CHARS = 500
const MAX_NODE_BODY_CHARS = 8000

export interface FolderCounts {
  read: number
  kept: number
  merged: number
  rejected: number
}

export interface LineCounts {
  read: number
  kept: number
  rejected: number
}

export interface Rejection {
  folder: FolderName
  file: string
  /** Fixed reason code. Never file contents. */
  reason: string
  position?: number
}

export interface ImportReport {
  dryRun: boolean
  folders: Record<FolderName, FolderCounts>
  totals: FolderCounts
  lines: LineCounts
  seen: number
  rejections: Rejection[]
}

export interface PlannedWord {
  folder: 'vocab' | 'grammar'
  file: string
  kind: 'word' | 'pattern'
  word: string
  wordKey: string
  reading: string
  level: string
  pos: string
  forms: string[]
  example: string
  meanings: { en?: string; zh?: string }
}

export interface PlannedSongLine {
  position: number
  text: string
  meanings: { en?: string; zh?: string }
  vocabKeys: string[]
}

export interface PlannedSong {
  file: string
  title: string
  artist: string
  songKey: string
  source: string
  lines: PlannedSongLine[]
}

export interface PlannedNode {
  file: string
  title: string
  titleKey: string
  body: string
  links: { title: string; key: string }[]
}

export interface LibraryPlan {
  words: PlannedWord[]
  songs: PlannedSong[]
  nodes: PlannedNode[]
  folderRead: Record<FolderName, number>
  folderDupMerged: Record<FolderName, number>
  folderRejected: Record<FolderName, number>
  lines: LineCounts
  rejections: Rejection[]
  report: ImportReport
}

const EMPTY_FRONT_MATTER_RE = /^---[ \t]*\n---[ \t]*(?:\n([\s\S]*))?$/
const FRONT_MATTER_RE = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n([\s\S]*))?$/

function newId(prefix: 'song_' | 'word_' | 'node_'): string {
  return `${prefix}${randomBytes(6).toString('hex')}`
}

function charLength(text: string): number {
  let count = 0
  for (const _ of text) count += 1
  return count
}

function truncateChars(text: string, max: number): string {
  if (text.length <= max) return text
  let out = ''
  let codePoints = 0
  for (const ch of text) {
    if (codePoints + 1 > max || out.length + ch.length > max) break
    out += ch
    codePoints += 1
  }
  return out
}

function asPlainObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function parseFrontMatter(
  raw: string
): { ok: true; data: Record<string, unknown>; body: string } | { ok: false; reason: string } {
  const normalized = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  const emptyMatch = EMPTY_FRONT_MATTER_RE.exec(normalized)
  if (emptyMatch) {
    return { ok: true, data: {}, body: (emptyMatch[1] ?? '').trim() }
  }
  const match = FRONT_MATTER_RE.exec(normalized)
  if (!match) return { ok: false, reason: 'invalid_front_matter' }

  let parsed: unknown
  try {
    parsed = parseYaml(match[1] ?? '')
  } catch {
    return { ok: false, reason: 'invalid_front_matter' }
  }
  if (parsed === null || parsed === undefined) {
    return { ok: true, data: {}, body: (match[2] ?? '').trim() }
  }
  const data = asPlainObject(parsed)
  if (!data) return { ok: false, reason: 'invalid_front_matter' }
  return { ok: true, data, body: (match[2] ?? '').trim() }
}

function readText(value: unknown, allowNumber = false): { ok: true; value: string } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, value: '' }
  if (typeof value === 'string') return { ok: true, value: value.trim() }
  if (allowNumber && typeof value === 'number' && Number.isFinite(value)) return { ok: true, value: String(value) }
  return { ok: false }
}

function readTitle(
  data: Record<string, unknown>
): { ok: true; title: string; key: string } | { ok: false; reason: string } {
  const title = readText(data['title'], true)
  if (!title.ok) return { ok: false, reason: 'invalid_title' }
  const key = keyOf(title.value)
  if (title.value === '' || key === '') return { ok: false, reason: 'missing_title' }
  if (charLength(title.value) > MAX_TITLE_CHARS) return { ok: false, reason: 'title_too_long' }
  return { ok: true, title: title.value, key }
}

function readForms(value: unknown): { ok: true; value: string[] } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, value: [] }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return { ok: true, value: trimmed === '' ? [] : [trimmed] }
  }
  if (!Array.isArray(value)) return { ok: false }
  const forms: string[] = []
  for (const item of value) {
    if (item === undefined || item === null) continue
    if (typeof item !== 'string') return { ok: false }
    const trimmed = item.trim()
    if (trimmed !== '') forms.push(trimmed)
  }
  return { ok: true, value: forms }
}

function walkMdFiles(dir: string, recursive: boolean): string[] {
  if (!existsSync(dir)) return []
  const files: string[] = []
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  )
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (recursive) files.push(...walkMdFiles(full, true))
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(full)
    }
  }
  return files
}

function emptyCounts(): Record<FolderName, number> {
  return { vocab: 0, grammar: 0, songs: 0, artists: 0 }
}

function buildReport(
  dryRun: boolean,
  read: Record<FolderName, number>,
  kept: Record<FolderName, number>,
  merged: Record<FolderName, number>,
  rejected: Record<FolderName, number>,
  lines: LineCounts,
  seen: number,
  rejections: Rejection[]
): ImportReport {
  const folders = {} as Record<FolderName, FolderCounts>
  const totals: FolderCounts = { read: 0, kept: 0, merged: 0, rejected: 0 }
  for (const folder of FOLDERS) {
    const entry: FolderCounts = {
      read: read[folder],
      kept: kept[folder],
      merged: merged[folder],
      rejected: rejected[folder]
    }
    folders[folder] = entry
    totals.read += entry.read
    totals.kept += entry.kept
    totals.merged += entry.merged
    totals.rejected += entry.rejected
  }
  return { dryRun, folders, totals, lines: { ...lines }, seen, rejections: [...rejections] }
}

interface ParsedSense {
  pos: string
  example: string
  glossEn: string
  glossZh: string
}

function parseSenses(raw: unknown): { ok: true; value: ParsedSense[] } | { ok: false } {
  if (raw === undefined || raw === null) return { ok: true, value: [] }
  if (!Array.isArray(raw)) return { ok: false }
  const out: ParsedSense[] = []
  for (const entry of raw) {
    const map = asPlainObject(entry)
    if (!map) return { ok: false }
    const pos = readText(map['pos'])
    const example = readText(map['example'])
    const glossEn = readText(map['gloss_en'], true)
    const glossZh = readText(map['gloss_zh'], true)
    if (!pos.ok || !example.ok || !glossEn.ok || !glossZh.ok) return { ok: false }
    out.push({ pos: pos.value, example: example.value, glossEn: glossEn.value, glossZh: glossZh.value })
  }
  return { ok: true, value: out }
}

function parseVocabFile(file: string, raw: string): { ok: true; word: PlannedWord } | { ok: false; reason: string } {
  const fm = parseFrontMatter(raw)
  if (!fm.ok) return fm
  const data = fm.data

  const title = readTitle(data)
  if (!title.ok) return title

  const reading = readText(data['reading'])
  if (!reading.ok) return { ok: false, reason: 'invalid_reading' }
  if (charLength(reading.value) > MAX_READING_CHARS) return { ok: false, reason: 'reading_too_long' }

  const level = readText(data['level'], true)
  const jlpt = readText(data['jlpt'], true)
  if (!level.ok || !jlpt.ok) return { ok: false, reason: 'invalid_level' }
  const resolvedLevel = level.value !== '' ? level.value : jlpt.value
  if (charLength(resolvedLevel) > MAX_LEVEL_CHARS) return { ok: false, reason: 'level_too_long' }

  const topPos = readText(data['pos'])
  const topExample = readText(data['example'])
  const topEn = readText(data['gloss_en'], true)
  const topZh = readText(data['gloss_zh'], true)
  if (!topPos.ok || !topExample.ok || !topEn.ok || !topZh.ok) return { ok: false, reason: 'invalid_field' }

  const forms = readForms(data['forms'])
  if (!forms.ok) return { ok: false, reason: 'invalid_forms' }

  const senses = parseSenses(data['senses'])
  if (!senses.ok) return { ok: false, reason: 'invalid_senses' }

  const firstSense = senses.value[0]
  const pos = topPos.value !== '' ? topPos.value : (firstSense?.pos ?? '')
  const example = topExample.value !== '' ? topExample.value : (firstSense?.example ?? '')
  if (charLength(pos) > MAX_POS_CHARS) return { ok: false, reason: 'pos_too_long' }
  if (charLength(example) > MAX_EXAMPLE_CHARS) return { ok: false, reason: 'example_too_long' }

  const senseEn = senses.value.map((s) => s.glossEn).filter((g) => g !== '')
  const senseZh = senses.value.map((s) => s.glossZh).filter((g) => g !== '')

  const en = senseEn.length > 0 ? truncateChars(senseEn.join('; '), MAX_MEANING_CHARS) : topEn.value
  const zh = senseZh.length > 0 ? truncateChars(senseZh.join('; '), MAX_MEANING_CHARS) : topZh.value
  if (charLength(en) > MAX_MEANING_CHARS || charLength(zh) > MAX_MEANING_CHARS) {
    return { ok: false, reason: 'meaning_too_long' }
  }

  return {
    ok: true,
    word: {
      folder: 'vocab',
      file,
      kind: 'word',
      word: title.title,
      wordKey: title.key,
      reading: reading.value,
      level: resolvedLevel,
      pos,
      forms: forms.value,
      example,
      meanings: { ...(en !== '' ? { en } : {}), ...(zh !== '' ? { zh } : {}) }
    }
  }
}

function parseGrammarFile(file: string, raw: string): { ok: true; word: PlannedWord } | { ok: false; reason: string } {
  const fm = parseFrontMatter(raw)
  if (!fm.ok) return fm
  const data = fm.data

  const title = readTitle(data)
  if (!title.ok) return title

  const jlpt = readText(data['jlpt'], true)
  if (!jlpt.ok) return { ok: false, reason: 'invalid_level' }
  if (charLength(jlpt.value) > MAX_LEVEL_CHARS) return { ok: false, reason: 'level_too_long' }

  const en = readText(data['explanation'], true)
  const zh = readText(data['explanation_zh'], true)
  if (!en.ok || !zh.ok) return { ok: false, reason: 'invalid_field' }
  if (charLength(en.value) > MAX_MEANING_CHARS || charLength(zh.value) > MAX_MEANING_CHARS) {
    return { ok: false, reason: 'meaning_too_long' }
  }

  return {
    ok: true,
    word: {
      folder: 'grammar',
      file,
      kind: 'pattern',
      word: title.title,
      wordKey: title.key,
      reading: '',
      level: jlpt.value,
      pos: '',
      forms: [],
      example: '',
      meanings: { ...(en.value !== '' ? { en: en.value } : {}), ...(zh.value !== '' ? { zh: zh.value } : {}) }
    }
  }
}

function parseSongLine(
  item: unknown,
  file: string,
  seenPositions: Set<number>,
  rejections: Rejection[]
): PlannedSongLine | undefined {
  const map = asPlainObject(item)
  if (!map) {
    rejections.push({ folder: 'songs', file, reason: 'invalid_line' })
    return undefined
  }
  const pos = map['i']
  if (typeof pos !== 'number' || !Number.isInteger(pos) || pos < 1) {
    rejections.push({ folder: 'songs', file, reason: 'invalid_line_position' })
    return undefined
  }
  if (pos > MAX_LINE_POSITION) {
    rejections.push({ folder: 'songs', file, reason: 'line_past_200', position: pos })
    return undefined
  }
  if (seenPositions.has(pos)) {
    rejections.push({ folder: 'songs', file, reason: 'duplicate_line_position', position: pos })
    return undefined
  }

  const ja = readText(map['ja'], true)
  if (!ja.ok) {
    rejections.push({ folder: 'songs', file, reason: 'invalid_line_text', position: pos })
    return undefined
  }
  if (ja.value === '') {
    rejections.push({ folder: 'songs', file, reason: 'empty_line_text', position: pos })
    return undefined
  }
  if (charLength(ja.value) > MAX_LINE_CHARS) {
    rejections.push({ folder: 'songs', file, reason: 'line_too_long', position: pos })
    return undefined
  }

  const vocabKeys: string[] = []
  const rawVocab = map['vocab']
  if (rawVocab !== undefined && rawVocab !== null) {
    if (!Array.isArray(rawVocab)) {
      rejections.push({ folder: 'songs', file, reason: 'invalid_line_vocab', position: pos })
      return undefined
    }
    const seenKeys = new Set<string>()
    for (const v of rawVocab) {
      if (typeof v !== 'string') {
        rejections.push({ folder: 'songs', file, reason: 'invalid_line_vocab', position: pos })
        return undefined
      }
      // The old library writes a line's words as wiki links, `[[word]]` or `[[word|shown text]]`.
      const wKey = keyOf(WIKI_LINK.exec(v)?.[1] ?? v)
      if (wKey !== '' && !seenKeys.has(wKey)) {
        seenKeys.add(wKey)
        vocabKeys.push(wKey)
      }
    }
  }

  const meanings: { en?: string; zh?: string } = {}
  for (const lang of ['en', 'zh'] as const) {
    const text = readText(map[lang], true)
    if (!text.ok || charLength(text.value) > MAX_MEANING_CHARS) {
      rejections.push({
        folder: 'songs',
        file,
        reason: text.ok ? 'line_meaning_too_long' : 'invalid_line_meaning',
        position: pos
      })
    } else if (text.value !== '') {
      meanings[lang] = text.value
    }
  }

  seenPositions.add(pos)
  return { position: pos, text: ja.value, meanings, vocabKeys }
}

function parseSongFile(
  file: string,
  raw: string
): { ok: true; song: PlannedSong; lineRead: number; lineRejections: Rejection[] } | { ok: false; reason: string } {
  const fm = parseFrontMatter(raw)
  if (!fm.ok) return fm
  const data = fm.data

  const title = readTitle(data)
  if (!title.ok) return title

  const artist = readText(data['artist'], true)
  if (!artist.ok) return { ok: false, reason: 'invalid_artist' }
  if (charLength(artist.value) > MAX_TITLE_CHARS) return { ok: false, reason: 'artist_too_long' }

  let source = ''
  const provenance = asPlainObject(data['provenance'])
  if (provenance && typeof provenance['source'] === 'string') {
    source = provenance['source'].trim()
  }

  const rawLines = data['lines']
  if (rawLines !== undefined && rawLines !== null && !Array.isArray(rawLines)) {
    return { ok: false, reason: 'invalid_lines' }
  }

  const lines: PlannedSongLine[] = []
  const lineRejections: Rejection[] = []
  const seenPositions = new Set<number>()
  const lineList = Array.isArray(rawLines) ? rawLines : []

  for (const item of lineList) {
    const parsedLine = parseSongLine(item, file, seenPositions, lineRejections)
    if (parsedLine) lines.push(parsedLine)
  }

  return {
    ok: true,
    song: {
      file,
      title: title.title,
      artist: artist.value,
      songKey: songKeyOf(title.title, artist.value),
      source,
      lines
    },
    lineRead: lineList.length,
    lineRejections
  }
}

function parseArtistFile(file: string, raw: string): { ok: true; node: PlannedNode } | { ok: false; reason: string } {
  const fm = parseFrontMatter(raw)
  if (!fm.ok) return fm

  const title = readTitle(fm.data)
  if (!title.ok) return title

  if (fm.body === '') return { ok: false, reason: 'empty_body' }
  if (charLength(fm.body) > MAX_NODE_BODY_CHARS) return { ok: false, reason: 'body_too_long' }

  return {
    ok: true,
    node: {
      file,
      title: title.title,
      titleKey: title.key,
      body: fm.body,
      links: extractLinks(fm.body, title.key)
    }
  }
}

/** Pure planner: reads the source folder read-only and builds the migration plan and initial report. */
export function planLibraryImport(from: string): LibraryPlan {
  if (!existsSync(from) || !statSync(from).isDirectory()) {
    throw new Error(`library source folder does not exist: ${from}`)
  }

  const words: PlannedWord[] = []
  const songs: PlannedSong[] = []
  const nodes: PlannedNode[] = []
  const folderRead = emptyCounts()
  const folderDupMerged = emptyCounts()
  const folderRejected = emptyCounts()
  const lines: LineCounts = { read: 0, kept: 0, rejected: 0 }
  const rejections: Rejection[] = []

  const seenWordKeys = new Set<string>()
  const wordCountByKey = new Map<string, number>()

  for (const folder of ['vocab', 'grammar'] as const) {
    for (const fullPath of walkMdFiles(join(from, folder), false)) {
      const file = relative(from, fullPath).replaceAll('\\', '/')
      folderRead[folder] += 1
      const raw = readFileSync(fullPath, 'utf8')
      const parsed = folder === 'vocab' ? parseVocabFile(file, raw) : parseGrammarFile(file, raw)
      if (!parsed.ok) {
        folderRejected[folder] += 1
        rejections.push({ folder, file, reason: parsed.reason })
        continue
      }
      const pairKey = `${parsed.word.kind}\n${parsed.word.wordKey}`
      if (seenWordKeys.has(pairKey)) {
        folderDupMerged[folder] += 1
        continue
      }
      seenWordKeys.add(pairKey)
      wordCountByKey.set(parsed.word.wordKey, (wordCountByKey.get(parsed.word.wordKey) ?? 0) + 1)
      words.push(parsed.word)
    }
  }

  const seenSongKeys = new Set<string>()
  for (const fullPath of walkMdFiles(join(from, 'songs'), true)) {
    const file = relative(from, fullPath).replaceAll('\\', '/')
    folderRead.songs += 1
    const parsed = parseSongFile(file, readFileSync(fullPath, 'utf8'))
    if (!parsed.ok) {
      folderRejected.songs += 1
      rejections.push({ folder: 'songs', file, reason: parsed.reason })
      continue
    }
    lines.read += parsed.lineRead
    lines.kept += parsed.song.lines.length
    lines.rejected += parsed.lineRead - parsed.song.lines.length
    if (parsed.lineRejections.length > 0) {
      folderRejected.songs += parsed.lineRejections.length
      rejections.push(...parsed.lineRejections)
    }
    if (seenSongKeys.has(parsed.song.songKey)) {
      folderDupMerged.songs += 1
      continue
    }
    seenSongKeys.add(parsed.song.songKey)
    songs.push(parsed.song)
  }

  const seenNodeKeys = new Set<string>()
  for (const fullPath of walkMdFiles(join(from, 'artists'), false)) {
    const file = relative(from, fullPath).replaceAll('\\', '/')
    folderRead.artists += 1
    const parsed = parseArtistFile(file, readFileSync(fullPath, 'utf8'))
    if (!parsed.ok) {
      folderRejected.artists += 1
      rejections.push({ folder: 'artists', file, reason: parsed.reason })
      continue
    }
    if (seenNodeKeys.has(parsed.node.titleKey)) {
      folderDupMerged.artists += 1
      continue
    }
    seenNodeKeys.add(parsed.node.titleKey)
    nodes.push(parsed.node)
  }

  const kept: Record<FolderName, number> = {
    vocab: words.filter((w) => w.folder === 'vocab').length,
    grammar: words.filter((w) => w.folder === 'grammar').length,
    songs: songs.length,
    artists: nodes.length
  }
  let seen = 0
  for (const song of songs) {
    for (const line of song.lines) {
      for (const wKey of line.vocabKeys) {
        seen += wordCountByKey.get(wKey) ?? 0
      }
    }
  }

  return {
    words,
    songs,
    nodes,
    folderRead,
    folderDupMerged,
    folderRejected,
    lines,
    rejections,
    report: buildReport(true, folderRead, kept, folderDupMerged, folderRejected, lines, seen, rejections)
  }
}

function hasLessonsTables(db: Db): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'lesson_word'")
    .pluck()
    .get() as string | undefined
  return row !== undefined
}

/** Computes the exact report against an open read/write database handle without modifying anything. */
export function previewLibraryImport(db: Db, plan: LibraryPlan): ImportReport {
  if (!hasLessonsTables(db)) {
    return buildReport(
      true,
      plan.folderRead,
      {
        vocab: plan.report.folders.vocab.kept,
        grammar: plan.report.folders.grammar.kept,
        songs: plan.report.folders.songs.kept,
        artists: plan.report.folders.artists.kept
      },
      plan.folderDupMerged,
      plan.folderRejected,
      plan.lines,
      plan.report.seen,
      plan.rejections
    )
  }

  const existingWordRows = db.prepare('SELECT kind, word_key FROM lesson_word').all() as {
    kind: 'word' | 'pattern'
    word_key: string
  }[]
  const existingWords = new Set<string>()
  const wordCountByKey = new Map<string, number>()
  for (const row of existingWordRows) {
    existingWords.add(`${row.kind}\n${row.word_key}`)
    wordCountByKey.set(row.word_key, (wordCountByKey.get(row.word_key) ?? 0) + 1)
  }

  const kept = emptyCounts()
  const merged = { ...plan.folderDupMerged }

  for (const w of plan.words) {
    const pairKey = `${w.kind}\n${w.wordKey}`
    if (existingWords.has(pairKey)) {
      merged[w.folder] += 1
      continue
    }
    kept[w.folder] += 1
    wordCountByKey.set(w.wordKey, (wordCountByKey.get(w.wordKey) ?? 0) + 1)
  }

  const existingSongKeys = new Set(db.prepare('SELECT song_key FROM lesson_song').pluck().all() as string[])
  let seen = 0
  for (const s of plan.songs) {
    if (existingSongKeys.has(s.songKey)) {
      merged.songs += 1
      continue
    }
    kept.songs += 1
    for (const line of s.lines) {
      for (const wKey of line.vocabKeys) {
        seen += wordCountByKey.get(wKey) ?? 0
      }
    }
  }

  const existingNodeKeys = new Set(db.prepare('SELECT title_key FROM library_node').pluck().all() as string[])
  for (const n of plan.nodes) {
    if (existingNodeKeys.has(n.titleKey)) {
      merged.artists += 1
      continue
    }
    kept.artists += 1
  }

  return buildReport(true, plan.folderRead, kept, merged, plan.folderRejected, plan.lines, seen, plan.rejections)
}

/**
 * Applies a planned library import in one database transaction, or previews it read-only when `dryRun` is true.
 * Existing words, songs and library nodes are merged (never overwritten).
 */
export function applyLibraryImport(
  storage: Storage,
  plan: LibraryPlan,
  options: { dryRun?: boolean; now?: () => Date } = {}
): ImportReport {
  if (options.dryRun) {
    return storage.read((db) => previewLibraryImport(db, plan))
  }

  return storage.tx((db) => {
    const at = isoNow(options.now ?? (() => new Date()))
    const kept = emptyCounts()
    const merged = { ...plan.folderDupMerged }
    let seen = 0

    const existingWordRows = db.prepare('SELECT id, kind, word_key FROM lesson_word').all() as {
      id: string
      kind: 'word' | 'pattern'
      word_key: string
    }[]
    const existingWords = new Map<string, string>()
    const wordIdsByKey = new Map<string, string[]>()
    const trackWord = (id: string, kind: 'word' | 'pattern', wordKey: string): void => {
      existingWords.set(`${kind}\n${wordKey}`, id)
      let list = wordIdsByKey.get(wordKey)
      if (!list) {
        list = []
        wordIdsByKey.set(wordKey, list)
      }
      if (!list.includes(id)) list.push(id)
    }
    for (const row of existingWordRows) {
      trackWord(row.id, row.kind, row.word_key)
    }

    const insertWord = db.prepare(
      `INSERT INTO lesson_word (id, kind, word, word_key, reading, level, pos, forms, example, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (kind, word_key) DO NOTHING`
    )
    const insertWordMeaning = db.prepare(
      `INSERT INTO lesson_word_meaning (word_id, language, meaning, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (word_id, language) DO NOTHING`
    )

    for (const w of plan.words) {
      const pairKey = `${w.kind}\n${w.wordKey}`
      if (existingWords.has(pairKey)) {
        merged[w.folder] += 1
        continue
      }
      const wordId = newId('word_')
      const res = insertWord.run(
        wordId,
        w.kind,
        w.word,
        w.wordKey,
        w.reading,
        w.level,
        w.pos,
        JSON.stringify(w.forms),
        w.example,
        at,
        at
      )
      if (res.changes === 0) {
        merged[w.folder] += 1
        continue
      }
      trackWord(wordId, w.kind, w.wordKey)
      if (w.meanings.en) insertWordMeaning.run(wordId, 'en', w.meanings.en, at)
      if (w.meanings.zh) insertWordMeaning.run(wordId, 'zh', w.meanings.zh, at)
      kept[w.folder] += 1
    }

    const existingSongKeys = new Set(db.prepare('SELECT song_key FROM lesson_song').pluck().all() as string[])
    const insertSong = db.prepare(
      `INSERT INTO lesson_song (id, title, artist, song_key, language, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (song_key) DO NOTHING`
    )
    const insertSongLine = db.prepare(
      `INSERT INTO lesson_song_line (song_id, position, text, reading)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (song_id, position) DO NOTHING`
    )
    const insertSongLineMeaning = db.prepare(
      `INSERT INTO lesson_song_line_meaning (song_id, position, language, meaning)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (song_id, position, language) DO NOTHING`
    )
    const insertWordSeen = db.prepare(
      `INSERT INTO lesson_word_seen (word_id, song_id, position)
       VALUES (?, ?, ?)
       ON CONFLICT (word_id, song_id, position) DO NOTHING`
    )

    for (const s of plan.songs) {
      if (existingSongKeys.has(s.songKey)) {
        merged.songs += 1
        continue
      }
      const songId = newId('song_')
      const res = insertSong.run(songId, s.title, s.artist, s.songKey, '', s.source, at, at)
      if (res.changes === 0) {
        merged.songs += 1
        continue
      }
      existingSongKeys.add(s.songKey)
      kept.songs += 1
      for (const line of s.lines) {
        insertSongLine.run(songId, line.position, line.text, '')
        if (line.meanings.en) insertSongLineMeaning.run(songId, line.position, 'en', line.meanings.en)
        if (line.meanings.zh) insertSongLineMeaning.run(songId, line.position, 'zh', line.meanings.zh)
        for (const wKey of line.vocabKeys) {
          const wordIds = wordIdsByKey.get(wKey)
          if (!wordIds) continue
          for (const wordId of wordIds) {
            const seenRes = insertWordSeen.run(wordId, songId, line.position)
            seen += seenRes.changes
          }
        }
      }
    }

    const existingNodeKeys = new Set(db.prepare('SELECT title_key FROM library_node').pluck().all() as string[])
    const insertNode = db.prepare(
      `INSERT INTO library_node (id, title, title_key, body, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (title_key) DO NOTHING`
    )
    const insertLink = db.prepare(
      `INSERT INTO library_link (node_id, target_title, target_key)
       VALUES (?, ?, ?)
       ON CONFLICT (node_id, target_key) DO NOTHING`
    )
    const insertFts = db.prepare('INSERT INTO library_fts (node_id, text) VALUES (?, ?)')

    for (const n of plan.nodes) {
      if (existingNodeKeys.has(n.titleKey)) {
        merged.artists += 1
        continue
      }
      const nodeId = newId('node_')
      const res = insertNode.run(nodeId, n.title, n.titleKey, n.body, at, at)
      if (res.changes === 0) {
        merged.artists += 1
        continue
      }
      existingNodeKeys.add(n.titleKey)
      kept.artists += 1
      for (const link of n.links) {
        insertLink.run(nodeId, link.title, link.key)
      }
      insertFts.run(nodeId, `${n.title} ${n.body}`)
    }

    return buildReport(false, plan.folderRead, kept, merged, plan.folderRejected, plan.lines, seen, plan.rejections)
  })
}

export function formatLibraryReport(report: ImportReport): string {
  const out = [
    `library migration: ${report.dryRun ? 'DRY RUN, nothing was imported' : 'APPLIED'}`,
    ...FOLDERS.map((folder) => {
      const c = report.folders[folder]
      return `  ${folder}: read ${c.read}, kept ${c.kept}, merged ${c.merged}, rejected ${c.rejected}`
    }),
    `  totals: read ${report.totals.read}, kept ${report.totals.kept}, merged ${report.totals.merged}, rejected ${report.totals.rejected}`,
    `  lines: read ${report.lines.read}, kept ${report.lines.kept}, rejected ${report.lines.rejected}, seen ${report.seen}`,
    `rejected (${report.rejections.length}):`,
    ...report.rejections.map((r) =>
      r.position !== undefined ? `  ${r.file}:${r.position} ${r.reason}` : `  ${r.file} ${r.reason}`
    )
  ]
  return out.join('\n')
}
