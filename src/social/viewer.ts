import { createLogger, type Logger } from '../records/logger.js'
import { type ChainAttempt, type ChainOutcome, runChain } from './chain.js'
import { checkedFetcher, type Lookup } from './fetch.js'
import {
  BlueskyPdsDirectory,
  DEFAULT_HTTP_READER_TIMEOUT_MS,
  DEFAULT_YTDLP_TIMEOUT_MS,
  readersFor,
  requiresExtractor,
  type SocialMirrorSettings
} from './readers.js'
import { resolveShareLink } from './share.js'
import type { PostField, SocialLookupTrace, SocialPost, SocialPostLookup } from './types.js'
import type { SocialPlatform, SocialPostTarget } from './urls.js'
import { runYtDlp } from './yt-dlp.js'

export interface SocialPostSettings {
  mirrors?: SocialMirrorSettings
  /** The deadline of one lookup, across every reader. */
  timeoutMs: number
  httpReaderTimeoutMs?: number
  ytDlpTimeoutMs?: number
  maxTextChars: number
  cacheTtlMs: number
  maxCacheEntries: number
  ytDlpPath: string
}

export interface SocialPostViewerDependencies {
  lookup?: Lookup
  logger?: Logger
  fetcher?: typeof fetch
  runExtractor?: typeof runYtDlp
  now?: () => number
  warn?: (platform: SocialPlatform, reason: string) => void
}

type ReadResult =
  | { status: 'found'; post: SocialPost; missing: PostField[] }
  | { status: 'failed'; reason: string; canonicalUrl?: string }

function failure(platform: SocialPlatform, reason: string, canonicalUrl?: string): SocialPostLookup {
  return { status: 'failed', platform, reason, ...(canonicalUrl ? { canonicalUrl } : {}) }
}

function found(post: SocialPost, missing: PostField[], target: SocialPostTarget): SocialPostLookup {
  return { status: 'found', post: { ...post, target }, ...(missing.length > 0 ? { missing } : {}) }
}

const SILENT_FALLBACK_READERS: ReadonlySet<string> = new Set([
  'instagram.page',
  'facebook.page',
  'reddit.feed',
  'youtube.oembed'
])

const FIXED_REASONS: ReadonlySet<string> = new Set([
  'timeout',
  'redirect',
  'network_error',
  'no_post_data',
  'missing_post',
  'identity_mismatch',
  'binary_missing',
  'invalid_did',
  'invalid_json',
  'empty_output',
  'output_too_large',
  'spawn_error',
  'unsupported',
  'unsupported_url'
])

function safeReason(reason: string | undefined): string | undefined {
  if (reason === undefined) return undefined
  if (FIXED_REASONS.has(reason) || /^http_\d{3}$/.test(reason) || /^exit_(?:\d+|unknown)$/.test(reason)) {
    return reason
  }
  return 'unknown'
}

function isReportableFailure(attempt: ChainAttempt): boolean {
  if (attempt.reason === undefined) return false
  if (attempt.readerId === 'reddit.feed') {
    return attempt.reason === 'http_403' || attempt.reason === 'http_429'
  }
  return !SILENT_FALLBACK_READERS.has(attempt.readerId)
}

/** The first reportable reason an attempt gave. Silent fallback readers stay internal so the next reader reports. */
function reasonOf(outcome: Extract<ChainOutcome, { status: 'failed' }>): string {
  return outcome.attempts.find(isReportableFailure)?.reason ?? 'no_post_data'
}

