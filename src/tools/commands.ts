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

const words = (id: string) => id.replace(/^features\./, '').replace(/[_.]+/g, ' ')

/** A due time as the chat reads it: weekday, date and time in the deployment's time zone. */
function when(iso: unknown, timeZone: string): string {
  const date = typeof iso === 'string' ? new Date(iso) : undefined
  if (!date || Number.isNaN(date.getTime())) return 'no time set'
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }).format(date)
}

const REPEAT_WORDS: Record<string, string> = { daily: 'every day', weekly: 'every week', monthly: 'every month' }

/** The answer of a direct command, written by code from the tool's result. It holds no persona text. */
export function renderDirect(
  tool: string,
  result: Extract<ToolResult, { ok: true }>,
  options: { timeZone: string } = { timeZone: 'Asia/Kuala_Lumpur' }
): string {
  if (result.receipt?.kind === 'mute.on') return 'Proactive messages are off for this chat.'
  if (result.receipt?.kind === 'mute.off') return 'Proactive messages are on for this chat.'
  const data = (result.data ?? {}) as Record<string, unknown>
  if (tool === 'help' && Array.isArray(data['commands'])) {
    const rows = data['commands'] as { command: string; usage: string; description?: string }[]
    if (rows.length === 0) return 'No commands are switched on in this chat.'
    return [
      'Commands in this chat:',
      ...rows.map((row) => `- **${row.command}** ${row.description ?? ''}`.trimEnd())
    ].join('\n')
  }
  if (tool === 'list') {
    const tools = Array.isArray(data['tools']) ? (data['tools'] as string[]) : []
    const features = (data['features'] ?? {}) as Record<string, unknown>
    const on = Object.entries(features)
      .filter(([, value]) => value === true)
      .map(([key]) => words(key))
    const off = Object.entries(features)
      .filter(([, value]) => value === false)
      .map(([key]) => words(key))
    const lines = [`Tools on here: ${tools.length ? tools.map(words).join(', ') : 'none'}.`]
    if (on.length || off.length)
      lines.push(`Features on: ${on.join(', ') || 'none'}. Off: ${off.join(', ') || 'none'}.`)
    return lines.join('\n')
  }
  if (tool === 'reminder_list' && Array.isArray(data['reminders'])) {
    const rows = data['reminders'] as { dueAt?: string; text?: string; repeat?: string | null; mine?: boolean }[]
    if (rows.length === 0) return 'No reminders in this chat.'
    return [
      'Reminders in this chat:',
      ...rows.map((row, index) => {
        const repeat = row.repeat ? `, ${REPEAT_WORDS[row.repeat] ?? row.repeat}` : ''
        const whose = row.mine === false ? ' (set by someone else)' : ''
        return `${index + 1}. ${(row.text ?? '').replace(/[.!?\s]+$/, '')}, ${when(row.dueAt, options.timeZone)}${repeat}${whose}`
      })
    ].join('\n')
  }
  const blocks: string[] = []
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value)) {
      blocks.push(
        value.length === 0
          ? `${words(key)}: none`
          : `${words(key)}:\n${value.map((item) => `- ${line(item)}`).join('\n')}`
      )
    } else if (value !== undefined && value !== null && typeof value !== 'object') {
      blocks.push(`${words(key)}: ${String(value)}`)
    }
  }
  return blocks.length > 0 ? blocks.join('\n\n') : 'Done.'
}

export function createCommandRouter(
  registry: ToolRegistry,
  options: { timeZone: string } = { timeZone: 'Asia/Kuala_Lumpur' }
): CommandRouter {
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
        text: renderDirect(match.tool, result, options),
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
