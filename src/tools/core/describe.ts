import { z } from 'zod'
import type { ToolRegistry } from '../registry.js'
import type { ToolDefinition } from '../types.js'

const emptySchema = z.strictObject({})

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
        description: registry.get(entry.tool)?.description ?? ''
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
