import type { ReaderContext, ReaderResult, SocialReader } from './chain.js'
import { array, base, capped, object, string } from './parsers.js'
import type { SocialMirrorSettings } from './readers.js'
import type { PlayableVideo, SocialPost } from './types.js'
import { parseOfficialSocialPostUrl, type SocialPlatform, type SocialPostTarget } from './urls.js'

export type MirrorPlatform = 'tiktok' | 'reddit' | 'rednote' | 'douyin'

const MAX_RESPONSE_BYTES = 256_000
const MAX_REDNOTE_PHOTOS = 20
const TIKWM = 'https://www.tikwm.com'
const ARCTIC_SHIFT = 'https://arctic-shift.photon-reddit.com'
const APIFY_REDNOTE_ENDPOINT =
  'https://api.apify.com/v2/acts/socialdatax~socialdatax-xhs-data-api/run-sync-get-dataset-items?timeout=30&memory=256'
const APIFY_DOUYIN_ENDPOINT =
  'https://api.apify.com/v2/acts/natanielsantos~douyin-scraper/run-sync-get-dataset-items?timeout=30&memory=512'
const APIFY_TIKTOK_ENDPOINT =
  'https://api.apify.com/v2/acts/gentle_cloud~tiktok-videos-watermark-free-scraper/run-sync-get-dataset-items?timeout=30&memory=128'

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

/** TikWM's own media host. TikTok's CDN hosts rotate (`v16m`, `v19`, ...), so they are matched by domain. */
const TIKWM_MEDIA_HOST = 'www.tikwm.com'

export function mirrorVideoRangeBytes(video: PlayableVideo): number | undefined {
  if (
    video.mirror === 'tiktok' &&
    video.bytes !== null &&
    video.bytes >= 8_000_000 &&
    Number.isSafeInteger(video.bytes) &&
    isTikTokCdnHost(httpsUrl(video.url)?.hostname ?? '')
  ) {
    return video.bytes
  }
}
const REDDIT_PREVIEW_HOSTS = new Set(['i.redd.it', 'preview.redd.it', 'external-preview.redd.it'])

function isTikTokCdnHost(host: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.tiktokcdn(?:-us)?\.com$/.test(host)
}

/** Rednote media CDN hosts (`*.xhscdn.com`), excluding avatar hosts so profile pictures never qualify as post media. */
function isXhsPostMediaHost(host: string): boolean {
  return (
    !host.startsWith('sns-avatar-') &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.xhscdn\.com$/.test(host)
  )
}

function isDouyinMediaHost(host: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.(?:douyinvod\.com|zjcdn\.com|amemv\.com|bytecdn\.cn)$/.test(
    host
  )
}

function isDouyinPreviewHost(host: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.douyinpic\.com$/.test(host)
}

function isApifyKvUrl(url: URL): boolean {
  return url.origin === 'https://api.apify.com' && url.pathname.startsWith('/v2/key-value-stores/')
}

/** The mirror platform whose media origin serves this URL, if any. */
export function mirrorAssetPlatform(value: string): MirrorPlatform | undefined {
  const url = httpsUrl(value)
  if (!url) return undefined
  if (url.hostname === TIKWM_MEDIA_HOST || isTikTokCdnHost(url.hostname) || isApifyKvUrl(url)) return 'tiktok'
  if (url.hostname === 'v.redd.it' || REDDIT_PREVIEW_HOSTS.has(url.hostname)) return 'reddit'
  if (isXhsPostMediaHost(url.hostname)) return 'rednote'
  if (isDouyinMediaHost(url.hostname) || isDouyinPreviewHost(url.hostname)) return 'douyin'
  return undefined
}

