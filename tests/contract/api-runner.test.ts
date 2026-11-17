import { describe, expect, it } from 'vitest'
import { createApiRunner } from '../../src/models/api-runner.js'
import { type ModelClient, ModelError, type ModelRequest, type ModelResponse } from '../../src/models/types.js'
import { createLogger } from '../../src/records/logger.js'
import type { OfferedTool, TurnContext } from '../../src/turn/types.js'

// The API runner: the agent kit's loop on the model seam, with the two chain limits (docs/trd/tools.md).

type Answer = Partial<ModelResponse> | ModelError
const response = (answer: Partial<ModelResponse>): ModelResponse => ({
  text: '',
  toolCalls: [],
  usage: { inputTokens: 7, outputTokens: 3, cachedTokens: 1 },
  costUsd: 0.002,
  model: 'main-model',
  ...answer
})

/** A model that answers from a queue and records what it was asked. The last answer repeats. */
function queueModel(answers: Answer[]): ModelClient & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = []
  return {
    requests,
    async call(request) {
      requests.push(structuredClone(request))
      const answer = answers[Math.min(requests.length, answers.length) - 1] as Answer
      if (answer instanceof ModelError) throw answer
      return response(answer)
    }
  }
}

const call = (id: string, name = 'lookup', args: Record<string, unknown> = { q: id }) => ({ id, name, args })

function lookupTool(log: { args: unknown; callId: string }[] = [], behave?: () => Promise<void> | void): OfferedTool {
  return {
    schema: {
      name: 'lookup',
      description: 'Looks one thing up.',
      parameters: { type: 'object', properties: { q: { type: 'string' } } }
    },
    async call(args, callId) {
      log.push({ args, callId })
      await behave?.()
      return { ok: true, content: JSON.stringify({ found: (args as { q: string }).q }), receiptId: `r_${log.length}` }
    }
  }
}

const context = { turnId: 'turn-1', chat: { chatId: 'c_test' } } as TurnContext
const system = [{ name: 'core' as const, text: 'You are a test character.' }]
const window = [{ role: 'user' as const, content: 'what is the answer?' }]

function run(
  model: ModelClient,
  tools: OfferedTool[] = [],
  overrides: Partial<Parameters<typeof createApiRunner>[0]> = {}
) {
  const runner = createApiRunner({
    clientFor: () => model,
    model: 'main-model',
    limits: { maxCallsPerTurn: 4, timeBudgetMs: 15_000 },
    ...overrides
  })
  return runner.run({ system, messages: window, tools, context, signal: new AbortController().signal })
}

