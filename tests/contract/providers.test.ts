import { readFileSync } from 'node:fs'
import type Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it } from 'vitest'
import { parseConfig } from '../../src/config/loader.js'
import { configSchema } from '../../src/config/schema.js'
import { createAnthropicClient, fromMessage, toMessagesBody } from '../../src/models/anthropic-client.js'
import { createApiRunner } from '../../src/models/api-runner.js'
import { createBreaker } from '../../src/models/breaker.js'
import { fromChatCompletionsBody, toChatCompletionsBody } from '../../src/models/openai-client.js'
import { createSubscriptionRunner } from '../../src/models/subscription-runner.js'
import type { ModelClient, ModelRequest, ModelResponse } from '../../src/models/types.js'
import { createLogger } from '../../src/records/logger.js'
import type { OfferedTool, TurnContext } from '../../src/turn/types.js'

// Providers and effort, and a provider's turn state (docs/trd/models.md#providers-and-effort).

const prices = { usdPerMTokIn: 0.1, usdPerMTokOut: 0.5, usdPerMTokCached: 0.01 }
const thinking = { type: 'thinking', thinking: 'weigh it', signature: 'sig-1' }

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    role: 'main',
    model: 'claude-haiku-5-5',
    system: [
      { name: 'core', text: 'You are a test character.' },
      { name: 'harness', text: 'Tools are listed below.' },
      { name: 'context', text: 'Recalled: nothing.' }
    ],
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    params: {},
    ...overrides
  }
}

function message(content: unknown[], overrides: Partial<Anthropic.Message> = {}): Anthropic.Message {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-5-5',
    content,
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 },
    ...overrides
  } as Anthropic.Message
}

