import type { MediaWatcher, WatchUrlSource } from './gemini-watcher.js'
import { type MediaOutcome, readMediaUrl } from './intake.js'

const MAX_LINK_RETRIES = 2
const MIN_RETRY_HEADROOM_MS = 5000

interface Attempt {
  ordinal: number
  attempt: 1 | 2
  startedAt: Date
  outcome: MediaOutcome
}

interface Completion extends Attempt {
  sequence: number
}

interface Retry {
  ordinal: number
  due: number
}

interface LinkWatchResult {
  attempts: Attempt[]
  final: (MediaOutcome | undefined)[]
  rateLimitStopped: boolean
}

/** One event loop for the initial parallel watches and the bounded, single retry lane. */
export async function watchLinkSegments(
  sources: readonly WatchUrlSource[],
  watcher: MediaWatcher,
  deadline: number,
  outerSignal: AbortSignal,
  now: () => Date
): Promise<LinkWatchResult> {
  const controller = new AbortController()
  const final: (MediaOutcome | undefined)[] = Array.from({ length: sources.length })
  const finished: Completion[] = []
  const completions: Completion[] = []
  let queued: Retry[] = []
  let nextSequence = 0
  let pending = 0
  let retries = 0
  let retryInFlight = false
  let rateLimits = 0
  let rateLimitStopped = false
  let cooldown = 0
  let stopped: 'timeout' | 'abort' | undefined
  let wake: (() => void) | undefined
  const remaining = () => deadline - performance.now()

  function stop(kind: 'timeout' | 'abort') {
    if (stopped) return
    stopped = kind
    queued = []
    controller.abort()
    wake?.()
  }

  const outerAbort = () => stop('abort')
  if (outerSignal.aborted) outerAbort()
  else outerSignal.addEventListener('abort', outerAbort, { once: true })
  const deadlineTimer = setTimeout(() => stop('timeout'), Math.max(0, Math.ceil(remaining())))

  function launch(ordinal: number, attempt: 1 | 2) {
    const startedAt = now()
    const timeLeft = remaining()
    if (stopped || timeLeft <= 0 || outerSignal.aborted || (attempt === 2 && timeLeft < MIN_RETRY_HEADROOM_MS)) return
    const sequence = nextSequence++
    pending++
    if (attempt === 2) {
      retries++
      retryInFlight = true
    }
    void readMediaUrl(sources[ordinal]!, { watcher, timeoutMs: Math.ceil(timeLeft) }, controller.signal).then(
      (outcome) => {
        // Timers may run late when the event loop stalls. Credit only readings completed by the monotonic
        // deadline; work observed after it is a local timeout even if the timer has not fired yet.
        const recorded: MediaOutcome =
          outcome.ok && performance.now() >= deadline
            ? {
                ok: false,
                kind: outcome.kind,
                reason: 'unreadable',
                failureKind: 'transient',
                failureDetail: { type: 'timeout' },
                durationMs: outcome.durationMs
              }
            : !outcome.ok && outcome.failureDetail?.type === 'abort' && stopped === 'timeout'
              ? { ...outcome, failureDetail: { type: 'timeout' } }
              : outcome
        completions.push({ sequence, ordinal, attempt, startedAt, outcome: recorded })
        wake?.()
      }
    )
  }

  const dueAt = (retry: Retry) => Math.max(retry.due, cooldown)

  function settle(completion: Completion) {
    pending--
    const { ordinal, attempt, outcome } = completion
    if (attempt === 2) retryInFlight = false
    finished.push(completion)
    final[ordinal] = outcome
    if (outcome.ok) return

    if (outcome.failureKind === 'auth') {
      stop('abort')
      return
    }
    const detail = outcome.failureDetail
    if (outcome.failureKind === 'rate_limit') {
      rateLimits++
      if (rateLimits >= 2) {
        rateLimitStopped = true
        queued = []
        return
      }
    }
    if (stopped || rateLimitStopped) return
    const hint = detail?.type === 'rate_limit' ? detail.retryAfterMs : undefined
    const validHint = hint !== undefined && Number.isFinite(hint) && hint >= 0
    const transient =
      outcome.failureKind === 'transient' &&
      (detail?.type === 'network' || detail?.type === 'http_transient' || detail?.type === 'transient')
    const rateLimited = outcome.failureKind === 'rate_limit' && validHint
    if (!transient && !rateLimited) return

    const backoff = 500 + Math.floor(Math.random() * 501)
    const due = performance.now() + Math.max(backoff, rateLimited ? hint : 0)
    if (rateLimited) cooldown = Math.max(cooldown, due)
    if (attempt === 1 && retries < MAX_LINK_RETRIES && deadline - Math.max(due, cooldown) >= MIN_RETRY_HEADROOM_MS) {
      queued.push({ ordinal, due })
    }
  }

  async function waitForEvent(delay?: number) {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await new Promise<void>((resolve) => {
        wake = resolve
        if (delay !== undefined) timer = setTimeout(resolve, Math.max(0, Math.ceil(delay)))
        if (completions.length > 0) resolve()
      })
    } finally {
      wake = undefined
      clearTimeout(timer)
    }
  }

  try {
    for (let ordinal = 0; ordinal < sources.length; ordinal++) launch(ordinal, 1)
    while (pending > 0 || queued.length > 0) {
      // Process every observed outcome before considering another launch, including shared-key failures.
      for (const completion of completions.splice(0)) settle(completion)
      if (outerSignal.aborted) stop('abort')
      else if (remaining() <= 0) stop('timeout')
      if (stopped || rateLimitStopped || retries >= MAX_LINK_RETRIES) queued = []
      else {
        queued = queued.filter((retry) => deadline - Math.max(performance.now(), dueAt(retry)) >= MIN_RETRY_HEADROOM_MS)
        queued.sort((a, b) => dueAt(a) - dueAt(b) || a.ordinal - b.ordinal)
      }

      const next = retryInFlight ? undefined : queued[0]
      if (next && dueAt(next) <= performance.now()) {
        queued.shift()
        launch(next.ordinal, 2)
        continue
      }
      if (pending === 0 && queued.length === 0) break
      await waitForEvent(next ? dueAt(next) - performance.now() : undefined)
    }
    return {
      attempts: finished.sort((a, b) => a.sequence - b.sequence).map(({ sequence: _sequence, ...attempt }) => attempt),
      final,
      rateLimitStopped
    }
  } finally {
    clearTimeout(deadlineTimer)
    outerSignal.removeEventListener('abort', outerAbort)
  }
}