describe('the API runner', () => {
  it('sends the prompt blocks, the window and the tool schemas, and returns the reply', async () => {
    const model = queueModel([{ text: 'forty-two' }])
    const result = await run(model, [lookupTool()])
    expect(result).toMatchObject({ text: 'forty-two', model: 'main-model', transport: 'api', receipts: [] })
    expect(result.chainLimit).toBeUndefined()
    expect(model.requests).toHaveLength(1)
    expect(model.requests[0]).toMatchObject({ role: 'main', model: 'main-model', system, messages: window })
    expect(model.requests[0]?.tools).toEqual([lookupTool().schema])
  })

  it('runs the tool the model calls and gives the model its result', async () => {
    const log: { args: unknown; callId: string }[] = []
    const model = queueModel([{ toolCalls: [call('a')] }, { text: 'found it' }])
    const result = await run(model, [lookupTool(log)])
    expect(result.text).toBe('found it')
    expect(log).toEqual([{ args: { q: 'a' }, callId: 'turn-1:a' }])
    expect(result.receipts).toEqual(['r_1'])
    // The second request is the same prompt and window, plus the loop's own steps.
    expect(model.requests[1]?.messages).toEqual([
      ...window,
      { role: 'assistant', content: '', toolCalls: [call('a')] },
      { role: 'tool', toolCallId: 'a', name: 'lookup', content: '{"found":"a"}' }
    ])
    expect(model.requests[1]?.system).toEqual(system)
    // Usage and cost are the sum of every model call of the turn.
    expect(result.usage).toEqual({ inputTokens: 14, outputTokens: 6, cachedTokens: 2 })
    expect(result.costUsd).toBeCloseTo(0.004)
  })

  it('runs several calls of one model step', async () => {
    const log: { args: unknown; callId: string }[] = []
    const model = queueModel([{ toolCalls: [call('a'), call('b')] }, { text: 'both found' }])
    const result = await run(model, [lookupTool(log)])
    expect(result.text).toBe('both found')
    expect(log.map((entry) => entry.callId).sort()).toEqual(['turn-1:a', 'turn-1:b'])
    expect(model.requests[1]?.messages.filter((message) => message.role === 'tool')).toHaveLength(2)
  })

  it('ends the chain at the call limit: the tool list is withdrawn and the model answers with what it has', async () => {
    const log: { args: unknown; callId: string }[] = []
    const model = queueModel([
      { toolCalls: [call('1')] },
      { toolCalls: [call('2')] },
      { toolCalls: [call('3')] },
      { toolCalls: [call('4')] },
      { text: 'this is what I have' }
    ])
    const result = await run(model, [lookupTool(log)])
    expect(result).toMatchObject({ text: 'this is what I have', chainLimit: 'calls' })
    expect(log).toHaveLength(4)
    expect(model.requests[3]?.tools).toHaveLength(1)
    expect(model.requests[4]?.tools).toEqual([])
  })

  it('drops a tool call the model makes after the limit', async () => {
    const log: { args: unknown; callId: string }[] = []
    const model = queueModel([
      { toolCalls: [call('1'), call('2'), call('3'), call('4'), call('5')] },
      { text: 'an answer after all', toolCalls: [call('6')] }
    ])
    const result = await run(model, [lookupTool(log)])
    expect(result.text).toBe('an answer after all')
    expect(log.length).toBeLessThanOrEqual(4)
    expect(result.chainLimit).toBe('calls')
  })

  it('ends the chain at the tool time limit', async () => {
    let clock = 0
    const log: { args: unknown; callId: string }[] = []
    const slow = lookupTool(log, () => {
      clock += 9_000
    })
    const model = queueModel([{ toolCalls: [call('1')] }, { toolCalls: [call('2')] }, { text: 'out of time' }])
    const result = await run(model, [slow], { now: () => new Date(clock) })
    expect(result).toMatchObject({ text: 'out of time', chainLimit: 'time' })
    expect(log).toHaveLength(2)
    expect(model.requests[2]?.tools).toEqual([])
  })

  it('keeps the loop alive when a tool throws: the model reads a typed error and logs the cause', async () => {
    const logs: Record<string, unknown>[] = []
    const logger = createLogger({ level: 'warn', module: 'api-test', sink: (line) => logs.push(JSON.parse(line)) })
    const broken: OfferedTool = {
      ...lookupTool(),
      call: async () => {
        throw new Error('a handler bug')
      }
    }
    const model = queueModel([{ toolCalls: [call('a')] }, { text: 'I could not look that up' }])
    const result = await run(model, [broken], { logger })
    expect(result.text).toBe('I could not look that up')
    const toolMessage = model.requests[1]?.messages.at(-1)
    expect(toolMessage).toMatchObject({ role: 'tool', content: '{"error":"error","reason":"the tool failed"}' })
    expect(logs).toEqual([
      expect.objectContaining({
        level: 'warn',
        event: 'api_tool_failed',
        turn_id: 'turn-1',
        tool: 'lookup',
        error: expect.objectContaining({ message: 'a handler bug' })
      })
    ])
  })

  it.each(['refusal', 'budget', 'auth', 'transient'] as const)(
    'rejects with the %s failure of the model',
    async (kind) => {
      await expect(run(queueModel([new ModelError(kind, `scripted ${kind}`)]))).rejects.toMatchObject({
        name: 'ModelError',
        kind
      })
    }
  )

  it('rejects with the model failure when it comes in the middle of a chain', async () => {
    const model = queueModel([{ toolCalls: [call('a')] }, new ModelError('rate_limit', 'scripted')])
    await expect(run(model, [lookupTool()])).rejects.toMatchObject({ kind: 'rate_limit' })
  })

  it('treats a reply with no text and no tool call as malformed', async () => {
    await expect(run(queueModel([{ text: '   ' }]))).rejects.toMatchObject({ kind: 'malformed' })
  })

  it('gives every attempt to the turn record through the client it was built with', async () => {
    const runner = createApiRunner({
      clientFor: (onCall) => ({
        async call() {
          onCall({
            role: 'fallback',
            model: 'fallback-model',
            transport: 'api',
            attempt: 1,
            startedAt: new Date(),
            durationMs: 5
          })
          return response({ text: 'from the fallback', model: 'fallback-model' })
        }
      }),
      model: 'main-model',
      limits: { maxCallsPerTurn: 4, timeBudgetMs: 15_000 }
    })
    const result = await runner.run({
      system,
      messages: window,
      tools: [],
      context,
      signal: new AbortController().signal
    })
    expect(result).toMatchObject({ role: 'fallback', model: 'fallback-model' })
    expect(result.calls).toHaveLength(1)
  })

  it('stops when the turn is aborted', async () => {
    const abort = new AbortController()
    const model: ModelClient = {
      call: () =>
        new Promise((_, reject) => {
          abort.signal.addEventListener('abort', () => reject(new ModelError('transient', 'aborted')))
        })
    }
    const runner = createApiRunner({
      clientFor: () => model,
      model: 'm',
      limits: { maxCallsPerTurn: 4, timeBudgetMs: 1000 }
    })
    const running = runner.run({ system, messages: window, tools: [], context, signal: abort.signal })
    setTimeout(() => abort.abort(), 20)
    await expect(running).rejects.toMatchObject({ kind: 'transient' })
  })

  it('uses maxToolCalls per turn when below the ceiling and caps it at the ceiling', async () => {
    const lowLog: { args: unknown; callId: string }[] = []
    const lowModel = queueModel([{ toolCalls: [call('1')] }, { text: 'stopped at one', toolCalls: [call('2')] }])
    const lowRunner = createApiRunner({
      clientFor: () => lowModel,
      model: 'main-model',
      limits: { maxCallsPerTurn: 8, timeBudgetMs: 15_000 }
    })
    const lowResult = await lowRunner.run({
      system,
      messages: window,
      tools: [lookupTool(lowLog)],
      context,
      signal: new AbortController().signal,
      maxToolCalls: 1
    })
    expect(lowResult).toMatchObject({ text: 'stopped at one', chainLimit: 'calls' })
    expect(lowLog).toHaveLength(1)
    expect(lowModel.requests[1]?.tools).toEqual([])

    const capLog: { args: unknown; callId: string }[] = []
    const capModel = queueModel([
      { toolCalls: [call('1')] },
      { toolCalls: [call('2')] },
      { text: 'capped at ceiling', toolCalls: [call('3')] }
    ])
    const capRunner = createApiRunner({
      clientFor: () => capModel,
      model: 'main-model',
      limits: { maxCallsPerTurn: 2, timeBudgetMs: 15_000 }
    })
    const capResult = await capRunner.run({
      system,
      messages: window,
      tools: [lookupTool(capLog)],
      context,
      signal: new AbortController().signal,
      maxToolCalls: 6
    })
    expect(capResult).toMatchObject({ text: 'capped at ceiling', chainLimit: 'calls' })
    expect(capLog).toHaveLength(2)
    expect(capModel.requests[2]?.tools).toEqual([])
  })
})
