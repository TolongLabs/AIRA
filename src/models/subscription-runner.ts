import type { Logger } from '../records/logger.js'
import type { ModelCallRecord, ReplyTarget, RunResult, TurnRunner } from '../turn/types.js'
import type { Breaker } from './breaker.js'
import type { ToolServer } from './tool-server.js'
import { ModelError, type ModelFailureKind, type ModelMessage, type ModelUsage, type PromptBlock } from './types.js'

export interface SubscriptionRunnerOptions {
  /** `config.llm.subscription` */
  subscription: { runnerUrl: string; toolServerUrl: string }
  /** `llm.main.model` and `llm.main.effort`: both transports run the same model at the same effort. */
  model: string
  /** Empty: `medium`, Claude Haiku 5.5's own default (docs/trd/models.md#run-request). */
  effort: string
  /** Effort on a `/think` turn. Empty means normal `effort`. */
  deepEffort?: string
  /** The shared secret of the core and the host runner service. */
  role?: 'main' | 'fallback'
  runnerToken: string
  toolServer: ToolServer
  breaker: Breaker
  /** Answers when the subscription cannot: the API runner on the fallback model. */
  fallback?: TurnRunner
  onAuthFailure?: (role: string) => void
  fetch?: typeof fetch
  logger: Logger
  now?: () => Date
}

interface RunnerResultLine {
  type: 'result'
  subtype?: string
  is_error?: boolean
  /** The HTTP status of a failed model call, when the program reports one. */
  api_error_status?: unknown
  result?: unknown
  total_cost_usd?: unknown
  usage?: {
    input_tokens?: unknown
    output_tokens?: unknown
    cache_read_input_tokens?: unknown
    cache_creation_input_tokens?: unknown
  }
}

/** The window as the one prompt the program takes. Exported for the tests. */
export function renderPrompt(messages: ModelMessage[]): string {
  const last = messages[messages.length - 1]
  if (!last) return ''
  if (messages.length === 1) return last.content
  const earlier = messages.slice(0, -1).map((msg) => {
    const cleaned = msg.content.replace(/\r\n|\r|\n/g, ' ').replace(/<\/conversation/gi, '')
    return `${msg.role}: ${cleaned}`
  })
  return `<conversation untrusted="true">\n${earlier.join('\n')}\n</conversation>\n\n${last.content}`
}

/** The system prompt: the blocks' texts joined by a blank line, with each offered tool's list line renamed. */
export function renderSystem(system: PromptBlock[], toolNames: string[]): string {
  const joined = system.map((block) => block.text).join('\n\n')
  if (toolNames.length === 0) return joined
  const offered = new Set(toolNames)
  return joined
    .split('\n')
    .map((line) => {
      if (!line.startsWith('- ')) return line
      const colon = line.indexOf(':', 2)
      if (colon === -1) return line
      const name = line.slice(2, colon)
      if (!offered.has(name)) return line
      return `- mcp__aira__${name}${line.slice(colon)}`
    })
    .join('\n')
}

/** A failed run's kind: by the HTTP status first, then the program's own error flag, then the text. */
function classifyFailure(result: RunnerResultLine, assistantError: string | undefined): ModelFailureKind {
  const status = typeof result.api_error_status === 'number' ? result.api_error_status : undefined
  if (status === 429 || status === 529) return 'rate_limit'
  if (status === 401 || status === 403) return 'auth'
  if (assistantError === 'rate_limit') return 'rate_limit'
  if (assistantError === 'authentication_failed') return 'auth'
  return classifyErrorText(typeof result.result === 'string' ? result.result : '')
}

function classifyErrorText(text: string): ModelFailureKind {
  // "You've hit your session limit" is the real program's text for a spent subscription (measured on the host).
  if (/rate limit|usage limit|session limit|limit reached|overloaded/i.test(text)) return 'rate_limit'
  if (/log ?in|auth|credential|expired/i.test(text)) return 'auth'
  return 'malformed'
}

