import type { SocialPlatform, SocialPostTarget } from './urls.js'

export interface PlayableVideo {
  url: string
  /** The approved mirror that verified this video's ownership. */
  mirror?: 'tiktok' | 'reddit' | 'rednote'
  /** Exact or declared byte size when known. */
  bytes: number | null
  /** Request headers the host requires (yt-dlp `http_headers`), else null. */
  headers: Record<string, string> | null
  /** true = has a sound track, false = known silent/video-only, null = unknown. */
  hasAudio: boolean | null
}

/** An earlier post of the thread a post continues (Threads only). */
export interface SocialThreadPost {
  authorHandle: string
  text: string
  photoUrls: string[]
}

/**
 * A native rendition supported by the same response that established the post identity. A video's `durationSec` is
 * null when the native duration is unknown; the group path then measures it before delivery.
 */
export type PostAttachment =
  | { kind: 'image'; url: string; owner: string }
  | { kind: 'video'; owner: string; video: PlayableVideo; durationSec: number | null }

export interface SocialPost {
  attachments?: PostAttachment[]
  platform: SocialPlatform
  id: string
  canonicalUrl: string
  target: SocialPostTarget
  authorHandle: string
  authorName: string
  createdAt: string | null
  text: string
  quotedText: string
  quotedAuthorHandle: string
  photoCount: number
  videoCount: number
  /** The one picture that stands for the post: its first photo, else a video's thumbnail or the link card's image. */
  imageUrl: string | null
  /** Every photo of the post's own, in order, up to MAX_POST_PHOTOS. Never a thumbnail, link card or avatar. */
  photoUrls: string[]
  /** The earlier posts of the thread this post continues, oldest first. Empty on every platform but Threads. */
  thread: SocialThreadPost[]
  externalTitle: string
  replyCount: number | null
  durationSec: number | null
  video: PlayableVideo | null
}

/** A field a post can lack. Its readers and the chain's completeness rules use the same names. */
export type PostField = 'text' | 'author' | 'media' | 'video'

export type SocialPostLookup =
  | { status: 'found'; post: SocialPost; missing?: PostField[] }
  | { status: 'failed'; platform: SocialPlatform; reason: string; canonicalUrl?: string }
  | { status: 'none' }

export interface SocialLookupObservation {
  target: SocialPostTarget
  started: Date
  ended: Date
  /** Absent when a platform switch skipped the lookup before any reader ran. */
  lookup?: SocialPostLookup
  trace?: SocialLookupTrace
  /** Set when the chat's platform switch skipped the lookup. Such a lookup has no attempts. */
  skip?: 'platform_disabled'
  /** Unique per parent record. Skipped lookups before the selected one take the lower ordinals. Defaults to 0. */
  ordinal?: number
}

export type SocialLookupObserver = (observation: SocialLookupObservation) => void

export interface SocialLookupTrace {
  reason?: string
  redirectHops?: number
  resolveMs?: number
  attempts: readonly { readerId: string; ok: boolean; reason?: string; ms: number }[]
}

export interface SocialReply {
  author: string
  text: string
  likes: number | null
}

export type ReplyLookup =
  | { status: 'found'; platform: SocialPlatform; replies: SocialReply[]; total: number | null }
  | { status: 'failed'; platform: SocialPlatform; reason: string }
