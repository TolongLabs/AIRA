import { join } from 'node:path'
import type { Config } from '../config/schema.js'
import { type ReportDocument, type ReportFormat, reportDocumentSchema, reportFormatSchema } from '../render/types.js'
import type { Storage } from '../storage/database.js'
import { putFile } from '../storage/files.js'
import type { TurnContext } from '../turn/types.js'

export const ACCEPT_WORDS = [
  'yes',
  'y',
  'ya',
  'yeah',
  'yep',
  'ok',
  'okay',
  'sure',
  'please',
  'boleh',
  'pdf',
  '好',
  '要'
] as const
export const DECLINE_WORDS = ['no', 'nope', 'nah', 'tak', '不用'] as const
const accept = new RegExp(
  `^(?:${ACCEPT_WORDS.join('|')})(?:[\\p{P}\\p{Extended_Pictographic}\\s\\uFE0F\\u200D]|\\p{Emoji_Modifier})*$`,
  'iu'
)

export function offerAnswer(text: string): 'accepted' | 'declined' | undefined {
  const whole = text.trim().toLowerCase()
  if (whole === '/pdf' || accept.test(whole)) return 'accepted'
  if ((DECLINE_WORDS as readonly string[]).includes(whole)) return 'declined'
  return undefined
}

export interface ResearchRow {
  job_id: string
  chat_id: string
  requester_id: string
  topic: string
  wants_pdf: number
  state: 'queued' | 'running' | 'done' | 'failed'
  findings: string | null
  report_file_id: string | null
  offer: 'none' | 'open' | 'accepted' | 'declined' | 'expired'
  offer_expires_at: string | null
  delivered_at: string | null
}

export const RESEARCH_LINES = {
  researchStarted: "Started. I'll send the findings here.",
  researchTopic: 'What should I research? Send /research and a topic.',
  researchBusy: 'A research job is already running here.',
  researchFailed: 'The research could not finish.',
  offerPdf: 'Want this as a PDF report? Reply yes.'
} as const

export type ReportRenderer = (doc: ReportDocument, format: ReportFormat) => Promise<{ pdf: Buffer; pages: number }>

export function createResearchOffers(options: {
  storage: Storage
  filesDir: string
  hostDataDir: string
  renderer: ReportRenderer
  format?: ReportFormat
  offerMinutes: Config['research']['offerMinutes']
  now?: () => Date
}) {
  const now = options.now ?? (() => new Date())
  const { storage } = options
  return {
    offerMinutes: options.offerMinutes,
    open(chatId: string, senderId: string): ResearchRow | undefined {
      return storage.tx((db) => {
        db.prepare(
          "UPDATE research_job SET offer = 'expired', updated_at = ? WHERE chat_id = ? AND offer = 'open' AND offer_expires_at <= ?"
        ).run(now().toISOString(), chatId, now().toISOString())
        return db
          .prepare(
            "SELECT * FROM research_job WHERE chat_id = ? AND requester_id = ? AND offer = 'open' ORDER BY created_at DESC, rowid DESC LIMIT 1"
          )
          .get(chatId, senderId) as ResearchRow | undefined
      })
    },
    async prepare(row: ResearchRow, context: TurnContext): Promise<{ attachment: string; fileId: string }> {
      if (row.chat_id !== context.chat.chatId || row.requester_id !== context.senderId || !row.findings)
        throw new Error('research_not_owned')
      if (row.report_file_id) {
        const path = storage.read((db) =>
          db.prepare('SELECT path FROM file WHERE sha256 = ?').pluck().get(row.report_file_id)
        )
        if (typeof path === 'string') return { attachment: path, fileId: row.report_file_id }
      }
      const format = reportFormatSchema.parse(context.settings['report.format']?.value ?? options.format ?? {})
      const result = await options.renderer(reportDocumentSchema.parse(JSON.parse(row.findings)), format)
      const stored = putFile(storage, options.filesDir, { data: result.pdf, ext: '.pdf', kind: 'report' }, now)
      return { attachment: stored.path, fileId: stored.sha256 }
    },
    media(attachment: string): string {
      return `MEDIA:${join(options.hostDataDir, 'files', attachment)}`
    }
  }
}

export type ResearchOffers = ReturnType<typeof createResearchOffers>
