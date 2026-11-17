import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LegacyRecord } from './legacy.js'

// The readers of the old memory stores (docs/trd/memory.md#migration). They read a copy of the old brain folder
// and turn it into the legacy export the import reads. They never write into the folder they read, and they report
// counts only: no text leaves the private folder.

/** Why a line of an old store did not become an export line. */
export type SkipReason =
  | 'folder_not_a_chat'
  | 'fact_unreadable'
  | 'fact_empty'
  | 'fact_expired'
  | 'lingo_unreadable'
  | 'lingo_unconfirmed'
  | 'lingo_empty'

export interface ExportResult {
  facts: LegacyRecord[]
  lingo: LegacyRecord[]
  skipped: Partial<Record<SkipReason, number>>
  /** Lines that could not be read, word for word, for the private reject file. */
  rejects: { source: string; line: number; reason: SkipReason; raw: string }[]
  chats: number
}

const SUFFIXES = ['s.whatsapp.net', 'g.us', 'c.us', 'lid'] as const

/** A chat folder's name back to the WhatsApp id: the old store wrote `@` as `.`. */
export function waIdOfFolder(name: string): string | undefined {
  for (const suffix of SUFFIXES) {
    if (name.endsWith(`.${suffix}`) && name.length > suffix.length + 1) {
      return `${name.slice(0, -suffix.length - 1)}@${suffix}`
    }
  }
  return undefined
}

/** A person's id as the old store kept it: bare digits are a LID (Assumption A-9), a folder-style id is mapped back. */
export function waIdOfPerson(value: string): string | undefined {
  const text = value.trim()
  if (/^\d+$/.test(text)) return `${text}@lid`
  return waIdOfFolder(text)
}

const isoOfSeconds = (value: unknown): string | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? new Date(value * 1000).toISOString() : undefined

function chatFolders(root: string): { kind: 'dm' | 'group'; folder: string; path: string }[] {
  const found: { kind: 'dm' | 'group'; folder: string; path: string }[] = []
  for (const kind of ['dm', 'group'] as const) {
    const dir = join(root, kind, 'whatsapp')
    if (!existsSync(dir)) continue
    for (const folder of readdirSync(dir).sort()) {
      const path = join(dir, folder)
      if (statSync(path).isDirectory()) found.push({ kind, folder, path })
    }
  }
  return found
}

/** Reads the per-chat fact files and the confirmed words under a copy of the old brain folder. */
export function readOldBrain(root: string, now: Date = new Date()): ExportResult {
  const result: ExportResult = { facts: [], lingo: [], skipped: {}, rejects: [], chats: 0 }
  const skip = (reason: SkipReason) => {
    result.skipped[reason] = (result.skipped[reason] ?? 0) + 1
  }

  for (const { kind, folder, path } of chatFolders(root)) {
    const chat = waIdOfFolder(folder)
    if (!chat) {
      skip('folder_not_a_chat')
      continue
    }
    result.chats++

    const facts = join(path, 'memories.jsonl')
    if (existsSync(facts)) {
      const source = `${kind}/whatsapp/${folder}/memories.jsonl`
      readFileSync(facts, 'utf8')
        .split('\n')
        // biome-ignore lint/suspicious/useIterableCallbackReturn: kept as written in the Biome 2 bump; behaviour unchanged
        .forEach((raw, index) => {
          if (raw.trim() === '') return
          let entry: Record<string, unknown>
          try {
            entry = JSON.parse(raw) as Record<string, unknown>
          } catch {
            skip('fact_unreadable')
            result.rejects.push({ source, line: index + 1, reason: 'fact_unreadable', raw })
            return
          }
          const text = typeof entry['text'] === 'string' ? entry['text'].trim() : ''
          if (text === '') return skip('fact_empty')
          const until = typeof entry['until'] === 'string' ? Date.parse(entry['until']) : Number.NaN
          if (Number.isFinite(until) && until <= now.getTime()) return skip('fact_expired')
          const about = typeof entry['about_id'] === 'string' ? waIdOfPerson(entry['about_id']) : undefined
          // In a DM the chat is the person. In a group a fact with no person is about no one the import can name.
          const subject = about ?? (kind === 'dm' ? chat : undefined)
          const updatedAt = isoOfSeconds(entry['ts'])
          result.facts.push({
            kind: 'fact',
            chat,
            ...(subject ? { subject } : {}),
            text,
            ...(updatedAt ? { updatedAt } : {})
          })
        })
    }

    const lingo = join(path, 'lingo.json')
    if (existsSync(lingo)) {
      const raw = readFileSync(lingo, 'utf8')
      let words: unknown[]
      try {
        const body = JSON.parse(raw) as { words?: unknown }
        if (!Array.isArray(body.words)) throw new Error('no words')
        words = body.words
      } catch {
        skip('lingo_unreadable')
        result.rejects.push({
          source: `${kind}/whatsapp/${folder}/lingo.json`,
          line: 1,
          reason: 'lingo_unreadable',
          raw
        })
        continue
      }
      for (const word of words as Record<string, unknown>[]) {
        if (word?.['confirmed'] !== true) {
          skip('lingo_unconfirmed')
          continue
        }
        const key = typeof word['term'] === 'string' ? word['term'].trim() : ''
        const text = typeof word['meaning'] === 'string' ? word['meaning'].trim() : ''
        if (key === '' || text === '') {
          skip('lingo_empty')
          continue
        }
        const updatedAt = isoOfSeconds(word['last_seen'])
        result.lingo.push({ kind: 'lingo', chat, key, text, ...(updatedAt ? { updatedAt } : {}) })
      }
    }
  }
  return result
}

const ndjson = (lines: unknown[]): string => lines.map((line) => `${JSON.stringify(line)}\n`).join('')

/** Writes the export and the reject file into a private folder. Returns the files it wrote. */
export function writeExport(out: string, result: ExportResult): string[] {
  mkdirSync(out, { recursive: true, mode: 0o700 })
  const files: [string, unknown[]][] = [
    ['facts.ndjson', result.facts],
    ['lingo.ndjson', result.lingo]
  ]
  for (const [name, lines] of files) writeFileSync(join(out, name), ndjson(lines), { mode: 0o600 })
  // The rejects are not `.ndjson`, so the import does not read them as export lines.
  writeFileSync(join(out, 'export-rejects.jsonl'), ndjson(result.rejects), { mode: 0o600 })
  return [...files.map(([name]) => name), 'export-rejects.jsonl']
}
