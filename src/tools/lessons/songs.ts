import { z } from 'zod'
import type { Storage } from '../../storage/database.js'
import type { ToolPorts } from '../ports.js'
import type { ToolDefinition } from '../types.js'
import { getCandidate, getSong, saveSong, storeCandidates } from './store.js'

const MAX_LYRICS_LINES = 200
const MAX_LINE_CHARS = 500
const MAX_CANDIDATES = 5

const lyricsSearchSchema = z.strictObject({
  query: z.string().trim().min(1).max(200)
})

const lyricsFetchSchema = z.strictObject({
  candidateId: z.string().trim().min(1).max(120)
})

const songGetSchema = z.strictObject({
  title: z.string().trim().min(1).max(120),
  artist: z.string().trim().max(120).optional()
})

const songSaveSchema = z.strictObject({
  title: z.string().trim().min(1).max(120),
  artist: z.string().trim().max(120).optional(),
  language: z.string().trim().max(40).optional(),
  candidateId: z.string().trim().min(1).max(120).optional(),
  lines: z
    .array(
      z.strictObject({
        text: z.string().trim().min(1).max(500),
        reading: z.string().trim().max(500).optional(),
        meaning: z.string().trim().max(500).optional()
      })
    )
    .min(1)
    .max(200),
  words: z
    .array(
      z.strictObject({
        kind: z.enum(['word', 'pattern']).optional(),
        word: z.string().trim().min(1).max(120),
        reading: z.string().trim().max(200).optional(),
        lines: z.array(z.number().int().min(1).max(200)).max(200).optional()
      })
    )
    .max(300)
    .optional()
})

export function lyricsSearchTool(
  storage: Storage,
  ports: ToolPorts
): ToolDefinition<z.infer<typeof lyricsSearchSchema>> {
  return {
    name: 'lyrics_search',
    description: 'Finds candidate lyrics for a song.',
    schema: lyricsSearchSchema,
    mode: 'both',
    mutates: false,
    feature: 'features.lessons',
    command: {
      names: ['lyrics'],
      kind: 'skill',
      usage: '/lyrics <song title or lyrics>'
    },
    async handler(args, context) {
      const lyrics = ports.lyrics
      if (!lyrics) {
        return { ok: false, kind: 'unavailable', reason: 'lyrics are not available' }
      }
      let raw: { ref: string; title: string; artist: string }[]
      try {
        raw = await lyrics.search(args.query, context.signal)
      } catch {
        return { ok: false, kind: 'unavailable', reason: 'the lyrics provider failed' }
      }
      const stored = storage.tx((db) =>
        storeCandidates(db, context.chat.chatId, lyrics.name, raw.slice(0, MAX_CANDIDATES), context.now)
      )
      return {
        ok: true,
        data: {
          untrusted: true,
          source: 'lyrics',
          candidates: stored.map((c) => ({ candidateId: c.id, title: c.title, artist: c.artist }))
        }
      }
    }
  }
}

export function lyricsFetchTool(storage: Storage, ports: ToolPorts): ToolDefinition<z.infer<typeof lyricsFetchSchema>> {
  return {
    name: 'lyrics_fetch',
    description: 'Fetches the lyrics of one search result.',
    schema: lyricsFetchSchema,
    mode: 'implicit',
    mutates: false,
    feature: 'features.lessons',
    async handler(args, context) {
      const candidate = getCandidate(storage, context.chat.chatId, args.candidateId)
      if (!candidate) {
        return { ok: false, kind: 'refused', reason: 'no such search result in this chat' }
      }
      const lyrics = ports.lyrics
      if (!lyrics) {
        return { ok: false, kind: 'unavailable', reason: 'lyrics are not available' }
      }
      let fetched: { title: string; artist: string; lines: string[] }
      try {
        fetched = await lyrics.fetch(candidate.ref, context.signal)
      } catch {
        return { ok: false, kind: 'unavailable', reason: 'the lyrics provider failed' }
      }
      let truncated = fetched.lines.length > MAX_LYRICS_LINES
      const lines = fetched.lines.slice(0, MAX_LYRICS_LINES).map((line) => {
        if (line.length > MAX_LINE_CHARS) {
          truncated = true
          return line.slice(0, MAX_LINE_CHARS)
        }
        return line
      })
      return {
        ok: true,
        data: {
          untrusted: true,
          source: 'lyrics',
          title: fetched.title,
          artist: fetched.artist,
          lines,
          truncated
        }
      }
    }
  }
}

export function songGetTool(storage: Storage): ToolDefinition<z.infer<typeof songGetSchema>> {
  return {
    name: 'song_get',
    description: 'Fetches one filed song with its readings.',
    schema: songGetSchema,
    mode: 'both',
    mutates: false,
    feature: 'features.lessons',
    command: {
      names: ['song'],
      kind: 'skill',
      usage: '/song <title>'
    },
    handler(args, context) {
      const song = getSong(storage, context.chat.chatId, args.title, args.artist)
      if (song === undefined) {
        return { ok: false, kind: 'refused', reason: 'no such song in this chat' }
      }
      if (song === 'ambiguous') {
        return { ok: false, kind: 'invalid', reason: 'more than one song has that title: give the artist' }
      }
      return { ok: true, data: song }
    }
  }
}

export function songSaveTool(storage: Storage): ToolDefinition<z.infer<typeof songSaveSchema>> {
  return {
    name: 'song_save',
    description: 'Files one worked song as study notes.',
    schema: songSaveSchema,
    mode: 'implicit',
    mutates: true,
    feature: 'features.lessons',
    handler(args, context) {
      let source = ''
      if (args.candidateId !== undefined) {
        const candidate = getCandidate(storage, context.chat.chatId, args.candidateId)
        if (!candidate) {
          return { ok: false, kind: 'refused', reason: 'no such search result in this chat' }
        }
        source = `${candidate.provider}:${candidate.ref}`
      }

      const { data } = context.commit((db) => {
        const saved = saveSong(
          db,
          context.chat.chatId,
          {
            title: args.title,
            artist: args.artist ?? '',
            language: args.language ?? '',
            source,
            lines: args.lines.map((line) => ({
              text: line.text,
              reading: line.reading ?? '',
              meaning: line.meaning ?? ''
            })),
            words: (args.words ?? []).map((w) => ({
              kind: w.kind ?? 'word',
              word: w.word,
              reading: w.reading ?? '',
              lines: w.lines ?? []
            }))
          },
          context.now
        )
        const result = {
          songId: saved.songId,
          replaced: saved.replaced,
          lines: args.lines.length,
          words: saved.words
        }
        return {
          data: result,
          receipt: {
            kind: 'lesson.song_saved',
            target: saved.songId,
            state: { replaced: saved.replaced, lines: args.lines.length, words: saved.words }
          }
        }
      })

      return { ok: true, data }
    }
  }
}
