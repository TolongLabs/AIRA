import { type JsonObject, walkPageData } from './meta.js'
import {
  array,
  base,
  capped,
  imageUrl,
  nativePhotos,
  nonNegativeInteger,
  object,
  photoList,
  string
} from './parsers.js'
import type { SocialPost } from './types.js'
import type { SocialPostTarget } from './urls.js'

/** Every full story on the page: the linked post, and sometimes others beside it. */
function stories(html: string): JsonObject[] {
  const found: JsonObject[] = []
  walkPageData(html, (value) => {
    if (value.__typename === 'Story' && Array.isArray(value.attachments) && typeof value.post_id === 'string') {
      found.push(value)
    }
  })
  return found
}

/** The media of each attachment: an album's items, or the attachment's one media. */
function attachmentMedia(story: JsonObject): JsonObject[] {
  return array(story.attachments).flatMap((item) => {
    const attachment = object(object(object(item).styles).attachment)
    const nodes = array(object(attachment.all_subattachments).nodes).map((node) => object(object(node).media))
    return nodes.length > 0 ? nodes : [object(attachment.media)]
  })
}

/** The linked post from its logged-out page, or null when the page holds no post or the post is a video. */
export function parseFacebookPage(
  html: string,
  target: SocialPostTarget,
  maxTextChars: number,
  videoIds?: Set<string>
): SocialPost | null {
  const found = stories(html)
  const photoLink = target.lookupKey.startsWith('facebook:photo:')
  const story = found.find((item) =>
    photoLink
      ? attachmentMedia(item).some((asset) => asset.__typename === 'Photo' && asset.id === target.id)
      : item.post_id === target.id
  )
  if (!story) return null
  const media = attachmentMedia(story)
  if (target.facebookGroup && videoIds) {
    for (const asset of media) {
      if (asset.__typename === 'Video' && typeof asset.id === 'string' && /^\d+$/.test(asset.id)) videoIds.add(asset.id)
    }
  }
  const videoCount = media.filter((item) => item.__typename === 'Video').length

  const photos = photoList(
    media
      .filter((item) => item.__typename === 'Photo' && (!photoLink || item.id === target.id))
      .map(
        (item) =>
          imageUrl(object(item.viewer_image).uri) ??
          imageUrl(object(item.photo_image).uri) ??
          imageUrl(object(item.image).uri)
      )
  )
  if (photos.length === 0 && videoCount > 0) return null

  const message = object(
    object(object(object(object(object(object(story.comet_sections).content).story).comet_sections).message).story)
      .message
  )
  const createdAt = nonNegativeInteger(story.creation_time)

  const post = base(target)
  post.authorName = string(object(array(story.actors)[0]).name)
  post.createdAt = createdAt === null ? null : new Date(createdAt * 1000).toISOString().slice(0, 10)
  post.text = capped(message.text ?? object(story.message).text, maxTextChars)
  post.photoUrls = photos
  post.attachments = nativePhotos(target.lookupKey, photos)
  post.photoCount = photos.length
  post.videoCount = videoCount
  post.imageUrl = photos[0] ?? null
  return post
}
