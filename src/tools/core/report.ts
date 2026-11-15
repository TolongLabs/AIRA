import { z } from 'zod'
import type { Storage } from '../../storage/database.js'
import { putFile } from '../../storage/files.js'
import type { ToolPorts } from '../ports.js'
import type { ToolDefinition } from '../types.js'

const makeReportSchema = z.strictObject({
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(50000)
})

export function makeReportTool(storage: Storage, ports: ToolPorts): ToolDefinition<z.infer<typeof makeReportSchema>> {
  return {
    name: 'make_report',
    description: 'Writes one long answer as a markdown document.',
    schema: makeReportSchema,
    mode: 'both',
    mutates: true,
    feature: 'features.reports',
    command: {
      names: ['report'],
      kind: 'skill',
      usage: '/report <topic>'
    },
    handler(args, context) {
      const markdown = `# ${args.title}\n\n${args.body}`
      const stored = putFile(
        storage,
        ports.filesDir,
        {
          data: Buffer.from(markdown, 'utf8'),
          ext: '.md',
          kind: 'report'
        },
        context.now
      )
      const { data } = context.commit(() => ({
        data: { created: true },
        receipt: {
          kind: 'report.created',
          target: stored.sha256,
          state: { attachment: stored.path }
        }
      }))
      return { ok: true, data }
    }
  }
}
