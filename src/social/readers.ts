import { resolveBlueskyDid } from './blueskyDid.js'
import type { ReaderResult, SocialReader } from './chain.js'
import { parseFacebookPage } from './facebook.js'
import { type Lookup, publicAddress } from './fetch.js'
import { parseInstagramPage } from './instagram.js'
import { fetchPostPage, META_PAGE_HEADERS } from './meta.js'
import { createMirrorReader, type MirrorPlatform } from './mirror-readers.js'
import {
  object,
  parseBlueskyThread,
  parseFxTwitterResponse,
  parseYouTubeOEmbed,
  parseYtDlpMetadata
} from './parsers.js'
import { parseRedditFeedPost } from './redditFeed.js'
import { BROWSER_USER_AGENT } from './replies/common.js'
import { fetchThreadsPage, parseThreadsPage } from './threads.js'
import type { PostField } from './types.js'
import {
  isFacebookPost,
  isResolvedFacebookPost,
  PLATFORM_NAME,
  parseOfficialSocialPostUrl,
  type SocialPlatform,
  type SocialPostTarget
} from './urls.js'

export const DEFAULT_HTTP_READER_TIMEOUT_MS = 2500
export const DEFAULT_YTDLP_TIMEOUT_MS = 4500
const TIKWM_TIMEOUT_MS = 5500

const BLUESKY_PDS_TIMEOUT_MS = 1500
const MAX_BLUESKY_PDS_CACHE_ENTRIES = 256
const ALL_FIELDS: readonly PostField[] = ['text', 'author', 'media', 'video']

/** The Bluesky PDS of a DID, found through the PLC directory. Cached so one account is looked up once. */
export class BlueskyPdsDirectory {
  private readonly cache = new Map<string, string>()

  constructor(private readonly lookupAddress?: Lookup) {}

