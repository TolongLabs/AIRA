import type { ReaderContext, ReaderResult, SocialReader } from './chain.js'
import { array, base, capped, object, string } from './parsers.js'
import type { PlayableVideo, SocialPost } from './types.js'
import { parseOfficialSocialPostUrl, type SocialPostTarget } from './urls.js'

export type MirrorPlatform = 'tiktok' | 'reddit'

const MAX_RESPONSE_BYTES = 256_000
const TIKWM = 'https://www.tikwm.com'
const ARCTIC_SHIFT = 'https://arctic-shift.photon-reddit.com'

function httpsUrl(value: unknown): URL | undefined {
  if (typeof value !== 'string' || /\s/.test(value)) return
  const authority = /^https:\/\/([^/?#]+)/i.exec(value)?.[1]
  if (!authority || /[@:\\]/.test(authority)) return
  try {
    const url = new URL(value)
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port) return url
  } catch {}
}

function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

const TIKTOK_RANGE_HOST = 'v16m.tiktokcdn-us.com'
const TIKTOK_VIDEO_HOSTS = new Set([TIKTOK_RANGE_HOST, 'www.tikwm.com'])

export function mirrorVideoRangeBytes(video: PlayableVideo): number | undefined {
  if (
    video.mirror === 'tiktok' &&
    video.bytes !== null &&
    video.bytes >= 8_000_000 &&
    Number.isSafeInteger(video.bytes) &&
    httpsUrl(video.url)?.hostname === TIKTOK_RANGE_HOST
  ) {
    return video.bytes
  }
}
const REDDIT_PREVIEW_HOSTS = new Set(['i.redd.it', 'preview.redd.it', 'external-preview.redd.it'])

function isTikTokCdnHost(host: string): boolean {
  return /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.tiktokcdn(?:-us)?\.com$/.test(host)
}

/** The mirror platform whose media origin serves this URL, if any. */
export function mirrorAssetPlatform(value: string): 'tiktok' | 'reddit' | undefined {
  const url = httpsUrl(value)
  if (!url) return undefined
  if (TIKTOK_VIDEO_HOSTS.has(url.hostname) || isTikTokCdnHost(url.hostname)) return 'tiktok'
  if (url.hostname === 'v.redd.it' || REDDIT_PREVIEW_HOSTS.has(url.hostname)) return 'reddit'
  return undefined
}

/** A mirror's preview picture, only on that platform's own image hosts. */
function preview(value: unknown, platform: MirrorPlatform): string | null {
  const url = httpsUrl(value)
  if (!url) return null
  const own = platform === 'tiktok' ? isTikTokCdnHost(url.hostname) : REDDIT_PREVIEW_HOSTS.has(url.hostname)
  return own ? url.href : null
}

async function boundedJson(response: Response): Promise<unknown> {
  const stream = response.body?.getReader()
  if (!stream) throw new Error('missing body')
  let total = 0
  const chunks: Uint8Array[] = []
  try {
    for (;;) {
      const { value, done } = await stream.read()
      if (done) break
      total += value.length
      if (total > MAX_RESPONSE_BYTES) throw new Error('oversized body')
      chunks.push(value)
    }
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8')) as unknown
  } finally {
    void stream.cancel().catch(() => undefined)
  }
}

function setVideo(post: SocialPost, video: PlayableVideo, allowGroup: boolean) {
  post.video = video
  post.videoCount = 1
  if (allowGroup && post.durationSec !== null)
    post.attachments = [{ kind: 'video', owner: post.target.lookupKey, video, durationSec: post.durationSec }]
}

function tikTokPost(document: unknown, target: SocialPostTarget, maxChars: number, allowGroup: boolean): ReaderResult {
  const payload = object(document)
  if (payload.code !== 0) return { ok: false, reason: 'no_post_data' }
  const postData = object(payload.data)
  if ((string(postData.video_id) || string(postData.id)) !== target.id)
    return { ok: false, reason: 'identity_mismatch' }

  const post = base(target)
  const author = object(postData.author)
  post.text = capped(postData.title, maxChars)
  post.authorHandle = capped(author.unique_id, 160)
  post.authorName = capped(author.nickname, 160)
  post.imageUrl = preview(postData.cover, 'tiktok')
  post.durationSec = positive(postData.duration)
  post.videoCount = 1
  const raw = string(postData.wmplay)
  const url = httpsUrl(raw.startsWith('//') ? `https:${raw}` : raw.startsWith('/') ? `${TIKWM}${raw}` : raw)
  if (url && TIKTOK_VIDEO_HOSTS.has(url.hostname)) {
    setVideo(
      post,
      { url: url.href, mirror: 'tiktok', bytes: positive(postData.wm_size), hasAudio: null, headers: null },
      allowGroup
    )
  }
  return { ok: true, post }
}

function originalRedditPhoto(row: Record<string, unknown>): string | undefined {
  if (
    row.post_hint !== 'image' ||
    row.is_self === true ||
    row.is_gallery === true ||
    row.crosspost_parent ||
    array(row.crosspost_parent_list).length > 0
  ) {
    return
  }
  const original = httpsUrl(row.url)
  if (
    original?.hostname !== 'i.redd.it' ||
    original.search ||
    original.hash ||
    !/^\/[a-z0-9]+\.(?:jpe?g|png|webp|gif)$/i.test(original.pathname)
  ) {
    return
  }
  const override = row.url_overridden_by_dest
  if (override !== undefined && override !== null && httpsUrl(override)?.href !== original.href) return
  return original.href
}

function redditPost(document: unknown, target: SocialPostTarget, maxChars: number, allowGroup: boolean): ReaderResult {
  const entries = array(object(document).data)
  const row = entries.map(object).find((candidate) => candidate.id === target.id)
  if (!row) return { ok: false, reason: entries.length ? 'identity_mismatch' : 'no_post_data' }
  const permalink = string(row.permalink)
  const native = parseOfficialSocialPostUrl(
    permalink.startsWith('/') ? `https://www.reddit.com${permalink}` : permalink
  )
  if (native?.platform !== 'reddit' || native.needsRedirect || native.id !== target.id)
    return { ok: false, reason: 'identity_mismatch' }
  const body = capped(row.selftext, maxChars)
  const removed = /^\[(?:removed|deleted)\]$/i.test(body) || Boolean(row.removed_by_category)
  if (removed) return { ok: false, reason: 'no_post_data' }

  const post = base(target)
  post.text = body
  post.externalTitle = capped(row.title, maxChars)
  const author = capped(row.author, 160)
  if (author !== '[deleted]') post.authorHandle = author
  post.imageUrl = preview(row.thumbnail, 'reddit')
  if (row.is_video !== true) {
    const photo = originalRedditPhoto(row)
    if (photo) {
      post.photoUrls = [photo]
      post.photoCount = 1
      if (allowGroup) post.attachments = [{ kind: 'image', owner: target.lookupKey, url: photo }]
    }
    return { ok: true, post }
  }

  post.videoCount = 1
  const media = object(object(row.secure_media).reddit_video ?? object(row.media).reddit_video)
  post.durationSec = positive(media.duration)
  const original = httpsUrl(row.url)
  const rendition = httpsUrl(media.fallback_url)
  const nativeId = original?.hostname === 'v.redd.it' ? /^\/([a-z0-9]+)\/?$/i.exec(original.pathname)?.[1] : undefined
  if (
    nativeId &&
    rendition?.hostname === 'v.redd.it' &&
    rendition.pathname.split('/')[1] === nativeId &&
    rendition.pathname.endsWith('.mp4')
  )
    setVideo(
      post,
      {
        url: rendition.href,
        mirror: 'reddit',
        bytes: null,
        hasAudio: typeof media.has_audio === 'boolean' ? media.has_audio : null,
        headers: null
      },
      allowGroup
    )
  return { ok: true, post }
}

export function createMirrorReader(
  platform: MirrorPlatform,
  timeoutMs: number,
  allowGroup: boolean,
  onRefused?: () => void
): SocialReader {
  const tiktok = platform === 'tiktok'
  return {
    id: tiktok ? 'tiktok.tikwm' : 'reddit.arctic_shift',
    kind: 'mirror_api',
    provides: ['text', 'author', 'media', 'video'],
    timeoutMs,
    isConfigured: () => true,
    async read(target: SocialPostTarget, ctx: ReaderContext): Promise<ReaderResult> {
      const resolved = parseOfficialSocialPostUrl(target.canonicalUrl)
      if (
        target.platform !== platform ||
        target.needsRedirect ||
        resolved?.platform !== platform ||
        resolved.needsRedirect ||
        resolved.id !== target.id ||
        (tiktok && !new URL(resolved.canonicalUrl).pathname.includes('/video/'))
      )
        return { ok: false, reason: 'identity_mismatch' }
      const endpoint = new URL(tiktok ? `${TIKWM}/api/` : `${ARCTIC_SHIFT}/api/posts/ids`)
      endpoint.searchParams.set(tiktok ? 'url' : 'ids', tiktok ? resolved.canonicalUrl : resolved.id)
      const response = await ctx.fetcher(endpoint, { signal: ctx.signal, redirect: 'error' })
      if (!response.ok) {
        if (response.status === 403 || response.status === 429) onRefused?.()
        void response.body?.cancel().catch(() => undefined)
        return { ok: false, reason: `http_${response.status}` }
      }
      let document: unknown
      try {
        document = await boundedJson(response)
      } catch {
        return { ok: false, reason: ctx.signal.aborted ? 'timeout' : 'invalid_json' }
      }
      return (tiktok ? tikTokPost : redditPost)(document, target, ctx.maxTextChars, allowGroup)
    }
  }
}
