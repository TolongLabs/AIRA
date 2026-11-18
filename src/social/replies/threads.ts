import { fetchThreadsPage, parseThreadsPage } from '../threads.js'
import { failed, found, rankReplies } from './common.js'
import type { ReplyFetcher } from './types.js'

// Logged out, the post page is the only source; it carries Threads' own first batch of replies, not all of them.
export const fetchThreadsReplies: ReplyFetcher = async (target, context) => {
  const fetched = await fetchThreadsPage(context.fetcher, target, context.signal)
  if ('reason' in fetched) return failed('threads', fetched.reason)
  if (!fetched.response.ok) return failed('threads', `http_${fetched.response.status}`)
  const page = parseThreadsPage(await fetched.response.text(), fetched.page, context.maxReplyChars)
  if (!page) return failed('threads', 'no_post_data')
  return found('threads', rankReplies(page.replies, context.maxReplies, context.maxReplyChars), page.post.replyCount)
}
