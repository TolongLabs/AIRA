import { createLogger, type Logger } from '../../records/logger.js'
import { checkedFetcher, type Lookup } from '../fetch.js'
import type { SocialPlatform, SocialPostTarget } from '../urls.js'
import { runYtDlp } from '../yt-dlp.js'
import { fetchBilibiliReplies } from './bilibili.js'
import { fetchBlueskyReplies } from './bluesky.js'
import { failed } from './common.js'
import { fetchInstagramReplies } from './instagram.js'
import { fetchRedditReplies } from './reddit.js'
import { fetchThreadsReplies } from './threads.js'
import { fetchTikTokReplies } from './tiktok.js'
import type { ReplyFetcher, ReplyLookup } from './types.js'
import { fetchXReplies } from './x.js'
import { fetchYouTubeReplies } from './youtube.js'

export interface ReplyReaderSettings {
  timeoutMs: number
  maxReplies: number
  maxReplyChars: number
  cacheTtlMs: number
  maxCacheEntries: number
  ytDlpPath: string
}

export interface ReplyReaderDependencies {
  lookup?: Lookup
  logger?: Logger
  fetchers?: Partial<Record<SocialPlatform, ReplyFetcher>>
  fetcher?: typeof fetch
  runExtractor?: typeof runYtDlp
  now?: () => number
  warn?: (platform: SocialPlatform, reason: string) => void
  youtubeApiKey?: () => string | undefined
}

const FETCHERS: Record<SocialPlatform, ReplyFetcher> = {
  x: fetchXReplies,
  bluesky: fetchBlueskyReplies,
  youtube: fetchYouTubeReplies,
  tiktok: fetchTikTokReplies,
  reddit: fetchRedditReplies,
  instagram: fetchInstagramReplies,
  bilibili: fetchBilibiliReplies,
  threads: fetchThreadsReplies,
  facebook: async () => failed('facebook', 'unsupported')
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

export class ReplyReader {
  private readonly cache = new Map<string, { lookup: ReplyLookup; expiresAt: number }>()
  private readonly fetchers: Record<SocialPlatform, ReplyFetcher>
  private readonly fetcher: typeof fetch
  private readonly runExtractor: typeof runYtDlp
  private readonly now: () => number
  private readonly warn: (platform: SocialPlatform, reason: string) => void
  private readonly youtubeApiKey: () => string | undefined
  private ytDlpAvailable = true

  constructor(
    private readonly settings: ReplyReaderSettings,
    dependencies: ReplyReaderDependencies = {}
  ) {
    this.fetchers = { ...FETCHERS, ...dependencies.fetchers }
    this.fetcher = checkedFetcher(dependencies.fetcher ?? fetch, dependencies.lookup)
    this.runExtractor = dependencies.runExtractor ?? runYtDlp
    this.now = dependencies.now ?? Date.now
    this.warn =
      dependencies.warn ??
      ((platform, reason) =>
        (dependencies.logger ?? createLogger({ level: 'warn', module: 'social' })).warn('social.replies_failed', {
          platform,
          reason
        }))
    this.youtubeApiKey = dependencies.youtubeApiKey ?? (() => process.env.YOUTUBE_API_KEY)
  }

  setYtDlpAvailable(available: boolean): void {
    this.ytDlpAvailable = available
  }

  async read(
    target: SocialPostTarget,
    maxReplies = this.settings.maxReplies,
    signal?: AbortSignal
  ): Promise<ReplyLookup> {
    const replyLimit = Number.isFinite(maxReplies)
      ? Math.min(50, Math.max(1, Math.trunc(maxReplies)))
      : this.settings.maxReplies
    if (target.platform === 'instagram' && !this.ytDlpAvailable) return this.report(target.platform, 'binary_missing')

    const cacheKey = `${target.lookupKey}:${replyLimit}`
    const cached = this.getCached(cacheKey)
    if (cached) return cached

    const controller = new AbortController()
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) controller.abort()
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<ReplyLookup>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true
        controller.abort()
        resolve(failed(target.platform, 'timeout'))
      }, this.settings.timeoutMs)
    })

    try {
      const cancelled = new Promise<ReplyLookup>((resolve) => {
        const finish = () => resolve(failed(target.platform, 'timeout'))
        if (controller.signal.aborted) finish()
        else controller.signal.addEventListener('abort', finish, { once: true })
      })
      if (controller.signal.aborted) return failed(target.platform, 'timeout')
      const lookup = await Promise.race([
        this.fetchers[target.platform](target, {
          fetcher: this.fetcher,
          runExtractor: this.runExtractor,
          ytDlpPath: this.settings.ytDlpPath,
          signal: controller.signal,
          maxReplies: replyLimit,
          maxReplyChars: this.settings.maxReplyChars,
          youtubeApiKey: this.youtubeApiKey(),
          timeoutMs: this.settings.timeoutMs
        }),
        timeout,
        cancelled
      ])
      if (lookup.status === 'failed') return this.report(target.platform, timedOut ? 'timeout' : lookup.reason)
      this.setCached(cacheKey, lookup)
      return lookup
    } catch (error) {
      return this.report(target.platform, timedOut || isAbort(error) ? 'timeout' : 'network_error')
    } finally {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
  }

  private report(platform: SocialPlatform, reason: string): ReplyLookup {
    this.warn(platform, reason)
    return failed(platform, reason)
  }

  private getCached(key: string): ReplyLookup | null {
    const entry = this.cache.get(key)
    if (!entry) return null
    if (entry.expiresAt <= this.now()) {
      this.cache.delete(key)
      return null
    }
    this.cache.delete(key)
    this.cache.set(key, entry)
    return entry.lookup
  }

  private setCached(key: string, lookup: ReplyLookup): void {
    if (this.settings.cacheTtlMs === 0) return
    this.cache.delete(key)
    this.cache.set(key, { lookup, expiresAt: this.now() + this.settings.cacheTtlMs })
    while (this.cache.size > this.settings.maxCacheEntries) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
  }
}

export function createReplyReader(settings: ReplyReaderSettings, dependencies?: ReplyReaderDependencies): ReplyReader {
  return new ReplyReader(settings, dependencies)
}
