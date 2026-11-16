import { z } from 'zod'
import type { ToolRegistry } from '../registry.js'
import type { ToolDefinition } from '../types.js'

const emptySchema = z.strictObject({})

/** What `/help` says for a command, in plain words for members. The tool description is written for the model. */
const HELP_TEXT: Readonly<Record<string, string>> = {
  cancel: 'Cancels one of your reminders.',
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
  report: 'Writes a long answer as a document.',
  search: 'Searches the web.',
  read: 'Reads a web page.',
  photo: 'Sends a photo.',
  think: 'Thinks harder about one message.'
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
      return { ok: true, data: { commands } }
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
