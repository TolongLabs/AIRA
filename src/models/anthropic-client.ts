import Anthropic, { APIConnectionError, APIError, APIUserAbortError } from '@anthropic-ai/sdk'
import { errorForStatus } from './openai-client.js'
import {
  type ModelClient,
  ModelError,
  type ModelRequest,
  type ModelResponse,
  type PromptBlock,
  type ToolCallRequest
} from './types.js'

// Claude's native Messages API (docs/trd/models.md#providers-and-effort). Claude is never reached through its
// OpenAI-compatible layer, which drops effort and has no prompt caching.

export interface AnthropicClientOptions {
  /** The API's origin, such as `https://api.anthropic.com`. */
  baseUrl: string
  apiKey: string
  /** Sent as `output_config.effort` with adaptive thinking when not empty. */
  effort?: string
  /** US dollars per million tokens. Claude's API reports no cost. */
  prices: { usdPerMTokIn: number; usdPerMTokOut: number; usdPerMTokCached: number }
  /** Replaces global fetch in tests. */
  fetch?: typeof fetch
}

type Params = Anthropic.MessageCreateParamsNonStreaming
type Effort = NonNullable<NonNullable<Params['output_config']>['effort']>

const DEFAULT_MAX_TOKENS = 16000
/** The prompt blocks that change rarely: the cache breakpoint goes after the last of them that is present. */
const STABLE_BLOCKS: ReadonlySet<PromptBlock['name']> = new Set(['core', 'speech', 'harness'])
/** A cache write costs this much of the input price on the default five-minute lifetime. */
const CACHE_WRITE_FACTOR = 1.25

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function systemBlocks(blocks: PromptBlock[]): Anthropic.TextBlockParam[] {
  const kept = blocks.filter((block) => block.text !== '')
  const lastStable = kept.findLastIndex((block) => STABLE_BLOCKS.has(block.name))
  return kept.map((block, index) => ({
    type: 'text' as const,
    text: block.text,
    ...(index === lastStable ? { cache_control: { type: 'ephemeral' as const } } : {})
  }))
}

/** The request body for one ModelRequest. Pure. Sampling parameters are not sent: Claude 5 models refuse them. */
export function toMessagesBody(request: ModelRequest, effort = ''): Params {
  const messages: Anthropic.MessageParam[] = []
  const pushUser = (block: Anthropic.ContentBlockParam) => {
    const last = messages.at(-1)
    if (last?.role === 'user' && Array.isArray(last.content)) last.content.push(block)
    else messages.push({ role: 'user', content: [block] })
  }
  for (const msg of request.messages) {
    if (msg.role === 'user') {
      pushUser({ type: 'text', text: msg.content })
    } else if (msg.role === 'tool') {
      pushUser({ type: 'tool_result', tool_use_id: msg.toolCallId, content: msg.content })
    } else {
      const ids = new Set((msg.toolCalls ?? []).map((call) => call.id))
      // Claude's own step goes back as it came, thinking included, without a call the loop dropped.
      // Another provider's state is dropped.
      const content: Anthropic.ContentBlockParam[] =
        msg.replay?.provider === 'anthropic'
          ? (msg.replay.blocks as Anthropic.ContentBlockParam[]).filter(
              (block) => block.type !== 'tool_use' || ids.has(block.id)
            )
          : [
              ...(msg.content === '' ? [] : [{ type: 'text' as const, text: msg.content }]),
              ...(msg.toolCalls ?? []).map((call) => ({
                type: 'tool_use' as const,
                id: call.id,
                name: call.name,
                input: call.args
              }))
            ]
      if (content.length > 0) messages.push({ role: 'assistant', content })
    }
  }

  const tools: Anthropic.Tool[] = request.tools.map((tool, index) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters as Anthropic.Tool.InputSchema,
    ...(index === request.tools.length - 1 ? { cache_control: { type: 'ephemeral' as const } } : {})
  }))

  const maxTokens = request.params['max_tokens']
  const body: Params = {
    model: request.model,
    max_tokens: typeof maxTokens === 'number' ? maxTokens : DEFAULT_MAX_TOKENS,
    messages,
    ...(request.system.length > 0 ? { system: systemBlocks(request.system) } : {}),
    ...(tools.length > 0 ? { tools } : {})
  }

  const outputConfig: NonNullable<Params['output_config']> = {}
  if (effort !== '') {
    body.thinking = { type: 'adaptive' }
    outputConfig.effort = effort as Effort
  }
  // An OpenAI-style response schema becomes Claude's structured output.
  const format = request.params['response_format']
  if (isRecord(format) && format['type'] === 'json_schema' && isRecord(format['json_schema'])) {
    const schema = format['json_schema']['schema']
    if (isRecord(schema)) outputConfig.format = { type: 'json_schema', schema }
  }
  if (Object.keys(outputConfig).length > 0) body.output_config = outputConfig
  return body
}

