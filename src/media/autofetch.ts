import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { Logger } from '../records/logger.js'
import { endJobRun, startJobRun } from '../records/turn-record.js'
import { getChatByWaId } from '../settings/chats.js'
import { resolveSettings } from '../settings/settings.js'
import type { SocialPost, SocialPostLookup } from '../social/types.js'
import { findSocialPostTargets, type SocialPostTarget } from '../social/urls.js'
import type { Storage } from '../storage/database.js'
import { writeFileAtomic } from '../storage/files.js'
import type { PagePort } from '../tools/ports.js'

// A group's post links answered with the posts' own media (docs/trd/system.md#autofetch).

export const AUTOFETCH_MAX_LINKS = 3
export const AUTOFETCH_MAX_FILES = 10
export const AUTOFETCH_MAX_IMAGE_BYTES = 8_000_000
export const AUTOFETCH_MAX_VIDEO_BYTES = 16_000_000
export const AUTOFETCH_REPEAT_MS = 10 * 60_000
const AUTOFETCH_TIMEOUT_MS = 60_000

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'video/mp4': '.mp4'
}

export interface AutofetchMedia {
  kind: 'image' | 'video'
  /** The file's path on the host, where the gateway reads it. */
  path: string
}

export interface Autofetch {
  /** The media to send for one group message, in order. Empty when nothing applies. Never throws for a post. */
  fetch(input: { chat: string; text: string }): Promise<AutofetchMedia[]>
}

export interface AutofetchOptions {
  storage: Storage
  viewer: { lookup(target: SocialPostTarget, signal?: AbortSignal): Promise<SocialPostLookup> }
  download: PagePort['download']
  /** `<dataDir>/cache/autofetch`, where the core writes. */
  cacheDir: string
  /** The same folder as the gateway sees it on the host. */
  hostCacheDir: string
  logger?: Logger
  now?: () => Date
}

/** The post's own media, video first, at most AUTOFETCH_MAX_FILES. Never its one picture. */
function postMedia(post: SocialPost): { kind: AutofetchMedia['kind']; url: string }[] {
  const video = post.video ? [{ kind: 'video' as const, url: post.video.url }] : []
  const photos = post.photoUrls.map((url) => ({ kind: 'image' as const, url }))
  return [...video, ...photos].slice(0, AUTOFETCH_MAX_FILES)
}

export function createAutofetch(options: AutofetchOptions): Autofetch {
  const now = options.now ?? (() => new Date())
  const sentAt = new Map<string, number>()

  /** True when the chat may get autofetch: an active group with the switch on, not muted. */
  function allowedChat(waId: string): string | undefined {
    const chat = getChatByWaId(options.storage, waId)
    if (chat?.status !== 'active' || chat.type !== 'group') return undefined
    const settings = resolveSettings(options.storage, chat)
    if (settings['features.autofetch']?.value !== true || settings['muted']?.value) return undefined
    return chat.chatId
  }

  /** Up to AUTOFETCH_MAX_LINKS new links, YouTube aside; each is marked sent at once, so a repeat waits. */
  function freshTargets(chatId: string, text: string): SocialPostTarget[] {
    const at = now().getTime()
    for (const [key, time] of sentAt) if (at - time > AUTOFETCH_REPEAT_MS) sentAt.delete(key)
    const picked: SocialPostTarget[] = []
    for (const target of findSocialPostTargets(text)) {
      const key = `${chatId}:${target.lookupKey}`
      if (target.platform === 'youtube' || sentAt.has(key)) continue
      if (picked.some((item) => item.lookupKey === target.lookupKey)) continue
      sentAt.set(key, at)
      picked.push(target)
      if (picked.length === AUTOFETCH_MAX_LINKS) break
    }
    return picked
  }

  async function save(
    item: { kind: AutofetchMedia['kind']; url: string },
    signal: AbortSignal
  ): Promise<AutofetchMedia | undefined> {
    const maxBytes = item.kind === 'video' ? AUTOFETCH_MAX_VIDEO_BYTES : AUTOFETCH_MAX_IMAGE_BYTES
    try {
      const file = await options.download(item.url, signal, maxBytes)
      const mime = file.contentType.split(';')[0]?.trim().toLowerCase() ?? ''
      const ext = EXTENSIONS[mime]
      const kindMatches = item.kind === 'video' ? mime === 'video/mp4' : mime.startsWith('image/')
      if (!ext || !kindMatches || file.data.length === 0 || file.data.length > maxBytes) return undefined
      const name = `${createHash('sha256').update(file.data).digest('hex')}${ext}`
      writeFileAtomic(join(options.cacheDir, name), file.data)
      return { kind: item.kind, path: join(options.hostCacheDir, name) }
    } catch {
      return undefined
    }
  }

  return {
    async fetch(input) {
      const chatId = allowedChat(input.chat)
      if (!chatId) return []
      const targets = freshTargets(chatId, input.text)
      if (targets.length === 0) return []

      const runId = options.storage.tx((db) => startJobRun(db, { kind: 'autofetch', chatId }, now))
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), AUTOFETCH_TIMEOUT_MS)
      const media: AutofetchMedia[] = []
      let failed = 0
      let threw = false
      try {
        for (const target of targets) {
          const lookup = await options.viewer.lookup(target, controller.signal).catch(() => undefined)
          if (lookup?.status !== 'found') continue
          // One post's files download at once; their order is kept.
          const saved = await Promise.all(postMedia(lookup.post).map((item) => save(item, controller.signal)))
          for (const item of saved) {
            if (item) media.push(item)
            else failed++
          }
        }
      } catch (error) {
        threw = true
        throw error
      } finally {
        clearTimeout(timer)
        const counts = {
          links: targets.length,
          images: media.filter((item) => item.kind === 'image').length,
          videos: media.filter((item) => item.kind === 'video').length,
          failed
        }
        options.storage.tx((db) =>
          endJobRun(db, runId, { outcome: threw ? 'failed' : media.length > 0 ? 'sent' : 'nothing', counts }, now)
        )
        options.logger?.info('autofetch.done', counts)
      }
      return media
    }
  }
}