export function createSubscriptionRunner(options: SubscriptionRunnerOptions): TurnRunner {
  const now = options.now ?? (() => new Date())
  const fetchImpl = options.fetch ?? fetch

  return {
    async run(input): Promise<RunResult> {
      const pinned = input.replyTarget
      // The fallback model's answer, recorded under the fallback role.
      const answerFromFallback = async (
        fallback: TurnRunner,
        failedCall?: ModelCallRecord,
        replyTarget?: ReplyTarget
      ): Promise<RunResult> => {
        const answer = await fallback.run({
          ...input,
          replyTarget,
          onCall: (call) => {
            call.role = 'fallback'
            input.onCall?.(call)
          }
        })
        return {
          ...answer,
          role: 'fallback',
          calls: failedCall ? [failedCall, ...answer.calls] : answer.calls
        }
      }
      // A regeneration stays on the route that gave the reply: it fails rather than moving to another model.
      const runFallback = async (error: ModelError, failedCall?: ModelCallRecord): Promise<RunResult> => {
        if (!pinned && error.kind !== 'refusal' && options.fallback && !input.signal.aborted) {
          return answerFromFallback(options.fallback, failedCall)
        }
        throw error
      }
      if (pinned?.transport === 'api') {
        if (!options.fallback) throw new ModelError('transient', 'the reply route is not configured')
        // The fallback runner has one slot, its main model, and that slot is the route that gave the reply.
        return answerFromFallback(options.fallback, undefined, { ...pinned, role: 'main' })
      }

      if (options.breaker.isOpen(options.role ?? 'main')) {
        return runFallback(new ModelError('rate_limit', 'subscription breaker is open'))
      }

      const startedAt = now()
      const session = options.toolServer.open({
        turnId: input.context.turnId,
        tools: input.tools,
        firstTool: input.firstTools?.[0],
        maxToolCalls: input.maxToolCalls,
        signal: input.signal
      })

      let initModel: string | undefined
      let failure: ModelError | undefined
      let rawText = ''
      const rawEffort = input.context.think && options.deepEffort ? options.deepEffort : options.effort
      const effort = rawEffort === '' ? 'medium' : rawEffort

      try {
        const timeoutMs = Math.max(1000, input.context.deadline - startedAt.getTime())
        const system = renderSystem(
          input.system,
          input.tools.map((tool) => tool.schema.name)
        )
        const prompt = renderPrompt(input.messages)
        const payload: Record<string, unknown> = {
          system,
          prompt,
          // The envelope always names the tool server. With no tools offered its session lists none, so the program
          // has no tools (docs/trd/models.md#run-request).
          tools: { url: options.subscription.toolServerUrl, token: session.token },
          timeoutMs
        }
        if (options.model !== '') payload['model'] = options.model
        payload['effort'] = effort

        let response: Response
        try {
          response = await fetchImpl(`${options.subscription.runnerUrl}/run`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${options.runnerToken}`
            },
            body: JSON.stringify(payload),
            signal: input.signal
          })
        } catch {
          failure = new ModelError('transient', 'subscription runner request failed')
          response = undefined as never
        }

        if (!failure) {
          if (response.status === 401 || response.status === 403) {
            failure = new ModelError('auth', 'subscription runner authentication failed')
          } else if (response.status >= 500) {
            failure = new ModelError('transient', `subscription runner returned HTTP ${response.status}`)
          } else if (!response.ok) {
            failure = new ModelError('malformed', `subscription runner returned HTTP ${response.status}`)
          } else {
            try {
              rawText = await response.text()
            } catch {
              failure = new ModelError('transient', 'subscription runner stream failed')
            }
          }
        }
      } finally {
        session.end()
      }

      if (!failure) {
        if (input.signal.aborted) {
          failure = new ModelError('transient', 'aborted')
        } else {
          let lastResult: RunnerResultLine | undefined
          let runnerError: string | undefined
          let assistantError: string | undefined
          for (const line of rawText.split('\n')) {
            const trimmed = line.trim()
            if (trimmed === '') continue
            let parsed: Record<string, unknown>
            try {
              parsed = JSON.parse(trimmed) as Record<string, unknown>
            } catch {
              continue
            }
            if (parsed['type'] === 'runner_error') {
              runnerError = typeof parsed['kind'] === 'string' ? parsed['kind'] : 'unknown'
            } else if (
              parsed['type'] === 'system' &&
              parsed['subtype'] === 'init' &&
              typeof parsed['model'] === 'string'
            ) {
              initModel = parsed['model']
            } else if (parsed['type'] === 'result') {
              lastResult = parsed as unknown as RunnerResultLine
            } else if (parsed['type'] === 'assistant' && typeof parsed['error'] === 'string') {
              assistantError = parsed['error']
            }
          }

          // A failed result says why the run failed. The program then exits with an error, so the runner's exit line
          // is only the cause when no failed result came.
          if (lastResult && (lastResult.is_error === true || lastResult.subtype !== 'success')) {
            failure = new ModelError(classifyFailure(lastResult, assistantError), 'subscription run failed')
          } else if (runnerError !== undefined) {
            failure = new ModelError('transient', `subscription runner error: ${runnerError}`)
          } else if (!lastResult) {
            failure = new ModelError('malformed', 'subscription runner returned no result')
          } else if (typeof lastResult.result !== 'string' || lastResult.result === '') {
            failure = new ModelError('malformed', 'subscription runner returned an empty result')
          } else {
            const durationMs = Math.max(0, now().getTime() - startedAt.getTime())
            const model = initModel ?? (options.model || 'subscription')
            // The program reports input without its cache reads and writes; count them in, as the API runner does.
            const cacheRead = Number(lastResult.usage?.cache_read_input_tokens ?? 0)
            const cacheWrite = Number(lastResult.usage?.cache_creation_input_tokens ?? 0)
            const usage: ModelUsage = {
              inputTokens: Number(lastResult.usage?.input_tokens ?? 0) + cacheRead + cacheWrite,
              outputTokens: Number(lastResult.usage?.output_tokens ?? 0),
              cachedTokens: cacheRead
            }
            const costUsd = typeof lastResult.total_cost_usd === 'number' ? lastResult.total_cost_usd : 0
            const call: ModelCallRecord = {
              role: options.role ?? 'main',
              model,
              transport: 'subscription',
              effort,
              attempt: 1,
              startedAt,
              durationMs,
              usage,
              costUsd
            }
            input.onCall?.(call)
            return {
              text: lastResult.result,
              usage,
              costUsd,
              model,
              role: options.role ?? 'main',
              transport: 'subscription',
              calls: [call],
              toolMs: session.state.toolMs,
              chainLimit: session.state.chainLimit,
              receipts: session.state.receipts
            }
          }
        }
      }

      if (failure.kind === 'rate_limit' || failure.kind === 'auth') {
        options.breaker.open(options.role ?? 'main')
      }
      if (failure.kind === 'auth') {
        options.onAuthFailure?.(options.role ?? 'main')
      }
      options.logger.warn('subscription_run_failed', {
        turnId: input.context.turnId,
        kind: failure.kind
      })

      const failedCall: ModelCallRecord = {
        role: options.role ?? 'main',
        model: initModel ?? (options.model || 'subscription'),
        transport: 'subscription',
        effort,
        attempt: 1,
        startedAt,
        durationMs: Math.max(0, now().getTime() - startedAt.getTime()),
        error: failure,
        failureKind: failure.kind
      }
      input.onCall?.(failedCall)
      if (session.state.toolCalls > 0) throw failure
      return runFallback(failure, failedCall)
    }
  }
}

/** An API regeneration is pinned. A new turn can change transport only before any tool executes. */
export function withSubscriptionFallback(api: TurnRunner, wrapper: TurnRunner): TurnRunner {
  return {
    async run(input) {
      if (input.replyTarget?.transport === 'subscription') return wrapper.run(input)
      if (input.replyTarget) return api.run(input)
      let usedTool = false
      const attempts: ModelCallRecord[] = []
      const tools = input.tools.map((tool) => ({
        ...tool,
        call: (...args: Parameters<typeof tool.call>) => {
          usedTool = true
          return tool.call(...args)
        }
      }))
      try {
        return await api.run({
          ...input,
          tools,
          onCall: (call) => {
            attempts.push(call)
            input.onCall?.(call)
          }
        })
      } catch (error) {
        if (
          usedTool ||
          input.signal.aborted ||
          !(error instanceof ModelError) ||
          error.kind === 'refusal' ||
          error.kind === 'budget'
        )
          throw error
        const result = await wrapper.run(input)
        return { ...result, calls: [...attempts, ...result.calls] }
      }
    }
  }
}
