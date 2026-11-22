import { describe, expect, it, vi } from 'vitest'
import { createAnthropicClient } from '../../src/models/anthropic-client.js'
import { createBreaker } from '../../src/models/breaker.js'
import {
  createOpenAiClient,
  errorForStatus,
  fromChatCompletionsBody,
  providerDiagnostics,
  toChatCompletionsBody
} from '../../src/models/openai-client.js'
import { createRoutedClient } from '../../src/models/routed-client.js'
import { addSpend, countedSpend, monthOf, spendState } from '../../src/models/spend.js'
import { ModelError, type ModelRequest } from '../../src/models/types.js'
import { createLogger } from '../../src/records/logger.js'
import type { ModelCallRecord } from '../../src/turn/types.js'
import { fakeModel, textResponse } from '../support/fake-model.js'
import { tmpStorage } from '../support/tmp.js'

const prices = { usdPerMTokIn: 3, usdPerMTokOut: 15, usdPerMTokCached: 0.3 }
const fakeKey = 'test-secret-api-key-999'

function baseRequest(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    role: 'main',
    model: 'model-a',
    system: [{ name: 'core', text: 'first block' }],
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    params: {},
    ...overrides
  }
}

describe('openai-client', () => {
  it('keeps provider text out of errors and logs', () => {
    const sentence = 'Private sentence quoted by the provider'
    const error = errorForStatus(400, JSON.stringify({ error: { type: 'invalid_request_error', message: sentence } }))
    const lines: string[] = []
    createLogger({ level: 'debug', module: 'models', sink: (line) => lines.push(line) }).error('model.failed', {
      error
    })
    expect(error.message).toBe('HTTP 400: invalid_request_error')
    expect(lines.join('')).not.toContain(sentence)
  })

  it.each([createOpenAiClient, createAnthropicClient])(
    'redacts a client HTTP error and keeps its diagnostic separately',
    async (createClient) => {
      const sentence = 'Private sentence quoted by the provider'
      const body = JSON.stringify({ error: { type: 'invalid_request_error', message: sentence } })
      const client = createClient({
        baseUrl: 'https://provider.invalid/v1',
        apiKey: fakeKey,
        prices,
        fetch: async () => new Response(body, { status: 400, headers: { 'content-type': 'application/json' } })
      })
      const error = await client.call(baseRequest()).catch((error: unknown) => error)
      expect(error).toBeInstanceOf(ModelError)
      expect((error as ModelError).message).toBe('HTTP 400: invalid_request_error')
      const lines: string[] = []
      createLogger({ module: 'models', level: 'debug', sink: (line) => lines.push(line) }).error('model.failed', {
        error
      })
      expect(lines.join('')).not.toContain(sentence)
      expect(providerDiagnostics(error)).toContain(sentence)
    }
  )

  it('drops JSON parser causes containing model text', async () => {
    const sentence = 'Private sentence in malformed JSON'
    const client = createOpenAiClient({
      baseUrl: 'https://provider.invalid/v1',
      apiKey: fakeKey,
      prices,
      fetch: async () => new Response(sentence)
    })
    const error = await client.call(baseRequest()).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(ModelError)
    expect((error as ModelError).cause).toBeUndefined()
    expect((error as ModelError).message).not.toContain(sentence)
    expect(providerDiagnostics(error)).toBe(sentence)
    try {
      fromChatCompletionsBody(
        {
          choices: [{ message: { tool_calls: [{ id: 'call-test', function: { name: 'test', arguments: sentence } }] } }]
        },
        prices
      )
      expect.unreachable()
    } catch (error) {
      expect((error as ModelError).cause).toBeUndefined()
      expect((error as ModelError).message).not.toContain(sentence)
    }
  })

  it('builds a body with system blocks, all message kinds, tools, params and stream: false', () => {
    const body = toChatCompletionsBody(
      baseRequest({
        system: [
          { name: 'core', text: 'be brief' },
          { name: 'tone', text: 'warm' }
        ],
        messages: [
          { role: 'user', content: 'hi' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'tc-1', name: 'lookup', args: { query: 'weather' } }]
          },
          { role: 'tool', toolCallId: 'tc-1', name: 'lookup', content: '{"temp":20}' }
        ],
        tools: [
          {
            name: 'lookup',
            description: 'looks up info',
            parameters: { type: 'object', properties: { query: { type: 'string' } } }
          }
        ],
        params: { temperature: 0.4, max_tokens: 200 }
      })
    )

    expect(body).toEqual({
      model: 'model-a',
      messages: [
        { role: 'system', content: 'be brief\n\nwarm' },
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'tc-1', type: 'function', function: { name: 'lookup', arguments: '{"query":"weather"}' } }]
        },
        { role: 'tool', tool_call_id: 'tc-1', content: '{"temp":20}' }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'lookup',
            description: 'looks up info',
            parameters: { type: 'object', properties: { query: { type: 'string' } } }
          }
        }
      ],
      temperature: 0.4,
      max_tokens: 200,
      stream: false
    })
  })

  it('omits the system message when there are no system blocks and omits tools when empty', () => {
    const body = toChatCompletionsBody(baseRequest({ system: [], tools: [] }))
    expect(body.messages).toEqual([{ role: 'user', content: 'hello' }])
    expect('tools' in body).toBe(false)
    expect(body.stream).toBe(false)
  })

  it('joins baseUrl with one slash and sends the authorization header', async () => {
    const urls: string[] = []
    const auths: string[] = []
    const mockFetch: typeof fetch = async (input, init) => {
      urls.push(String(input))
      const headers = init?.headers as Record<string, string>
      auths.push(headers.authorization ?? '')
      return new Response(
        JSON.stringify({
          model: 'model-a',
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5 }
        }),
        { status: 200 }
      )
    }

    const noSlash = createOpenAiClient({
      baseUrl: 'https://provider.example/v1',
      apiKey: fakeKey,
      prices,
      fetch: mockFetch
    })
    const withSlash = createOpenAiClient({
      baseUrl: 'https://provider.example/v1/',
      apiKey: fakeKey,
      prices,
      fetch: mockFetch
    })

    await noSlash.call(baseRequest())
    await withSlash.call(baseRequest())

    expect(urls).toEqual([
      'https://provider.example/v1/chat/completions',
      'https://provider.example/v1/chat/completions'
    ])
    expect(auths).toEqual([`Bearer ${fakeKey}`, `Bearer ${fakeKey}`])
  })

  it('parses a text response, usage with and without cached tokens, and computes cost from prices or usage.cost', () => {
    const withoutCached = fromChatCompletionsBody(
      {
        model: 'provider-model',
        choices: [{ message: { content: 'hello back' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1_000_000, completion_tokens: 100_000 }
      },
      prices
    )
    expect(withoutCached).toEqual({
      text: 'hello back',
      toolCalls: [],
      usage: { inputTokens: 1_000_000, outputTokens: 100_000, cachedTokens: 0 },
      costUsd: 3 + 1.5,
      model: 'provider-model'
    })

    const withCached = fromChatCompletionsBody(
      {
        model: 'provider-model',
        choices: [{ message: { content: 'cached' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 1_000_000,
          completion_tokens: 100_000,
          prompt_tokens_details: { cached_tokens: 500_000 }
        }
      },
      prices
    )
    expect(withCached.usage.cachedTokens).toBe(500_000)
    expect(withCached.costUsd).toBeCloseTo(1.5 + 0.15 + 1.5, 10)

    const reportedCost = fromChatCompletionsBody(
      {
        choices: [{ message: { content: 'priced' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0123 }
      },
      prices
    )
    expect(reportedCost.costUsd).toBe(0.0123)
  })

  it('parses tool calls and rejects non-object tool arguments as malformed', () => {
    const parsed = fromChatCompletionsBody(
      {
        model: 'm',
        choices: [
          {
            message: {
              content: null,
              tool_calls: [{ id: 'c1', type: 'function', function: { name: 'ping', arguments: '{"x":1}' } }]
            }
          }
        ]
      },
      prices
    )
    expect(parsed.text).toBe('')
    expect(parsed.toolCalls).toEqual([{ id: 'c1', name: 'ping', args: { x: 1 } }])

    expect(() =>
      fromChatCompletionsBody(
        {
          choices: [
            {
              message: {
                content: '',
                tool_calls: [{ id: 'c1', type: 'function', function: { name: 'ping', arguments: '[1,2]' } }]
              }
            }
          ]
        },
        prices
      )
    ).toThrow(ModelError)

    expect(() =>
      fromChatCompletionsBody(
        {
          choices: [
            {
              message: {
                content: '',
                tool_calls: [{ id: 'c1', type: 'function', function: { name: 'ping', arguments: '{bad' } }]
              }
            }
          ]
        },
        prices
      )
    ).toThrow(ModelError)
  })

  it('rejects empty messages as malformed, and content_filter or refusal as refusal', () => {
    try {
      fromChatCompletionsBody({ choices: [{ message: { content: '' } }] }, prices)
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(ModelError)
      expect((err as ModelError).kind).toBe('malformed')
    }

    try {
      fromChatCompletionsBody({ choices: [{ finish_reason: 'content_filter', message: { content: 'x' } }] }, prices)
      expect.unreachable()
    } catch (err) {
      expect((err as ModelError).kind).toBe('refusal')
    }

    try {
      fromChatCompletionsBody({ choices: [{ message: { content: null, refusal: 'cannot do that' } }] }, prices)
      expect.unreachable()
    } catch (err) {
      expect((err as ModelError).kind).toBe('refusal')
    }
  })

  it('maps HTTP statuses in errorForStatus and caps the body snippet at 200 chars', () => {
    expect(errorForStatus(401, 'bad key').kind).toBe('auth')
    expect(errorForStatus(403, 'forbidden').kind).toBe('auth')
    expect(errorForStatus(429, 'slow down').kind).toBe('rate_limit')
    expect(errorForStatus(408, 'timeout').kind).toBe('transient')
    expect(errorForStatus(409, 'conflict').kind).toBe('transient')
    expect(errorForStatus(425, 'too early').kind).toBe('transient')
    expect(errorForStatus(500, 'err').kind).toBe('transient')
    expect(errorForStatus(503, 'down').kind).toBe('transient')
    expect(errorForStatus(400, 'blocked by content_policy').kind).toBe('refusal')
    expect(errorForStatus(422, 'triggered safety check').kind).toBe('refusal')
    expect(errorForStatus(400, 'missing field').kind).toBe('malformed')
    expect(errorForStatus(404, 'not found').kind).toBe('malformed')

    const longBody = 'x'.repeat(300)
    const err = errorForStatus(502, longBody)
    expect(err.message).toContain('502')
    expect(err.message.length).toBeLessThanOrEqual('HTTP 502: '.length + 200)
  })

  it('maps network failures to transient, aborts to transient aborted, bad JSON to malformed, and never leaks apiKey', async () => {
    const netFail = createOpenAiClient({
      baseUrl: 'https://provider.example/v1',
      apiKey: fakeKey,
      prices,
      fetch: async () => {
        throw new Error('socket hang up')
      }
    })
    await expect(netFail.call(baseRequest())).rejects.toMatchObject({ kind: 'transient' })

    const controller = new AbortController()
    const abortClient = createOpenAiClient({
      baseUrl: 'https://provider.example/v1',
      apiKey: fakeKey,
      prices,
      fetch: async (_input, init) => {
        if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
        throw new Error('unexpected')
      }
    })
    controller.abort()
    await expect(abortClient.call(baseRequest(), controller.signal)).rejects.toMatchObject({
      kind: 'transient',
      message: 'aborted'
    })

    const badJson = createOpenAiClient({
      baseUrl: 'https://provider.example/v1',
      apiKey: fakeKey,
      prices,
      fetch: async () => new Response('<html>oops</html>', { status: 200 })
    })
    await expect(badJson.call(baseRequest())).rejects.toMatchObject({ kind: 'malformed' })

    const authFail = createOpenAiClient({
      baseUrl: 'https://provider.example/v1',
      apiKey: fakeKey,
      prices,
      fetch: async () => new Response('unauthorized', { status: 401 })
    })
    try {
      await authFail.call(baseRequest())
      expect.unreachable()
    } catch (err) {
      expect((err as ModelError).kind).toBe('auth')
      expect((err as ModelError).message).not.toContain(fakeKey)
    }
  })
})

describe('spend', () => {
  it('formats monthOf in UTC', () => {
    expect(monthOf(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01')
    expect(monthOf(new Date('2026-12-31T23:59:59Z'))).toBe('2026-12')
  })

  it('sums repeated additions, ignores uncounted spend in countedSpend, and starts a new month at 0', () => {
    const storage = tmpStorage()
    const jan = () => new Date('2026-01-15T12:00:00Z')
    const feb = () => new Date('2026-02-01T00:00:00Z')

    storage.tx((db) => {
      addSpend(db, { role: 'main', counted: true, costUsd: 1.25, inputTokens: 100, outputTokens: 50 }, jan)
      addSpend(db, { role: 'main', counted: true, costUsd: 0.75, inputTokens: 200, outputTokens: 25 }, jan)
      addSpend(db, { role: 'fallback', counted: true, costUsd: 0.5, inputTokens: 50, outputTokens: 10 }, jan)
      addSpend(db, { role: 'main', counted: false, costUsd: 10, inputTokens: 500, outputTokens: 100 }, jan)
    })

    expect(countedSpend(storage, '2026-01')).toBeCloseTo(2.5, 10)
    expect(countedSpend(storage, '2026-02')).toBe(0)
    expect(spendState(storage, 10, feb).spentUsd).toBe(0)
  })

  it('enforces 80% background and 100% reply thresholds, and treats budget 0 as uncapped', () => {
    const storage = tmpStorage()
    const now = () => new Date('2026-03-10T00:00:00Z')

    storage.tx((db) => addSpend(db, { role: 'main', counted: true, costUsd: 79, inputTokens: 1, outputTokens: 1 }, now))
    expect(spendState(storage, 100, now)).toEqual({
      spentUsd: 79,
      budgetUsd: 100,
      backgroundAllowed: true,
      repliesAllowed: true
    })

    storage.tx((db) => addSpend(db, { role: 'main', counted: true, costUsd: 1, inputTokens: 1, outputTokens: 1 }, now))
    expect(spendState(storage, 100, now)).toEqual({
      spentUsd: 80,
      budgetUsd: 100,
      backgroundAllowed: false,
      repliesAllowed: true
    })

    storage.tx((db) => addSpend(db, { role: 'main', counted: true, costUsd: 20, inputTokens: 1, outputTokens: 1 }, now))
    expect(spendState(storage, 100, now)).toEqual({
      spentUsd: 100,
      budgetUsd: 100,
      backgroundAllowed: false,
      repliesAllowed: false
    })

    expect(spendState(storage, 0, now)).toEqual({
      spentUsd: 100,
      budgetUsd: 0,
      backgroundAllowed: true,
      repliesAllowed: true
    })
  })
})

describe('breaker', () => {
  it('opens for breakerMs, closes by itself, fires onOpen once per opening, and isolates roles', () => {
    let timeMs = 1000
    const opened: string[] = []
    const breaker = createBreaker({
      breakerMs: 5000,
      now: () => new Date(timeMs),
      onOpen: (role) => opened.push(role)
    })

    expect(breaker.isOpen('main')).toBe(false)
    breaker.open('main')
    expect(breaker.isOpen('main')).toBe(true)
    expect(breaker.isOpen('fallback')).toBe(false)
    expect(breaker.openRoles()).toEqual(['main'])
    expect(opened).toEqual(['main'])

    timeMs = 4000
    breaker.open('main')
    expect(opened).toEqual(['main'])

    timeMs = 6000
    expect(breaker.isOpen('main')).toBe(true)
    timeMs = 9000
    expect(breaker.isOpen('main')).toBe(false)
    expect(breaker.openRoles()).toEqual([])

    breaker.open('main')
    expect(opened).toEqual(['main', 'main'])
  })
})

describe('routed-client', () => {
  const defaultConfig = { llm: { maxRetries: 2, monthlyBudgetUsd: 50 } }

  function makeSleep() {
    const waits: number[] = []
    const sleep = async (ms: number) => {
      waits.push(ms)
    }
    return { waits, sleep }
  }

  it('returns the reply and reports a failed spend write once', async () => {
    const storage = tmpStorage()
    vi.spyOn(storage, 'tx').mockImplementation(() => {
      throw new Error('write failed')
    })
    const onSpendError = vi.fn()
    const client = createRoutedClient({
      main: { client: fakeModel([textResponse('ok')]), model: 'main-m' },
      config: defaultConfig,
      breaker: createBreaker({ breakerMs: 1000 }),
      storage,
      transport: 'api',
      onSpendError
    })
    expect((await client.call(baseRequest())).text).toBe('ok')
    expect(onSpendError).toHaveBeenCalledTimes(1)
  })

  it('calls main once on success', async () => {
    const storage = tmpStorage()
    const main = fakeModel([textResponse('hi', 0.01)])
    const fallback = fakeModel([textResponse('unused')])
    const { waits, sleep } = makeSleep()
    const client = createRoutedClient({
      main: { client: main, model: 'main-m' },
      fallback: { client: fallback, model: 'fb-m' },
      config: defaultConfig,
      breaker: createBreaker({ breakerMs: 60_000 }),
      storage,
      transport: 'api',
      sleep
    })

    const res = await client.call(baseRequest())
    expect(res.text).toBe('hi')
    expect(main.requests).toHaveLength(1)
    expect(fallback.requests).toHaveLength(0)
    expect(waits).toEqual([])
  })

  it('retries transient errors with doubling waits and then succeeds', async () => {
    const storage = tmpStorage()
    const main = fakeModel([
      new ModelError('transient', 't1'),
      new ModelError('transient', 't2'),
      textResponse('recovered')
    ])
    const { waits, sleep } = makeSleep()
    const client = createRoutedClient({
      main: { client: main, model: 'main-m' },
      config: defaultConfig,
      breaker: createBreaker({ breakerMs: 60_000 }),
      storage,
      transport: 'api',
      sleep
    })

    const res = await client.call(baseRequest())
    expect(res.text).toBe('recovered')
    expect(waits).toEqual([250, 500])
  })

  it('switches from main after its retry count and lets the fallback recover inside the deadline', async () => {
    const storage = tmpStorage()
    const main = fakeModel([
      new ModelError('transient', 't1'),
      new ModelError('transient', 't2'),
      new ModelError('transient', 't3')
    ])
    const fallback = fakeModel([
      new ModelError('transient', 'busy'),
      new ModelError('transient', 'busy'),
      new ModelError('transient', 'busy'),
      { text: 'from fallback', model: 'fb-m' }
    ])
    const { waits, sleep } = makeSleep()
    const client = createRoutedClient({
      main: { client: main, model: 'main-m' },
      fallback: { client: fallback, model: 'fb-m' },
      deadline: 3000,
      now: () => new Date(0),
      config: defaultConfig,
      breaker: createBreaker({ breakerMs: 60_000 }),
      storage,
      transport: 'api',
      sleep
    })

    const res = await client.call(baseRequest())
    expect(res.text).toBe('from fallback')
    expect(res.model).toBe('fb-m')
    expect(main.requests).toHaveLength(3)
    expect(fallback.requests).toHaveLength(4)
    expect(waits).toEqual([250, 500, 250, 500, 1000])
  })

  it('retries a pinned model until the elapsed limit even with no signal and a frozen clock', async () => {
    const { waits, sleep } = makeSleep()
    const fail = vi.fn(async () => {
      throw new ModelError('transient', 'still down')
    })
    const main = fakeModel([textResponse('unused')])
    const client = createRoutedClient({
      main: { client: main, model: 'main-m' },
      fallback: { client: { call: fail }, model: 'fb-m' },
      pin: { role: 'fallback', model: 'fb-m' },
      deadline: 12_000,
      now: () => new Date(0),
      config: defaultConfig,
      breaker: createBreaker({ breakerMs: 60_000 }),
      storage: tmpStorage(),
      transport: 'api',
      sleep
    })

    await expect(client.call(baseRequest())).rejects.toMatchObject({ kind: 'transient', message: 'still down' })
    expect(waits).toEqual([250, 500, 1000, 2000, 4000, 4000])
    expect(fail).toHaveBeenCalledTimes(7)
    expect(main.requests).toHaveLength(0)
  })

  it('checks the spend cap again after a transient wait', async () => {
    const storage = tmpStorage()
    const now = () => new Date(0)
    const main = fakeModel([new ModelError('transient', 'temporary'), textResponse('unused')])
    const client = createRoutedClient({
      main: { client: main, model: 'main-m' },
      deadline: 1000,
      now,
      config: defaultConfig,
      breaker: createBreaker({ breakerMs: 60_000 }),
      storage,
      transport: 'api',
      sleep: async () => {
        storage.tx((db) =>
          addSpend(db, { role: 'main', counted: true, costUsd: 50, inputTokens: 1, outputTokens: 1 }, now)
        )
      }
    })
    await expect(client.call(baseRequest())).rejects.toMatchObject({ kind: 'budget' })
    expect(main.requests).toHaveLength(1)
  })

  it('retries malformed once immediately, then falls back on a second malformed', async () => {
    const storage = tmpStorage()
    const main = fakeModel([new ModelError('malformed', 'bad1'), new ModelError('malformed', 'bad2')])
    const fallback = fakeModel([{ text: 'from fallback', model: 'fb-m' }])
    const { waits, sleep } = makeSleep()
    const client = createRoutedClient({
      main: { client: main, model: 'main-m' },
      fallback: { client: fallback, model: 'fb-m' },
      config: defaultConfig,
      breaker: createBreaker({ breakerMs: 60_000 }),
      storage,
      transport: 'api',
      sleep
    })

    const res = await client.call(baseRequest())
    expect(res.text).toBe('from fallback')
    expect(main.requests).toHaveLength(2)
    expect(waits).toEqual([])
  })

  it('rate_limit opens the breaker, falls back, and subsequent calls skip main', async () => {
    const storage = tmpStorage()
    const main = fakeModel([new ModelError('rate_limit', '429'), textResponse('should not run')])
    const fallback = fakeModel([textResponse('fb 1'), textResponse('fb 2')])
    const breaker = createBreaker({ breakerMs: 60_000 })
    const client = createRoutedClient({
      main: { client: main, model: 'main-m' },
      fallback: { client: fallback, model: 'fb-m' },
      config: defaultConfig,
      breaker,
      storage,
      transport: 'api'
    })

    expect((await client.call(baseRequest())).text).toBe('fb 1')
    expect(breaker.isOpen('main')).toBe(true)
    expect((await client.call(baseRequest())).text).toBe('fb 2')
    expect(main.requests).toHaveLength(1)
    expect(fallback.requests).toHaveLength(2)
  })

  it('auth opens the breaker, calls onAuthFailure, and falls back', async () => {
    const storage = tmpStorage()
    const authFailedRoles: string[] = []
    const main = fakeModel([new ModelError('auth', '401')])
    const fallback = fakeModel([textResponse('fb')])
    const breaker = createBreaker({ breakerMs: 60_000 })
    const client = createRoutedClient({
      main: { client: main, model: 'main-m' },
      fallback: { client: fallback, model: 'fb-m' },
      config: defaultConfig,
      breaker,
      storage,
      transport: 'api',
      onAuthFailure: (role) => authFailedRoles.push(role)
    })

    expect((await client.call(baseRequest())).text).toBe('fb')
    expect(breaker.isOpen('main')).toBe(true)
    expect(authFailedRoles).toEqual(['main'])
  })

  it('refusal rejects at once without asking the fallback', async () => {
    const storage = tmpStorage()
    const main = fakeModel([new ModelError('refusal', 'nope')])
    const fallback = fakeModel([textResponse('unused')])
    const client = createRoutedClient({
      main: { client: main, model: 'main-m' },
      fallback: { client: fallback, model: 'fb-m' },
      config: defaultConfig,
      breaker: createBreaker({ breakerMs: 60_000 }),
      storage,
      transport: 'api'
    })

    await expect(client.call(baseRequest())).rejects.toMatchObject({ kind: 'refusal', message: 'nope' })
    expect(fallback.requests).toHaveLength(0)
  })

  it('rejects with the last error when both main and fallback fail, or when no fallback is configured', async () => {
    const storage = tmpStorage()
    const { sleep } = makeSleep()

    const mainOnly = fakeModel([new ModelError('rate_limit', 'main limited')])
    const singleClient = createRoutedClient({
      main: { client: mainOnly, model: 'main-m' },
      config: defaultConfig,
      breaker: createBreaker({ breakerMs: 60_000 }),
      storage,
      transport: 'api',
      sleep
    })
    await expect(singleClient.call(baseRequest())).rejects.toMatchObject({
      kind: 'rate_limit',
      message: 'main limited'
    })

    const main = fakeModel([new ModelError('rate_limit', 'main limited')])
    const fallback = fakeModel([new ModelError('auth', 'fallback bad key')])
    const bothClient = createRoutedClient({
      main: { client: main, model: 'main-m' },
      fallback: { client: fallback, model: 'fb-m' },
      config: defaultConfig,
      breaker: createBreaker({ breakerMs: 60_000 }),
      storage,
      transport: 'api',
      sleep
    })
    await expect(bothClient.call(baseRequest())).rejects.toMatchObject({ kind: 'auth', message: 'fallback bad key' })
  })

  it('sends the exact same request to fallback except role and model', async () => {
    const storage = tmpStorage()
    const main = fakeModel([new ModelError('rate_limit', '429')])
    const fallback = fakeModel([textResponse('ok')])
    const client = createRoutedClient({
      main: { client: main, model: 'main-m' },
      fallback: { client: fallback, model: 'fb-m' },
      config: defaultConfig,
      breaker: createBreaker({ breakerMs: 60_000 }),
      storage,
      transport: 'api'
    })

    await client.call(
      baseRequest({
        tools: [{ name: 't', description: 'd', parameters: { type: 'object' } }],
        params: { temperature: 0.7 }
      })
    )

    const mainReq = main.requests[0]
    const fbReq = fallback.requests[0]
    expect(mainReq).toBeDefined()
    expect(fbReq).toBeDefined()
    expect(fbReq).toEqual({ ...mainReq, role: 'fallback', model: 'fb-m' })
  })

  it('stops with budget before calling any model', async () => {
    const storage = tmpStorage()
    const now = () => new Date('2026-04-01T00:00:00Z')
    storage.tx((db) => addSpend(db, { role: 'main', counted: true, costUsd: 50, inputTokens: 1, outputTokens: 1 }, now))
    const main = fakeModel([textResponse('unused')])
    const client = createRoutedClient({
      main: { client: main, model: 'main-m' },
      config: defaultConfig,
      breaker: createBreaker({ breakerMs: 60_000 }),
      storage,
      transport: 'api',
      now
    })

    await expect(client.call(baseRequest())).rejects.toMatchObject({ kind: 'budget' })
    expect(main.requests).toHaveLength(0)
  })

  it('records spend per success with the answering role, and does not count subscription transport', async () => {
    const storage = tmpStorage()
    const now = () => new Date('2026-05-01T00:00:00Z')

    const apiMain = fakeModel([new ModelError('rate_limit', '429')])
    const apiFallback = fakeModel([
      { text: 'ok', usage: { inputTokens: 10, outputTokens: 20, cachedTokens: 0 }, costUsd: 1.5 }
    ])
    const apiClient = createRoutedClient({
      main: { client: apiMain, model: 'main-m' },
      fallback: { client: apiFallback, model: 'fb-m' },
      config: defaultConfig,
      breaker: createBreaker({ breakerMs: 60_000 }),
      storage,
      transport: 'api',
      now
    })
    await apiClient.call(baseRequest())
    expect(countedSpend(storage, '2026-05')).toBeCloseTo(1.5, 10)
    const fbRow = storage.read((db) =>
      db.prepare("SELECT role, counted, cost_usd FROM spend WHERE month = '2026-05' AND role = 'fallback'").get()
    ) as { role: string; counted: number; cost_usd: number }
    expect(fbRow).toEqual({ role: 'fallback', counted: 1, cost_usd: 1.5 })

    const subMain = fakeModel([
      { text: 'sub', usage: { inputTokens: 10, outputTokens: 20, cachedTokens: 0 }, costUsd: 5 }
    ])
    const subClient = createRoutedClient({
      main: { client: subMain, model: 'sub-m' },
      config: defaultConfig,
      breaker: createBreaker({ breakerMs: 60_000 }),
      storage,
      transport: 'subscription',
      now
    })
    await subClient.call(baseRequest())
    expect(countedSpend(storage, '2026-05')).toBeCloseTo(1.5, 10)
  })

  it('reports every attempt to onCall with rising attempt numbers and failure kinds', async () => {
    const storage = tmpStorage()
    const records: ModelCallRecord[] = []
    const main = fakeModel([new ModelError('malformed', 'm1'), new ModelError('malformed', 'm2')])
    const fallback = fakeModel([
      new ModelError('transient', 't1'),
      { text: 'done', usage: { inputTokens: 3, outputTokens: 4, cachedTokens: 1 }, costUsd: 0.2 }
    ])
    const { sleep } = makeSleep()
    const client = createRoutedClient({
      main: { client: main, model: 'main-m' },
      fallback: { client: fallback, model: 'fb-m' },
      config: defaultConfig,
      breaker: createBreaker({ breakerMs: 60_000 }),
      storage,
      transport: 'api',
      sleep,
      onCall: (record) => records.push(record)
    })

    await client.call(baseRequest())
    expect(records.map((r) => [r.attempt, r.role, r.model, r.failureKind, r.costUsd])).toEqual([
      [1, 'main', 'main-m', 'malformed', undefined],
      [2, 'main', 'main-m', 'malformed', undefined],
      [3, 'fallback', 'fb-m', 'transient', undefined],
      [4, 'fallback', 'fb-m', undefined, 0.2]
    ])
  })

  it('stops retrying when the signal aborts', async () => {
    const storage = tmpStorage()
    const controller = new AbortController()
    const main = fakeModel([new ModelError('transient', 't1'), textResponse('never')])
    const client = createRoutedClient({
      main: { client: main, model: 'main-m' },
      config: defaultConfig,
      breaker: createBreaker({ breakerMs: 60_000 }),
      storage,
      transport: 'api',
      sleep: async () => {
        controller.abort()
      }
    })

    await expect(client.call(baseRequest(), controller.signal)).rejects.toMatchObject({
      kind: 'transient',
      message: 'aborted'
    })
    expect(main.requests).toHaveLength(1)
  })

  it('treats non-ModelError throws as transient', async () => {
    const storage = tmpStorage()
    const { waits, sleep } = makeSleep()
    let calls = 0
    const main = {
      async call() {
        calls += 1
        if (calls === 1) throw new Error('unexpected boom')
        return textResponse('ok')
      }
    }
    const records: ModelCallRecord[] = []
    const client = createRoutedClient({
      main: { client: main, model: 'main-m' },
      config: defaultConfig,
      breaker: createBreaker({ breakerMs: 60_000 }),
      storage,
      transport: 'api',
      sleep,
      onCall: (r) => records.push(r)
    })

    const res = await client.call(baseRequest())
    expect(res.text).toBe('ok')
    expect(waits).toEqual([250])
    expect(records[0]?.failureKind).toBe('transient')
    expect(records[0]?.error).toMatchObject({ message: 'unexpected boom' })
  })
})
