import { array, capped, imageUrl, nonNegativeInteger, object, photoList, string } from './parsers.js'
import type { SocialPost } from './types.js'
import { parseSocialPostUrl, type SocialPostTarget } from './urls.js'

// Threads and Instagram share one post shape (Meta's media model): `image_versions2`, `video_versions`,
// `carousel_media`, `caption`, `user` and `taken_at`.

export type JsonObject = Record<string, unknown>

// Threads and Instagram render a post into the page only for a request that looks like a browser navigating to
// it; without Accept and Sec-Fetch-* they serve an empty app shell.
export const META_PAGE_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1'
}

const DATA_BLOCK = /<script type="application\/json"[^>]*\bdata-sjs\b[^>]*>([\s\S]*?)<\/script>/g

/** Calls `visit` on every object in the page's embedded JSON blocks, depth first. */
export function walkPageData(html: string, visit: (value: JsonObject) => void): void {
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    if (value === null || typeof value !== 'object') return
    visit(value as JsonObject)
    for (const child of Object.values(value)) walk(child)
  }
  for (const [, json] of html.matchAll(DATA_BLOCK)) {
    try {
      walk(JSON.parse(json ?? ''))
    } catch {
      // Unrelated blocks are not always JSON the post depends on.
    }
  }
}

export function firstCandidate(media: JsonObject): string | null {
  return imageUrl(object(array(object(media.image_versions2).candidates)[0]).url)
}

export function firstVideoUrl(media: JsonObject): string | null {
  return imageUrl(object(array(media.video_versions)[0]).url)
}

/** The post's own photos: the photo items of a carousel, or the post itself when it is one photo. Never a video's cover. */
export function metaPhotoUrls(media: JsonObject): string[] {
  const items = array(media.carousel_media).map(object)
  if (items.length > 0) return photoList(items.filter((item) => !firstVideoUrl(item)).map(firstCandidate))
  return firstVideoUrl(media) ? [] : photoList([firstCandidate(media)])
}

function hasAudio(...media: JsonObject[]): boolean | null {
  const flag = media.map((item) => item.has_audio).find((value) => typeof value === 'boolean')
  return typeof flag === 'boolean' ? flag : null
}

/** Fills the author, date, text, photos and video a Meta post carries. Never the author's profile picture. */
export function fillMetaPost(post: SocialPost, media: JsonObject, maxTextChars: number): void {
  const user = object(media.user)
  const items = array(media.carousel_media).map(object)
  const videoItems = items.filter((item) => firstVideoUrl(item))
  const videoSource = firstVideoUrl(media) ? media : videoItems[0]
  const takenAt = nonNegativeInteger(media.taken_at)

  post.authorHandle = string(user.username)
  post.authorName = string(user.full_name)
  post.createdAt = takenAt === null ? null : new Date(takenAt * 1000).toISOString().slice(0, 10)
  post.text = capped(object(media.caption).text, maxTextChars)
  if (items.length > 0) {
    post.photoCount = items.length - videoItems.length
    post.videoCount = videoItems.length
  } else if (firstVideoUrl(media)) {
    post.videoCount = 1
  } else if (firstCandidate(media)) {
    post.photoCount = 1
  }
  post.imageUrl = items[0] ? firstCandidate(items[0]) : firstCandidate(media)
  post.photoUrls = metaPhotoUrls(media)
  if (videoSource) {
    post.video = {
      url: firstVideoUrl(videoSource) as string,
      bytes: null,
      headers: null,
      hasAudio: hasAudio(videoSource, media)
    }
  }
}

const REDIRECTS = new Set([301, 302, 303, 307, 308])

/**
 * The page of a post. A share or short link, one `resolved` says is not yet the post, answers with one redirect,
 * followed only when its `Location` parses as a resolved post link of the same platform; that page is fetched
 * through the same checked fetcher.
 */
export async function fetchPostPage(
  fetcher: typeof fetch,
  target: SocialPostTarget,
  signal: AbortSignal,
  resolved: (target: SocialPostTarget) => boolean
): Promise<{ page: SocialPostTarget; response: Response } | { reason: 'redirect' }> {
  const response = await fetcher(target.canonicalUrl, { headers: META_PAGE_HEADERS, signal })
  if (!REDIRECTS.has(response.status) || resolved(target)) return { page: target, response }
  await response.body?.cancel()
  const location = response.headers.get('location')
  let next: SocialPostTarget | null = null
  try {
    next = location ? parseSocialPostUrl(new URL(location, target.canonicalUrl).href) : null
  } catch {
    next = null
  }
  if (next?.platform !== target.platform || !resolved(next)) return { reason: 'redirect' }
  return { page: next, response: await fetcher(next.canonicalUrl, { headers: META_PAGE_HEADERS, signal }) }
}
