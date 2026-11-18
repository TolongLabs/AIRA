import type { SocialPlatform, SocialPostTarget } from './urls.js'

export interface PlayableVideo {
  url: string
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

export interface SocialPost {
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

export type SocialPostLookup =
  | { status: 'found'; post: SocialPost }
  | { status: 'failed'; platform: SocialPlatform; reason: string }
  | { status: 'none' }

export interface SocialReply {
  author: string
  text: string
  likes: number | null
}

export type ReplyLookup =
  | { status: 'found'; platform: SocialPlatform; replies: SocialReply[]; total: number | null }
  | { status: 'failed'; platform: SocialPlatform; reason: string }
