import { isForbiddenUrl } from '../tools/ports.js'
import type { PostField, SocialPost } from './types.js'
import { isFacebookPost, PLATFORM_NAME, type SocialPlatform, type SocialPostTarget } from './urls.js'
import type { runYtDlp } from './yt-dlp.js'

// The ordered reader chain of one social lookup (docs/trd/tools.md#social-post-reader). Readers run in order; a later
// reader fills only the fields still missing. Internal reasons stay in ChainOutcome.attempts and never reach a model.

export type ReaderKind = 'api_keyed' | 'api_public' | 'page_meta' | 'mirror_api' | 'yt_dlp' | 'oembed'

export interface ReaderContext {
  fetcher: typeof fetch
  runExtractor: typeof runYtDlp
  /** Aborts at the lookup deadline, at this reader's own limit, or when the caller cancels. */
  signal: AbortSignal
  /** The clipped remaining limit for this reader within the lookup deadline. Passed to an extractor as its process limit. */
  timeoutMs: number
  maxTextChars: number
}

export interface ReaderResult {
  ok: boolean
  post?: Partial<SocialPost>
  /** First-party API only: the post is confirmed private, deleted or gone. Ignored from any other kind. */
  terminal?: boolean
  /** Internal log code, such as `http_429`. Never shown to the model. */
  reason?: string
}

export interface SocialReader {
  readonly id: string
  readonly kind: ReaderKind
  /** The fields this reader can supply. A reader runs only when one of them is still missing. */
  readonly provides: readonly PostField[]
  readonly timeoutMs: number
  isConfigured(): boolean
  read(target: SocialPostTarget, ctx: ReaderContext): Promise<ReaderResult>
}

export interface ChainAttempt {
  readerId: string
  ok: boolean
  reason?: string
  ms: number
}

export type ChainOutcome =
  | { status: 'failed'; attempts: ChainAttempt[] }
  | { status: 'readable' | 'partial'; post: SocialPost; missing: PostField[]; attempts: ChainAttempt[] }

export interface ChainRun {
  /** Aborts at the lookup's end, whatever the reason. */
  signal: AbortSignal
  /** Epoch milliseconds when the lookup must end. */
  deadlineAt: number
  /** The lookup's whole budget. Limits a reader when tighter than the remaining deadline. */
  budgetMs: number
  now: () => number
  fetcher: typeof fetch
  runExtractor: typeof runYtDlp
  maxTextChars: number
}

type Shape = 'photo' | 'video' | 'youtube'

const STUBS: ReadonlySet<string> = new Set(['log in', 'login', 'sign in', 'signin', 'just a moment'])

/** Text-and-photo posts, video-first posts (TikTok, Bilibili, Facebook video) and YouTube need different fields. */
function shapeOf(target: SocialPostTarget): Shape {
  if (target.platform === 'youtube') return 'youtube'
  if (target.platform === 'tiktok' || target.platform === 'bilibili') return 'video'
  if (target.platform === 'facebook' && !isFacebookPost(target)) return 'video'
  return 'photo'
}

function isValidMediaUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:' && !isForbiddenUrl(value)
  } catch {
    return false
  }
}

/** A platform name or a login wall's words stand for no caption. A real short caption is kept. */
export function isBlockStub(text: string, platform: SocialPlatform): boolean {
  const name = PLATFORM_NAME[platform].toLowerCase()
  const normal = text
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/[.…]+$/, '')
  return (
    normal === '' ||
    normal === name ||
    STUBS.has(normal) ||
    normal === `log in to ${name}` ||
    normal === `sign in to ${name}`
  )
}

function hasText(post: Partial<SocialPost>): boolean {
  return (post.text ?? '').trim() !== '' || (post.externalTitle ?? '').trim() !== ''
}

function hasAuthor(post: Partial<SocialPost>): boolean {
  return (post.authorHandle ?? '').trim() !== '' || (post.authorName ?? '').trim() !== ''
}

function hasMedia(post: Partial<SocialPost>): boolean {
  return (post.photoUrls?.length ?? 0) > 0 || (post.imageUrl ?? null) !== null
}

/** YouTube's video is known once its duration is; other posts have one when their video URL is. */
function hasVideo(post: Partial<SocialPost>, shape: Shape): boolean {
  return shape === 'youtube' ? (post.durationSec ?? null) !== null : (post.video ?? null) !== null
}

function expectsVideo(post: Partial<SocialPost>, shape: Shape): boolean {
  return shape !== 'photo' || (post.videoCount ?? 0) > 0
}

function isComplete(post: Partial<SocialPost>, shape: Shape): boolean {
  if (shape === 'youtube') return hasAuthor(post) && hasText(post) && hasVideo(post, shape)
  if (shape === 'video') return hasAuthor(post) && hasText(post) && hasVideo(post, shape)
  return hasAuthor(post) && (hasText(post) || hasMedia(post)) && (!expectsVideo(post, shape) || hasVideo(post, shape))
}

/** The fields a post lacks. Media counts as missing only for text-and-photo posts. */
function missingFields(post: Partial<SocialPost>, shape: Shape): PostField[] {
  const missing: PostField[] = []
  if (!hasText(post)) missing.push('text')
  if (!hasAuthor(post)) missing.push('author')
  if (shape === 'photo' && !hasMedia(post)) missing.push('media')
  if (expectsVideo(post, shape) && !hasVideo(post, shape)) missing.push('video')
  return missing
}

