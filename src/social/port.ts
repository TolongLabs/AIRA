import type { PostPort } from '../tools/ports.js'
import type { ToolFailureKind } from '../tools/types.js'
import type { ReplyReader } from './replies/service.js'
import { type PostPortResult, toPostPortResult } from './result.js'
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
    async read(url, signal): Promise<PostPortResult> {
      const target = parseSocialPostUrl(url)
      if (!target) throw new SocialPostError('unsupported_url')
      const [lookup, replyLookup] = await Promise.all([
        viewer.lookup(target, signal),
        replies.read(target, undefined, signal).catch(() => null)
      ])
      if (lookup.status !== 'found') {
        throw new SocialPostError(lookup.status === 'failed' ? lookup.reason : 'no_post_data')
      }
      return toPostPortResult(lookup.post, {
        replies: replyLookup?.status === 'found' ? replyLookup.replies : [],
        missing: lookup.missing
      })
    }
  }
}
