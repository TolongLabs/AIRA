import type { z } from 'zod'
import { RenderError, renderNote } from '../../render/render.js'
import { type NoteDocument, noteDocumentSchema, reportFormatSchema } from '../../render/types.js'
import type { Storage } from '../../storage/database.js'
import { putFile } from '../../storage/files.js'
import type { TurnContext } from '../../turn/types.js'
import type { ToolPorts } from '../ports.js'
import type { ToolDefinition } from '../types.js'

const DEFAULT_RENDER_OPTIONS = {
  typstPath: 'typst',
  timeoutMs: 20_000,
  maxPages: 30,
  maxBytes: 5_242_880
}

const FORMAT_WORD = /\b(pdf|markdown|md)\b/gi

/** Picks `pdf` or `markdown` from the turn's message text, else the chat's `report.defaultFormat` (`pdf`). */
export function pickDocumentFormat(context: Pick<TurnContext, 'messageText' | 'settings'>): 'pdf' | 'markdown' {
  const text = context.messageText ?? ''
  let picked: 'pdf' | 'markdown' | undefined
  for (const match of text.matchAll(FORMAT_WORD)) {
    const token = match[1]?.toLowerCase()
    if (token === 'pdf') picked = 'pdf'
    else if (token === 'md' || token === 'markdown') picked = 'markdown'
  }
  if (picked) return picked
  return context.settings['report.defaultFormat']?.value === 'markdown' ? 'markdown' : 'pdf'
}

export function renderNoteMarkdown(doc: NoteDocument): string {
  return [`# ${doc.title}`, ...doc.sections.map((section) => `## ${section.heading}\n\n${section.body}`)].join('\n\n')
}

export function makeReportTool(storage: Storage, ports: ToolPorts): ToolDefinition<z.infer<typeof noteDocumentSchema>> {
  return {
    name: 'make_report',
    description:
      'Writes one document as Markdown or PDF. Fill title and sections with plain paragraphs and - lists only.',
    schema: noteDocumentSchema,
    mode: 'both',
    mutates: true,
    feature: 'features.reports',
    timeoutMs: 25_000,
    command: {
      names: ['doc'],
      kind: 'skill',
      usage: '/doc <topic>'
    },
    async handler(args, context) {
      const format = pickDocumentFormat(context)
      let data: Buffer
      let ext: '.md' | '.pdf'
      if (format === 'markdown') {
        data = Buffer.from(renderNoteMarkdown(args), 'utf8')
        ext = '.md'
      } else {
        const profile = reportFormatSchema.safeParse(
          context.settings['report.format']?.value ?? ports.reportFormat ?? {}
        )
        if (!profile.success) {
          return { ok: false, kind: 'invalid', reason: 'invalid report format setting' }
        }
        try {
          const render = ports.noteRenderer ?? ((doc, fmt) => renderNote(doc, fmt, DEFAULT_RENDER_OPTIONS))
          const rendered = await render(args, profile.data)
          data = rendered.pdf
          ext = '.pdf'
        } catch (error) {
          if (error instanceof RenderError) {
            if (error.kind === 'timeout') {
              return { ok: false, kind: 'timeout', reason: 'The PDF render timed out.', cause: error }
            }
            if (error.kind === 'invalid') {
              return { ok: false, kind: 'invalid', reason: error.message, cause: error }
            }
          }
          return { ok: false, kind: 'error', reason: 'The PDF could not be rendered.', cause: error }
        }
      }
      const stored = putFile(
        storage,
        ports.filesDir,
        {
          data,
          ext,
          kind: 'report'
        },
        context.now
      )
      const { data: resultData } = context.commit(() => ({
        data: { created: true, format },
        receipt: {
          kind: 'report.created',
          target: stored.sha256,
          state: { attachment: stored.path }
        }
      }))
      return { ok: true, data: resultData }
    }
  }
}