describe('the anthropic provider', () => {
  it('sends effort with adaptive thinking, no sampling, and a schema as structured output', () => {
    const body = toMessagesBody(
      request({
        params: {
          temperature: 0,
          response_format: { type: 'json_schema', json_schema: { name: 'ops', schema: { type: 'object' } } }
        }
      }),
      'medium'
    )
    expect(body.thinking).toEqual({ type: 'adaptive' })
    expect(body.output_config).toEqual({
      effort: 'medium',
      format: { type: 'json_schema', schema: { type: 'object' } }
    })
    expect(body).not.toHaveProperty('temperature')
  })

  it('sends no thinking and no effort when effort is empty', () => {
    const body = toMessagesBody(request())
    expect(body).not.toHaveProperty('thinking')
    expect(body).not.toHaveProperty('output_config')
  })

  it('caches after the last stable prompt block and the last tool', () => {
    const tool = { name: 'lookup', description: 'Looks up.', parameters: { type: 'object', properties: {} } }
    const body = toMessagesBody(request({ tools: [tool, { ...tool, name: 'note' }] }))
    const system = body.system as Anthropic.TextBlockParam[]
    expect(system.map((block) => Boolean(block.cache_control))).toEqual([false, true, false])
    expect(body.tools?.map((entry) => Boolean((entry as Anthropic.Tool).cache_control))).toEqual([false, true])
  })

  it('merges tool results into one user message and sends its own thinking back unchanged', () => {
    const blocks = [thinking, { type: 'tool_use', id: 'a', name: 'lookup', input: { q: 'a' } }]
    const body = toMessagesBody(
      request({
        messages: [
          { role: 'user', content: 'look it up' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'a', name: 'lookup', args: { q: 'a' } }],
            replay: { provider: 'anthropic', blocks }
          },
          { role: 'tool', toolCallId: 'a', name: 'lookup', content: '{"found":"a"}' }
        ]
      })
    )
    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'look it up' }] },
      { role: 'assistant', content: blocks },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: '{"found":"a"}' }] }
    ])
  })

  it("drops a call the loop dropped, and another provider's state", () => {
    const blocks = [
      thinking,
      { type: 'tool_use', id: 'a', name: 'lookup', input: {} },
      { type: 'tool_use', id: 'b', name: 'other', input: {} }
    ]
    const kept = toMessagesBody(
      request({
        messages: [
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'a', name: 'lookup', args: {} }],
            replay: { provider: 'anthropic', blocks }
          }
        ]
      })
    )
    expect(kept.messages[0]?.content).toEqual(blocks.slice(0, 2))
    const foreign = toMessagesBody(
      request({
        messages: [
          {
            role: 'assistant',
            content: 'checking',
            toolCalls: [{ id: 'a', name: 'lookup', args: {} }],
            replay: { provider: 'openai-compatible', reasoningContent: 'not for Claude' }
          }
        ]
      })
    )
    expect(foreign.messages[0]?.content).toEqual([
      { type: 'text', text: 'checking' },
      { type: 'tool_use', id: 'a', name: 'lookup', input: {} }
    ])
  })

  it('reads text, tool calls, usage and cost, and keeps thinking only for a step that calls a tool', () => {
    const replied = fromMessage(message([thinking, { type: 'text', text: 'hi' }]), prices)
    expect(replied.text).toBe('hi')
    expect(replied.replay).toBeUndefined()
    expect(replied.usage).toEqual({ inputTokens: 2100, outputTokens: 40, cachedTokens: 2000 })
    expect(replied.costUsd).toBeCloseTo((100 * 0.1 + 2000 * 0.01 + 40 * 0.5) / 1_000_000)
    const content = [thinking, { type: 'tool_use', id: 'a', name: 'lookup', input: { q: 'a' } }]
    const stepped = fromMessage(message(content, { stop_reason: 'tool_use' }), prices)
    expect(stepped.toolCalls).toEqual([{ id: 'a', name: 'lookup', args: { q: 'a' } }])
    expect(stepped.replay).toEqual({ provider: 'anthropic', blocks: content })
  })

  it('names a refusal and an empty answer', () => {
    expect(() => fromMessage(message([], { stop_reason: 'refusal' }), prices)).toThrow(
      expect.objectContaining({ kind: 'refusal' })
    )
    expect(() => fromMessage(message([thinking]), prices)).toThrow(expect.objectContaining({ kind: 'malformed' }))
  })

  it('calls the native endpoint with the key and maps failure statuses', async () => {
    const seen: { url: string; headers: Headers; body: Record<string, unknown> }[] = []
    let status = 200
    const fakeFetch = (async (url: string, init: RequestInit) => {
      seen.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(String(init.body)) })
      const body =
        status === 200 ? message([{ type: 'text', text: 'ok' }]) : { type: 'error', error: { message: 'no' } }
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const client = createAnthropicClient({
      baseUrl: 'https://claude.example/',
      apiKey: 'test-key-123',
      effort: 'high',
      prices,
      fetch: fakeFetch
    })
    const answer = await client.call(request())
    expect(answer.text).toBe('ok')
    expect(seen[0]?.url).toBe('https://claude.example/v1/messages')
    expect(seen[0]?.headers.get('authorization')).toBe('Bearer test-key-123')
    expect(seen[0]?.body['output_config']).toEqual({ effort: 'high' })
    for (const [code, kind] of [
      [429, 'rate_limit'],
      [401, 'auth'],
      [529, 'transient']
    ] as const) {
      status = code
      await expect(client.call(request())).rejects.toMatchObject({ kind })
    }
  })
})

describe('the openai-compatible provider', () => {
  it('sends effort as reasoning_effort, keeps reasoning text, and sends only its own back', () => {
    expect(toChatCompletionsBody(request(), 'high')['reasoning_effort']).toBe('high')
    expect(toChatCompletionsBody(request())).not.toHaveProperty('reasoning_effort')
    const parsed = fromChatCompletionsBody(
      {
        model: 'deepseek',
        choices: [
          {
            message: {
              content: '',
              reasoning_content: 'call the tool',
              tool_calls: [{ id: 'a', type: 'function', function: { name: 'lookup', arguments: '{}' } }]
            }
          }
        ]
      },
      prices
    )
    expect(parsed.replay).toEqual({ provider: 'openai-compatible', reasoningContent: 'call the tool' })
    const step = { role: 'assistant' as const, content: '', toolCalls: [{ id: 'a', name: 'lookup', args: {} }] }
    const own = toChatCompletionsBody(
      request({ messages: [{ ...step, ...(parsed.replay && { replay: parsed.replay }) }] })
    )
    expect((own['messages'] as Record<string, unknown>[]).at(-1)?.['reasoning_content']).toBe('call the tool')
    const foreign = toChatCompletionsBody(
      request({ messages: [{ ...step, replay: { provider: 'anthropic', blocks: [thinking] } }] })
    )
    expect((foreign['messages'] as Record<string, unknown>[]).at(-1)).not.toHaveProperty('reasoning_content')
  })
})