  /** The PDS's public endpoint, or null when the directory has none within its own short deadline. */
  async resolve(did: string, fetcher: typeof fetch, signal: AbortSignal): Promise<string | null> {
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
      return await Promise.race([this.lookup(did, fetcher, budgetSignal), timeout])
    } catch {
      return null
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private get(did: string): string | null {
    const endpoint = this.cache.get(did)
    if (!endpoint) return null
    this.cache.delete(did)
    this.cache.set(did, endpoint)
    return endpoint
  }

  private set(did: string, endpoint: string): void {
    this.cache.delete(did)
    this.cache.set(did, endpoint)
    while (this.cache.size > MAX_BLUESKY_PDS_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
  }

  private async lookup(did: string, fetcher: typeof fetch, signal: AbortSignal): Promise<string | null> {
    const cached = this.get(did)
    if (cached) return cached

    let response: Response
    try {
      response = await fetcher(`https://plc.directory/${did}`, { signal })
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
    this.set(did, normalized)
    return normalized
  }
}

export type SocialMirrorSettings = Partial<Record<MirrorPlatform, 'off' | 'read' | 'read_and_group'>> & {
  redditGroupChatIds?: readonly string[] | undefined
}

export interface ReaderEnv {
  mirrors?: SocialMirrorSettings | undefined
  ytDlpPath: string
  ytDlpAvailable: () => boolean
  pds: BlueskyPdsDirectory
  httpTimeoutMs: number
  ytDlpTimeoutMs: number
}

type ReadOperation = 'text' | 'preview' | 'photos' | 'video'
type GroupOperation = 'photos' | 'video'
interface PlatformAdapter {
  read: readonly ReadOperation[]
  group: readonly GroupOperation[]
  extractorRequired?: boolean
  readers(target: SocialPostTarget, env: ReaderEnv): SocialReader[]
}

const adapters: Record<SocialPlatform, PlatformAdapter> = {
  x: {
    read: ['text', 'preview', 'photos', 'video'],
    group: ['photos', 'video'],
    readers: (_, env) => [fxTwitterReader(env)]
  },
  bluesky: {
    read: ['text', 'preview', 'photos', 'video'],
    group: ['photos'],
    readers: (_, env) => [blueskyApiReader(env)]
  },
  threads: {
    read: ['text', 'preview', 'photos', 'video'],
    group: ['photos'],
    readers: (_, env) => [threadsPageReader(env)]
  },
  instagram: {
    read: ['text', 'preview', 'photos', 'video'],
    group: ['photos'],
    readers: (_, env) => [instagramPageReader(env), ytDlpReader(env)]
  },
  facebook: {
    read: ['text', 'preview', 'photos', 'video'],
    group: ['photos'],
    readers: (target, env) =>
      isFacebookPost(target) ? [facebookPageReader(env), ytDlpReader(env)] : [ytDlpReader(env)]
  },
  reddit: { read: ['text', 'preview', 'video'], group: [], readers: (_, env) => redditReaders(env) },
  youtube: {
    read: ['text', 'preview', 'video'],
    group: [],
    extractorRequired: true,
    readers: (_, env) => [ytDlpReader(env), youtubeOEmbedReader(env)]
  },
  tiktok: {
    read: ['text', 'preview', 'video'],
    group: [],
    extractorRequired: true,
    readers: (_, env) => [ytDlpReader(env)]
  },
  bilibili: {
    read: ['text', 'preview', 'video'],
    group: [],
    extractorRequired: true,
    readers: (_, env) => [ytDlpReader(env)]
  }
}

function mirrorMode(platform: SocialPlatform, mirrors?: SocialMirrorSettings) {
  return platform === 'tiktok' || platform === 'reddit' ? (mirrors?.[platform] ?? 'off') : 'off'
}

function supportsMirror(target: SocialPostTarget, mirrors?: SocialMirrorSettings): boolean {
  return (
    mirrorMode(target.platform, mirrors) !== 'off' &&
    (target.platform !== 'tiktok' ||
      target.needsRedirect === true ||
      new URL(target.canonicalUrl).pathname.includes('/video/'))
  )
}

export function requiresExtractor(target: SocialPostTarget, mirrors?: SocialMirrorSettings): boolean {
  if (supportsMirror(target, mirrors)) return false
  return (
    adapters[target.platform].extractorRequired === true || (target.platform === 'facebook' && !isFacebookPost(target))
  )
}

export function groupOperations(
  platform: SocialPlatform,
  mirrors?: SocialMirrorSettings,
  chatId?: string
): readonly GroupOperation[] {
  if (mirrorMode(platform, mirrors) !== 'read_and_group') return adapters[platform].group
  const scope = platform === 'reddit' ? mirrors?.redditGroupChatIds : undefined
  if (scope !== undefined && (chatId === undefined ? scope.length === 0 : !scope.includes(chatId))) return []
  return platform === 'reddit' ? ['photos', 'video'] : ['video']
}

export function socialCapabilities(extractorAvailable: boolean, mirrors?: SocialMirrorSettings) {
  const platforms = Object.keys(adapters) as SocialPlatform[]
  const entry = (id: SocialPlatform, operations: readonly ReadOperation[]) => ({
    id,
    name: PLATFORM_NAME[id],
    operations
  })
  return {
    'features.social': platforms.flatMap((id) => {
      const adapter = adapters[id]
      const mirror = mirrorMode(id, mirrors) !== 'off'
      if (adapter.extractorRequired && !extractorAvailable && !mirror) return []
      if (id === 'reddit' && mirror) return [entry(id, ['text', 'preview', 'photos', 'video'])]
      const operations =
        !extractorAvailable && (id === 'reddit' || id === 'facebook')
          ? adapter.read.filter((value) => value !== 'video')
          : adapter.read
      return [entry(id, operations)]
    }),
    'features.autofetch': platforms.flatMap((id) => {
      const operations = groupOperations(id, mirrors)
      return operations.length ? [entry(id, operations)] : []
    })
  }
}

/** The readers of one platform in their order, built per lookup. */
export function readersFor(target: SocialPostTarget, env: ReaderEnv): SocialReader[] {
  const readers = adapters[target.platform].readers(target, env)
  if (target.platform === 'tiktok' && supportsMirror(target, env.mirrors)) {
    const timeoutMs = Math.max(TIKWM_TIMEOUT_MS, env.httpTimeoutMs)
    readers.unshift(createMirrorReader('tiktok', timeoutMs, mirrorMode('tiktok', env.mirrors) === 'read_and_group'))
  }
  return readers
}

function redditReaders(env: ReaderEnv): SocialReader[] {
  // An explicit refusal ends the Reddit lookup, including the remaining fallback readers.
  let refused = false
  const onRefused = () => {
    refused = true
  }
  const canContinue = () => !refused
  const readers = [redditFeedReader(env, onRefused)]
  const mode = mirrorMode('reddit', env.mirrors)
  if (mode !== 'off') {
    const mirror = createMirrorReader('reddit', env.httpTimeoutMs, mode === 'read_and_group', onRefused)
    readers.push({ ...mirror, isConfigured: canContinue })
  }
  readers.push(ytDlpReader(env, canContinue))
  return readers
}

function fxTwitterReader(env: ReaderEnv): SocialReader {
  return {
    id: 'x.fxtwitter',
    kind: 'mirror_api',
    provides: ALL_FIELDS,
    timeoutMs: env.httpTimeoutMs,
    isConfigured: () => true,
    async read(target, ctx): Promise<ReaderResult> {
      const response = await ctx.fetcher(`https://api.fxtwitter.com/status/${target.id}`, { signal: ctx.signal })
      if (!response.ok) return { ok: false, reason: `http_${response.status}` }
      const payload = await response.json()
      const nativeId = object(object(payload).tweet).id
      if (typeof nativeId === 'string' && nativeId !== target.id) return { ok: false, reason: 'identity_mismatch' }
      return { ok: true, post: parseFxTwitterResponse(payload, target, ctx.maxTextChars) }
    }
  }
}

function threadsPageReader(env: ReaderEnv): SocialReader {
  return {
    id: 'threads.page',
    kind: 'page_meta',
    provides: ALL_FIELDS,
    timeoutMs: env.httpTimeoutMs,
    isConfigured: () => true,
    async read(target, ctx): Promise<ReaderResult> {
      const fetched = await fetchThreadsPage(ctx.fetcher, target, ctx.signal)
      if ('reason' in fetched) return { ok: false, reason: fetched.reason }
      if (!fetched.response.ok) return { ok: false, reason: `http_${fetched.response.status}` }
      const page = parseThreadsPage(await fetched.response.text(), fetched.page, ctx.maxTextChars)
      return page ? { ok: true, post: page.post } : { ok: false, reason: 'no_post_data' }
    }
  }
}

function blueskyApiReader(env: ReaderEnv): SocialReader {
  return {
    id: 'bluesky.api',
    kind: 'api_public',
    provides: ALL_FIELDS,
    timeoutMs: env.httpTimeoutMs,
    isConfigured: () => true,
    async read(target, ctx): Promise<ReaderResult> {
      const resolved = await resolveBlueskyDid(target.profile ?? '', ctx.fetcher, ctx.signal)
      if ('reason' in resolved) return { ok: false, reason: resolved.reason }

      const threadUrl = new URL('https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread')
      threadUrl.searchParams.set('uri', `at://${resolved.did}/app.bsky.feed.post/${target.id}`)
      threadUrl.searchParams.set('depth', '0')
      threadUrl.searchParams.set('parentHeight', '0')
      const response = await ctx.fetcher(threadUrl, { signal: ctx.signal })
      if (!response.ok) {
        // A removed or private post answers 404 or 410; any other status may be a passing fault.
        const gone = response.status === 404 || response.status === 410
        return { ok: false, reason: `http_${response.status}`, terminal: gone }
      }
      const parsed = parseBlueskyThread(await response.json(), target, ctx.maxTextChars, resolved.did)
      if (!parsed) return { ok: false, reason: 'missing_post' }
      const blob = parsed.blueskyBlob
      if (blob?.did.startsWith('did:plc:')) {
        const endpoint = await env.pds.resolve(blob.did, ctx.fetcher, ctx.signal)
        if (endpoint) {
          parsed.post.video = {
            url: `${endpoint}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(blob.did)}&cid=${encodeURIComponent(blob.cid)}`,
            bytes: blob.bytes,
            headers: null,
            hasAudio: null
          }
        }
      }
      return { ok: true, post: parsed.post }
    }
  }
}

/** Instagram's logged-out page, which carries the photo posts yt-dlp refuses. */
function instagramPageReader(env: ReaderEnv): SocialReader {
  return {
    id: 'instagram.page',
    kind: 'page_meta',
    provides: ALL_FIELDS,
    timeoutMs: env.httpTimeoutMs,
    isConfigured: () => true,
    async read(target, ctx): Promise<ReaderResult> {
      try {
        const response = await ctx.fetcher(target.canonicalUrl, { headers: META_PAGE_HEADERS, signal: ctx.signal })
        if (!response.ok) {
          await response.body?.cancel()
          return { ok: false, reason: `http_${response.status}` }
        }
        const post = parseInstagramPage(await response.text(), target, ctx.maxTextChars)
        return post ? { ok: true, post } : { ok: false, reason: 'no_post_data' }
      } catch {
        return { ok: false, reason: ctx.signal.aborted ? 'timeout' : 'network_error' }
      }
    }
  }
}

/** A Facebook post's or photo's logged-out page, after a share's one redirect. */
function facebookPageReader(env: ReaderEnv): SocialReader {
  return {
    id: 'facebook.page',
    kind: 'page_meta',
    provides: ALL_FIELDS,
    timeoutMs: env.httpTimeoutMs,
    isConfigured: () => true,
    async read(target, ctx): Promise<ReaderResult> {
      try {
        const fetched = await fetchPostPage(ctx.fetcher, target, ctx.signal, isResolvedFacebookPost)
        if ('reason' in fetched) return { ok: false, reason: fetched.reason }
        if (!fetched.response.ok) {
          await fetched.response.body?.cancel()
          return { ok: false, reason: `http_${fetched.response.status}` }
        }
        const post = parseFacebookPage(await fetched.response.text(), fetched.page, ctx.maxTextChars)
        return post ? { ok: true, post } : { ok: false, reason: 'no_post_data' }
      } catch {
        return { ok: false, reason: ctx.signal.aborted ? 'timeout' : 'network_error' }
      }
    }
  }
}

/** Reddit's comment feed, which reads every kind of post in under a second. It is refused, not failed, on 403 and 429. */
function redditFeedReader(env: ReaderEnv, onRefused: () => void): SocialReader {
  return {
    id: 'reddit.feed',
    kind: 'page_meta',
    provides: ALL_FIELDS,
    timeoutMs: env.httpTimeoutMs,
    isConfigured: () => true,
    async read(target, ctx): Promise<ReaderResult> {
      const feedUrl = new URL(`https://www.reddit.com/comments/${target.id}/.rss`)
      feedUrl.searchParams.set('limit', '1')
      try {
        const response = await ctx.fetcher(feedUrl, {
          headers: { 'User-Agent': BROWSER_USER_AGENT },
          signal: ctx.signal
        })
        if (response.status === 403 || response.status === 429) {
          onRefused()
          return { ok: false, reason: `http_${response.status}` }
        }
        if (!response.ok) {
          await response.body?.cancel()
          return { ok: false, reason: `http_${response.status}` }
        }
        const post = parseRedditFeedPost(await response.text(), target, ctx.maxTextChars)
        return post ? { ok: true, post } : { ok: false, reason: 'no_post_data' }
      } catch {
        // A failed feed still leaves yt-dlp to try.
        return { ok: false, reason: ctx.signal.aborted ? 'timeout' : 'network_error' }
      }
    }
  }
}

/** yt-dlp's metadata. Without the extractor it fails at once, as the platform has no other reader then. */
function ytDlpReader(env: ReaderEnv, isConfigured: () => boolean = () => true): SocialReader {
  return {
    id: 'yt_dlp',
    kind: 'yt_dlp',
    provides: ALL_FIELDS,
    timeoutMs: env.ytDlpTimeoutMs,
    isConfigured,
    async read(target, ctx): Promise<ReaderResult> {
      if (!env.ytDlpAvailable()) return { ok: false, reason: 'binary_missing' }
      const result = await ctx.runExtractor(env.ytDlpPath, target.extractorUrl, ctx.timeoutMs)
      if ('reason' in result) return { ok: false, reason: result.reason }
      const page = object(result.metadata).webpage_url
      const declared = typeof page === 'string' ? parseOfficialSocialPostUrl(page) : null
      if (declared && !declared.needsRedirect && declared.lookupKey !== target.lookupKey) {
        return { ok: false, reason: 'identity_mismatch' }
      }
      return { ok: true, post: parseYtDlpMetadata(result.metadata, target, ctx.maxTextChars) }
    }
  }
}

/** YouTube's oEmbed has no bot check, so it backs up a refused extraction and still gives the title and channel. */
function youtubeOEmbedReader(env: ReaderEnv): SocialReader {
  return {
    id: 'youtube.oembed',
    kind: 'oembed',
    provides: ['text', 'author', 'media'],
    timeoutMs: env.httpTimeoutMs,
    isConfigured: () => true,
    async read(target, ctx): Promise<ReaderResult> {
      const oembedUrl = new URL('https://www.youtube.com/oembed')
      oembedUrl.searchParams.set('url', target.canonicalUrl)
      oembedUrl.searchParams.set('format', 'json')
      const response = await ctx.fetcher(oembedUrl, { signal: ctx.signal })
      if (!response.ok) {
        await response.body?.cancel()
        return { ok: false, reason: `http_${response.status}` }
      }
      let payload: unknown
      try {
        payload = await response.json()
      } catch {
        return { ok: false, reason: ctx.signal.aborted ? 'timeout' : 'invalid_json' }
      }
      const post = parseYouTubeOEmbed(payload, target, ctx.maxTextChars)
      return post ? { ok: true, post } : { ok: false, reason: 'no_post_data' }
    }
  }
}
