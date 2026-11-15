import { randomBytes } from 'node:crypto'
import { ftsQuery } from '../../memory/recall.js'
import { type Db, type Storage, isoNow } from '../../storage/database.js'

type Clock = () => Date
const wallClock: Clock = () => new Date()

export type WordKind = 'word' | 'pattern'

export interface SongLine {
  position: number
  text: string
  reading: string
  meaning: string
}

export interface SongWord {
  kind: WordKind
  word: string
  reading: string
  meaning: string
  lines: number[]
}

export interface Song {
  songId: string
  title: string
  artist: string
  language: string
  source: string
  lines: SongLine[]
  words: SongWord[]
}

function newId(prefix: 'song_' | 'word_' | 'node_' | 'cand_'): string {
  return `${prefix}${randomBytes(6).toString('hex')}`
}

/** Normalised lookup key: NFKC, trimmed, inner whitespace collapsed, lower-cased. */
export function keyOf(text: string): string {
  return text.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()
}

function songKeyOf(title: string, artist: string): string {
  return `${keyOf(title)}\n${keyOf(artist)}`
}

export function saveSong(
  db: Db,
  chatId: string,
  song: {
    title: string
    artist: string
    language: string
    source: string
    lines: { text: string; reading: string; meaning: string }[]
    words: { kind: WordKind; word: string; reading: string; lines: number[] }[]
  },
  now: Clock = wallClock
): { songId: string; replaced: boolean; words: number } {
  const sKey = songKeyOf(song.title, song.artist)
  const at = isoNow(now)
  const existingId = db
    .prepare('SELECT id FROM lesson_song WHERE chat_id = ? AND song_key = ?')
    .pluck()
    .get(chatId, sKey) as string | undefined

  let songId: string
  let replaced: boolean
  if (existingId !== undefined) {
    songId = existingId
    replaced = true
    db.prepare(
      `UPDATE lesson_song
       SET title = ?, artist = ?, language = ?, source = ?, updated_at = ?
       WHERE id = ? AND chat_id = ?`
    ).run(song.title, song.artist, song.language, song.source, at, songId, chatId)
    db.prepare('DELETE FROM lesson_song_line WHERE song_id = ? AND chat_id = ?').run(songId, chatId)
    db.prepare('DELETE FROM lesson_word_seen WHERE song_id = ? AND chat_id = ?').run(songId, chatId)
  } else {
    songId = newId('song_')
    replaced = false
    db.prepare(
      `INSERT INTO lesson_song (id, chat_id, title, artist, song_key, language, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(songId, chatId, song.title, song.artist, sKey, song.language, song.source, at, at)
  }

  const insertLine = db.prepare(
    `INSERT INTO lesson_song_line (song_id, chat_id, position, text, reading, meaning)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
  for (let i = 0; i < song.lines.length; i++) {
    const line = song.lines[i]
    if (!line) continue
    insertLine.run(songId, chatId, i + 1, line.text, line.reading, line.meaning)
  }

  const findWord = db.prepare('SELECT id, reading FROM lesson_word WHERE chat_id = ? AND kind = ? AND word_key = ?')
  const fillWordReading = db.prepare('UPDATE lesson_word SET reading = ?, updated_at = ? WHERE id = ? AND chat_id = ?')
  const insertWord = db.prepare(
    `INSERT INTO lesson_word (id, chat_id, kind, word, word_key, reading, meaning, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, '', ?, ?)`
  )
  const insertSeen = db.prepare(
    'INSERT OR IGNORE INTO lesson_word_seen (word_id, chat_id, song_id, position) VALUES (?, ?, ?, ?)'
  )

  const maxLine = song.lines.length
  const wordIds = new Set<string>()
  for (const entry of song.words) {
    const wKey = keyOf(entry.word)
    const found = findWord.get(chatId, entry.kind, wKey) as { id: string; reading: string } | undefined
    let wordId: string
    if (found) {
      wordId = found.id
      if (found.reading === '' && entry.reading !== '') {
        fillWordReading.run(entry.reading, at, wordId, chatId)
      }
    } else {
      wordId = newId('word_')
      insertWord.run(wordId, chatId, entry.kind, entry.word, wKey, entry.reading, at, at)
    }
    wordIds.add(wordId)

    for (const pos of entry.lines) {
      if (!Number.isInteger(pos) || pos < 1 || pos > maxLine) continue
      insertSeen.run(wordId, chatId, songId, pos)
    }
  }

  return { songId, replaced, words: wordIds.size }
}

export function getSong(
  storage: Storage,
  chatId: string,
  title: string,
  artist?: string
): Song | undefined | 'ambiguous' {
  const tKey = keyOf(title)
  const rows = storage.read((db) => {
    if (artist !== undefined) {
      const sKey = songKeyOf(title, artist)
      return db
        .prepare('SELECT id, title, artist, language, source FROM lesson_song WHERE chat_id = ? AND song_key = ?')
        .all(chatId, sKey) as { id: string; title: string; artist: string; language: string; source: string }[]
    }
    return db
      .prepare(
        `SELECT id, title, artist, language, source
         FROM lesson_song
         WHERE chat_id = ? AND substr(song_key, 1, instr(song_key, char(10)) - 1) = ?`
      )
      .all(chatId, tKey) as { id: string; title: string; artist: string; language: string; source: string }[]
  })

  if (rows.length === 0) return undefined
  if (rows.length > 1) return 'ambiguous'
  const songRow = rows[0]
  if (!songRow) return undefined

  return storage.read((db) => {
    const lines = db
      .prepare(
        `SELECT position, text, reading, meaning
         FROM lesson_song_line
         WHERE song_id = ? AND chat_id = ?
         ORDER BY position ASC`
      )
      .all(songRow.id, chatId) as SongLine[]

    const seenRows = db
      .prepare(
        `SELECT w.id, w.kind, w.word, w.reading, w.meaning, s.position
         FROM lesson_word_seen s
         JOIN lesson_word w ON w.id = s.word_id AND w.chat_id = s.chat_id
         WHERE s.song_id = ? AND s.chat_id = ? AND w.chat_id = ?
         ORDER BY w.word_key ASC, w.kind ASC, s.position ASC`
      )
      .all(songRow.id, chatId, chatId) as {
      id: string
      kind: WordKind
      word: string
      reading: string
      meaning: string
      position: number
    }[]

    const wordsById = new Map<string, SongWord>()
    for (const row of seenRows) {
      let item = wordsById.get(row.id)
      if (!item) {
        item = {
          kind: row.kind,
          word: row.word,
          reading: row.reading,
          meaning: row.meaning,
          lines: []
        }
        wordsById.set(row.id, item)
      }
      item.lines.push(row.position)
    }

    return {
      songId: songRow.id,
      title: songRow.title,
      artist: songRow.artist,
      language: songRow.language,
      source: songRow.source,
      lines,
      words: [...wordsById.values()]
    }
  })
}

export function lookupWord(
  storage: Storage,
  chatId: string,
  word: string
): {
  word: string
  kind: WordKind
  reading: string
  meaning: string
  seen: { songTitle: string; artist: string; position: number; line: string }[]
}[] {
  const wKey = keyOf(word)
  return storage.read((db) => {
    const wordRows = db
      .prepare(
        `SELECT id, kind, word, reading, meaning
         FROM lesson_word
         WHERE chat_id = ? AND word_key = ?
         ORDER BY kind ASC`
      )
      .all(chatId, wKey) as { id: string; kind: WordKind; word: string; reading: string; meaning: string }[]

    const seenStmt = db.prepare(
      `SELECT song.title AS songTitle, song.artist, seen.position, line.text AS line
       FROM lesson_word_seen seen
       JOIN lesson_song song ON song.id = seen.song_id AND song.chat_id = seen.chat_id
       JOIN lesson_song_line line
         ON line.song_id = seen.song_id AND line.chat_id = seen.chat_id AND line.position = seen.position
       WHERE seen.word_id = ? AND seen.chat_id = ? AND song.chat_id = ? AND line.chat_id = ?
       ORDER BY song.title ASC, seen.position ASC`
    )

    return wordRows.map((row) => ({
      word: row.word,
      kind: row.kind,
      reading: row.reading,
      meaning: row.meaning,
      seen: seenStmt.all(row.id, chatId, chatId, chatId) as {
        songTitle: string
        artist: string
        position: number
        line: string
      }[]
    }))
  })
}

export function setGloss(
  db: Db,
  chatId: string,
  input: { kind: WordKind; word: string; reading?: string; meaning: string },
  now: Clock = wallClock
): { wordId: string; created: boolean } {
  const wKey = keyOf(input.word)
  const at = isoNow(now)
  const existing = db
    .prepare('SELECT id FROM lesson_word WHERE chat_id = ? AND kind = ? AND word_key = ?')
    .get(chatId, input.kind, wKey) as { id: string } | undefined

  if (existing) {
    if (input.reading !== undefined) {
      db.prepare('UPDATE lesson_word SET meaning = ?, reading = ?, updated_at = ? WHERE id = ? AND chat_id = ?').run(
        input.meaning,
        input.reading,
        at,
        existing.id,
        chatId
      )
    } else {
      db.prepare('UPDATE lesson_word SET meaning = ?, updated_at = ? WHERE id = ? AND chat_id = ?').run(
        input.meaning,
        at,
        existing.id,
        chatId
      )
    }
    return { wordId: existing.id, created: false }
  }

  const wordId = newId('word_')
  db.prepare(
    `INSERT INTO lesson_word (id, chat_id, kind, word, word_key, reading, meaning, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(wordId, chatId, input.kind, input.word, wKey, input.reading ?? '', input.meaning, at, at)
  return { wordId, created: true }
}

function extractLinks(body: string, selfKey: string): { title: string; key: string }[] {
  const seen = new Set<string>()
  const links: { title: string; key: string }[] = []
  const re = /\[\[([^\[\]]{1,120})\]\]/g
  for (const match of body.matchAll(re)) {
    const raw = (match[1] ?? '').trim()
    if (raw.length === 0 || raw.length > 120) continue
    const key = keyOf(raw)
    if (key === '' || key === selfKey || seen.has(key)) continue
    seen.add(key)
    links.push({ title: raw, key })
  }
  return links
}

export function writeNode(
  db: Db,
  chatId: string,
  input: { title: string; body: string },
  now: Clock = wallClock
): { nodeId: string; replaced: boolean; links: string[] } {
  const tKey = keyOf(input.title)
  const at = isoNow(now)
  const links = extractLinks(input.body, tKey)

  const existingId = db
    .prepare('SELECT id FROM library_node WHERE chat_id = ? AND title_key = ?')
    .pluck()
    .get(chatId, tKey) as string | undefined

  let nodeId: string
  let replaced: boolean
  if (existingId !== undefined) {
    nodeId = existingId
    replaced = true
    db.prepare('UPDATE library_node SET title = ?, body = ?, updated_at = ? WHERE id = ? AND chat_id = ?').run(
      input.title,
      input.body,
      at,
      nodeId,
      chatId
    )
    db.prepare('DELETE FROM library_link WHERE node_id = ? AND chat_id = ?').run(nodeId, chatId)
  } else {
    nodeId = newId('node_')
    replaced = false
    db.prepare(
      `INSERT INTO library_node (id, chat_id, title, title_key, body, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(nodeId, chatId, input.title, tKey, input.body, at, at)
  }

  const insertLink = db.prepare(
    'INSERT INTO library_link (node_id, chat_id, target_title, target_key) VALUES (?, ?, ?, ?)'
  )
  for (const link of links) {
    insertLink.run(nodeId, chatId, link.title, link.key)
  }

  db.prepare('DELETE FROM library_fts WHERE node_id = ? AND chat_id = ?').run(nodeId, chatId)
  db.prepare('INSERT INTO library_fts (node_id, chat_id, text) VALUES (?, ?, ?)').run(
    nodeId,
    chatId,
    `${input.title} ${input.body}`
  )

  return { nodeId, replaced, links: links.map((l) => l.title) }
}

export function openNode(
  storage: Storage,
  chatId: string,
  title: string
): { title: string; body: string; links: { title: string; exists: boolean }[]; linkedFrom: string[] } | undefined {
  const tKey = keyOf(title)
  return storage.read((db) => {
    const node = db
      .prepare('SELECT id, title, body FROM library_node WHERE chat_id = ? AND title_key = ?')
      .get(chatId, tKey) as { id: string; title: string; body: string } | undefined
    if (!node) return undefined

    const linkRows = db
      .prepare(
        `SELECT l.target_title AS title, CASE WHEN target.id IS NOT NULL THEN 1 ELSE 0 END AS exists_flag
         FROM library_link l
         LEFT JOIN library_node target ON target.chat_id = l.chat_id AND target.title_key = l.target_key
         WHERE l.node_id = ? AND l.chat_id = ?
         ORDER BY l.target_key ASC`
      )
      .all(node.id, chatId) as { title: string; exists_flag: number }[]

    const backlinkRows = db
      .prepare(
        `SELECT n.title
         FROM library_link l
         JOIN library_node n ON n.id = l.node_id AND n.chat_id = l.chat_id
         WHERE l.chat_id = ? AND l.target_key = ? AND n.chat_id = ?
         ORDER BY n.title_key ASC`
      )
      .all(chatId, tKey, chatId) as { title: string }[]

    return {
      title: node.title,
      body: node.body,
      links: linkRows.map((r) => ({ title: r.title, exists: r.exists_flag === 1 })),
      linkedFrom: backlinkRows.map((r) => r.title)
    }
  })
}

export function searchLibrary(
  storage: Storage,
  chatId: string,
  query: string,
  limit: number
): { title: string; excerpt: string; via?: string }[] {
  if (limit <= 0) return []
  const fts = ftsQuery(query)
  if (!fts) return []

  return storage.read((db) => {
    const matches = db
      .prepare(
        `SELECT library_node.id, library_node.title, library_node.body
         FROM library_fts
         JOIN library_node
           ON library_node.id = library_fts.node_id
          AND library_node.chat_id = library_fts.chat_id
         WHERE library_fts MATCH ?
           AND library_fts.chat_id = ?
           AND library_node.chat_id = ?
         ORDER BY bm25(library_fts)
         LIMIT ?`
      )
      .all(fts, chatId, chatId, limit) as { id: string; title: string; body: string }[]

    const results: { title: string; excerpt: string; via?: string }[] = []
    const seenIds = new Set<string>()
    for (const row of matches) {
      seenIds.add(row.id)
      results.push({ title: row.title, excerpt: row.body.slice(0, 300) })
    }

    if (results.length < limit && matches.length > 0) {
      const linkedStmt = db.prepare(
        `SELECT target.id, target.title, target.body
         FROM library_link l
         JOIN library_node target
           ON target.chat_id = l.chat_id
          AND target.title_key = l.target_key
         WHERE l.node_id = ? AND l.chat_id = ? AND target.chat_id = ?
         ORDER BY target.title_key ASC`
      )
      for (const match of matches) {
        const linked = linkedStmt.all(match.id, chatId, chatId) as { id: string; title: string; body: string }[]
        for (const row of linked) {
          if (seenIds.has(row.id)) continue
          seenIds.add(row.id)
          results.push({ title: row.title, excerpt: row.body.slice(0, 300), via: match.title })
          if (results.length >= limit) break
        }
        if (results.length >= limit) break
      }
    }

    return results
  })
}

export function libraryGaps(
  storage: Storage,
  chatId: string,
  limit: number
): {
  missingNotes: { title: string; linkedFrom: string[] }[]
  wordsWithoutMeaning: { kind: WordKind; word: string }[]
} {
  if (limit <= 0) {
    return { missingNotes: [], wordsWithoutMeaning: [] }
  }
  return storage.read((db) => {
    const missingRows = db
      .prepare(
        `SELECT l.target_title, l.target_key, n.title AS source_title
         FROM library_link l
         JOIN library_node n ON n.id = l.node_id AND n.chat_id = l.chat_id
         LEFT JOIN library_node target ON target.chat_id = l.chat_id AND target.title_key = l.target_key
         WHERE l.chat_id = ? AND n.chat_id = ? AND target.id IS NULL
         ORDER BY l.target_key ASC, n.title_key ASC`
      )
      .all(chatId, chatId) as { target_title: string; target_key: string; source_title: string }[]

    const missingMap = new Map<string, { title: string; linkedFrom: string[] }>()
    for (const row of missingRows) {
      let entry = missingMap.get(row.target_key)
      if (!entry) {
        if (missingMap.size >= limit) break
        entry = { title: row.target_title, linkedFrom: [] }
        missingMap.set(row.target_key, entry)
      }
      entry.linkedFrom.push(row.source_title)
    }

    const wordsWithoutMeaning = db
      .prepare(
        `SELECT kind, word
         FROM lesson_word
         WHERE chat_id = ? AND meaning = ''
         ORDER BY word_key ASC, kind ASC
         LIMIT ?`
      )
      .all(chatId, limit) as { kind: WordKind; word: string }[]

    return {
      missingNotes: [...missingMap.values()],
      wordsWithoutMeaning
    }
  })
}

const CANDIDATE_TTL_MS = 24 * 60 * 60 * 1000

export function storeCandidates(
  db: Db,
  chatId: string,
  provider: string,
  results: { ref: string; title: string; artist: string }[],
  now: Clock = wallClock
): { id: string; title: string; artist: string }[] {
  const nowDate = now()
  const cutoff = new Date(nowDate.getTime() - CANDIDATE_TTL_MS).toISOString()
  db.prepare('DELETE FROM lesson_lyrics_candidate WHERE chat_id = ? AND created_at < ?').run(chatId, cutoff)

  const at = nowDate.toISOString()
  const insert = db.prepare(
    `INSERT INTO lesson_lyrics_candidate (id, chat_id, provider, ref, title, artist, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
  const stored: { id: string; title: string; artist: string }[] = []
  for (const item of results) {
    const id = newId('cand_')
    insert.run(id, chatId, provider, item.ref, item.title, item.artist, at)
    stored.push({ id, title: item.title, artist: item.artist })
  }
  return stored
}

export function getCandidate(
  storage: Storage,
  chatId: string,
  candidateId: string
): { provider: string; ref: string; title: string; artist: string } | undefined {
  return storage.read((db) => {
    return db
      .prepare('SELECT provider, ref, title, artist FROM lesson_lyrics_candidate WHERE id = ? AND chat_id = ?')
      .get(candidateId, chatId) as { provider: string; ref: string; title: string; artist: string } | undefined
  })
}
