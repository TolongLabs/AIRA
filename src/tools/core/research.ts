import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { RESEARCH_LINES } from '../../research/offer.js'
import type { Storage } from '../../storage/database.js'
import { enqueueJob } from '../../storage/leases.js'
import type { ToolPorts } from '../ports.js'
import type { ToolDefinition } from '../types.js'

const startSchema = z.strictObject({ topic: z.string().trim().max(2000) })

export function researchStartTool(storage: Storage): ToolDefinition<z.infer<typeof startSchema>> {
  return {
    name: 'research_start',
    description: 'Starts background research for this chat.',
    schema: startSchema,
    mode: 'explicit',
    mutates: true,
    feature: 'features.research',
    command: {
      names: ['research'],
      kind: 'direct',
      usage: '/research <topic>',
      directArgs: (_name, rest) => ({ topic: rest })
    },
    handler(args, context) {
      const line = (key: keyof typeof RESEARCH_LINES) => context.character.lines[key] ?? RESEARCH_LINES[key]
      if (!args.topic) {
        const { data } = context.commit(() => ({
          data: { text: line('researchTopic') },
          receipt: { kind: 'research.topic_requested' }
        }))
        return { ok: true, data }
      }
      const { data } = context.commit((db) => {
        const busy = db
          .prepare("SELECT 1 FROM research_job WHERE chat_id = ? AND state IN ('queued', 'running')")
          .get(context.chat.chatId)
        if (busy) return { data: { text: line('researchBusy') }, receipt: { kind: 'research.busy' } }
        const id = `res_${randomUUID()}`
        enqueueJob(
          db,
          'research_job',
          {
            jobId: id,
            chatId: context.chat.chatId,
            payload: JSON.stringify({ topic: args.topic }),
            requesterId: context.senderId,
            topic: args.topic,
            wantsPdf: /\b(?:pdf|report)\b/i.test(args.topic)
          },
          context.now
        )
        return {
          data: { text: line('researchStarted') },
          receipt: { kind: 'research.queued', target: id, state: { queued: true } }
        }
      })
      return { ok: true, data }
    }
  }
}

export function reportPdfTool(ports: ToolPorts): ToolDefinition<Record<string, never>> {
  return {
    name: 'report_pdf',
    description: 'Renders your open research offer as a PDF.',
    schema: z.strictObject({}),
    mode: 'explicit',
    mutates: true,
    feature: 'features.research',
    timeoutMs: 25000,
    command: { names: ['pdf'], kind: 'direct', usage: '/pdf', directArgs: () => ({}) },
    async handler(_args, context) {
      const offers = ports.research
      const row = offers?.open(context.chat.chatId, context.senderId)
      if (!offers || !row) {
        const { data } = context.commit(() => ({
          data: { text: 'No open PDF offer.' },
          receipt: { kind: 'research.no_offer' }
        }))
        return { ok: true, data }
      }
      let file: Awaited<ReturnType<typeof offers.prepare>>
      try {
        file = await offers.prepare(row, context)
      } catch {
        return { ok: false, kind: 'error', reason: 'The PDF could not be rendered.' }
      }
      const { data } = context.commit((db) => {
        const result = db
          .prepare(
            "UPDATE research_job SET offer = 'accepted', report_file_id = ?, updated_at = ? WHERE job_id = ? AND chat_id = ? AND requester_id = ? AND offer = 'open' AND offer_expires_at > ?"
          )
          .run(
            file.fileId,
            context.now().toISOString(),
            row.job_id,
            context.chat.chatId,
            context.senderId,
            context.now().toISOString()
          )
        if (result.changes !== 1) throw new Error('research_offer_closed')
        return {
          data: { text: 'Here is the PDF report.' },
          receipt: { kind: 'research.pdf', target: row.job_id, state: { attachment: file.attachment } }
        }
      })
      return { ok: true, data }
    }
  }
}