/** The ModelResponse for one Claude message. Throws ModelError when it has nothing usable. Pure. */
export function fromMessage(message: Anthropic.Message, prices: AnthropicClientOptions['prices']): ModelResponse {
  if (message.stop_reason === 'refusal') throw new ModelError('refusal', 'stop_reason refusal')
  const text = message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')
  const toolCalls: ToolCallRequest[] = message.content.flatMap((block) =>
    block.type === 'tool_use'
      ? [{ id: block.id, name: block.name, args: isRecord(block.input) ? block.input : {} }]
      : []
  )
  if (text === '' && toolCalls.length === 0) {
    throw new ModelError('malformed', `response has no text and no tool calls (stop_reason ${message.stop_reason})`)
  }

  const usage = message.usage
  const uncached = usage.input_tokens
  const cacheRead = usage.cache_read_input_tokens ?? 0
  const cacheWrite = usage.cache_creation_input_tokens ?? 0
  const costUsd =
    ((uncached + cacheWrite * CACHE_WRITE_FACTOR) * prices.usdPerMTokIn +
      cacheRead * prices.usdPerMTokCached +
      usage.output_tokens * prices.usdPerMTokOut) /
    1_000_000

  const thought = message.content.some((block) => block.type === 'thinking' || block.type === 'redacted_thinking')
  return {
    text,
    toolCalls,
    usage: {
      inputTokens: uncached + cacheRead + cacheWrite,
      outputTokens: usage.output_tokens,
      cachedTokens: cacheRead
    },
    costUsd,
    model: message.model,
    ...(thought && toolCalls.length > 0 ? { replay: { provider: 'anthropic', blocks: message.content } } : {})
  }
}

export function createAnthropicClient(options: AnthropicClientOptions): ModelClient {
  // The routed client owns retries and fallback, so the SDK makes one attempt.
  const client = new Anthropic({
    apiKey: options.apiKey,
    baseURL: options.baseUrl.replace(/\/+$/, ''),
    maxRetries: 0,
    ...(options.fetch ? { fetch: options.fetch } : {})
  })

  return {
    async call(request, signal) {
      if (signal?.aborted) throw new ModelError('transient', 'aborted')
      let message: Anthropic.Message
      try {
        message = await client.messages.create(toMessagesBody(request, options.effort), signal ? { signal } : {})
      } catch (err) {
        if (err instanceof APIUserAbortError || signal?.aborted) {
          throw new ModelError('transient', 'aborted', { cause: err })
        }
        if (err instanceof APIConnectionError) {
          throw new ModelError('transient', 'provider connection failed')
        }
        if (err instanceof APIError && err.status !== undefined) {
          throw errorForStatus(err.status, JSON.stringify(err.error))
        }
        throw new ModelError('malformed', 'unexpected provider response')
      }
      return fromMessage(message, options.prices)
    }
  }
}
