import type { Storage } from '../storage/database.js'
import type { ReplyCleaner } from '../turn/types.js'

// The delivery step for files (docs/trd/tools.md#atomic-tools, rule 4). A tool that makes a file does not send
// it: its receipt names the file, and this step attaches it to the reply as a MEDIA line.

const FILE_PATH = /^[0-9a-f]{2}\/[0-9a-f]{64}(\.[a-z0-9]{1,8})?$/

/** The files the receipts of one turn name, as paths the gateway can read on the host. */
export function attachmentsOf(
  storage: Storage,
  input: { chatId: string; receiptIds: readonly string[]; hostDataDir: string }
): string[] {
  if (input.receiptIds.length === 0) return []
  const states = storage.read((db) => {
    const find = db.prepare('SELECT state FROM receipt WHERE receipt_id = ? AND chat_id = ?').pluck()
    return input.receiptIds.map((id) => find.get(id, input.chatId) as string | null | undefined)
  })
  const paths: string[] = []
  for (const state of states) {
    if (typeof state !== 'string') continue
    const attachment = (JSON.parse(state) as { attachment?: unknown }).attachment
    // The path is the content-addressed name the storage layer gave the file. Nothing else is attached.
    if (typeof attachment === 'string' && FILE_PATH.test(attachment)) {
      paths.push(`${input.hostDataDir.replace(/\/+$/, '')}/files/${attachment}`)
    }
  }
  return [...new Set(paths)]
}

/** Wraps a cleaner: after the reply is cleaned, adds one MEDIA line for each file this turn's receipts name. */
export function withAttachments(
  cleaner: ReplyCleaner,
  options: { storage: Storage; hostDataDir: string }
): ReplyCleaner {
  return {
    clean(input) {
      const cleaned = cleaner.clean(input)
      if (cleaned.content === '' || cleaned.replacedBy) return cleaned
      let paths: string[]
      try {
        paths = attachmentsOf(options.storage, {
          chatId: input.context.chat.chatId,
          receiptIds: input.run.receipts,
          hostDataDir: options.hostDataDir
        })
      } catch {
        return cleaned
      }
      if (paths.length === 0) return cleaned
      return {
        ...cleaned,
        content: [cleaned.content, ...paths.map((path) => `MEDIA:${path}`)].join('\n'),
        attachments: [...(cleaned.attachments ?? []), ...paths]
      }
    }
  }
}
