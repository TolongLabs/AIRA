import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { activeFact, addNote, applyOperation, lingoKey, normaliseKey, setLingo, setSource } from '../memory/store.js'
import { MAX_VALUE_CHARS, RESERVED_KEY_PREFIXES } from '../memory/types.js'
import { ensureSubject, getChatByWaId } from '../settings/chats.js'
import { openDatabase, type Storage } from '../storage/database.js'
import {
  type BackupManifest,
  backupSources,
  manifestOf,
  type ReadResult,
  readLegacyExport,
  type SourceRef
} from './legacy.js'

// The one-time memory migration (docs/trd/memory.md#migration): back up, read, map, dry run, review, import.
// It runs with the core stopped, as the only process on the database, and imports in one transaction.

/** The mark on every imported row: the job a memory row names as its source. */
export const IMPORT_SOURCE = 'legacy_import'

export type Outcome = 'kept' | 'merged' | 'rejected' | 'unassigned'

export interface ReportLine extends SourceRef {
  outcome: Outcome
  /** A reason code. Never text of the record. */
  reason?: string
}

export interface ImportReport {
  dryRun: boolean
  /** The checksum of the inputs this report was made from. The real run must see the same inputs. */
  inputDigest: string
  files: number
  lines: number
  counts: Record<Outcome, number>
  reasons: Record<string, number>
  detail: ReportLine[]
}

const time = (value: string | undefined): number => (value === undefined ? 0 : Date.parse(value))

/**
 * Imports the records into one database, in one transaction. A record without a known chat is never imported:
 * it is `unassigned`, for review. The same input imported twice changes nothing the second time.
 */
export function importRecords(storage: Storage, read: ReadResult, now: () => Date = () => new Date()): ReportLine[] {
  const detail: ReportLine[] = read.rejects.map(({ source, line, reason }) => ({
    source,
    line,
    outcome: 'rejected',
    reason
  }))
  // Oldest first, so the newest value of a slot is the one that stays active.
  const ordered = [...read.records].sort((a, b) => time(a.record.updatedAt) - time(b.record.updatedAt))

  storage.tx((db) => {
    /** The rows this run made, by item id: a later record may replace them. A fact the new core learned may not be. */
    const mine = new Map<string, SourceRef>()
    const lineOf = new Map<SourceRef, ReportLine>()
    const mark = (ref: SourceRef, outcome: Outcome, reason?: string): void => {
      const entry: ReportLine = { source: ref.source, line: ref.line, outcome, ...(reason ? { reason } : {}) }
      lineOf.set(ref, entry)
      detail.push(entry)
    }

    for (const entry of ordered) {
      const { record } = entry
      const ref: SourceRef = entry
      if (record.chat === undefined) {
        mark(ref, 'unassigned', 'no_chat')
        continue
      }
      const chat = getChatByWaId(storage, record.chat)
      if (!chat) {
        mark(ref, 'unassigned', 'unknown_chat')
        continue
      }
      const text = record.text.trim()
      if (text === '') {
        mark(ref, 'rejected', 'empty_text')
        continue
      }
      if (text.length > MAX_VALUE_CHARS) {
        // Never cut a memory short without saying so.
        mark(ref, 'rejected', 'too_long')
        continue
      }
      const subjectId = record.subject === undefined ? undefined : ensureSubject(storage, record.subject, now)

      // The slot the record goes to: a chat word, a fact with a usable key, or none.
      let slotKey: string | undefined
      if (record.kind === 'lingo') {
        slotKey = record.key === undefined ? undefined : lingoKey(record.key)
        if (slotKey === undefined) {
          mark(ref, 'rejected', record.key === undefined ? 'no_word' : 'invalid_word')
          continue
        }
      } else if (record.kind === 'fact' && record.key !== undefined) {
        const key = normaliseKey(record.key)
        if (key !== undefined && !RESERVED_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) slotKey = key
      }

      if (slotKey === undefined) {
        // A note, or a fact with no usable slot: kept as a note of the person, word for word.
        if (subjectId === undefined) {
          mark(ref, 'rejected', 'no_subject')
          continue
        }
        const note = addNote(db, chat.chatId, { subjectId, text }, now)
        if (note.effect === 'added') {
          setSource(db, chat.chatId, note.itemId, IMPORT_SOURCE)
          mark(ref, 'kept', record.kind === 'fact' ? 'kept_as_note' : undefined)
        } else {
          mark(ref, 'merged', 'duplicate')
        }
        continue
      }

      // A chat word is about the chat, whoever the old store filed it under.
      const slotSubject = record.kind === 'lingo' ? undefined : subjectId
      const existing = activeFact(db, chat.chatId, slotSubject, slotKey)
      if (existing && !mine.has(existing.id)) {
        // The new core already learned this slot, or an earlier run imported it. The stored fact stays.
        mark(ref, 'merged', existing.sourceJob === IMPORT_SOURCE ? 'already_imported' : 'newer_exists')
        continue
      }
      let itemId: string
      if (record.kind === 'lingo') {
        itemId = setLingo(db, chat.chatId, { word: record.key as string, meaning: text }, now)
      } else {
        const outcome = applyOperation(
          db,
          chat.chatId,
          {
            op: 'add',
            ...(slotSubject === undefined ? {} : { subjectId: slotSubject }),
            key: slotKey,
            value: text,
            quote: ''
          },
          { jobId: IMPORT_SOURCE },
          now
        )
        if (!outcome.accepted) {
          mark(ref, 'rejected', outcome.reason)
          continue
        }
        itemId = outcome.itemId
      }
      if (existing && itemId === existing.id) {
        mark(ref, 'merged', 'duplicate')
        continue
      }
      if (existing) {
        // An older record of the same slot, kept a moment ago, is now the superseded version.
        const older = lineOf.get(mine.get(existing.id) as SourceRef)
        if (older) {
          older.outcome = 'merged'
          older.reason = 'older_version'
        }
      }
      setSource(db, chat.chatId, itemId, IMPORT_SOURCE)
      mine.set(itemId, ref)
      mark(ref, 'kept')
    }
  })
  return detail.sort((a, b) => a.source.localeCompare(b.source) || a.line - b.line)
}

