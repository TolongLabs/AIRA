import type { Storage } from '../storage/database.js'
import type { ModelCallRecord } from '../turn/types.js'
import type { Breaker } from './breaker.js'
import { addSpend, spendState } from './spend.js'
import { type ModelClient, ModelError, type ModelRequest, type ModelResponse } from './types.js'

export interface RoutedTarget {
  client: ModelClient
  model: string
  effort?: string
}

/** One reply's route: the configured role and model that gave it. */
export interface ReplyRoute {
  role: 'main' | 'fallback'
  model: string
}

export interface RoutedClientOptions {
  main: RoutedTarget
  fallback?: RoutedTarget
  config: { llm: { maxRetries: number; monthlyBudgetUsd: number } }
  breaker: Breaker
  storage: Storage
  /** 'api' counts against the cap. 'subscription' does not. */
  transport: 'api' | 'subscription'
  /** Called once per attempt, success or failure, so the caller can write model_call rows. */
  onCall?: (record: ModelCallRecord) => void
  onSpendError?: (error: unknown) => void
  /** Called when a role fails with auth, for the operator alert. */
  onAuthFailure?: (role: string) => void
  /** Waits between retries. Replaced in tests. Default: a timer that the signal can cut short. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  now?: () => Date
  /** A regeneration's route. Only this role and model answer, and no other target does. */
  pin?: ReplyRoute
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new ModelError('transient', 'aborted'))
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(new ModelError('transient', 'aborted'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function toModelError(err: unknown): ModelError {
  if (err instanceof ModelError) return err
  const message = err instanceof Error ? err.message : String(err)
  return new ModelError('transient', message, { cause: err })
}

export function createRoutedClient(options: RoutedClientOptions): ModelClient {
  const now = options.now ?? (() => new Date())
  const sleep = options.sleep ?? defaultSleep

  const callTarget = async (
    role: 'main' | 'fallback',
    target: RoutedTarget,
    baseRequest: ModelRequest,
    attemptState: { count: number },
    signal?: AbortSignal
  ): Promise<{ ok: true; response: ModelResponse } | { ok: false; error: ModelError }> => {
    let transientRetries = 0
    let malformedRetried = false

    while (true) {
      if (signal?.aborted) {
        throw new ModelError('transient', 'aborted')
      }

      attemptState.count += 1
      const attempt = attemptState.count
      const startedAt = now()
      const request: ModelRequest = { ...baseRequest, role, model: target.model }
      const effort = target.effort && target.effort !== '' ? target.effort : undefined

      try {
        const response = await target.client.call(request, signal)
        options.onCall?.({
          role,
          model: target.model,
          ...(effort ? { effort } : {}),
          transport: options.transport,
          attempt,
          startedAt,
          durationMs: Math.max(0, now().getTime() - startedAt.getTime()),
          usage: response.usage,
          costUsd: response.costUsd
        })
        try {
          options.storage.tx((db) => {
            addSpend(
              db,
              {
                role,
                counted: options.transport === 'api',
                costUsd: response.costUsd,
                inputTokens: response.usage.inputTokens,
                outputTokens: response.usage.outputTokens
              },
              now
            )
          })
        } catch (error) {
          options.onSpendError?.(error)
        }
        return { ok: true, response }
      } catch (rawErr) {
        const err = toModelError(rawErr)
        options.onCall?.({
          role,
          model: target.model,
          ...(effort ? { effort } : {}),
          transport: options.transport,
          attempt,
          startedAt,
          durationMs: Math.max(0, now().getTime() - startedAt.getTime()),
          error: err,
          failureKind: err.kind
        })

        if (signal?.aborted) {
          throw new ModelError('transient', 'aborted', { cause: err })
        }

        if (err.kind === 'refusal' || err.kind === 'budget') {
          throw err
        }

        if (err.kind === 'rate_limit' || err.kind === 'auth') {
          options.breaker.open(role)
          if (err.kind === 'auth') {
            options.onAuthFailure?.(role)
          }
          return { ok: false, error: err }
        }

        if (err.kind === 'malformed') {
          if (!malformedRetried) {
            malformedRetried = true
            continue
          }
          return { ok: false, error: err }
        }

        // transient
        if (transientRetries < options.config.llm.maxRetries) {
          const delayMs = 250 * 2 ** transientRetries
          transientRetries += 1
          try {
            await sleep(delayMs, signal)
          } catch (sleepErr) {
            if (signal?.aborted) {
              throw new ModelError('transient', 'aborted', { cause: sleepErr })
            }
            throw toModelError(sleepErr)
          }
          if (signal?.aborted) {
            throw new ModelError('transient', 'aborted')
          }
          continue
        }

        return { ok: false, error: err }
      }
    }
  }

  return {
    async call(request, signal) {
      if (signal?.aborted) {
        throw new ModelError('transient', 'aborted')
      }

      if (!spendState(options.storage, options.config.llm.monthlyBudgetUsd, now).repliesAllowed) {
        throw new ModelError('budget', 'monthly budget reached')
      }

      const attemptState = { count: 0 }
      if (options.pin) {
        const { role, model } = options.pin
        const target = role === 'main' ? options.main : options.fallback
        if (!target || target.model !== model) throw new ModelError('transient', 'the reply route is not configured')
        if (options.breaker.isOpen(role)) throw new ModelError('rate_limit', 'the reply route is rate limited')
        const result = await callTarget(role, target, request, attemptState, signal)
        if (result.ok) return result.response
        throw result.error
      }
      let lastError: ModelError | undefined

      if (!options.breaker.isOpen('main')) {
        const result = await callTarget('main', options.main, request, attemptState, signal)
        if (result.ok) return result.response
        lastError = result.error
      }

      if (options.fallback && !options.breaker.isOpen('fallback')) {
        const result = await callTarget('fallback', options.fallback, request, attemptState, signal)
        if (result.ok) return result.response
        lastError = result.error
      }

      throw lastError ?? new ModelError('rate_limit', 'all model breakers are open')
    }
  }
}
