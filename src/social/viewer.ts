import { createLogger, type Logger } from '../records/logger.js'
import { resolveBlueskyDid } from './blueskyDid.js'
import { parseFacebookPage } from './facebook.js'
import { checkedFetcher, type Lookup, publicAddress } from './fetch.js'
import { parseInstagramPage } from './instagram.js'
import { fetchPostPage, META_PAGE_HEADERS } from './meta.js'
import { parseBlueskyThread, parseFxTwitterResponse, parseYouTubeOEmbed, parseYtDlpMetadata } from './parsers.js'
import { parseRedditFeedPost } from './redditFeed.js'
import { BROWSER_USER_AGENT } from './replies/common.js'
import { resolveShareLink } from './share.js'
import { fetchThreadsPage, parseThreadsPage } from './threads.js'
import type { SocialPost, SocialPostLookup } from './types.js'
import { isFacebookPost, isResolvedFacebookPost, type SocialPlatform, type SocialPostTarget } from './urls.js'
import { runYtDlp } from './yt-dlp.js'

export interface SocialPostSettings {
  timeoutMs: number
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

function failure(platform: SocialPlatform, reason: string): SocialPostLookup {
  return { status: 'failed', platform, reason }
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

function isYtDlpPlatform(platform: SocialPlatform): boolean {
  return platform !== 'x' && platform !== 'bluesky' && platform !== 'threads'
}

const MAX_BLUESKY_PDS_CACHE_ENTRIES = 256
const BLUESKY_PDS_TIMEOUT_MS = 1500

export class SocialPostViewer {
  private readonly cache = new Map<string, { post: SocialPost; expiresAt: number }>()
  private readonly blueskyPdsCache = new Map<string, string>()
  private readonly shareCache = new Map<string, { target: SocialPostTarget; expiresAt: number }>()
  private ytDlpAvailable = true
  private readonly lookupAddress: Lookup | undefined
  private readonly fetcher: typeof fetch
  private readonly runExtractor: typeof runYtDlp
  private readonly now: () => number
  private readonly warn: (platform: SocialPlatform, reason: string) => void

  constructor(
    private readonly settings: SocialPostSettings,
    dependencies: SocialPostViewerDependencies = {}
  ) {
    this.lookupAddress = dependencies.lookup
    this.fetcher = checkedFetcher(dependencies.fetcher ?? fetch, dependencies.lookup)
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
    // Reddit has its feed; Instagram and Facebook posts and photos have pages. They read without yt-dlp.
    if (
      isYtDlpPlatform(target.platform) &&
      target.platform !== 'reddit' &&
      target.platform !== 'instagram' &&
      !isFacebookPost(target) &&
      !this.ytDlpAvailable
    ) {
      return failure(target.platform, 'binary_missing')
    }

    const cached = this.getCached(target.lookupKey)
    // The cache key ignores timestamps, so the cached post's target may carry another link's `t=`.
    if (cached) return { status: 'found', post: { ...cached, target } }

    const controller = new AbortController()
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) controller.abort()
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<SocialPostLookup>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true
        controller.abort()
        resolve(failure(target.platform, 'timeout'))
      }, this.settings.timeoutMs)
    })

    try {
      const cancelled = new Promise<SocialPostLookup>((resolve) => {
        const finish = () => resolve(failure(target.platform, 'timeout'))
        if (controller.signal.aborted) finish()
        else controller.signal.addEventListener('abort', finish, { once: true })
      })
      if (controller.signal.aborted) return failure(target.platform, 'timeout')
      const result = await Promise.race([this.lookupRequested(target, controller.signal), timeout, cancelled])
      if (result.status === 'found') this.setCached(target.lookupKey, result.post)
      if (result.status === 'failed') return this.reportFailure(result.platform, timedOut ? 'timeout' : result.reason)
      return result
    } catch (error) {
      return this.reportFailure(target.platform, timedOut || isAbort(error) ? 'timeout' : 'network_error')
    } finally {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
  }

  private reportFailure(platform: SocialPlatform, reason: string): SocialPostLookup {
    this.warn(platform, reason)
    return failure(platform, reason)
  }

  private getCached(key: string): SocialPost | null {
    const entry = this.cache.get(key)
    if (!entry) return null
    if (entry.expiresAt <= this.now()) {
      this.cache.delete(key)
      return null
    }
    this.cache.delete(key)
    this.cache.set(key, entry)
    return entry.post
  }

  private setCached(key: string, post: SocialPost): void {
    if (this.settings.cacheTtlMs === 0) return
    this.cache.delete(key)
    this.cache.set(key, { post, expiresAt: this.now() + this.settings.cacheTtlMs })
    while (this.cache.size > this.settings.maxCacheEntries) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
  }

  private getCachedBlueskyPds(did: string): string | null {
    const endpoint = this.blueskyPdsCache.get(did)
    if (!endpoint) return null
    this.blueskyPdsCache.delete(did)
    this.blueskyPdsCache.set(did, endpoint)
    return endpoint
  }

  private setCachedBlueskyPds(did: string, endpoint: string): void {
    this.blueskyPdsCache.delete(did)
    this.blueskyPdsCache.set(did, endpoint)
    while (this.blueskyPdsCache.size > MAX_BLUESKY_PDS_CACHE_ENTRIES) {
      const oldest = this.blueskyPdsCache.keys().next().value
      if (oldest === undefined) break
      this.blueskyPdsCache.delete(oldest)
    }
  }

  private async resolveBlueskyPds(did: string, signal: AbortSignal): Promise<string | null> {
    const controller = new AbortController()
    const budgetSignal = AbortSignal.any([signal, controller.signal])
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        controller.abort()
        resolve(null)
      }, BLUESKY_PDS_TIMEOUT_MS)
    })
    try {
      return await Promise.race([this.lookupBlueskyPds(did, budgetSignal), timeout])
    } catch {
      return null
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private async lookupBlueskyPds(did: string, signal: AbortSignal): Promise<string | null> {
    const cached = this.getCachedBlueskyPds(did)
    if (cached) return cached

    let response: Response
    try {
      // Its own short deadline: the post is worth returning without its video, but not worth losing to a slow
      // directory lookup that eats the whole lookup budget.
      response = await this.fetcher(`https://plc.directory/${did}`, {
        signal
      })
    } catch {
      return null
    }
    if (!response.ok) return null

    let document: unknown
    try {
      document = await response.json()
    } catch {
      return null
    }
    if (!document || typeof document !== 'object' || Array.isArray(document)) return null

    const services = (document as { service?: unknown }).service
    if (!Array.isArray(services)) return null
    const pds = services.find(
      (service) =>
        service !== null &&
        typeof service === 'object' &&
        !Array.isArray(service) &&
        typeof (service as { id?: unknown }).id === 'string' &&
        (service as { id: string }).id.endsWith('#atproto_pds') &&
        (service as { type?: unknown }).type === 'AtprotoPersonalDataServer'
    ) as { serviceEndpoint?: unknown } | undefined
    if (!pds || typeof pds.serviceEndpoint !== 'string') return null

    let endpoint: URL
    try {
      endpoint = new URL(pds.serviceEndpoint)
    } catch {
      return null
    }
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      return null
    }
    if (!(await publicAddress(endpoint.hostname, this.lookupAddress)) || signal.aborted) return null

    const normalized = `${endpoint.origin}${endpoint.pathname.replace(/\/+$/, '')}`
    this.setCachedBlueskyPds(did, normalized)
    return normalized
  }

  private async lookupRedditFeed(
    target: SocialPostTarget,
    signal: AbortSignal
  ): Promise<SocialPost | { refused: string } | null> {
    const feedUrl = new URL(`https://www.reddit.com/comments/${target.id}/.rss`)
    feedUrl.searchParams.set('limit', '1')
    try {
      const response = await this.fetcher(feedUrl, { headers: { 'User-Agent': BROWSER_USER_AGENT }, signal })
      // Reddit refuses a flagged IP here and on the JSON yt-dlp reads alike, so yt-dlp would only spend ~9 s failing.
      if (response.status === 403 || response.status === 429) return { refused: `http_${response.status}` }
      return response.ok ? parseRedditFeedPost(await response.text(), target, this.settings.maxTextChars) : null
    } catch {
      // A refused or failed feed still leaves yt-dlp to try.
      return null
    }
  }

  /** Instagram's logged-out page, which carries the photo posts yt-dlp refuses. Null sends the lookup on to yt-dlp. */
  private async lookupInstagramPage(target: SocialPostTarget, signal: AbortSignal): Promise<SocialPost | null> {
    try {
      const response = await this.fetcher(target.canonicalUrl, { headers: META_PAGE_HEADERS, signal })
      if (!response.ok) {
        await response.body?.cancel()
        return null
      }
      return parseInstagramPage(await response.text(), target, this.settings.maxTextChars)
    } catch {
      return null
    }
  }

  /** A Facebook post's or photo's logged-out page, after a share's one redirect. Null sends it on to yt-dlp. */
  private async lookupFacebookPage(target: SocialPostTarget, signal: AbortSignal): Promise<SocialPost | null> {
    try {
      const fetched = await fetchPostPage(this.fetcher, target, signal, isResolvedFacebookPost)
      if ('reason' in fetched) return null
      if (!fetched.response.ok) {
        await fetched.response.body?.cancel()
        return null
      }
      const post = parseFacebookPage(await fetched.response.text(), fetched.page, this.settings.maxTextChars)
      // The post keeps the link it was asked for, so its cache entry and the tools' refusal both find it.
      return post ? { ...post, target } : null
    } catch {
      return null
    }
  }

  /** A share or short link resolves first; the post keeps the link it was asked for, so both addresses close. */
  private async lookupRequested(requested: SocialPostTarget, signal: AbortSignal): Promise<SocialPostLookup> {
    if (!requested.needsRedirect) return this.lookupUncached(requested, signal)
    const resolved = await this.resolveShare(requested, signal)
    if (!resolved) return failure(requested.platform, 'redirect')
    const result = await this.lookupUncached(resolved, signal)
    return result.status === 'found' ? { status: 'found', post: { ...result.post, target: requested } } : result
  }

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

  private async lookupUncached(target: SocialPostTarget, signal: AbortSignal): Promise<SocialPostLookup> {
    if (target.platform === 'x') {
      const response = await this.fetcher(`https://api.fxtwitter.com/status/${target.id}`, { signal })
      if (!response.ok) return failure('x', `http_${response.status}`)
      const payload = await response.json()
      return { status: 'found', post: parseFxTwitterResponse(payload, target, this.settings.maxTextChars) }
    }

    if (target.platform === 'threads') {
      const fetched = await fetchThreadsPage(this.fetcher, target, signal)
      if ('reason' in fetched) return failure('threads', fetched.reason)
      if (!fetched.response.ok) return failure('threads', `http_${fetched.response.status}`)
      const page = parseThreadsPage(await fetched.response.text(), fetched.page, this.settings.maxTextChars)
      // The post keeps the link it was asked for, so its cache entry and the tools' refusal both find it.
      return page ? { status: 'found', post: { ...page.post, target } } : failure('threads', 'no_post_data')
    }

    if (target.platform === 'bluesky') {
      const resolved = await resolveBlueskyDid(target.profile ?? '', this.fetcher, signal)
      if ('reason' in resolved) return failure('bluesky', resolved.reason)
      const { did } = resolved

      const threadUrl = new URL('https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread')
      threadUrl.searchParams.set('uri', `at://${did}/app.bsky.feed.post/${target.id}`)
      threadUrl.searchParams.set('depth', '0')
      threadUrl.searchParams.set('parentHeight', '0')
      const response = await this.fetcher(threadUrl, { signal })
      if (!response.ok) return failure('bluesky', `http_${response.status}`)
      const parsed = parseBlueskyThread(await response.json(), target, this.settings.maxTextChars)
      if (!parsed) return failure('bluesky', 'missing_post')
      const blob = parsed.blueskyBlob
      if (blob?.did.startsWith('did:plc:')) {
        const endpoint = await this.resolveBlueskyPds(blob.did, signal)
        if (endpoint) {
          parsed.post.video = {
            url: `${endpoint}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(blob.did)}&cid=${encodeURIComponent(blob.cid)}`,
            bytes: blob.bytes,
            headers: null,
            hasAudio: null
          }
        }
      }
      return { status: 'found', post: parsed.post }
    }

    if (target.platform === 'instagram') {
      const page = await this.lookupInstagramPage(target, signal)
      if (page) return { status: 'found', post: page }
    }

    if (isFacebookPost(target)) {
      const page = await this.lookupFacebookPage(target, signal)
      if (page) return { status: 'found', post: page }
    }

    // yt-dlp takes ~9 s to refuse a Reddit post with no hosted video, past the lookup budget; the feed answers
    // in well under a second for every kind of post, so yt-dlp runs only for the video.
    const redditFeed = target.platform === 'reddit' ? await this.lookupRedditFeed(target, signal) : null
    if (redditFeed && 'refused' in redditFeed) return failure('reddit', redditFeed.refused)
    const redditFeedPost = redditFeed
    if (redditFeedPost && redditFeedPost.videoCount === 0) return { status: 'found', post: redditFeedPost }

    if (!this.ytDlpAvailable)
      return redditFeedPost ? { status: 'found', post: redditFeedPost } : failure(target.platform, 'binary_missing')
    const result = await this.runExtractor(this.settings.ytDlpPath, target.extractorUrl, this.settings.timeoutMs)
    if ('reason' in result) {
      if (redditFeedPost) return { status: 'found', post: redditFeedPost }
      if (target.platform !== 'youtube' || signal.aborted) return failure(target.platform, result.reason)
      // YouTube walls repeated requests from one home IP behind a bot check that oEmbed does not have.
      const oembedUrl = new URL('https://www.youtube.com/oembed')
      oembedUrl.searchParams.set('url', target.canonicalUrl)
      oembedUrl.searchParams.set('format', 'json')
      const response = await this.fetcher(oembedUrl, { signal })
      const post = response.ok ? parseYouTubeOEmbed(await response.json(), target, this.settings.maxTextChars) : null
      return post ? { status: 'found', post } : failure('youtube', result.reason)
    }
    return { status: 'found', post: parseYtDlpMetadata(result.metadata, target, this.settings.maxTextChars) }
  }
}

export function createSocialPostViewer(
  settings: SocialPostSettings,
  dependencies?: SocialPostViewerDependencies
): SocialPostViewer {
  return new SocialPostViewer(settings, dependencies)
}