/** Only the enabled mirror's own posts use its origin-locked download policy. */
export function enabledMirrorAsset(
  value: string,
  source: SocialPlatform | undefined,
  settings: SocialMirrorSettings
): boolean {
  if (source !== 'tiktok' && source !== 'reddit' && source !== 'rednote' && source !== 'douyin') return false
  if ((source === 'rednote' || source === 'douyin') && !settings.apifyToken) return false
  return (settings[source] ?? 'off') !== 'off' && mirrorAssetPlatform(value) === source
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
  // A verified video owned by this post may carry no duration; the group path measures it before delivery.
  if (allowGroup)
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
  if (url && (url.hostname === TIKWM_MEDIA_HOST || isTikTokCdnHost(url.hostname))) {
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

function xhsMediaUrl(value: unknown): string | null {
  const url = httpsUrl(value)
  return url && isXhsPostMediaHost(url.hostname) ? url.href : null
}

function rednotePost(document: unknown, target: SocialPostTarget, maxChars: number, allowGroup: boolean): ReaderResult {
  const entries = Array.isArray(document) ? document : [document]
  const row = entries
    .map(object)
    .find((candidate) => string(candidate.note_id).toLowerCase() === target.id.toLowerCase())
  if (!row) {
    const hasAnyId = entries.some((candidate) => string(object(candidate).note_id).length > 0)
    return { ok: false, reason: hasAnyId ? 'identity_mismatch' : 'no_post_data' }
  }

  const post = base(target)
  const title = string(row.title).trim()
  const content = string(row.content).trim()
  const combined = title && content && !content.startsWith(title) ? `${title}\n\n${content}` : content || title
  post.text = capped(combined, maxChars)
  post.authorName = capped(row.author_name, 160)
  const published = positive(row.publish_time)
  if (published !== null) post.createdAt = new Date(published * 1000).toISOString()

  const cover = xhsMediaUrl(row.cover_image_url)
  const videoUrl = xhsMediaUrl(row.video_video_url)
  const isVideo = row.note_type === 'video' || videoUrl !== null

  if (isVideo) {
    post.imageUrl = cover
    post.videoCount = 1
    const durationMs = positive(row.video_duration_ms)
    post.durationSec = durationMs !== null ? durationMs / 1000 : null
    if (videoUrl) {
      setVideo(post, { url: videoUrl, mirror: 'rednote', bytes: null, hasAudio: null, headers: null }, allowGroup)
    }
    return { ok: true, post }
  }

  const seen = new Set<string>()
  const photos: string[] = []
  for (const entry of array(row.image_items)) {
    const photo = xhsMediaUrl(object(entry).image_url)
    if (!photo || seen.has(photo)) continue
    seen.add(photo)
    photos.push(photo)
    if (photos.length >= MAX_REDNOTE_PHOTOS) break
  }
  post.photoUrls = photos
  post.photoCount = photos.length
  post.imageUrl = photos[0] ?? cover
  if (allowGroup && photos.length > 0) {
    post.attachments = photos.map((url) => ({ kind: 'image', owner: target.lookupKey, url }))
  }
  return { ok: true, post }
}

/** True when a verified Douyin play URL may redirect across Douyin's rotating CDN edges (cookieless). */
export function isDouyinRedirectMediaUrl(value: string): boolean {
  const url = httpsUrl(value)
  return url !== undefined && isDouyinMediaHost(url.hostname)
}

function douyinPost(document: unknown, target: SocialPostTarget, maxChars: number, allowGroup: boolean): ReaderResult {
  const entries = Array.isArray(document) ? document : [document]
  const row = entries.map(object).find((candidate) => string(candidate.id) === target.id)
  if (!row) {
    const hasAnyId = entries.some((candidate) => string(object(candidate).id).length > 0)
    return { ok: false, reason: hasAnyId ? 'identity_mismatch' : 'no_post_data' }
  }

  const post = base(target)
  const author = object(row.authorMeta)
  const videoMeta = object(row.videoMeta)
  post.text = capped(row.text, maxChars)
  post.authorName = capped(author.name, 160)
  post.authorHandle = capped(author.username, 160)
  const created = positive(row.createTime)
  if (created !== null) post.createdAt = new Date(created * 1000).toISOString()

  const cover = [videoMeta.originCover, videoMeta.cover, row.thumb]
    .map(httpsUrl)
    .find((url) => url !== undefined && isDouyinPreviewHost(url.hostname))
  post.imageUrl = cover?.href ?? null
  post.videoCount = 1
  const durationMs = positive(videoMeta.duration)
  post.durationSec = durationMs !== null ? durationMs / 1000 : null

  const playUrl = httpsUrl(videoMeta.playUrl)
  if (playUrl && isDouyinMediaHost(playUrl.hostname)) {
    setVideo(post, { url: playUrl.href, mirror: 'douyin', bytes: null, hasAudio: null, headers: null }, allowGroup)
  }
  return { ok: true, post }
}

function tikTokApifyPost(
  document: unknown,
  target: SocialPostTarget,
  maxChars: number,
  allowGroup: boolean
): ReaderResult {
  const entries = Array.isArray(document) ? document : [document]
  const row = entries.map(object).find((candidate) => string(candidate.id) === target.id)
  if (!row) {
    const hasAnyId = entries.some((candidate) => string(object(candidate).id).length > 0)
    return { ok: false, reason: hasAnyId ? 'identity_mismatch' : 'no_post_data' }
  }

  const post = base(target)
  const author = object(row.author)
  post.text = capped(row.desc, maxChars)
  post.authorHandle = capped(author.uniqueId, 160)
  const created = positive(row.createTime)
  if (created !== null) post.createdAt = new Date(created * 1000).toISOString()
  post.imageUrl = preview(row.thumbnail, 'tiktok')
  post.durationSec = positive(row.duration)
  post.videoCount = 1

  const downloadUrl = httpsUrl(row.videoDownloadUrl)
  if (downloadUrl && isApifyKvUrl(downloadUrl)) {
    setVideo(post, { url: downloadUrl.href, mirror: 'tiktok', bytes: null, hasAudio: null, headers: null }, allowGroup)
  }
  return { ok: true, post }
}

export function createTikTokApifyReader(timeoutMs: number, allowGroup: boolean, apifyToken: string): SocialReader {
  return {
    id: 'tiktok.apify',
    kind: 'mirror_api',
    provides: ['text', 'author', 'media', 'video'],
    timeoutMs,
    isConfigured: () => Boolean(apifyToken),
    async read(target: SocialPostTarget, ctx: ReaderContext): Promise<ReaderResult> {
      const resolved = parseOfficialSocialPostUrl(target.canonicalUrl)
      if (
        target.platform !== 'tiktok' ||
        target.needsRedirect ||
        resolved?.platform !== 'tiktok' ||
        resolved.needsRedirect ||
        resolved.id !== target.id ||
        !new URL(resolved.canonicalUrl).pathname.includes('/video/')
      ) {
        return { ok: false, reason: 'identity_mismatch' }
      }
      const response = await ctx.fetcher(APIFY_TIKTOK_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apifyToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          start_urls: [{ url: resolved.canonicalUrl }],
          request_timeout: 20
        }),
        signal: ctx.signal,
        redirect: 'error'
      })
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined)
        return { ok: false, reason: `http_${response.status}` }
      }
      let document: unknown
      try {
        document = await boundedJson(response)
      } catch {
        return { ok: false, reason: ctx.signal.aborted ? 'timeout' : 'invalid_json' }
      }
      return tikTokApifyPost(document, target, ctx.maxTextChars, allowGroup)
    }
  }
}

