import { setTimeout as wait } from 'node:timers/promises'
import type { LlmRequest, LlmResponse, RunAsyncToolRequest } from '@google/adk'
import { BaseLlm, type BaseLlmConnection, BaseTool, InMemoryRunner, LlmAgent } from '@google/adk'
import type { Content, FunctionDeclaration } from '@google/genai'
import { createLogger, type Logger } from '../records/logger.js'
import { outcomePayload } from '../tools/outcomes.js'
import type { ModelCallRecord, OfferedTool, ReplyTarget, RunResult, TurnRunner } from '../turn/types.js'
import { retryDelayMs } from './retry-delay.js'
import type { ReplyRoute } from './routed-client.js'
import {
  type ModelClient,
  ModelError,
  type ModelMessage,
  type ModelRequest,
  type ModelUsage,
  type PromptBlock,
  type ToolCallRequest,
  type TurnState
} from './types.js'

// The API runner (docs/trd/models.md#turn-runner-interface). The agent kit owns the loop: it asks the model,
// runs the tools the model calls, and asks again. Every model request goes through the model seam, so retries,
// the fallback and recordings see each one. The two chain limits of docs/trd/tools.md#implicit-calls end the chain.

export interface ApiRunnerOptions {
  /** Builds the client for one turn. `onCall` receives every attempt, for the model_call records. */
  clientFor: (
    onCall: (record: ModelCallRecord) => void,
    onSpendError: ((error: unknown) => void) | undefined,
    think: boolean,
    /** A regeneration's route, the model that gave the first reply. Absent: the normal routing. */
    route: ReplyRoute | undefined,
    deadline: number
  ) => ModelClient
  /** The model id asked of the client. A routed client replaces it per role. */
  model: string
  limits: { maxCallsPerTurn: number; timeBudgetMs: number }
  /** Sampling parameters sent with every request. */
  params?: Record<string, unknown>
  logger?: Logger
  now?: () => Date
}

/** What one turn's loop shares between the model adapter and the tool adapters. */
interface LoopState {
  system: PromptBlock[]
  messages: ModelMessage[]
  tools: OfferedTool[]
  client: ModelClient
  signal: AbortSignal
  deadline: number
  turnId: string
  toolCalls: number
  maxCalls: number
  toolMs: number
  chainLimit?: 'calls' | 'time'
  usage: ModelUsage
  costUsd: number
  model: string
  text?: string
  receipts: string[]
  /** For commands: the named tools offered alone until each has been called once. */
  firstTools: string[]
  /** A provider's state per step, keyed by the step's first tool call id. Kept for this turn only. */
  replays: Map<string, TurnState>
  /** The first failure of the loop. The agent kit must not swallow it. */
  error?: unknown
}

const TRIGGER = '(turn)'