describe('turn state in the API runner', () => {
  it('sends a step back with the state it came with, within the turn', async () => {
    const replay = { provider: 'anthropic' as const, blocks: [thinking] }
    const answers: Partial<ModelResponse>[] = [
      { toolCalls: [{ id: 'a', name: 'lookup', args: {} }], replay },
      { text: 'found it' }
    ]
    const requests: ModelRequest[] = []
    const model: ModelClient = {
      async call(asked) {
        requests.push(structuredClone(asked))
        return {
          text: '',
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
          costUsd: 0,
          model: 'm',
          ...answers[requests.length - 1]
        }
      }
    }
    const tool: OfferedTool = {
      schema: { name: 'lookup', description: 'Looks up.', parameters: { type: 'object', properties: {} } },
      async call() {
        return { ok: true, content: '{}' }
      }
    }
    const runner = createApiRunner({
      clientFor: () => model,
      model: 'm',
      limits: { maxCallsPerTurn: 4, timeBudgetMs: 15_000 }
    })
    const result = await runner.run({
      system: [{ name: 'core', text: 'x' }],
      messages: [{ role: 'user', content: 'go' }],
      tools: [tool],
      context: { turnId: 'turn-1', chat: { chatId: 'c_test' } } as TurnContext,
      signal: new AbortController().signal
    })
    expect(result.text).toBe('found it')
    expect(requests[1]?.messages[1]).toEqual({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'a', name: 'lookup', args: {} }],
      replay
    })
  })
})

describe('effort in config.yml', () => {
  const config = parseConfig(readFileSync('config.yml', 'utf8'))

  it('carries the launch models', () => {
    expect(config.llm.main).toMatchObject({ provider: 'anthropic', model: 'claude-haiku-5-5', effort: 'medium' })
    expect(config.llm.fallback).toMatchObject({
      provider: 'openai-compatible',
      model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017',
      effort: 'high'
    })
  })

  it("refuses an effort outside Claude's list for Claude, and leaves other servers to check their own", () => {
    const withMain = (main: Partial<typeof config.llm.main>, transport = config.llm.transport) =>
      configSchema.safeParse({ ...config, llm: { ...config.llm, transport, main: { ...config.llm.main, ...main } } })
    expect(withMain({ effort: 'none' }).success).toBe(false)
    expect(withMain({ effort: 'xhigh' }).success).toBe(true)
    expect(withMain({ provider: 'openai-compatible', effort: 'none' }).success).toBe(true)
    expect(withMain({ provider: 'openai-compatible', effort: 'none' }, 'subscription').success).toBe(false)
  })
})

describe('the subscription runner', () => {
  it('asks the program for the main model at the main effort, medium when empty', async () => {
    const payloads: Record<string, unknown>[] = []
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      payloads.push(JSON.parse(String(init.body)))
      throw new Error('stop here')
    }) as typeof fetch
    const toolServer = {
      open: () => ({ token: 'ab'.repeat(16), end: () => {} })
    } as unknown as Parameters<typeof createSubscriptionRunner>[0]['toolServer']
    for (const effort of ['', 'xhigh']) {
      const runner = createSubscriptionRunner({
        subscription: { runnerUrl: 'http://127.0.0.1:9', toolServerUrl: 'http://127.0.0.1:9883' },
        model: 'claude-haiku-5-5',
        effort,
        runnerToken: 'r'.repeat(32),
        toolServer,
        breaker: createBreaker({ breakerMs: 60_000 }),
        logger: createLogger({ level: 'error', module: 'sub-test', sink: () => {} }),
        fetch: fakeFetch
      })
      await runner
        .run({
          system: [{ name: 'core', text: 'x' }],
          messages: [{ role: 'user', content: 'hi' }],
          tools: [],
          context: { turnId: 't', chat: { chatId: 'c_test' } } as TurnContext,
          signal: new AbortController().signal
        })
        .catch(() => undefined)
    }
    expect(payloads.map((payload) => [payload['model'], payload['effort']])).toEqual([
      ['claude-haiku-5-5', 'medium'],
      ['claude-haiku-5-5', 'xhigh']
    ])
  })
})
