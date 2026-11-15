import { BaseLlm, type BaseLlmConnection, BaseTool, InMemoryRunner, LlmAgent } from '@google/adk'
import type { LlmRequest, LlmResponse, RunAsyncToolRequest } from '@google/adk'
import type { Content, FunctionDeclaration } from '@google/genai'
import type { ModelCallRecord, OfferedTool, RunResult, TurnRunner } from '../turn/types.js'
import {
  type ModelClient,
  ModelError,
  type ModelMessage,
  type ModelRequest,
  type ModelUsage,
  type PromptBlock,
  type ToolCallRequest
} from './types.js'

// The API runner (docs/trd/models.md#turn-runner-interface). The agent kit owns the loop: it asks the model,
// runs the tools the model calls, and asks again. Every model request goes through the model seam, so retries,
// the fallback and recordings see each one. The two chain limits of docs/trd/tools.md#implicit-calls end the chain.

export interface ApiRunnerOptions {
  /** Builds the client for one turn. `onCall` receives every attempt, for the model_call records. */
  clientFor: (onCall: (record: ModelCallRecord) => void) => ModelClient
  /** The model id asked of the client. A routed client replaces it per role. */
  model: string
  limits: { maxCallsPerTurn: number; timeBudgetMs: number }
  /** Sampling parameters sent with every request. */
  params?: Record<string, unknown>
  now?: () => Date
}

/** What one turn's loop shares between the model adapter and the tool adapters. */
interface LoopState {
  system: PromptBlock[]
  messages: ModelMessage[]
  tools: OfferedTool[]
  client: ModelClient
  signal: AbortSignal
  turnId: string
  toolCalls: number
  toolMs: number
  chainLimit?: 'calls' | 'time'
  usage: ModelUsage
  costUsd: number
  model: string
  text?: string
  receipts: string[]
  /** The first failure of the loop. The agent kit must not swallow it. */
  error?: unknown
}

const TRIGGER = '(turn)'

/** The loop's own steps, from the agent kit's contents: what the model called and what the tools returned. */
export function loopMessages(contents: Content[]): ModelMessage[] {
  const messages: ModelMessage[] = []
  for (const [index, content] of contents.entries()) {
    const parts = content.parts ?? []
    // The first content is the trigger that starts the run. The real window is sent in its place.
    if (index === 0 && content.role !== 'model' && parts.every((part) => part.functionResponse === undefined)) continue
    if (content.role === 'model') {
      const toolCalls: ToolCallRequest[] = parts.flatMap((part) =>
        part.functionCall
          ? [{ id: part.functionCall.id ?? '', name: part.functionCall.name ?? '', args: part.functionCall.args ?? {} }]
          : []
      )
      const text = parts.map((part) => part.text ?? '').join('')
      messages.push({ role: 'assistant', content: text, ...(toolCalls.length > 0 ? { toolCalls } : {}) })
      continue
    }
    for (const part of parts) {
      const response = part.functionResponse
      if (!response) continue
      const body = response.response as { content?: unknown } | undefined
      messages.push({
        role: 'tool',
        toolCallId: response.id ?? '',
        name: response.name ?? '',
        content: typeof body?.content === 'string' ? body.content : JSON.stringify(body ?? {})
      })
    }
  }
  return messages
}

class SeamLlm extends BaseLlm {
  constructor(
    private readonly state: LoopState,
    private readonly options: ApiRunnerOptions
  ) {
    super({ model: 'aira-model-seam' })
  }

  async *generateContentAsync(llmRequest: LlmRequest): AsyncGenerator<LlmResponse, void> {
    const { state } = this
    const request: ModelRequest = {
      role: 'main',
      model: this.options.model,
      system: state.system,
      messages: [...state.messages, ...loopMessages(llmRequest.contents)],
      // When a chain limit is reached, the tool list is withdrawn and the model answers with what it has.
      tools: state.chainLimit ? [] : state.tools.map((tool) => tool.schema),
      params: this.options.params ?? {}
    }
    try {
      const response = await state.client.call(request, state.signal)
      state.usage.inputTokens += response.usage.inputTokens
      state.usage.outputTokens += response.usage.outputTokens
      state.usage.cachedTokens += response.usage.cachedTokens
      state.costUsd += response.costUsd
      state.model = response.model
      const toolCalls = state.chainLimit ? [] : response.toolCalls
      if (toolCalls.length === 0) {
        if (response.text.trim() === '')
          throw new ModelError('malformed', 'the model returned no text and no tool call')
        state.text = response.text
      }
      yield {
        content: {
          role: 'model',
          parts: [
            ...(response.text === '' ? [] : [{ text: response.text }]),
            ...toolCalls.map((call) => ({ functionCall: { id: call.id, name: call.name, args: call.args } }))
          ]
        },
        turnComplete: true
      }
    } catch (error) {
      state.error ??= error
      throw error
    }
  }

