import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { Db } from '../storage/database.js'

const MAX_BYTES = 5_242_880
const HASH = /^[a-f0-9]{64}$/

interface ReceiptFile {
  target: string
  state: string
  result: string
  path: string
  bytes: number
}

export type ReportDocumentMetadata = {
  sha256: string
} & ({ mime: 'application/pdf'; filename: 'report.pdf' } | { mime: 'text/markdown'; filename: 'report.md' })
export type ReportDocument = ReportDocumentMetadata & { data: Buffer }

function ownedBytes(root: string, path: string, size: number): Buffer | null {
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_BYTES) return null
  const absoluteRoot = resolve(root)
  const absolute = join(absoluteRoot, path)
  try {
    if (realpathSync(absoluteRoot) !== absoluteRoot || realpathSync(dirname(absolute)) !== dirname(absolute))
      return null
    for (const directory of [absoluteRoot, dirname(absolute)]) {
      const entry = lstatSync(directory)
      if (!entry.isDirectory() || (process.getuid && entry.uid !== process.getuid())) return null
    }
    const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const info = fstatSync(fd)
      if (!info.isFile() || info.size !== size || (process.getuid && info.uid !== process.getuid())) return null
      const data = Buffer.alloc(size + 1)
      let read = 0
      while (read < data.length) {
        const count = readSync(fd, data, read, data.length - read, null)
        if (count === 0) break
        read += count
      }
      return read === size ? data.subarray(0, size) : null
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

function validateFile(filesDir: string, row: ReceiptFile): ReportDocument | null {
  if (!HASH.test(row.target)) return null
  const prefix = `${row.target.slice(0, 2)}/${row.target}`
  if (row.path !== `${prefix}.pdf` && row.path !== `${prefix}.md`) return null
  try {
    const result: unknown = JSON.parse(row.result)
    const state: unknown = JSON.parse(row.state)
    if (typeof result !== 'object' || result === null || !('ok' in result) || result.ok !== true) return null
    if (
      typeof state !== 'object' ||
      state === null ||
      !('attachment' in state) ||
      state.attachment !== row.path ||
      Object.keys(state).length !== 1
    )
      return null
  } catch {
    return null
  }
  const data = ownedBytes(filesDir, row.path, row.bytes)
  if (!data || createHash('sha256').update(data).digest('hex') !== row.target) return null
  if (row.path.endsWith('.pdf')) {
    if (!data.subarray(0, 5).equals(Buffer.from('%PDF-'))) return null
    return { sha256: row.target, data, mime: 'application/pdf', filename: 'report.pdf' }
  }
  try {
    if (new TextDecoder('utf-8', { fatal: true }).decode(data).includes('\0')) return null
  } catch {
    return null
  }
  return { sha256: row.target, data, mime: 'text/markdown', filename: 'report.md' }
}

/** The private report receipt, never reply text or a caller-supplied path, authorizes document bytes. */
export function readStandaloneReport(
  db: Db,
  filesDir: string,
  input: { chatId: string; turnId: string; sha256?: string }
): ReportDocument | null {
  const rows = db
    .prepare(
      `SELECT r.target, r.state, tr.result, f.path, f.bytes
     FROM receipt r
     JOIN tool_result tr ON tr.call_id = r.call_id AND tr.turn_id = r.turn_id AND tr.chat_id = r.chat_id AND tr.tool = r.tool
     JOIN file f ON f.sha256 = r.target AND f.kind = 'report'
     WHERE r.chat_id = ? AND r.turn_id = ? AND r.tool = 'make_report' AND r.kind = 'report.created'
       AND (? IS NULL OR r.target = ?)
     ORDER BY r.created_at, r.receipt_id`
    )
    .iterate(input.chatId, input.turnId, input.sha256 ?? null, input.sha256 ?? null) as Iterable<ReceiptFile>
  for (const row of rows) {
    const document = validateFile(filesDir, row)
    if (document) return document
  }
  return null
}
