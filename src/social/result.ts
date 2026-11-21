import type { PostField, SocialPost, SocialReply } from './types.js'
import { PLATFORM_NAME, type SocialPlatform } from './urls.js'

/** The fields of a read post, as the model reads them. */
export interface ReadPostPayload {
  untrusted: true
  author: string
  text: string
  media: string[]
  platform: SocialPlatform
  handle: string
  createdAt: string | null
  quotedText: string
  replyCount: number | null
  canonicalUrl: string
  thread: { author: string; text: string; media: string[] }[]
  replies: SocialReply[]
  durationSec: number | null
}

/** What the social port returns: the payload, with the fields it lacks when the post is only partly read. */
export type PostPortResult = ReadPostPayload & { missing?: PostField[] }

/** A post read in whole or in part. A total failure is never a result: it is a failed tool call. */
export interface ModelPostResult {
  status: 'readable' | 'partial'
  untrusted: true
  /** The platform's display name, such as "Reddit". */
  platform: string
  post: ReadPostPayload
  missing?: PostField[]
  /** Set only when partial: a fixed sentence saying what was visible. */
  note?: string
}

const FIELD_LABEL: Record<PostField, string> = { text: 'text', author: 'author', media: 'pictures', video: 'video' }
const FIELDS: readonly PostField[] = ['text', 'author', 'media', 'video']
const VISIBLE_MEDIA_SHAPE = Symbol('visibleMediaShape')

type MediaShape = { pictures: boolean; video: boolean }

function joinWords(items: readonly string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

function isSocialPost(post: SocialPost | ReadPostPayload): post is SocialPost {
  return 'photoUrls' in post
}

function socialPostMediaShape(post: SocialPost): MediaShape {
  return {
    pictures: (post.photoUrls?.length ?? 0) > 0 || (post.imageUrl ?? null) !== null,
    video: post.platform === 'youtube' ? (post.durationSec ?? null) !== null : (post.video ?? null) !== null
  }
}

/** Converts a rich internal SocialPost to the model-facing port payload without losing media shape for notes. */
export function toPostPortResult(
  post: SocialPost,
  options: { missing?: readonly PostField[]; replies?: SocialReply[] } = {}
): PostPortResult {
  const photoUrls = post.photoUrls ?? []
  const thread = post.thread ?? []
  const result: PostPortResult = {
    untrusted: true,
    author: post.authorName || post.authorHandle,
    text: post.text.trim() !== '' ? post.text : post.externalTitle,
    media: [...(photoUrls.length > 0 ? photoUrls : [post.imageUrl]), post.video?.url].filter((value): value is string =>
      Boolean(value)
    ),
    platform: post.platform,
    handle: post.authorHandle,
    createdAt: post.createdAt,
    quotedText: post.quotedText,
    replyCount: post.replyCount,
    canonicalUrl: post.canonicalUrl,
    thread: thread.map((item) => ({ author: item.authorHandle, text: item.text, media: item.photoUrls })),
    replies: options.replies ?? [],
    durationSec: post.durationSec,
    ...(options.missing && options.missing.length > 0 ? { missing: [...options.missing] } : {})
  }
  // Non-enumerable so JSON serialization and `{ ...read }` spreads omit internal metadata from model payloads.
  Object.defineProperty(result, VISIBLE_MEDIA_SHAPE, {
    value: socialPostMediaShape(post),
    enumerable: false
  })
  return result
}

function visibleFields(post: SocialPost | PostPortResult, missingOverride?: readonly PostField[]): PostField[] {
  const missing = new Set(missingOverride ?? (isSocialPost(post) ? [] : (post.missing ?? [])))
  if (isSocialPost(post)) {
    const mediaShape = socialPostMediaShape(post)
    const present: Record<PostField, boolean> = {
      text: (post.text ?? '').trim() !== '' || (post.externalTitle ?? '').trim() !== '',
      author: (post.authorName ?? '').trim() !== '' || (post.authorHandle ?? '').trim() !== '',
      media: mediaShape.pictures,
      video: mediaShape.video
    }
    return FIELDS.filter((field) => !missing.has(field) && present[field])
  }

  const shape = (post as { [VISIBLE_MEDIA_SHAPE]?: MediaShape })[VISIBLE_MEDIA_SHAPE]
  const present: Record<PostField, boolean> = {
    text: post.text.trim() !== '',
    author: post.author.trim() !== '' || post.handle.trim() !== '',
    media: shape ? shape.pictures : !missing.has('media') && post.media.length > 0,
    video: shape
      ? shape.video
      : !missing.has('video') &&
        (post.platform === 'youtube'
          ? post.durationSec !== null
          : post.durationSec !== null || (missing.has('media') && post.media.length > 0))
  }
  return FIELDS.filter((field) => !missing.has(field) && present[field])
}

/** The fixed sentence for a partial read, built strictly from the fields that were actually visible. */
export function partialNote(post: SocialPost | PostPortResult, missing?: readonly PostField[]): string {
  const visible = visibleFields(post, missing).map((field) => FIELD_LABEL[field])
  if (visible.length === 0) return 'No post fields were visible.'
  return `Only the ${joinWords(visible)} ${visible.length === 1 ? 'was' : 'were'} visible.`
}

export function modelPostResult(read: PostPortResult): ModelPostResult {
  const { missing, ...post } = read
  const platform = PLATFORM_NAME[post.platform]
  if (!missing || missing.length === 0) return { status: 'readable', untrusted: true, platform, post }
  return { status: 'partial', untrusted: true, platform, post, missing, note: partialNote(read, missing) }
}
