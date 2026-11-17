import { describe, expect, it } from 'vitest'
import { createApiRunner } from '../../src/models/api-runner.js'
import type { ModelClient, ModelRequest, ModelResponse } from '../../src/models/types.js'
import { createLogger } from '../../src/records/logger.js'
import { createRedactor } from '../../src/records/redact.js'
import { setSetting } from '../../src/settings/settings.js'
import { createCommandRouter } from '../../src/tools/commands.js'
import { registerCoreTools } from '../../src/tools/core/index.js'
import { createToolRegistry, type ToolRegistry } from '../../src/tools/registry.js'
import type { CommandRouter } from '../../src/turn/types.js'
import { startTestCore } from '../support/core.js'
import { tmpDir } from '../support/tmp.js'

type Answer = Partial<ModelResponse>

function queueClient(answers: Answer[]): ModelClient & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = []
  return {
    requests,
    async call(request) {
      requests.push(structuredClone(request))
      const answer = answers[Math.min(requests.length, answers.length) - 1] ?? {}
      return {
        text: '',
        toolCalls: [],
        usage: { inputTokens: 50, outputTokens: 10, cachedTokens: 0 },
        costUsd: 0.001,
        model: request.model,
        ...answer
      }
    }
  }
}

async function setupCore(answers: Answer[]) {
  const client = queueClient(answers)
  // biome-ignore lint/style/useConst: assigned after the core starts, which needs the closures first
  let registry!: ToolRegistry
  // biome-ignore lint/style/useConst: assigned after the core starts, which needs the closures first
  let router!: CommandRouter
  const core = await startTestCore({
    runner: createApiRunner({
      clientFor: (onCall) => ({
        async call(request, signal) {
          const startedAt = new Date()
          const res = await client.call(request, signal)
          onCall({
            role: 'main',
            model: res.model,
            transport: 'api',
            attempt: 1,
            startedAt,
            durationMs: 1,
            usage: res.usage,
            costUsd: res.costUsd
          })
          return res
        }
      }),
      model: 'test-model',
      limits: { maxCallsPerTurn: 6, timeBudgetMs: 10_000 }
    }),
    deps: {
      tools: { offered: (ctx) => registry.offered(ctx) },
      commands: {
        match: (text, ctx) => router.match(text, ctx),
        runDirect: (match, ctx) => router.runDirect(match, ctx),
        contextFor: (match, ctx) => router.contextFor(match, ctx)
      }
    }
  })
  registry = createToolRegistry({
    storage: core.storage,
    config: { tools: { defaultTimeoutMs: 500 } },
    logger: createLogger({ level: 'error', module: 'commands-anywhere-replay', sink: () => {} }),
    redactor: createRedactor()
  })
  registerCoreTools(registry, { filesDir: tmpDir('aira-files-') })
  router = createCommandRouter(registry)
  const chatId = core.activate('0000000000@lid', 'group')
  const send = (mid: string, text: string) =>
    core.gateway.send({
      chat: { waId: '0000000000@lid', kind: 'group' },
      sender: '1234567890@s.whatsapp.net',
      mid,
      text
    })
  return { core, client, chatId, send }
}

const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString()

describe('commands anywhere replay', () => {
  it('a mid-message /remind sets a reminder', async () => {
    const dueAt = inAnHour()
    const { core, client, send } = await setupCore([
      { toolCalls: [{ id: 'c1', name: 'reminder_set', args: { text: 'buy milk', dueAt } }] },
      { text: 'Got it, I will remind you to buy milk.' }
    ])
    const reply = await send('m-1', 'hey please /remind me to buy milk in an hour')
    expect(reply.content).toContain('Got it, I will remind you to buy milk.')
    expect(client.requests[0]?.tools.map((t) => t.name)).toEqual(['reminder_set'])
    const reminders = core.storage.read((db) => db.prepare('SELECT text, state FROM reminder').all())
    expect(reminders).toEqual([{ text: 'buy milk', state: 'active' }])
  })

  it('two commands with the limit at 2 call both tools in one turn with one reply', async () => {
    const dueAt = inAnHour()
    const { core, client, chatId, send } = await setupCore([
      {
        toolCalls: [
          { id: 'c1', name: 'reminder_set', args: { text: 'call dentist', dueAt } },
          { id: 'c2', name: 'note', args: { text: 'prefers morning appointments' } }
        ]
      },
      { text: 'Reminder set and noted.' }
    ])
    setSetting(core.storage, {
      level: 'chat',
      scope: chatId,
      key: 'commands.maxPerMessage',
      value: 2,
      actor: 'test'
    })
    const reply = await send('m-1', 'please /remind me to call dentist and /remember I prefer mornings')
    expect(reply.content).toBe('Reminder set and noted.')
    expect(client.requests[0]?.tools.map((t) => t.name).sort()).toEqual(['note', 'reminder_set'])
    expect(client.requests[1]?.tools.length).toBeGreaterThan(2)
    const calls = core.storage.read((db) => db.prepare('SELECT tool FROM tool_call ORDER BY rowid').all())
    expect(calls).toEqual([{ tool: 'reminder_set' }, { tool: 'note' }])
  })

  it('with the limit at 1 the second command is treated as ordinary text', async () => {
    const dueAt = inAnHour()
    const { client, send } = await setupCore([
      { toolCalls: [{ id: 'c1', name: 'reminder_set', args: { text: 'dentist', dueAt } }] },
      { text: 'Reminder set.' }
    ])
    const reply = await send('m-1', '/remind me dentist and /remember mornings')
    expect(reply.content).toBe('Reminder set.')
    expect(client.requests[0]?.tools.map((t) => t.name)).toEqual(['reminder_set'])
    expect(client.requests[1]?.tools.map((t) => t.name)).toContain('note')
  })

  it('a lone /help stays a direct answer with no model call', async () => {
    const { client, send } = await setupCore([{ text: 'must not be called' }])
    const reply = await send('m-1', '/help')
    expect(client.requests).toHaveLength(0)
    expect(reply.content).toContain('/remind')
  })

  it('/help drops a command after its feature is switched off', async () => {
    const { core, chatId, send } = await setupCore([])
    expect((await send('m-1', '/help')).content).toContain('/remind')
    setSetting(core.storage, {
      level: 'chat',
      scope: chatId,
      key: 'features.reminders',
      value: false,
      actor: 'test'
    })
    expect((await send('m-2', '/help')).content).not.toContain('/remind')
  })
})
