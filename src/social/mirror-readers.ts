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

const TIKTOK_VIDEO_HOSTS = new Set(['v16m.tiktokcdn-us.com', 'www.tikwm.com'])
const PREVIEW_HOSTS = new Set(['i.redd.it', 'preview.redd.it', 'external-preview.redd.it'])

function allowedPreview(url: URL): boolean {
  return (
    PREVIEW_HOSTS.has(url.hostname) ||
    url.hostname.endsWith('.tiktokcdn.com') ||
    url.hostname.endsWith('.tiktokcdn-us.com')
  )
}

export function isMirrorAssetUrl(value: string): boolean {
  const url = httpsUrl(value)
  return Boolean(url && (url.hostname === 'v.redd.it' || TIKTOK_VIDEO_HOSTS.has(url.hostname) || allowedPreview(url)))
}

function preview(value: unknown): string | null {
  const url = httpsUrl(value)
  return url && allowedPreview(url) ? url.href : null
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
  post.imageUrl = preview(postData.cover)
  post.durationSec = positive(postData.duration)
  post.videoCount = 1
  const raw = string(postData.wmplay)
  const url = httpsUrl(raw.startsWith('//') ? `https:${raw}` : raw.startsWith('/') ? `${TIKWM}${raw}` : raw)
  if (url && TIKTOK_VIDEO_HOSTS.has(url.hostname)) {
    setVideo(post, { url: url.href, bytes: positive(postData.wm_size), hasAudio: null, headers: null }, allowGroup)
  }
  return { ok: true, post }
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
  post.imageUrl = preview(row.thumbnail)
  if (row.is_video !== true) return { ok: true, post }

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
