import type { CommandMatch, CommandRouter, TurnContext } from '../turn/types.js'
import type { ToolRegistry } from './registry.js'
import type { ToolResult } from './types.js'

// Text commands (docs/trd/tools.md#explicit-calls-text-commands). A command is plain text: the first word names
// the tool, and the rest is the person's own words. One command per message.

const COMMAND = /^\/([A-Za-z][A-Za-z0-9]*)(?:[ \t\n]+([\s\S]*))?$/

/**
 * What a skill-style command needs before the model can fill its arguments: a command that removes or cancels
 * must resolve to exactly one row, so the model is shown the rows to choose from.
 */
const CONTEXT_TOOL: Record<string, { tool: string; args: (rest: string) => unknown }> = {
  reminder_cancel: { tool: 'reminder_list', args: () => ({}) },
  forget: { tool: 'recall', args: (rest) => ({ query: rest.trim().slice(0, 200) || 'everything' }) }
}

function line(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') {
    return Object.entries(value)
      .filter(([, inner]) => inner !== null && inner !== undefined && inner !== '' && typeof inner !== 'object')
      .map(([key, inner]) => `${key}: ${String(inner)}`)
      .join(', ')
  }
  return String(value)
}

/** The answer of a direct command, written by code from the tool's result. It holds no persona text. */
export function renderDirect(tool: string, result: Extract<ToolResult, { ok: true }>): string {
  if (result.receipt?.kind === 'mute.on') return 'Proactive messages are off for this chat.'
  if (result.receipt?.kind === 'mute.off') return 'Proactive messages are on for this chat.'
  const data = (result.data ?? {}) as Record<string, unknown>
  const blocks: string[] = []
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value)) {
      blocks.push(value.length === 0 ? `${key}: none` : `${key}:\n${value.map((item) => `- ${line(item)}`).join('\n')}`)
    } else if (typeof value === 'object' && value !== null) {
      blocks.push(
        `${key}:\n${Object.entries(value)
          .map(([name, inner]) => `- ${name}: ${String(inner)}`)
          .join('\n')}`
      )
    } else if (value !== undefined && value !== null) {
      blocks.push(`${key}: ${String(value)}`)
    }
  }
  return blocks.length > 0 ? blocks.join('\n\n') : `${tool}: done`
}

export function createCommandRouter(registry: ToolRegistry): CommandRouter {
  return {
    match(text, context): CommandMatch | undefined {
      const found = COMMAND.exec(text.trim())
      if (!found) return undefined
      const name = (found[1] as string).toLowerCase()
      const rest = (found[2] ?? '').trim()
      // A name that matches no command this chat may use is ordinary text and goes to the model.
      const entry = registry.commands(context).find((command) => command.name === name)
      if (!entry) return undefined
      let tool = entry.tool
      const definition = registry.get(tool)
      const routed = definition?.command?.route?.(rest)
      if (routed !== undefined && routed !== tool) {
        if (!registry.enabled(routed, context)) return undefined
        tool = routed
      }
      const target = registry.get(tool)
      const kind = target === definition ? entry.kind : (target?.command?.kind ?? 'skill')
      return {
        name,
        tool,
        kind,
        rest,
        ...(kind === 'direct' ? { args: definition?.command?.directArgs?.(name, rest) ?? {} } : {})
      }
    },

    async runDirect(match, context) {
      const result = await registry.call(match.tool, match.args ?? {}, context, {
        callId: `${context.turnId}:command`,
        source: 'command'
      })
      if (!result.ok) return { ok: false, text: '', receipts: [] }
      return {
        ok: true,
        text: renderDirect(match.tool, result),
        receipts: result.receipt ? [result.receipt.receiptId] : []
      }
    },

    async contextFor(match, context: TurnContext) {
      const helper = CONTEXT_TOOL[match.tool]
      if (!helper || !registry.enabled(helper.tool, context)) return undefined
      const result = await registry.call(helper.tool, helper.args(match.rest), context, {
        callId: `${context.turnId}:command-context`,
        source: 'command'
      })
      if (!result.ok) return undefined
      // Tool results are untrusted text: labelled, and unable to close their own block.
      const body = JSON.stringify(result.data).replace(/<\/?command_context[^>]*>/gi, '')
      return `<command_context untrusted="true">\n${body}\n</command_context>`
    }
  }
}
