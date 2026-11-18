import { fetchPostPage, fillMetaPost, type JsonObject, metaPhotoUrls, walkPageData } from './meta.js'
import { array, base, capped, imageUrl, nonNegativeInteger, object, string } from './parsers.js'
import type { SocialPost, SocialThreadPost } from './types.js'
import type { SocialPostTarget } from './urls.js'

/** The most earlier posts of a thread a post carries. */
const MAX_THREAD_POSTS = 3

export interface ThreadsReply {
  author: string
  text: string
  likes: number | null
}

export interface ThreadsPage {
  post: SocialPost
  replies: ThreadsReply[]
}

/** Every `result.data.media` in the page's embedded GraphQL results: the post, its replies, and related posts. */
function mediaResults(html: string): JsonObject[] {
  const found: JsonObject[] = []
  walkPageData(html, (value) => {
    const media = object(object(object(value.result).data).media)
    if (Object.keys(media).length > 0) found.push(media)
  })
  return found
}

/**
 * The earlier posts of the thread the post continues, as the page holds them, oldest first. Threads sends them in a
 * result of their own that names the post by `id` only, as it does the replies.
 */
function threadPosts(results: JsonObject[], media: JsonObject, maxTextChars: number): SocialThreadPost[] {
  const code = media.code
  const thread = results
    .filter((item) => item.code === code || (media.id !== undefined && item.id === media.id))
    .map((item) => array(object(object(object(item.text_post_app_info).containing_thread).posts).edges))
    .find((edges) => edges.length > 0)
  return (thread ?? [])
    .map((edge) => object(object(edge).node))
    .filter((node) => typeof node.code === 'string' && node.code !== code)
    .slice(-MAX_THREAD_POSTS)
    .map((node) => ({
      authorHandle: string(object(node.user).username),
      text: capped(object(node.caption).text, maxTextChars),
      photoUrls: metaPhotoUrls(node)
    }))
}

/** The page of a Threads post; a short or share link has no profile until its redirect names the post. */
export function fetchThreadsPage(
  fetcher: typeof fetch,
  target: SocialPostTarget,
  signal: AbortSignal
): Promise<{ page: SocialPostTarget; response: Response } | { reason: 'redirect' }> {
  return fetchPostPage(fetcher, target, signal, (item) => Boolean(item.profile))
}

function replyNodes(info: JsonObject, key: 'direct_replies' | 'pinned_replies'): JsonObject[] {
  return array(object(info[key]).edges).map((edge) =>
    object(object(array(object(object(object(edge).node).posts).edges)[0]).node)
  )
}

export function parseThreadsPage(html: string, target: SocialPostTarget, maxTextChars: number): ThreadsPage | null {
  const results = mediaResults(html)
  const media = results.find((item) => item.code === target.id && 'caption' in item)
  if (!media) return null

  const info = object(media.text_post_app_info)
  const linkCard = object(info.link_preview_attachment)
  const quote = object(object(info.share_info).quoted_post)

  const post = base(target)
  fillMetaPost(post, media, maxTextChars)
  post.quotedText = capped(object(quote.caption).text, maxTextChars)
  post.quotedAuthorHandle = string(object(quote.user).username)
  post.externalTitle = capped(linkCard.title, maxTextChars)
  post.replyCount = nonNegativeInteger(info.direct_reply_count)
  post.imageUrl ??= imageUrl(linkCard.image_url)
  post.thread = threadPosts(results, media, maxTextChars)

  // The page carries the first replies Threads chose to show; a pinned reply can repeat one of them.
  const replyInfo = object(
    results.find((item) => item.id === media.id && 'direct_replies' in object(item.text_post_app_info))
      ?.text_post_app_info
  )
  const seen = new Set<string>()
  const replies: ThreadsReply[] = []
  for (const node of [...replyNodes(replyInfo, 'pinned_replies'), ...replyNodes(replyInfo, 'direct_replies')]) {
    const key = string(node.pk) || string(node.id)
    if (!key || seen.has(key)) continue
    seen.add(key)
    replies.push({
      author: string(object(node.user).username),
      text: string(object(node.caption).text),
      likes: nonNegativeInteger(node.like_count)
    })
  }

  return { post, replies }
}