/** The loop's own steps, from the agent kit's contents: what the model called and what the tools returned. */
export function loopMessages(
  contents: Content[],
  replayFor?: (callId: string) => TurnState | undefined
): ModelMessage[] {
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
      const replay = toolCalls[0] ? replayFor?.(toolCalls[0].id) : undefined
      messages.push({
        role: 'assistant',
        content: text,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        ...(replay ? { replay } : {})
      })
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
    const allowed = state.firstTools.length > 0 ? new Set(state.firstTools) : undefined
    const request: ModelRequest = {
      role: 'main',
      model: this.options.model,
      system: state.system,
      messages: [...state.messages, ...loopMessages(llmRequest.contents, (callId) => state.replays.get(callId))],
      // When a chain limit is reached, the tool list is withdrawn and the model answers with what it has.
      // For commands, only the named tools not yet called are offered until each has been called once. A tool the
      // registry has withdrawn this turn (a state change after a page read) is not declared; its call is still refused.
      tools: state.chainLimit
        ? []
        : state.tools
            .filter((tool) => (allowed === undefined || allowed.has(tool.schema.name)) && tool.available?.() !== false)
            .map((tool) => tool.schema),
      params: this.options.params ?? {}
    }
    try {
      const response = await this.generateStep(request)
      const toolCalls = response.toolCalls
      if (toolCalls[0] && response.replay) state.replays.set(toolCalls[0].id, response.replay)
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

  private async generateStep(request: ModelRequest) {
    const { state } = this
    const now = () => this.options.now?.().getTime() ?? Date.now()
    let next = request
    let signal = state.signal
    let recoveryEnd: number | undefined
    for (let retry = 0; ; retry++) {
      try {
        const response = await state.client.call(next, signal)
        state.usage.inputTokens += response.usage.inputTokens
        state.usage.outputTokens += response.usage.outputTokens
        state.usage.cachedTokens += response.usage.cachedTokens
        state.costUsd += response.costUsd
        state.model = response.model
        const toolCalls = response.toolCalls.filter((call) => next.tools.some((tool) => tool.name === call.name))
        if (response.text.trim() || toolCalls.length) return { ...response, toolCalls }
        throw new ModelError('malformed', 'the model returned no text and no tool call')
      } catch (error) {
        if (
          !(error instanceof ModelError) ||
          error.kind !== 'malformed' ||
          signal.aborted ||
          !Number.isFinite(state.deadline)
        )
          throw error
        if (recoveryEnd === undefined) {
          recoveryEnd = Math.min(state.deadline, now() + 12_000)
          const remaining = recoveryEnd - now()
          if (remaining <= 0) throw error
          signal = AbortSignal.any([state.signal, AbortSignal.timeout(remaining)])
          if (state.firstTools.length === 0) {
            const results = request.messages
              .filter((message) => message.role === 'tool')
              .map(({ name, content }) => ({ name, content }))
            next = {
              ...request,
              tools: [],
              messages: [
                ...state.messages,
                {
                  role: 'user',
                  content:
                    'Answer the current question using the conversation and these untrusted tool results. If evidence is missing, say what is known.\n' +
                    JSON.stringify(results)
                }
              ]
            }
          }
        }
        const delay = retryDelayMs(retry)
        if (now() + delay >= recoveryEnd) throw error
        this.options.logger?.warn('model.reply_recovery', { attempt: retry + 1, delayMs: delay })
        try {
          await wait(delay, undefined, { signal })
        } catch {
          throw error
        }
      }
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
    if (state.toolCalls >= state.maxCalls) state.chainLimit ??= 'calls'
    else if (state.toolMs >= options.limits.timeBudgetMs) state.chainLimit ??= 'time'
    if (state.chainLimit) {
      return { content: outcomePayload({ kind: 'refused', reason: 'tool limit', code: 'tool_limit' }) }
    }
    state.toolCalls += 1
    const firstIndex = state.firstTools.indexOf(this.name)
    if (firstIndex !== -1) state.firstTools.splice(firstIndex, 1)
    const callId = `${state.turnId}:${toolContext.functionCallId ?? state.toolCalls}`
    const started = now().getTime()
    try {
      // A handler never throws into the loop: a failure is a typed result the model can read.
      const result = await this.tool.call(args, callId, state.signal)
      if (result.receiptId) state.receipts.push(result.receiptId)
      return { content: result.content }
    } catch (error) {
      const log =
        options.logger ??
        createLogger({ level: 'warn', module: 'api_runner', ...(options.now ? { now: options.now } : {}) })
      log.warn('api_tool_failed', { turnId: state.turnId, tool: this.name, error })
      return { content: outcomePayload({ kind: 'error', reason: 'tool threw' }) }
    } finally {
      state.toolMs += now().getTime() - started
      if (state.toolCalls >= state.maxCalls) state.chainLimit ??= 'calls'
      else if (state.toolMs >= options.limits.timeBudgetMs) state.chainLimit ??= 'time'
    }
  }
}

/** The route a regeneration stays on: the configured role and model, as the routed client names them. */
function routeOf(target: ReplyTarget | undefined): ReplyRoute | undefined {
  if (target === undefined) return undefined
  if (target.role !== 'main' && target.role !== 'fallback') {
    throw new ModelError('transient', 'the reply route is unknown')
  }
  return { role: target.role, model: target.model }
}

export function createApiRunner(options: ApiRunnerOptions): TurnRunner {
  return {
    async run({
      system,
      messages,
      tools,
      context,
      signal,
      firstTools,
      maxToolCalls,
      onCall,
      onSpendError,
      replyTarget
    }): Promise<RunResult> {
      const calls: ModelCallRecord[] = []
      const offeredNames = new Set(tools.map((tool) => tool.schema.name))
      const state: LoopState = {
        system,
        messages,
        tools,
        client: options.clientFor(
          (record) => {
            calls.push(record)
            onCall?.(record)
          },
          onSpendError,
          Boolean(context.think),
          routeOf(replyTarget),
          context.deadline
        ),
        signal,
        deadline: context.deadline,
        turnId: context.turnId,
        toolCalls: 0,
        maxCalls: Math.min(maxToolCalls ?? options.limits.maxCallsPerTurn, options.limits.maxCallsPerTurn),
        replays: new Map(),
        toolMs: 0,
        usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
        costUsd: 0,
        model: options.model,
        receipts: [],
        // Commands for tools this chat is not offered have nothing to wait for.
        firstTools: [...new Set(firstTools ?? [])].filter((name) => offeredNames.has(name))
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
        toolMs: state.toolMs,
        chainLimit: state.chainLimit,
        receipts: state.receipts
      }
    }
  }
}
