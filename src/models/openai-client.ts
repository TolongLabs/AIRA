import {
  type ModelClient,
  ModelError,
  type ModelFailureKind,
  type ModelRequest,
  type ModelResponse,
  type ToolCallRequest
} from './types.js'

export interface OpenAiClientOptions {
  baseUrl: string
  apiKey: string
  /** Sent as `reasoning_effort` when not empty (docs/trd/models.md#providers-and-effort). */
  effort?: string
  /** US dollars per million tokens, used when the response reports no cost. */
  prices: { usdPerMTokIn: number; usdPerMTokOut: number; usdPerMTokCached: number }
  /** Replaces global fetch in tests. */
  fetch?: typeof fetch
}

type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | {
      role: 'assistant'
      content: string
      reasoning_content?: string
      tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
    }
  | { role: 'tool'; tool_call_id: string; content: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asNonNegativeInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function isAbortError(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true
  return err instanceof Error && err.name === 'AbortError'
}

/** The request body for one ModelRequest. Pure. */
export function toChatCompletionsBody(request: ModelRequest, effort = ''): Record<string, unknown> {
  const messages: ChatMessage[] = []
  if (request.system.length > 0) {
    messages.push({
      role: 'system',
      content: request.system.map((block) => block.text).join('\n\n')
    })
  }
  for (const msg of request.messages) {
    if (msg.role === 'user') {
      messages.push({ role: 'user', content: msg.content })
    } else if (msg.role === 'assistant') {
      const entry: ChatMessage = { role: 'assistant', content: msg.content }
      // The server's reasoning goes back with its own step. Another provider's state is dropped.
      if (msg.replay?.provider === 'openai-compatible') entry.reasoning_content = msg.replay.reasoningContent
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        entry.tool_calls = msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.args) }
        }))
      }
      messages.push(entry)
    } else {
      messages.push({ role: 'tool', tool_call_id: msg.toolCallId, content: msg.content })
    }
  }

  const body: Record<string, unknown> = {
    model: request.model,
    messages
  }
  if (request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      }
    }))
  }
  if (effort !== '') body.reasoning_effort = effort
  for (const [key, value] of Object.entries(request.params)) {
    body[key] = value
  }
  body.stream = false
  return body
}

function parseToolCalls(raw: unknown): ToolCallRequest[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) {
    throw new ModelError('malformed', 'tool_calls is not an array')
  }
  const calls: ToolCallRequest[] = []
  for (const item of raw) {
    if (!isRecord(item) || typeof item.id !== 'string' || !isRecord(item.function)) {
      throw new ModelError('malformed', 'invalid tool_call entry')
    }
    const fn = item.function
    if (typeof fn.name !== 'string' || typeof fn.arguments !== 'string') {
      throw new ModelError('malformed', 'invalid tool_call function')
    }
    let parsedArgs: unknown
    try {
      parsedArgs = JSON.parse(fn.arguments)
    } catch (cause) {
      throw new ModelError('malformed', 'tool call arguments are not valid JSON', { cause })
    }
    if (!isRecord(parsedArgs)) {
      throw new ModelError('malformed', 'tool call arguments must be a JSON object')
    }
    calls.push({ id: item.id, name: fn.name, args: parsedArgs })
  }
  return calls
}

