import type { PostPort } from '../tools/ports.js'
import type { ToolFailureKind } from '../tools/types.js'
import type { ReplyReader } from './replies/service.js'
import { parseSocialPostUrl } from './urls.js'
import type { SocialPostViewer } from './viewer.js'

export class SocialPostError extends Error {
  readonly kind: ToolFailureKind

  constructor(reason: string) {
    super(reason)
    this.kind = reason === 'timeout' ? 'timeout' : reason === 'binary_missing' ? 'unavailable' : 'error'
  }
}

export function createSocialPostPort(viewer: SocialPostViewer, replies: ReplyReader): PostPort {
  return {
    async read(url, signal) {
      const target = parseSocialPostUrl(url)
      if (!target) throw new SocialPostError('unsupported_url')
      const [lookup, replyLookup] = await Promise.all([
        viewer.lookup(target, signal),
        replies.read(target, undefined, signal).catch(() => null)
      ])
      if (lookup.status !== 'found') {
        throw new SocialPostError(lookup.status === 'failed' ? lookup.reason : 'no_post_data')
      }
      const post = lookup.post
      return {
        untrusted: true,
        author: post.authorName || post.authorHandle,
        text: post.text,
        media: [post.imageUrl, post.video?.url].filter((value): value is string => Boolean(value)),
        platform: post.platform,
        handle: post.authorHandle,
        createdAt: post.createdAt,
        quotedText: post.quotedText,
        replyCount: post.replyCount,
        canonicalUrl: post.canonicalUrl,
        replies: replyLookup?.status === 'found' ? replyLookup.replies : [],
        durationSec: post.durationSec
      }
    }
  }
}
