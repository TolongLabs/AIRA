import { ModelError, type ModelFailureKind, type ModelUsage } from '../models/types.js'
import type { MediaReading, MediaWatcher, WatchResult, WatchUrlSource } from './gemini-watcher.js'
import { type MediaFile, type MediaKind, type MediaLimits, mediaFault, mediaKindOf } from './limits.js'

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
    /cannot fetch content|not available|private/i.test(err.message)
  )
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

  const abortPromise = new Promise<never>((_resolve, reject) => {
    if (controller.signal.aborted) {
      reject(new ModelError('transient', 'aborted'))
      return
    }
    controller.signal.addEventListener(
      'abort',
      () => {
        reject(new ModelError('transient', 'aborted'))
      },
      { once: true }
    )
  })

  try {
    const result = await Promise.race([call(controller.signal), abortPromise])
    return {
      ok: true,
      kind,
      reading: result.reading,
      usage: result.usage,
      model: result.model,
      durationMs: Date.now() - startedAt
    }
  } catch (err) {
    const failureKind: ModelFailureKind = timedOut ? 'transient' : err instanceof ModelError ? err.kind : 'transient'
    const reason = !timedOut && isUnavailableError(err) ? 'unavailable' : 'unreadable'
    return {
      ok: false,
      kind,
      reason,
      failureKind,
      durationMs: Date.now() - startedAt
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/** Reads one file under the limits and the timeout. Never throws. */
export async function readMedia(
  file: MediaFile,
  options: MediaIntakeOptions,
  signal?: AbortSignal
): Promise<MediaOutcome> {
  const startedAt = Date.now()
  const kind = mediaKindOf(file.contentType)

  if (!options.watcher) {
    return {
      ok: false,
      ...(kind !== undefined ? { kind } : {}),
      reason: 'off',
      durationMs: Date.now() - startedAt
    }
  }

  const fault = mediaFault(file, options.limits)
  if (fault !== undefined) {
    return {
      ok: false,
      ...(kind !== undefined ? { kind } : {}),
      reason: faultReason(fault),
      durationMs: Date.now() - startedAt
    }
  }

  if (kind === undefined) {
    return { ok: false, reason: 'unsupported type', durationMs: Date.now() - startedAt }
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
  const startedAt = Date.now()
  const watchUrl = options.watcher?.watchUrl
  if (!watchUrl) {
    return {
      ok: false,
      kind: 'video',
      reason: 'off',
      durationMs: Date.now() - startedAt
    }
  }

  return runWithTimeout((abortSignal) => watchUrl(source, abortSignal), 'video', options.timeoutMs, startedAt, signal)
}

export function sanitizeMediaText(text: string): string {
  return text.replace(/<\/?media/gi, '').replace(/\r?\n|\r/g, ' ')
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
