import { fillMetaPost, type JsonObject, walkPageData } from './meta.js'
import { base, nonNegativeInteger, object } from './parsers.js'
import type { SocialPost } from './types.js'
import type { SocialPostTarget } from './urls.js'

/** Every post the page shows logged out. Instagram leaves `if_not_gated_logged_out` null for a gated post. */
function polarisMedia(html: string): JsonObject[] {
  const found: JsonObject[] = []
  walkPageData(html, (value) => {
    if (!('xig_polaris_media' in value)) return
    const media = object(object(value.xig_polaris_media).if_not_gated_logged_out)
    if (Object.keys(media).length > 0) found.push(media)
  })
  return found
}

/** The linked post from its logged-out page, or null when the page holds no such post. */
export function parseInstagramPage(html: string, target: SocialPostTarget, maxTextChars: number): SocialPost | null {
  const media = polarisMedia(html).find((item) => item.code === target.id)
  if (!media) return null
  const post = base(target)
  fillMetaPost(post, media, maxTextChars)
  post.replyCount = nonNegativeInteger(media.comment_count)
  return post
}