export function createMirrorReader(
  platform: MirrorPlatform,
  timeoutMs: number,
  allowGroup: boolean,
  onRefused?: () => void,
  apifyToken?: string
): SocialReader {
  const id =
    platform === 'tiktok'
      ? 'tiktok.tikwm'
      : platform === 'reddit'
        ? 'reddit.arctic_shift'
        : platform === 'rednote'
          ? 'rednote.apify'
          : 'douyin.apify'
  const needsApify = platform === 'rednote' || platform === 'douyin'
  return {
    id,
    kind: 'mirror_api',
    provides: ['text', 'author', 'media', 'video'],
    timeoutMs,
    isConfigured: () => (needsApify ? Boolean(apifyToken) : true),
    async read(target: SocialPostTarget, ctx: ReaderContext): Promise<ReaderResult> {
      const resolved = parseOfficialSocialPostUrl(target.canonicalUrl)
      if (
        target.platform !== platform ||
        target.needsRedirect ||
        resolved?.platform !== platform ||
        resolved.needsRedirect ||
        resolved.id !== target.id ||
        (platform === 'tiktok' && !new URL(resolved.canonicalUrl).pathname.includes('/video/'))
      )
        return { ok: false, reason: 'identity_mismatch' }
      if (needsApify && !apifyToken) return { ok: false, reason: 'unsupported' }

      let response: Response
      if (platform === 'rednote') {
        response = await ctx.fetcher(APIFY_REDNOTE_ENDPOINT, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apifyToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            operation: 'get_note_detail',
            note_id: resolved.id,
            max_items: 1,
            auto_paginate: false
          }),
          signal: ctx.signal,
          redirect: 'error'
        })
      } else if (platform === 'douyin') {
        response = await ctx.fetcher(APIFY_DOUYIN_ENDPOINT, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apifyToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            postUrls: [resolved.canonicalUrl],
            shouldDownloadVideos: false,
            shouldDownloadCovers: false
          }),
          signal: ctx.signal,
          redirect: 'error'
        })
      } else {
        const tiktok = platform === 'tiktok'
        const endpoint = new URL(tiktok ? `${TIKWM}/api/` : `${ARCTIC_SHIFT}/api/posts/ids`)
        endpoint.searchParams.set(tiktok ? 'url' : 'ids', tiktok ? resolved.canonicalUrl : resolved.id)
        response = await ctx.fetcher(endpoint, { signal: ctx.signal, redirect: 'error' })
      }
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
      if (platform === 'tiktok') return tikTokPost(document, target, ctx.maxTextChars, allowGroup)
      if (platform === 'reddit') return redditPost(document, target, ctx.maxTextChars, allowGroup)
      if (platform === 'rednote') return rednotePost(document, target, ctx.maxTextChars, allowGroup)
      return douyinPost(document, target, ctx.maxTextChars, allowGroup)
    }
  }
}