  async connect(): Promise<BaseLlmConnection> {
    throw new Error('the model seam has no live connection')
  }
}

class SeamTool extends BaseTool {
  constructor(
    private readonly tool: OfferedTool,
    private readonly state: LoopState,
    private readonly options: ApiRunnerOptions
  ) {
    super({ name: tool.schema.name, description: tool.schema.description })
  }

  // The model adapter sends the registry's own schema. The agent kit only needs a declaration to route the call.
  override _getDeclaration(): FunctionDeclaration {
    return { name: this.name, description: this.description }
  }

  async runAsync({ args, toolContext }: RunAsyncToolRequest): Promise<unknown> {
    const { state, options } = this
    const now = options.now ?? (() => new Date())
    if (state.toolCalls >= options.limits.maxCallsPerTurn) state.chainLimit ??= 'calls'
    else if (state.toolMs >= options.limits.timeBudgetMs) state.chainLimit ??= 'time'
    if (state.chainLimit) {
      return { content: JSON.stringify({ error: 'refused', reason: 'the tool limit for this turn is reached' }) }
    }
    state.toolCalls += 1
    const callId = `${state.turnId}:${toolContext.functionCallId ?? state.toolCalls}`
    const started = now().getTime()
    try {
      // A handler never throws into the loop: a failure is a typed result the model can read.
      const result = await this.tool.call(args, callId, state.signal)
      if (result.receiptId) state.receipts.push(result.receiptId)
      return { content: result.content }
    } catch {
      return { content: JSON.stringify({ error: 'error', reason: 'the tool failed' }) }
    } finally {
      state.toolMs += now().getTime() - started
      if (state.toolCalls >= options.limits.maxCallsPerTurn) state.chainLimit ??= 'calls'
      else if (state.toolMs >= options.limits.timeBudgetMs) state.chainLimit ??= 'time'
    }
  }
}

export function createApiRunner(options: ApiRunnerOptions): TurnRunner {
  return {
    async run({ system, messages, tools, context, signal }): Promise<RunResult> {
      const calls: ModelCallRecord[] = []
      const state: LoopState = {
        system,
        messages,
        tools,
        client: options.clientFor((record) => calls.push(record)),
        signal,
        turnId: context.turnId,
        toolCalls: 0,
        toolMs: 0,
        usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
        costUsd: 0,
        model: options.model,
        receipts: []
      }
      const agent = new LlmAgent({
        name: 'turn',
        model: new SeamLlm(state, options),
        tools: tools.map((tool) => new SeamTool(tool, state, options))
      })
      const runner = new InMemoryRunner({ agent, appName: 'aira' })
      try {
        const events = runner.runEphemeral({
          userId: context.chat.chatId,
          newMessage: { role: 'user', parts: [{ text: TRIGGER }] }
        })
        for await (const event of events) {
          if (state.error !== undefined || signal.aborted) break
          // The reply is taken from the model adapter, so nothing the agent kit adds can reach the chat.
          void event
        }
      } catch (error) {
        state.error ??= error
      }
      if (state.error !== undefined) {
        if (state.error instanceof ModelError) throw state.error
        throw new ModelError('transient', 'the agent loop failed', { cause: state.error })
      }
      if (signal.aborted) throw new ModelError('transient', 'aborted')
      if (state.text === undefined) throw new ModelError('malformed', 'the loop ended with no reply')
      const last = calls[calls.length - 1]
      return {
        text: state.text,
        usage: state.usage,
        costUsd: state.costUsd,
        model: state.model,
        role: last?.role ?? 'main',
        transport: 'api',
        calls,
        chainLimit: state.chainLimit,
        receipts: state.receipts
      }
    }
  }
}
