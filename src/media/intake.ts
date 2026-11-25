import { ModelError, type ModelFailureKind, type ModelUsage } from '../models/types.js'
import {
  type MediaReading,
  MediaWatchError,
  type MediaWatcher,
  type MediaWatchFailureDetail,
  type WatchResult,
  type WatchUrlSource
} from './gemini-watcher.js'
import { type MediaFile, type MediaKind, type MediaLimits, mediaFault, mediaKindOf } from './limits.js'
import { sanitizeMediaText } from './text.js'

export { sanitizeMediaText } from './text.js'

export interface MediaIntakeOptions {
  watcher?: MediaWatcher
  limits: MediaLimits
  timeoutMs: number
}

type MediaLimitFault = 'unsupported type' | 'empty file' | 'too large' | 'too long'

export type MediaFailureReason = MediaLimitFault | 'off' | 'unavailable' | 'unreadable'

export type MediaOutcome =
  | { ok: true; kind: MediaKind; reading: MediaReading; usage: ModelUsage; model: string; durationMs: number }
  | {
      ok: false
      kind?: MediaKind
      reason: MediaFailureReason
      failureKind?: ModelFailureKind
      failureDetail?: MediaWatchFailureDetail
      error?: unknown
      durationMs: number
    }

function faultReason(fault: string): Exclude<MediaFailureReason, 'off'> {
  if (
    fault === 'unsupported type' ||
    fault === 'empty file' ||
    fault === 'too large' ||
    fault === 'too long' ||
    fault === 'unavailable'
  ) {
    return fault
  }
  return 'unreadable'
}

function isUnavailableError(err: unknown): boolean {
  return (
    err instanceof ModelError &&
    err.kind === 'malformed' &&
    ((err instanceof MediaWatchError && err.detail.type === 'unavailable') ||
      /cannot fetch content|not available|private/i.test(err.message))
  )
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt))
}

function failureDetailFor(err: unknown, timedOut: boolean, signal?: AbortSignal): MediaWatchFailureDetail | undefined {
  if (timedOut) return { type: 'timeout' }
  if (err instanceof MediaWatchError) {
    if (isUnavailableError(err)) {
      return { type: 'unavailable' }
    }
    return err.detail
  }
  if (err instanceof ModelError && err.kind !== 'transient') {
    if (isUnavailableError(err)) return { type: 'unavailable' }
    switch (err.kind) {
      case 'rate_limit':
        return { type: 'rate_limit' }
      case 'auth':
        return { type: 'auth' }
      case 'refusal':
        return { type: 'refusal' }
      case 'malformed':
        return { type: 'parse' }
      case 'budget':
        return undefined
    }
  }
  if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) return { type: 'abort' }
  if (err instanceof Error && err.name === 'TimeoutError') return { type: 'timeout' }
  if (err instanceof ModelError && err.kind === 'transient') return { type: 'transient' }
  return undefined
}

async function runWithTimeout(
  call: (signal: AbortSignal) => Promise<WatchResult>,
  kind: MediaKind,
  timeoutMs: number,
  startedAt: number,
  signal?: AbortSignal
): Promise<MediaOutcome> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  const onAbort = () => {
    controller.abort()
  }
  if (signal) {
    if (signal.aborted) {
      controller.abort()
    } else {
      signal.addEventListener('abort', onAbort, { once: true })
    }
  }

  let onControllerAbort: (() => void) | undefined
  const abortPromise = new Promise<never>((_resolve, reject) => {
    if (controller.signal.aborted) {
      reject(new MediaWatchError('transient', 'aborted', { type: 'abort' }))
      return
    }
    onControllerAbort = () => {
      reject(new MediaWatchError('transient', 'aborted', { type: 'abort' }))
    }
    controller.signal.addEventListener('abort', onControllerAbort, { once: true })
  })

  try {
    const result = await Promise.race([call(controller.signal), abortPromise])
    return {
      ok: true,
      kind,
      reading: result.reading,
      usage: result.usage,
      model: result.model,
      durationMs: elapsedMs(startedAt)
    }
  } catch (err) {
    const failureKind: ModelFailureKind = timedOut ? 'transient' : err instanceof ModelError ? err.kind : 'transient'
    const reason = !timedOut && isUnavailableError(err) ? 'unavailable' : 'unreadable'
    const failureDetail = failureDetailFor(err, timedOut, signal)
    return {
      ok: false,
      kind,
      reason,
      failureKind,
      ...(failureDetail !== undefined ? { failureDetail } : {}),
      error: err,
      durationMs: elapsedMs(startedAt)
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    if (onControllerAbort !== undefined) {
      controller.signal.removeEventListener('abort', onControllerAbort)
    }
  }
}

/** Reads one file under the limits and the timeout. Never throws. */
export async function readMedia(
  file: MediaFile,
  options: MediaIntakeOptions,
  signal?: AbortSignal
): Promise<MediaOutcome> {
  const startedAt = performance.now()
  const kind = mediaKindOf(file.contentType)

  if (!options.watcher) {
    return {
      ok: false,
      ...(kind !== undefined ? { kind } : {}),
      reason: 'off',
      durationMs: elapsedMs(startedAt)
    }
  }

  const fault = mediaFault(file, options.limits)
  if (fault !== undefined) {
    return {
      ok: false,
      ...(kind !== undefined ? { kind } : {}),
      reason: faultReason(fault),
      durationMs: elapsedMs(startedAt)
    }
  }

  if (kind === undefined) {
    return { ok: false, reason: 'unsupported type', durationMs: elapsedMs(startedAt) }
  }

  return runWithTimeout(
    (abortSignal) => (options.watcher as MediaWatcher).watch(file, abortSignal),
    kind,
    options.timeoutMs,
    startedAt,
    signal
  )
}

/** Reads one video URL under the timeout. Never throws. */
export async function readMediaUrl(
  source: WatchUrlSource,
  options: Pick<MediaIntakeOptions, 'watcher' | 'timeoutMs'>,
  signal?: AbortSignal
): Promise<MediaOutcome> {
  const startedAt = performance.now()
  const watchUrl = options.watcher?.watchUrl
  if (!watchUrl) {
    return {
      ok: false,
      kind: 'video',
      reason: 'off',
      durationMs: elapsedMs(startedAt)
    }
  }
  if (signal?.aborted) {
    return {
      ok: false,
      kind: 'video',
      reason: 'unreadable',
      failureKind: 'transient',
      failureDetail: { type: 'abort' },
      error: new MediaWatchError('transient', 'aborted', { type: 'abort' }),
      durationMs: elapsedMs(startedAt)
    }
  }

  return runWithTimeout((abortSignal) => watchUrl(source, abortSignal), 'video', options.timeoutMs, startedAt, signal)
}

/** The readings as one labelled, untrusted block for prompt block 4. Empty string for no reading. */
export function mediaBlock(
  readings: { kind: MediaKind; reading: MediaReading }[],
  extraLines: readonly string[] = []
): string {
  if (readings.length === 0 && extraLines.length === 0) return ''
  const lines = ['<media untrusted="true">']
  for (const item of readings) {
    lines.push(`- ${item.kind}: ${sanitizeMediaText(item.reading.description)}`)
    if (item.reading.transcript !== undefined && item.reading.transcript.length > 0) {
      lines.push(`  transcript: ${sanitizeMediaText(item.reading.transcript)}`)
    }
  }
  lines.push(...extraLines)
  lines.push('</media>')
  return lines.join('\n')
}