function hasAnyField(post: Partial<SocialPost>): boolean {
  return hasText(post) || hasAuthor(post) || hasMedia(post) || (post.video ?? null) !== null
}

function blankPost(target: SocialPostTarget): SocialPost {
  return {
    platform: target.platform,
    id: '',
    canonicalUrl: '',
    target,
    authorHandle: '',
    authorName: '',
    createdAt: null,
    text: '',
    quotedText: '',
    quotedAuthorHandle: '',
    photoCount: 0,
    videoCount: 0,
    imageUrl: null,
    photoUrls: [],
    thread: [],
    externalTitle: '',
    replyCount: null,
    durationSec: null,
    video: null
  }
}

/** Drops a block stub and invalid or non-HTTPS media or video URLs, so none counts as a field. */
function clean(post: Partial<SocialPost>, platform: SocialPlatform): Partial<SocialPost> {
  const out = { ...post }
  if (out.text !== undefined && isBlockStub(out.text, platform)) out.text = ''
  if (out.externalTitle !== undefined && isBlockStub(out.externalTitle, platform)) out.externalTitle = ''
  if (out.photoUrls) out.photoUrls = out.photoUrls.filter(isValidMediaUrl)
  if (out.imageUrl && !isValidMediaUrl(out.imageUrl)) out.imageUrl = null
  if (out.video && !isValidMediaUrl(out.video.url)) out.video = null
  if (out.thread) {
    out.thread = out.thread.map((item) => ({ ...item, photoUrls: item.photoUrls.filter(isValidMediaUrl) }))
  }
  return out
}

function isEmpty(value: unknown): boolean {
  return (
    value === undefined || value === null || value === '' || value === 0 || (Array.isArray(value) && value.length === 0)
  )
}

/** Copies only the fields the accumulator lacks. A photo list also fills an image-only entry, and a video fills a null. */
function mergeFillGaps(acc: SocialPost, incoming: Partial<SocialPost>): SocialPost {
  const merged: Record<string, unknown> = { ...acc }
  for (const [key, value] of Object.entries(incoming)) {
    if (isEmpty(merged[key]) && !isEmpty(value)) merged[key] = value
  }
  return merged as unknown as SocialPost
}

async function runReader(
  reader: SocialReader,
  target: SocialPostTarget,
  run: ChainRun,
  leftMs: number
): Promise<ReaderResult> {
  if (run.signal.aborted) return { ok: false, reason: 'timeout' }
  const limit = Math.max(1, Math.min(reader.timeoutMs, run.budgetMs, leftMs))
  const own = new AbortController()
  const timer = setTimeout(() => own.abort(), limit)
  const signal = AbortSignal.any([run.signal, own.signal])
  // A reader that ignores its signal still ends at the limit.
  const stopped = new Promise<ReaderResult>((resolve) => {
    if (signal.aborted) {
      resolve({ ok: false, reason: 'timeout' })
      return
    }
    signal.addEventListener('abort', () => resolve({ ok: false, reason: 'timeout' }), { once: true })
  })
  try {
    return await Promise.race([
      reader.read(target, {
        fetcher: run.fetcher,
        runExtractor: run.runExtractor,
        signal,
        timeoutMs: limit,
        maxTextChars: run.maxTextChars
      }),
      stopped
    ])
  } catch {
    return { ok: false, reason: signal.aborted ? 'timeout' : 'network_error' }
  } finally {
    clearTimeout(timer)
  }
}

/** Runs the readers in order and merges what they find. Stops on a complete post, a terminal answer or the deadline. */
export async function runChain(
  readers: readonly SocialReader[],
  target: SocialPostTarget,
  run: ChainRun
): Promise<ChainOutcome> {
  const shape = shapeOf(target)
  let acc = blankPost(target)
  const attempts: ChainAttempt[] = []
  let terminal = false

  for (const reader of readers) {
    if (isComplete(acc, shape)) break
    const missing = missingFields(acc, shape)
    if (!reader.provides.some((field) => missing.includes(field))) continue
    if (!reader.isConfigured()) continue

    const leftMs = run.deadlineAt - run.now()
    if (leftMs <= 0 || run.signal.aborted) {
      attempts.push({ readerId: reader.id, ok: false, reason: 'timeout', ms: 0 })
      break
    }
    const startedAt = run.now()
    const result = await runReader(reader, target, run, leftMs)
    attempts.push({
      readerId: reader.id,
      ok: result.ok,
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
      ms: Math.max(0, run.now() - startedAt)
    })
    if (result.ok && result.post) acc = mergeFillGaps(acc, clean(result.post, target.platform))
    // Only a first-party API failure may end the chain: a mirror or scraper reporting a removed post is not proof.
    if (!result.ok && result.terminal && (reader.kind === 'api_public' || reader.kind === 'api_keyed')) {
      terminal = true
      break
    }
  }

  if (terminal || !hasAnyField(acc)) return { status: 'failed', attempts }
  const post = { ...acc, id: acc.id || target.id, canonicalUrl: acc.canonicalUrl || target.canonicalUrl, target }
  if (isComplete(acc, shape)) return { status: 'readable', post, missing: [], attempts }
  return { status: 'partial', post, missing: missingFields(acc, shape), attempts }
}
