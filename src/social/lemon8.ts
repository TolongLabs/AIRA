import { COMPRESSION_MAX_SECONDS } from '../media/video-compression.js'
import type { JsonObject } from './meta.js'
import { array, base, capped, nativePhotos, object, photoList, positiveFiniteNumber, string } from './parsers.js'
import { htmlToText } from './redditFeed.js'
import type { PlayableVideo, SocialPost } from './types.js'
import type { SocialPostTarget } from './urls.js'

const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi
// A `src` attribute of its own, not `data-src`: such a script is an external file with no inline article.
const SCRIPT_SRC = /(?:^|\s)src\s*=/i
const ENCODED_JSON = /^%7b/i
/** An https URL on one public subdomain of tiktokcdn.com, with no credentials, port or stray authority characters. */
function verifiedMediaUrl(value: unknown): string | null {
  const raw = string(value)
  if (/\s/.test(raw)) return null
  const authority = /^https:\/\/([^/?#]+)/i.exec(raw)?.[1]
  if (!authority || /[@:\\]/.test(authority)) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  const onCdn = url.hostname.endsWith('.tiktokcdn.com')
  return url.protocol === 'https:' && !url.username && !url.password && !url.port && onCdn ? raw : null
}

/** Only direct loader routes can own the linked article. Related items can appear deeper in the same page. */
function articleRecord(html: string, id: string): JsonObject | null {
  const key = `$ArticleDetail+${id}`
  for (const match of html.matchAll(SCRIPT)) {
    if (SCRIPT_SRC.test(match[1] ?? '')) continue
    const body = (match[2] ?? '').trim()
    if (!ENCODED_JSON.test(body)) continue
    let root: unknown
    try {
      root = JSON.parse(decodeURIComponent(body))
    } catch {
      continue
    }
    const loader = object(object(root).state).loaderData
    for (const route of Object.values(object(loader))) {
      const fields = object(route)
      if (Object.hasOwn(fields, key)) return object(fields[key])
    }
  }
  return null
}

/** The linked article from its logged-out page, or null when the page holds no article for this target. */
export function parseLemon8Page(html: string, target: SocialPostTarget, maxTextChars: number): SocialPost | null {
  const detail = articleRecord(html, target.id)
  if (!detail || string(detail.groupId) !== target.id) return null

  const author = object(detail.author)
  const linkName = string(author.linkName)
  if (!target.profile || linkName.toLowerCase() !== target.profile.toLowerCase()) return null

  const post = base(target)
  post.authorHandle = linkName
  post.authorName = capped(author.nickName, maxTextChars)
  const title = htmlToText(string(detail.title))
  const body = htmlToText(string(detail.content))
  post.text = capped([title, body].filter((part) => part !== '').join(' '), maxTextChars)

  if (detail.articleClass === 'Gallery') {
    const photos = photoList(array(detail.imageList).map((item) => verifiedMediaUrl(object(item).url)))
    post.photoUrls = photos
    post.photoCount = photos.length
    post.imageUrl = photos[0] ?? null
    if (photos.length > 0) post.attachments = nativePhotos(target.lookupKey, photos)
  } else if (detail.articleClass === 'Video') {
    const native = object(detail.video)
    const url = verifiedMediaUrl(native.url)
    const duration = positiveFiniteNumber(native.duration)
    post.imageUrl = verifiedMediaUrl(object(detail.largeImage).url)
    post.videoCount = 1
    post.durationSec = duration
    if (url) {
      const video: PlayableVideo = { url, bytes: null, headers: null, hasAudio: null }
      post.video = video
      post.attachments = [
        {
          kind: 'video',
          owner: target.lookupKey,
          video,
          durationSec: duration === COMPRESSION_MAX_SECONDS ? null : duration
        }
      ]
    }
  }
  return post
}
