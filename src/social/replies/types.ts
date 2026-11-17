import type { SocialPlatform, SocialPostTarget } from '../urls.js'
import type { runYtDlp } from '../yt-dlp.js'

export type { SocialReply, ReplyLookup } from '../types.js'
import type { ReplyLookup } from '../types.js'

export interface ReplyFetchContext {
  fetcher: typeof fetch
  runExtractor: typeof runYtDlp
  ytDlpPath: string
  signal: AbortSignal
  maxReplies: number
  maxReplyChars: number
  youtubeApiKey: string | undefined
  timeoutMs: number
}

export type ReplyFetcher = (target: SocialPostTarget, context: ReplyFetchContext) => Promise<ReplyLookup>