export function buildReport(
  detail: ReportLine[],
  read: ReadResult,
  manifest: BackupManifest,
  dryRun: boolean
): ImportReport {
  const counts: Record<Outcome, number> = { kept: 0, merged: 0, rejected: 0, unassigned: 0 }
  const reasons: Record<string, number> = {}
  for (const line of detail) {
    counts[line.outcome] += 1
    if (line.reason) reasons[`${line.outcome}:${line.reason}`] = (reasons[`${line.outcome}:${line.reason}`] ?? 0) + 1
  }
  return {
    dryRun,
    inputDigest: manifest.digest,
    files: read.files.length,
    lines: detail.length,
    counts,
    reasons,
    detail
  }
}

export function formatReport(report: ImportReport): string {
  const lines = [
    `memory migration: ${report.dryRun ? 'DRY RUN, nothing was imported' : 'IMPORTED'}`,
    `inputs: ${report.files} files, ${report.lines} lines, checksum ${report.inputDigest.slice(0, 16)}`,
    `kept ${report.counts.kept}, merged ${report.counts.merged}, rejected ${report.counts.rejected}, unassigned ${report.counts.unassigned}`,
    'by reason:',
    ...Object.entries(report.reasons)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([reason, count]) => `  ${reason}: ${count}`),
    'not imported:',
    ...report.detail
      .filter((line) => line.outcome === 'rejected' || line.outcome === 'unassigned')
      .map((line) => `  ${line.source}:${line.line} ${line.outcome} ${line.reason ?? ''}`.trimEnd())
  ]
  return lines.join('\n')
}

export interface MigrationOptions {
  /** The folder of the legacy export. It is read and copied, never changed. */
  from: string
  /** A private folder for the backup, the reject file, the review file and the report. Never inside the repository. */
  out: string
  /** The live database file. */
  databaseFile: string
  /** The explicit confirmation of the real run. Without it, the run is a dry run. */
  confirm?: boolean
  now?: () => Date
}

/**
 * Steps 1 to 6. A dry run imports into a scratch copy of the database and deletes it. The real run needs the
 * confirmation and a dry-run report of the same inputs in the same output folder.
 */
export async function runMigration(options: MigrationOptions): Promise<ImportReport> {
  const now = options.now ?? (() => new Date())
  mkdirSync(options.out, { recursive: true, mode: 0o700 })
  const reportFile = join(options.out, 'report.json')
  const before = manifestOf(options.from)

  if (options.confirm) {
    let reviewed: ImportReport | undefined
    try {
      reviewed = JSON.parse(readFileSync(reportFile, 'utf8')) as ImportReport
    } catch {
      throw new Error('no dry-run report in the output folder: run without --confirm first and read the report')
    }
    if (reviewed.inputDigest !== before.digest) {
      throw new Error('the old stores changed since the dry run: run the dry run again and read the new report')
    }
  }

  // 1. Back up, with checksums. 2. Read. Rejects and unassigned lines go to private files, word for word.
  const manifest = backupSources(options.from, join(options.out, 'backup'))
  const read = readLegacyExport(options.from)
  const private_ = { mode: 0o600 } as const
  writeFileSync(
    join(options.out, 'rejects.ndjson'),
    read.rejects.map((reject) => JSON.stringify(reject)).join('\n'),
    private_
  )

  const live = openDatabase(options.databaseFile)
  let detail: ReportLine[]
  try {
    if (options.confirm) {
      detail = importRecords(live, read, now)
    } else {
      // 4. Dry run: the same import, into a scratch copy that is then deleted.
      const scratchFile = join(options.out, 'scratch.db')
      for (const suffix of ['', '-wal', '-shm']) rmSync(scratchFile + suffix, { force: true })
      await live.backup(scratchFile)
      const scratch = openDatabase(scratchFile)
      try {
        detail = importRecords(scratch, read, now)
      } finally {
        scratch.close()
        for (const suffix of ['', '-wal', '-shm']) rmSync(scratchFile + suffix, { force: true })
      }
    }
  } finally {
    live.close()
  }

  const unassigned = new Set(
    detail.filter((line) => line.outcome === 'unassigned').map((line) => `${line.source}:${line.line}`)
  )
  writeFileSync(
    join(options.out, 'review.ndjson'),
    read.records
      .filter((entry) => unassigned.has(`${entry.source}:${entry.line}`))
      .map((entry) => JSON.stringify(entry))
      .join('\n'),
    private_
  )

  // The old stores are only read: they must be exactly as they were.
  if (manifestOf(options.from).digest !== before.digest) throw new Error('the old stores changed during the migration')

  const report = buildReport(detail, read, manifest, !options.confirm)
  writeFileSync(
    options.confirm ? join(options.out, 'import-report.json') : reportFile,
    JSON.stringify(report, null, 2),
    private_
  )
  writeFileSync(
    join(options.out, options.confirm ? 'import-report.txt' : 'report.txt'),
    `${formatReport(report)}\n`,
    private_
  )
  return report
}
