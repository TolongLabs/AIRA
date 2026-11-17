import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { z } from 'zod'

// Reading the old memory for the one-time migration (docs/trd/memory.md#migration). The old stores are only ever
// read and copied. Nothing here writes into the folder it reads.

/**
 * One line of a legacy export: one remembered thing, with the WhatsApp ids the old store knew it by. A reader for
 * each old store turns that store into these lines; the import works on them alone.
 */
export const legacyRecord = z.strictObject({
  kind: z.enum(['fact', 'note', 'lingo']),
  /** The WhatsApp id of the chat the old store kept it under. Absent: the old store did not say. */
  chat: z.string().min(1).optional(),
  /** The WhatsApp id of the person it is about. Absent: about the chat itself. */
  subject: z.string().min(1).optional(),
  /** The slot of a fact, or the word of a chat's own word. */
  key: z.string().min(1).optional(),
  text: z.string(),
  updatedAt: z.iso.datetime({ offset: true }).optional()
})
export type LegacyRecord = z.infer<typeof legacyRecord>

export interface SourceRef {
  /** The file, relative to the folder that was read. */
  source: string
  line: number
}

export interface ReadResult {
  files: string[]
  records: (SourceRef & { record: LegacyRecord })[]
  /** Lines that could not be read. The raw line is kept, for the reject file: nothing is dropped. */
  rejects: (SourceRef & { reason: 'not_json' | 'invalid_record'; raw: string })[]
}

function walk(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const path = join(dir, name)
      return statSync(path).isDirectory() ? walk(path) : [path]
    })
}

/** Reads every `.ndjson` file under a folder, in name order. A line that fails to parse is a reject, never a loss. */
export function readLegacyExport(dir: string): ReadResult {
  const result: ReadResult = { files: [], records: [], rejects: [] }
  for (const path of walk(dir).filter((file) => file.endsWith('.ndjson'))) {
    const source = relative(dir, path)
    result.files.push(source)
    readFileSync(path, 'utf8')
      .split('\n')
      .forEach((raw, index) => {
        if (raw.trim() === '') return
        const ref = { source, line: index + 1 }
        let value: unknown
        try {
          value = JSON.parse(raw)
        } catch {
          result.rejects.push({ ...ref, reason: 'not_json', raw })
          return
        }
        const parsed = legacyRecord.safeParse(value)
        if (parsed.success) result.records.push({ ...ref, record: parsed.data })
        else result.rejects.push({ ...ref, reason: 'invalid_record', raw })
      })
  }
  return result
}

const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')

export interface BackupManifest {
  /** `<sha256>  <relative path>` lines, in name order. */
  lines: string[]
  /** One checksum over the whole manifest: the same inputs give the same value. */
  digest: string
}

/** The checksums of every file under a folder. */
export function manifestOf(dir: string): BackupManifest {
  const lines = walk(dir).map((path) => `${sha256(path)}  ${relative(dir, path)}`)
  return { lines, digest: createHash('sha256').update(lines.join('\n')).digest('hex') }
}

/**
 * Copies every file under `from` into `to`, writes `SHA256SUMS` beside the copies, and checks each copy against
 * its source. Throws when a copy differs. The source folder is not changed.
 */
export function backupSources(from: string, to: string): BackupManifest {
  const manifest = manifestOf(from)
  for (const path of walk(from)) {
    const target = join(to, relative(from, path))
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
    copyFileSync(path, target)
    if (sha256(target) !== sha256(path)) throw new Error(`backup copy differs from its source: ${relative(from, path)}`)
  }
  mkdirSync(to, { recursive: true, mode: 0o700 })
  writeFileSync(join(to, 'SHA256SUMS'), `${manifest.lines.join('\n')}\n`, { mode: 0o600 })
  return manifest
}
