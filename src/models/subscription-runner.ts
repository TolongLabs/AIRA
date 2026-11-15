import type { Logger } from '../records/logger.js'
import type { ModelCallRecord, RunResult, TurnRunner } from '../turn/types.js'
import type { Breaker } from './breaker.js'
import type { ToolServer } from './tool-server.js'
import { ModelError, type ModelFailureKind, type ModelMessage, type ModelUsage, type PromptBlock } from './types.js'

export interface SubscriptionRunnerOptions {
  /** `config.llm.subscription` */
  subscription: { runnerUrl: string; model: string; toolServerUrl: string }
  /** The shared secret of the core and the host runner service. */
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
  result?: unknown
  total_cost_usd?: unknown
  usage?: {
    input_tokens?: unknown
    output_tokens?: unknown
    cache_read_input_tokens?: unknown
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

function classifyErrorText(text: string): ModelFailureKind {
  if (/rate limit|usage limit|limit reached|overloaded/i.test(text)) return 'rate_limit'
  if (/log ?in|auth|credential|expired/i.test(text)) return 'auth'
  return 'malformed'
}

export function createSubscriptionRunner(options: SubscriptionRunnerOptions): TurnRunner {
  const now = options.now ?? (() => new Date())
  const fetchImpl = options.fetch ?? fetch

  return {
    async run(input): Promise<RunResult> {
      const runFallback = async (error: ModelError, failedCall?: ModelCallRecord): Promise<RunResult> => {
        if (error.kind !== 'refusal' && options.fallback && !input.signal.aborted) {
          const fallback = await options.fallback.run(input)
          return {
            ...fallback,
            role: 'fallback',
            calls: failedCall ? [failedCall, ...fallback.calls] : fallback.calls
          }
        }
        throw error
      }

      if (options.breaker.isOpen('main')) {
        return runFallback(new ModelError('rate_limit', 'subscription breaker is open'))
      }

      const startedAt = now()
      const session = options.toolServer.open({
        turnId: input.context.turnId,
        tools: input.tools,
        firstTool: input.firstTool,
        signal: input.signal
      })

      let initModel: string | undefined
      let failure: ModelError | undefined
      let rawText = ''

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
          tools: { url: options.subscription.toolServerUrl, token: session.token },
          timeoutMs
        }
        if (options.subscription.model !== '') payload['model'] = options.subscription.model

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
            }
          }

          if (runnerError !== undefined) {
            failure = new ModelError('transient', `subscription runner error: ${runnerError}`)
          } else if (!lastResult) {
            failure = new ModelError('malformed', 'subscription runner returned no result')
          } else if (lastResult.is_error === true || lastResult.subtype !== 'success') {
            const resultText = typeof lastResult.result === 'string' ? lastResult.result : ''
            failure = new ModelError(classifyErrorText(resultText), 'subscription run failed')
          } else if (typeof lastResult.result !== 'string' || lastResult.result === '') {
            failure = new ModelError('malformed', 'subscription runner returned an empty result')
          } else {
            const durationMs = Math.max(0, now().getTime() - startedAt.getTime())
            const model = initModel ?? (options.subscription.model || 'subscription')
            const usage: ModelUsage = {
              inputTokens: Number(lastResult.usage?.input_tokens ?? 0),
              outputTokens: Number(lastResult.usage?.output_tokens ?? 0),
              cachedTokens: Number(lastResult.usage?.cache_read_input_tokens ?? 0)
            }
            const costUsd = typeof lastResult.total_cost_usd === 'number' ? lastResult.total_cost_usd : 0
            return {
              text: lastResult.result,
              usage,
              costUsd,
              model,
              role: 'main',
              transport: 'subscription',
              calls: [
                {
                  role: 'main',
                  model,
                  transport: 'subscription',
                  attempt: 1,
                  startedAt,
                  durationMs,
                  usage,
                  costUsd
                }
              ],
              chainLimit: session.state.chainLimit,
              receipts: session.state.receipts
            }
          }
        }
      }

      if (failure.kind === 'rate_limit' || failure.kind === 'auth') {
        options.breaker.open('main')
      }
      if (failure.kind === 'auth') {
        options.onAuthFailure?.('main')
      }
      options.logger.warn('subscription_run_failed', {
        turnId: input.context.turnId,
        kind: failure.kind
      })

      const failedCall: ModelCallRecord = {
        role: 'main',
        model: initModel ?? (options.subscription.model || 'subscription'),
        transport: 'subscription',
        attempt: 1,
        startedAt,
        durationMs: Math.max(0, now().getTime() - startedAt.getTime()),
        failureKind: failure.kind
      }
      return runFallback(failure, failedCall)
    }
  }
}
