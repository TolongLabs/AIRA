import { z } from 'zod'
import type { ToolRegistry } from '../registry.js'
import type { ToolDefinition } from '../types.js'

const emptySchema = z.strictObject({})

/** What `/help` says for a command, in plain words for members. The tool description is written for the model. */
const HELP_TEXT: Readonly<Record<string, string>> = {
  cancel: 'Cancels one of your reminders.',
  doc: 'Writes a long answer as a document.',
  forget: 'Forgets one thing I remembered.',
  help: 'Lists the commands you can use here.',
  history: 'Searches what was said in this chat.',
  list: 'Lists the features switched on here.',
  mute: 'Stops my messages that you did not ask for.',
  unmute: 'Turns those messages back on.',
  recall: 'Shows what I remember.',
  remember: 'Remembers something you tell me.',
  remind: 'Sets a reminder.',
  reminders: 'Lists the reminders in this chat.',
  research: 'Researches a topic and sends findings here.',
  pdf: 'Makes a PDF from your open research offer.',
  report: 'Opens the private feedback form for this conversation.',
  search: 'Searches the web.',
  read: 'Reads a web page.',
  photo: 'Sends a photo.'
}

/** The first sentence of a model-facing description, for a command with no plain text of its own. */
function firstSentence(text: string): string {
  return text.match(/^[^.!?]*[.!?]/)?.[0] ?? text
}

export function helpTool(registry: ToolRegistry): ToolDefinition<z.infer<typeof emptySchema>> {
  return {
    name: 'help',
    description: 'Lists the commands this chat may use.',
    schema: emptySchema,
    mode: 'explicit',
    mutates: false,
    command: {
      names: ['help'],
      kind: 'direct',
      usage: '/help',
      directArgs: () => ({})
    },
    handler(_args, context) {
      const commands = registry.commands(context).map((entry) => ({
        command: `/${entry.name}`,
        usage: entry.usage,
        description: HELP_TEXT[entry.name] ?? firstSentence(registry.get(entry.tool)?.description ?? '')
      }))
      const rawMax = context.settings['commands.maxPerMessage']?.value
      const maxPerMessage =
        typeof rawMax === 'number' && Number.isInteger(rawMax) && rawMax >= 1 ? Math.min(rawMax, 5) : 1
      const think = context.settings['features.think']?.value !== false
      return {
        ok: true,
        data: { commands, ...(maxPerMessage > 1 ? { maxPerMessage } : {}), ...(think ? { think: true } : {}) }
      }
    }
  }
}

export function listTool(registry: ToolRegistry): ToolDefinition<z.infer<typeof emptySchema>> {
  return {
    name: 'list',
    description: 'Lists the tools and features switched on for this chat.',
    schema: emptySchema,
    mode: 'explicit',
    mutates: false,
    command: {
      names: ['list'],
      kind: 'direct',
      usage: '/list',
      directArgs: () => ({})
    },
    handler(_args, context) {
      const tools = registry.offered(context).map((item) => item.schema.name)
      const features: Record<string, boolean> = {}
      for (const [key, resolved] of Object.entries(context.settings)) {
        if (key.startsWith('features.')) {
          features[key] = resolved.value === true
        }
      }
      return { ok: true, data: { tools, features } }
    }
  }
}
