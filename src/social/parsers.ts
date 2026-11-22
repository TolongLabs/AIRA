import type { PlayableVideo, SocialPost } from './types.js'
import { parseOfficialSocialPostUrl, type SocialPostTarget } from './urls.js'
import { selectPlayableVideo, type VideoCandidate } from './videoVariant.js'

type JsonObject = Record<string, unknown>

export function object(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {}
}

export function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function string(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function _count(value: unknown): number {
  return Array.isArray(value) ? value.length : 0
}

function compact(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

export function capped(value: unknown, maxTextChars: number): string {
  return compact(string(value)).slice(0, maxTextChars)
}

export function nonNegativeInteger(value: unknown): number | null {
  return Number.isInteger(value) && (value as number) >= 0 ? (value as number) : null
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function positiveFiniteNumber(value: unknown): number | null {
  const number = finiteNumber(value)
  return number !== null && number > 0 ? number : null
}

function nonNegativeFiniteNumber(value: unknown): number | null {
  const number = finiteNumber(value)
  return number !== null && number >= 0 ? number : null
}

function headers(value: unknown): Record<string, string> | null {
  const entries = Object.entries(object(value)).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string'
  )
  return entries.length ? Object.fromEntries(entries) : null
}

export function date(value: unknown): string | null {
  const input = string(value)
  const parsed = /^\d{8}$/.test(input)
    ? new Date(`${input.slice(0, 4)}-${input.slice(4, 6)}-${input.slice(6, 8)}T00:00:00Z`)
    : new Date(input)
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString().slice(0, 10)
}

export function imageUrl(value: unknown): string | null {
  const url = string(value)
  return /^https:\/\//i.test(url) ? url : null
}

/** The most photos a post keeps (docs/trd/models.md#social-post-and-reply-readers). */
export const MAX_POST_PHOTOS = 20

/** The usable https URLs among `values`, in order, once each, at most MAX_POST_PHOTOS. */
export function photoList(values: unknown[]): string[] {
  const urls = values.map(imageUrl).filter((url): url is string => url !== null)
  return [...new Set(urls)].slice(0, MAX_POST_PHOTOS)
}

export function base(target: SocialPostTarget): SocialPost {
  return {
    platform: target.platform,
    id: target.id,
    canonicalUrl: target.canonicalUrl,
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

export function nativePhotos(owner: string, urls: string[]): NonNullable<SocialPost['attachments']> {
  return urls.map((url) => ({ kind: 'image', owner, url }))
}

export function parseFxTwitterResponse(payload: unknown, target: SocialPostTarget, maxTextChars: number): SocialPost {
  const tweet = object(object(payload).tweet)
  const author = object(tweet.author)
  const media = object(tweet.media)
  const photos = array(media.photos)
  const videos = array(media.videos)
  const firstPhoto = object(photos[0])
  const firstVideo = object(videos[0])
  const quote = object(tweet.quote)
  const quoteAuthor = object(quote.author)
  const post = base(target)
  post.authorHandle = string(author.screen_name)
  post.authorName = string(author.name)
  post.createdAt = date(tweet.created_at)
  post.text = capped(tweet.text, maxTextChars)
  post.quotedText = capped(quote.text, maxTextChars)
  post.quotedAuthorHandle = string(quoteAuthor.screen_name)
  post.photoCount = photos.length
  post.videoCount = videos.length
  post.imageUrl = imageUrl(firstPhoto.url) ?? imageUrl(firstVideo.thumbnail_url)
  post.photoUrls = photoList(photos.map((photo) => object(photo).url))
  post.replyCount = nonNegativeInteger(tweet.replies)
  post.durationSec = positiveFiniteNumber(firstVideo.duration)

  const variants = array(firstVideo.variants).map((value): VideoCandidate => {
    const variant = object(value)
    const contentType = string(variant.content_type).toLowerCase()
    return {
      url: string(variant.url),
      container: contentType === 'video/mp4' ? 'mp4' : contentType === 'application/x-mpegurl' ? 'm3u8' : null,
      protocol: null,
      hasVideo: true,
      hasAudio: null,
      bytes: null,
      bitrate: finiteNumber(variant.bitrate),
      headers: null
    }
  })
  const formats = array(firstVideo.formats).map((value): VideoCandidate => {
    const format = object(value)
    return {
      url: string(format.url),
      container: typeof format.container === 'string' ? format.container : null,
      protocol: null,
      hasVideo: true,
      hasAudio: null,
      bytes: null,
      bitrate: finiteNumber(format.bitrate),
      headers: null
    }
  })
  const fallback: VideoCandidate = {
    url: string(firstVideo.url),
    container: firstVideo.format === 'video/mp4' ? 'mp4' : null,
    protocol: null,
    hasVideo: true,
    hasAudio: null,
    bytes: null,
    bitrate: null,
    headers: null
  }
  post.video = selectPlayableVideo(variants) ?? selectPlayableVideo(formats) ?? selectPlayableVideo([fallback])
  if (tweet.id === target.id) {
    const native = photos.map(object).filter((photo) => photo.type === 'photo')
    post.attachments = nativePhotos(target.lookupKey, photoList(native.map((photo) => photo.url)))
    if (firstVideo.type === 'video' && !media.broadcast && post.video) {
      post.attachments.push({
        kind: 'video',
        owner: target.lookupKey,
        video: post.video,
        durationSec: post.durationSec
      })
    }
  }
  return post
}

function blueskyQuote(embed: JsonObject): { text: string; author: string } {
  const recordView = object(embed.record)
  const record = object(recordView.record)
  const value = object(record.value)
  const author = object(record.author)
  return { text: string(value.text), author: string(author.handle) }
}

export interface BlueskyBlob {
  did: string
  cid: string
  bytes: number | null
}

export interface ParsedBlueskyThread {
  post: SocialPost
  blueskyBlob?: BlueskyBlob
  /** True when the post's own video is the blob its verified record names. Only then may it be offered as native. */
  nativeVideo?: boolean
}

function blueskyBlob(record: JsonObject, did: string): BlueskyBlob | undefined {
  const embed = object(record.embed)
  const video = object(embed.video ?? object(embed.media).video)
  const cid = string(object(video.ref).$link)
  if (string(video.mimeType) !== 'video/mp4' || !did || !cid) return undefined
  return { did, cid, bytes: nonNegativeInteger(video.size) }
}

export function parseBlueskyThread(
  payload: unknown,
  target: SocialPostTarget,
  maxTextChars: number,
  resolvedDid?: string
): ParsedBlueskyThread | null {
  const thread = object(object(payload).thread)
  const postView = object(thread.post)
  const record = object(postView.record)
  if (!Object.keys(postView).length || !Object.keys(record).length) return null

  const author = object(postView.author)
  if (
    resolvedDid &&
    ((typeof author.did === 'string' && author.did !== resolvedDid) ||
      (typeof postView.uri === 'string' && postView.uri !== `at://${resolvedDid}/app.bsky.feed.post/${target.id}`))
  )
    return null
  const embed = object(postView.embed)
  const media = embed.$type === 'app.bsky.embed.recordWithMedia#view' ? object(embed.media) : embed
  const images = array(media.images)
  const videos = media.$type === 'app.bsky.embed.video#view' ? [media] : []
  const external = object(media.external)
  const firstImage = object(images[0])
  const quote = blueskyQuote(embed)
  const post = base(target)
  post.authorHandle = string(author.handle)
  post.authorName = string(author.displayName)
  post.createdAt = date(record.createdAt)
  post.text = capped(record.text, maxTextChars)
  post.quotedText = capped(quote.text, maxTextChars)
  post.quotedAuthorHandle = quote.author
  post.photoCount = images.length
  post.videoCount = videos.length
  post.externalTitle = string(external.title)
  post.imageUrl = imageUrl(firstImage.fullsize) ?? imageUrl(videos[0]?.thumbnail) ?? imageUrl(external.thumb)
  post.photoUrls = photoList(images.map((image) => object(image).fullsize))
  post.replyCount = nonNegativeInteger(postView.replyCount)
  if (
    resolvedDid &&
    author.did === resolvedDid &&
    postView.uri === `at://${resolvedDid}/app.bsky.feed.post/${target.id}` &&
    media.$type === 'app.bsky.embed.images#view'
  ) {
    post.attachments = nativePhotos(target.lookupKey, post.photoUrls)
  }
  const blob = blueskyBlob(record, string(author.did))
  // Native only when the record's own DID, URI and blob CID all name this post, and the view is its own video.
  const nativeVideo =
    Boolean(resolvedDid) &&
    author.did === resolvedDid &&
    postView.uri === `at://${resolvedDid}/app.bsky.feed.post/${target.id}` &&
    media.$type === 'app.bsky.embed.video#view' &&
    blob !== undefined &&
    string(media.cid) === blob.cid
  return blob ? { post, blueskyBlob: blob, nativeVideo } : { post }
}

export function parseYouTubeOEmbed(
  payload: unknown,
  target: SocialPostTarget,
  maxTextChars: number
): SocialPost | null {
  const data = object(payload)
  const title = capped(data.title, maxTextChars)
  if (!title) return null
  const post = base(target)
  post.authorHandle = string(data.author_url).match(/\/@([^/?#]+)/)?.[1] ?? ''
  post.authorName = string(data.author_name)
  post.text = title
  post.imageUrl = imageUrl(data.thumbnail_url)
  post.videoCount = 1
  return post
}

const BILIBILI_BV_ID = /^BV[\da-z]+$/i
const BILIBILI_PART_ID = /^(BV[\da-z]+)_p(\d+)$/i
const PART_NUMBER = /^[1-9]\d*$/

/** The part selected in the canonical address, if any. */
function requestedPart(target: SocialPostTarget): string | null {
  return new URL(target.canonicalUrl).searchParams.get('p')
}

/**
 * A Bilibili id is the target's own when it is the exact BV id of a single video, or the one part the link named.
 * A multi-part id never stands for its first part, nor for a part the link did not name.
 */
function bilibiliIdMatches(id: string, target: SocialPostTarget): boolean {
  if (!BILIBILI_BV_ID.test(target.id)) return false
  const requested = requestedPart(target)
  if (requested === null) return id === target.id
  const part = BILIBILI_PART_ID.exec(id)
  return PART_NUMBER.test(requested) && part !== null && part[1] === target.id && part[2] === requested
}

/**
 * Whether a yt-dlp envelope proves the target's own native video: the target's id and page, an MP4 the extractor
 * selected, and neither a live stream nor a playlist. Only Facebook and Bilibili are native here. YouTube, TikTok
 * and Reddit take video from their own readers and mirrors; Instagram takes it from its page.
 */
function isNativeYtDlpVideo(
  data: JsonObject,
  target: SocialPostTarget,
  formats: readonly VideoCandidate[],
  video: PlayableVideo
): boolean {
  if (!formats.some((format) => format.url === video.url && format.container === 'mp4')) return false
  if (data._type !== 'video' || Array.isArray(data.entries) || data.playlist_id != null || data.playlist_index != null)
    return false
  if (data.is_live === true || (typeof data.live_status === 'string' && data.live_status !== 'not_live')) return false
  const page = typeof data.webpage_url === 'string' ? parseOfficialSocialPostUrl(data.webpage_url) : null
  if (page === null || page.lookupKey !== target.lookupKey) return false
  if (target.platform === 'facebook') return data.extractor_key === 'Facebook' && data.id === target.id
  if (target.platform === 'bilibili') {
    return data.extractor_key === 'BiliBili' && bilibiliIdMatches(string(data.id), target)
  }
  return false
}

export function parseYtDlpMetadata(payload: unknown, target: SocialPostTarget, maxTextChars: number): SocialPost {
  const data = object(payload)
  const post = base(target)
  const title = compact(string(data.title))
  const description = compact(string(data.description))
  // channel_id is a subreddit or a YouTube channel key and a numeric uploader_id is a TikTok or Instagram account
  // number, so neither names the account the way a reader would. Instagram keeps the username in channel.
  const uploaderId = string(data.uploader_id).replace(/^@/, '')
  const instagramUsername = target.platform === 'instagram' ? string(data.channel) : ''
  post.authorHandle = instagramUsername || (/^\d+$/.test(uploaderId) ? '' : uploaderId) || string(data.uploader)
  post.authorName = string(data.uploader) || string(data.channel) || string(data.channel_id)
  post.createdAt = date(data.upload_date)
  post.text = [title, description].filter(Boolean).join(' — ').slice(0, maxTextChars)
  post.imageUrl = imageUrl(data.thumbnail)
  post.replyCount = nonNegativeInteger(data.comment_count)
  post.durationSec = positiveFiniteNumber(data.duration)
  const formats = array(data.formats).map((value): VideoCandidate => {
    const format = object(value)
    const videoCodec = string(format.vcodec)
    const audioCodec = string(format.acodec)
    return {
      url: string(format.url),
      container: typeof format.ext === 'string' ? format.ext : null,
      protocol: typeof format.protocol === 'string' ? format.protocol : null,
      // yt-dlp names audio-only formats 'none'; a format with no codec listed (Instagram's muxed MP4s) is a video.
      hasVideo: videoCodec !== 'none',
      hasAudio: audioCodec === '' ? null : audioCodec !== 'none',
      bytes: nonNegativeFiniteNumber(format.filesize ?? format.filesize_approx),
      bitrate: finiteNumber(format.tbr),
      headers: headers(format.http_headers)
    }
  })
  const video = selectPlayableVideo(formats)
  post.video = video
  if (video && isNativeYtDlpVideo(data, target, formats, video)) {
    post.attachments = [{ kind: 'video', owner: target.lookupKey, video, durationSec: post.durationSec }]
  }
  // yt-dlp gives an Instagram reel no duration, so a playable format is what marks it as a video.
  post.videoCount = typeof data.duration === 'number' || post.video ? 1 : 0
  post.photoCount = target.platform === 'instagram' && post.videoCount === 0 ? 1 : 0
  return post
}
