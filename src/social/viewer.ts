import { createLogger, type Logger } from '../records/logger.js'
import { type ChainOutcome, runChain } from './chain.js'
import { checkedFetcher, type Lookup } from './fetch.js'
import { BlueskyPdsDirectory, DEFAULT_HTTP_READER_TIMEOUT_MS, DEFAULT_YTDLP_TIMEOUT_MS, readersFor } from './readers.js'
import { resolveShareLink } from './share.js'
import type { PostField, SocialPost, SocialPostLookup } from './types.js'
import { isFacebookPost, type SocialPlatform, type SocialPostTarget } from './urls.js'
import { runYtDlp } from './yt-dlp.js'

export interface SocialPostSettings {
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

/** Platforms whose posts only the extractor can read. Reddit, Instagram and Facebook posts also have page readers. */
function isYtDlpPlatform(target: SocialPostTarget): boolean {
  if (target.platform === 'x' || target.platform === 'bluesky' || target.platform === 'threads') return false
  if (target.platform === 'reddit' || target.platform === 'instagram' || isFacebookPost(target)) return false
  return true
}

function found(post: SocialPost, missing: PostField[], target: SocialPostTarget): SocialPostLookup {
  return { status: 'found', post: { ...post, target }, ...(missing.length > 0 ? { missing } : {}) }
}

/** The first reason an attempt gave. A reader that fails silently leaves the next reader's reason to report. */
function reasonOf(outcome: Extract<ChainOutcome, { status: 'failed' }>): string {
  return outcome.attempts.find((attempt) => attempt.reason !== undefined)?.reason ?? 'no_post_data'
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
  private readonly warn: (platform: SocialPlatform, reason: string) => void

  constructor(
    private readonly settings: SocialPostSettings,
    dependencies: SocialPostViewerDependencies = {}
  ) {
    this.fetcher = checkedFetcher(dependencies.fetcher ?? fetch, dependencies.lookup)
    this.pds = new BlueskyPdsDirectory(dependencies.lookup)
    this.runExtractor = dependencies.runExtractor ?? runYtDlp
    this.now = dependencies.now ?? Date.now
    this.warn =
      dependencies.warn ??
      ((platform, reason) =>
        (dependencies.logger ?? createLogger({ level: 'warn', module: 'social' })).warn('social.lookup_failed', {
          platform,
          reason
        }))
  }

  setYtDlpAvailable(available: boolean): void {
    this.ytDlpAvailable = available
  }

  async lookup(target: SocialPostTarget, signal?: AbortSignal): Promise<SocialPostLookup> {
    // Without the extractor, a platform that needs it stays unreadable. That is expected, not a fault to warn about.
    if (isYtDlpPlatform(target) && !this.ytDlpAvailable) return failure(target.platform, 'binary_missing')
    const cached = this.getCached(target.lookupKey)
    // The cache key ignores timestamps, so the cached post's target may carry another link's `t=`.
    if (cached) return found(cached.post, cached.missing, target)
    if (signal?.aborted) return failure(target.platform, 'timeout')

    const result = await this.read(target, signal)
    if (result.status === 'failed') return this.reportFailure(target.platform, result.reason, result.canonicalUrl)
    this.setCached(target.lookupKey, result.post, result.missing)
    return found(result.post, result.missing, target)
  }

  private reportFailure(platform: SocialPlatform, reason: string, canonicalUrl?: string): SocialPostLookup {
    this.warn(platform, reason)
    return failure(platform, reason, canonicalUrl)
  }

  /** One lookup under the deadline: a share resolves first, then the platform's reader chain runs. */
  private async read(requested: SocialPostTarget, signal?: AbortSignal): Promise<ReadResult> {
    if (this.settings.timeoutMs <= 0) return { status: 'failed', reason: 'timeout' }
    const deadlineAt = this.now() + this.settings.timeoutMs
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) controller.abort()
    const timer = setTimeout(() => controller.abort(), this.settings.timeoutMs)
    let resolvedCanonical: string | undefined
    try {
      const resolved = requested.needsRedirect
        ? await untilAborted(this.resolveShare(requested, controller.signal), controller.signal, null)
        : requested
      if (controller.signal.aborted) return { status: 'failed', reason: 'timeout' }
      if (!resolved) return { status: 'failed', reason: 'redirect' }
      if (resolved.canonicalUrl !== requested.canonicalUrl) resolvedCanonical = resolved.canonicalUrl

      const outcome = await runChain(
        readersFor(resolved, {
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
          budgetMs: this.settings.timeoutMs
        }
      )
      if (outcome.status === 'failed') {
        return {
          status: 'failed',
          reason: controller.signal.aborted ? 'timeout' : reasonOf(outcome),
          ...(resolvedCanonical ? { canonicalUrl: resolvedCanonical } : {})
        }
      }
      return { status: 'found', post: outcome.post, missing: outcome.missing }
    } catch {
      return {
        status: 'failed',
        reason: controller.signal.aborted ? 'timeout' : 'network_error',
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
  private async resolveShare(share: SocialPostTarget, signal: AbortSignal): Promise<SocialPostTarget | null> {
    const cached = this.getCachedShare(share.lookupKey)
    if (cached) return cached
    const resolved = await resolveShareLink(share, this.fetcher, signal)
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