/** The ModelResponse for one response body. Throws ModelError('malformed') when it has no usable message. Pure. */
export function fromChatCompletionsBody(body: unknown, prices: OpenAiClientOptions['prices']): ModelResponse {
  if (!isRecord(body)) {
    throw new ModelError('malformed', 'response body is not an object')
  }
  const choices = body.choices
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new ModelError('malformed', 'response has no choices')
  }
  const choice = choices[0]
  if (!isRecord(choice)) {
    throw new ModelError('malformed', 'first choice is not an object')
  }
  if (choice.finish_reason === 'content_filter') {
    throw new ModelError('refusal', 'content_filter')
  }
  const message = choice.message
  if (!isRecord(message)) {
    throw new ModelError('malformed', 'choice has no message object')
  }
  if (typeof message.refusal === 'string' && message.refusal.length > 0) {
    throw new ModelError('refusal', message.refusal)
  }

  let text = ''
  if (message.content !== undefined && message.content !== null) {
    if (typeof message.content !== 'string') {
      throw new ModelError('malformed', 'message content is not a string')
    }
    text = message.content
  }

  const toolCalls = parseToolCalls(message.tool_calls)
  if (text.length === 0 && toolCalls.length === 0) {
    throw new ModelError('malformed', 'response has no text and no tool calls')
  }

  const usageObj = isRecord(body.usage) ? body.usage : {}
  const inputTokens = asNonNegativeInt(usageObj.prompt_tokens)
  const outputTokens = asNonNegativeInt(usageObj.completion_tokens)
  const details = isRecord(usageObj.prompt_tokens_details) ? usageObj.prompt_tokens_details : {}
  const cachedTokens = asNonNegativeInt(details.cached_tokens)

  const costUsd =
    typeof usageObj.cost === 'number' && Number.isFinite(usageObj.cost)
      ? usageObj.cost
      : ((inputTokens - cachedTokens) * prices.usdPerMTokIn +
          cachedTokens * prices.usdPerMTokCached +
          outputTokens * prices.usdPerMTokOut) /
        1_000_000

  const reasoningContent = typeof message.reasoning_content === 'string' ? message.reasoning_content : ''
  return {
    text,
    toolCalls,
    usage: { inputTokens, outputTokens, cachedTokens },
    costUsd,
    model: typeof body.model === 'string' ? body.model : '',
    ...(reasoningContent === '' ? {} : { replay: { provider: 'openai-compatible', reasoningContent } })
  }
}

const REFUSAL_BODY_PATTERN = /content_policy|content_filter|safety/i

/** The ModelError for a failed HTTP response. Pure. */
export function errorForStatus(status: number, bodyText: string): ModelError {
  let kind: ModelFailureKind
  if (status === 401 || status === 403) {
    kind = 'auth'
  } else if (status === 429) {
    kind = 'rate_limit'
  } else if (status === 408 || status === 409 || status === 425 || (status >= 500 && status <= 599)) {
    kind = 'transient'
  } else if ((status === 400 || status === 422) && REFUSAL_BODY_PATTERN.test(bodyText)) {
    kind = 'refusal'
  } else {
    kind = 'malformed'
  }
  const snippet = bodyText.slice(0, 200)
  const message = snippet.length > 0 ? `HTTP ${status}: ${snippet}` : `HTTP ${status}`
  return new ModelError(kind, message)
}

export function createOpenAiClient(options: OpenAiClientOptions): ModelClient {
  const endpoint = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`
  const fetchFn = options.fetch ?? globalThis.fetch

  return {
    async call(request, signal) {
      if (signal?.aborted) {
        throw new ModelError('transient', 'aborted')
      }

      let response: Response
      try {
        response = await fetchFn(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${options.apiKey}`
          },
          body: JSON.stringify(toChatCompletionsBody(request, options.effort)),
          signal
        })
      } catch (err) {
        if (isAbortError(err, signal)) {
          throw new ModelError('transient', 'aborted', { cause: err })
        }
        const message = err instanceof Error ? err.message : 'network error'
        throw new ModelError('transient', message, { cause: err })
      }

      if (!response.ok) {
        let bodyText = ''
        try {
          bodyText = await response.text()
        } catch (err) {
          if (isAbortError(err, signal)) {
            throw new ModelError('transient', 'aborted', { cause: err })
          }
        }
        throw errorForStatus(response.status, bodyText)
      }

      let rawText: string
      try {
        rawText = await response.text()
      } catch (err) {
        if (isAbortError(err, signal)) {
          throw new ModelError('transient', 'aborted', { cause: err })
        }
        throw new ModelError('transient', err instanceof Error ? err.message : 'failed to read response', {
          cause: err
        })
      }

      let json: unknown
      try {
        json = JSON.parse(rawText)
      } catch (cause) {
        throw new ModelError('malformed', 'response body is not valid JSON', { cause })
      }

      const parsed = fromChatCompletionsBody(json, options.prices)
      return parsed.model === '' ? { ...parsed, model: request.model } : parsed
    }
  }
}