/** Resolves to `onAbort` as soon as the signal aborts, even when the work ignores it. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal, onAbort: T): Promise<T> {
  if (signal.aborted) return Promise.resolve(onAbort)
  return new Promise((resolve, reject) => {
    const done = () => resolve(onAbort)
    signal.addEventListener('abort', done, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', done)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', done)
        reject(error)
      }
    )
  })
}

export class SocialPostViewer {
  private readonly cache = new Map<string, { post: SocialPost; missing: PostField[]; expiresAt: number }>()
  private readonly shareCache = new Map<string, { target: SocialPostTarget; expiresAt: number }>()
  private readonly pds: BlueskyPdsDirectory
  private ytDlpAvailable = true
  private readonly fetcher: typeof fetch
  private readonly runExtractor: typeof runYtDlp
  private readonly now: () => number
  private readonly logger: Logger
  private readonly warn: (platform: SocialPlatform, reason: string) => void

  constructor(
    private readonly settings: SocialPostSettings,
    dependencies: SocialPostViewerDependencies = {}
  ) {
    this.fetcher = checkedFetcher(dependencies.fetcher ?? fetch, dependencies.lookup)
    this.pds = new BlueskyPdsDirectory(dependencies.lookup)
    this.runExtractor = dependencies.runExtractor ?? runYtDlp
    this.now = dependencies.now ?? Date.now
    const logger = dependencies.logger ?? createLogger({ level: 'warn', module: 'social' })
    this.logger = logger
    this.warn =
      dependencies.warn ??
      ((platform, reason) =>
        logger.warn('social.lookup_failed', {
          platform,
          reason
        }))
  }

  setYtDlpAvailable(available: boolean): void {
    this.ytDlpAvailable = available
  }

  async lookup(
    target: SocialPostTarget,
    signal?: AbortSignal,
    observe?: (trace: SocialLookupTrace) => void
  ): Promise<SocialPostLookup> {
    // Without the extractor, a platform that needs it stays unreadable. That is expected, not a fault to warn about.
    if (requiresExtractor(target, this.settings.mirrors) && !this.ytDlpAvailable)
      return failure(target.platform, 'binary_missing')
    const cached = this.getCached(target.lookupKey)
    // The cache key ignores timestamps, so the cached post's target may carry another link's `t=`.
    if (cached) {
      observe?.({ reason: 'cache_hit', attempts: [] })
      return found(cached.post, cached.missing, target)
    }
    if (signal?.aborted) return failure(target.platform, 'timeout')

    const result = await this.read(target, signal, observe)
    if (result.status === 'failed') return this.reportFailure(target.platform, result.reason, result.canonicalUrl)
    this.setCached(target.lookupKey, result.post, result.missing)
    return found(result.post, result.missing, target)
  }

  private reportFailure(platform: SocialPlatform, reason: string, canonicalUrl?: string): SocialPostLookup {
    this.warn(platform, reason)
    return failure(platform, reason, canonicalUrl)
  }

  private logLookup(
    platform: SocialPlatform,
    status: ChainOutcome['status'],
    attempts: readonly ChainAttempt[],
    reason?: string
  ): void {
    const safeAggregate = safeReason(reason)
    this.logger.info('social.lookup', {
      platform,
      status,
      ...(safeAggregate !== undefined ? { reason: safeAggregate } : {}),
      attempts: attempts.map((attempt) => {
        const reasonCode = safeReason(attempt.reason)
        return {
          readerId: attempt.readerId,
          ok: attempt.ok,
          ...(reasonCode !== undefined ? { reason: reasonCode } : {}),
          ms: Math.max(0, attempt.ms)
        }
      })
    })
  }

  /** One lookup under the deadline: a share resolves first, then the platform's reader chain runs. */
  private async read(
    requested: SocialPostTarget,
    signal?: AbortSignal,
    observe?: (trace: SocialLookupTrace) => void
  ): Promise<ReadResult> {
    if (this.settings.timeoutMs <= 0) {
      this.logLookup(requested.platform, 'failed', [], 'timeout')
      return { status: 'failed', reason: 'timeout' }
    }
    const needsApifyBudget =
      requested.platform === 'rednote' ||
      requested.platform === 'douyin' ||
      requested.platform === 'linkedin' ||
      (requested.platform === 'tiktok' && Boolean(this.settings.mirrors?.apifyToken))
    const lookupTimeoutMs = needsApifyBudget ? Math.max(this.settings.timeoutMs, 20_000) : this.settings.timeoutMs
    const deadlineAt = this.now() + lookupTimeoutMs
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) controller.abort()
    const timer = setTimeout(() => controller.abort(), lookupTimeoutMs)
    let resolvedCanonical: string | undefined
    let resolution: Pick<SocialLookupTrace, 'redirectHops' | 'resolveMs'> = {}
    try {
      let resolved: SocialPostTarget | null = requested
      if (requested.needsRedirect) {
        const started = this.now()
        let redirectHops = 0
        resolved = await untilAborted(
          this.resolveShare(requested, controller.signal, (count) => {
            redirectHops = count
          }),
          controller.signal,
          null
        )
        resolution = { redirectHops, resolveMs: this.now() - started }
      }
      if (controller.signal.aborted) {
        this.logLookup(requested.platform, 'failed', [], 'timeout')
        observe?.({ ...resolution, attempts: [], reason: 'timeout' })
        return { status: 'failed', reason: 'timeout' }
      }
      if (!resolved) {
        this.logLookup(requested.platform, 'failed', [], 'redirect')
        observe?.({ ...resolution, attempts: [], reason: 'redirect' })
        return { status: 'failed', reason: 'redirect' }
      }
      if (resolved.canonicalUrl !== requested.canonicalUrl) resolvedCanonical = resolved.canonicalUrl

      const outcome = await runChain(
        readersFor(resolved, {
          mirrors: this.settings.mirrors,
          ytDlpPath: this.settings.ytDlpPath,
          ytDlpAvailable: () => this.ytDlpAvailable,
          pds: this.pds,
          httpTimeoutMs: this.settings.httpReaderTimeoutMs ?? DEFAULT_HTTP_READER_TIMEOUT_MS,
          ytDlpTimeoutMs: this.settings.ytDlpTimeoutMs ?? DEFAULT_YTDLP_TIMEOUT_MS
        }),
        resolved,
        {
          signal: controller.signal,
          deadlineAt,
          now: this.now,
          fetcher: this.fetcher,
          runExtractor: this.runExtractor,
          maxTextChars: this.settings.maxTextChars,
          budgetMs: lookupTimeoutMs
        }
      )
      observe?.({ ...resolution, attempts: outcome.attempts })
      if (outcome.status === 'failed') {
        const reason = controller.signal.aborted ? 'timeout' : reasonOf(outcome)
        this.logLookup(requested.platform, 'failed', outcome.attempts, reason)
        return {
          status: 'failed',
          reason,
          ...(resolvedCanonical ? { canonicalUrl: resolvedCanonical } : {})
        }
      }
      this.logLookup(requested.platform, outcome.status, outcome.attempts)
      return { status: 'found', post: outcome.post, missing: outcome.missing }
    } catch {
      const reason = controller.signal.aborted ? 'timeout' : 'network_error'
      this.logLookup(requested.platform, 'failed', [], reason)
      return {
        status: 'failed',
        reason,
        ...(resolvedCanonical ? { canonicalUrl: resolvedCanonical } : {})
      }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
  }

  private getCached(key: string): { post: SocialPost; missing: PostField[] } | null {
    const entry = this.cache.get(key)
    if (!entry) return null
    if (entry.expiresAt <= this.now()) {
      this.cache.delete(key)
      return null
    }
    this.cache.delete(key)
    this.cache.set(key, entry)
    return entry
  }

  private setCached(key: string, post: SocialPost, missing: PostField[]): void {
    if (this.settings.cacheTtlMs === 0) return
    this.cache.delete(key)
    this.cache.set(key, { post, missing, expiresAt: this.now() + this.settings.cacheTtlMs })
    while (this.cache.size > this.settings.maxCacheEntries) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
  }

  /** A share or short link resolves first; the post keeps the link it was asked for, so both addresses close. */
  private async resolveShare(
    share: SocialPostTarget,
    signal: AbortSignal,
    onRedirect?: (count: number) => void
  ): Promise<SocialPostTarget | null> {
    const cached = this.getCachedShare(share.lookupKey)
    if (cached) return cached
    const resolved = await resolveShareLink(share, this.fetcher, signal, onRedirect)
    if (resolved) this.setCachedShare(share.lookupKey, resolved)
    return resolved
  }

  private getCachedShare(key: string): SocialPostTarget | null {
    const entry = this.shareCache.get(key)
    if (!entry) return null
    this.shareCache.delete(key)
    if (entry.expiresAt <= this.now()) return null
    this.shareCache.set(key, entry)
    return entry.target
  }

  private setCachedShare(key: string, target: SocialPostTarget): void {
    if (this.settings.cacheTtlMs === 0) return
    this.shareCache.delete(key)
    this.shareCache.set(key, { target, expiresAt: this.now() + this.settings.cacheTtlMs })
    while (this.shareCache.size > this.settings.maxCacheEntries) {
      const oldest = this.shareCache.keys().next().value
      if (oldest === undefined) break
      this.shareCache.delete(oldest)
    }
  }
}

export function createSocialPostViewer(
  settings: SocialPostSettings,
  dependencies?: SocialPostViewerDependencies
): SocialPostViewer {
  return new SocialPostViewer(settings, dependencies)
}
