import { createHash, createHmac } from 'node:crypto'
import { join } from 'node:path'
import { recordAutofetchHandoff, recordSocialLookup } from '../records/autofetch.js'
import type { Logger } from '../records/logger.js'
import { endJobRun, startJobRun } from '../records/turn-record.js'
import { getChatByWaId } from '../settings/chats.js'
import { resolveSettings } from '../settings/settings.js'
import { mirrorVideoRangeBytes } from '../social/mirror-readers.js'
import { groupOperations, type SocialMirrorSettings } from '../social/readers.js'
import type { SocialLookupTrace, SocialPost, SocialPostLookup } from '../social/types.js'
import { findSocialPostTargets, parseOfficialSocialPostUrl, type SocialPostTarget } from '../social/urls.js'
import type { Db, Storage } from '../storage/database.js'
import { writeFileAtomic } from '../storage/files.js'
import type { PagePort } from '../tools/ports.js'
import { COMPRESSION_MAX_INPUT_BYTES, COMPRESSION_MAX_SECONDS, type CompressVideo, isMp4 } from './video-compression.js'

// A group's post links answered with the posts' own media (docs/trd/system.md#autofetch).

export const AUTOFETCH_MAX_LINKS = 3
export const AUTOFETCH_MAX_FILES = 10
export const AUTOFETCH_MAX_IMAGE_BYTES = 8_000_000
export const AUTOFETCH_MAX_VIDEO_BYTES = 16_000_000
export const AUTOFETCH_REPEAT_MS = 10 * 60_000
const AUTOFETCH_TIMEOUT_MS = 60_000
const AUTOFETCH_ASSET_TIMEOUT_MS = 10_000
/** A verified mirror video gets this long to download, as its CDN can be slow. */
const MIRROR_VIDEO_TIMEOUT_MS = 25_000

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'video/mp4': '.mp4'
}

function matchesSignature(mime: string, data: Buffer): boolean {
  switch (mime) {
    case 'image/jpeg':
    case 'image/jpg':
      return data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
    case 'image/png':
      return data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    case 'image/webp':
      return data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP'
    case 'image/gif':
      return data.toString('latin1', 0, 6) === 'GIF87a' || data.toString('latin1', 0, 6) === 'GIF89a'
    case 'video/mp4':
      return isMp4(data)
    default:
      return false
  }
}

export interface AutofetchMedia {
  kind: 'image' | 'video'
  /** The file's path on the host, where the gateway reads it. */
  path: string
}

export interface AutofetchBatch {
  media: AutofetchMedia[]
  deliveryKey?: string
}

export interface Autofetch {
  /** The media to send for one group message, in order. Empty when nothing applies. Never throws for a post. */
  fetch(input: { chat: string; text: string }): Promise<AutofetchBatch>
}

export interface AutofetchOptions {
  storage: Storage
  viewer: {
    lookup(
      target: SocialPostTarget,
      signal?: AbortSignal,
      observe?: (trace: SocialLookupTrace) => void
    ): Promise<SocialPostLookup>
  }
  download: PagePort['download']
  compressVideo?: CompressVideo
  mirrors?: SocialMirrorSettings
  /** `<dataDir>/cache/autofetch`, where the core writes. */
  cacheDir: string
  /** The same folder as the gateway sees it on the host. */
  hostCacheDir: string
  logger?: Logger
  now?: () => Date
}

function postMedia(
  post: SocialPost,
  target: SocialPostTarget,
  chatId: string,
  mirrors?: SocialMirrorSettings
): {
  kind: AutofetchMedia['kind']
  url: string
  headers?: Record<string, string> | null
  durationSec?: number
  downloadTimeoutMs?: number
  rangeBytes?: number
}[] {
  const resolved = parseOfficialSocialPostUrl(post.canonicalUrl)
  if (
    !resolved ||
    resolved.platform !== target.platform ||
    post.platform !== target.platform ||
    resolved.id !== post.id
  ) {
    return []
  }
  const threadsAlias = target.platform === 'threads' && /^\/(?:t|share)\//.test(new URL(target.canonicalUrl).pathname)
  if (resolved.lookupKey !== target.lookupKey && !target.needsRedirect && !threadsAlias) return []
  const operations = groupOperations(resolved.platform, mirrors, chatId)
  const attachments = (post.attachments ?? []).filter(
    (item) => item.owner === resolved.lookupKey && operations.includes(item.kind === 'image' ? 'photos' : 'video')
  )
  const video = attachments.find(
    (item) => item.kind === 'video' && Number.isFinite(item.durationSec) && item.durationSec > 0
  )
  const photos = attachments.flatMap((item) => (item.kind === 'image' ? [{ kind: item.kind, url: item.url }] : []))
  return [
    ...(video?.kind === 'video'
      ? [
          {
            kind: video.kind,
            url: video.video.url,
            headers: video.video.headers,
            durationSec: video.durationSec,
            ...(video.video.mirror ? { downloadTimeoutMs: MIRROR_VIDEO_TIMEOUT_MS } : {}),
            ...(mirrorVideoRangeBytes(video.video) !== undefined
              ? { rangeBytes: mirrorVideoRangeBytes(video.video) }
              : {})
          }
        ]
      : []),
    ...photos
  ].slice(0, AUTOFETCH_MAX_FILES)
}

function videoDurationBand(post: SocialPost, items: ReturnType<typeof postMedia>) {
  if (post.videoCount === 0 && !post.video) return undefined
  // A group mode without video still measures the post's own known duration.
  const known = post.durationSec !== null && Number.isFinite(post.durationSec) && post.durationSec > 0
  const durationSec =
    items.find((asset) => asset.kind === 'video')?.durationSec ?? (known ? post.durationSec! : undefined)
  if (durationSec === undefined) return 'unknown'
  if (durationSec <= 60) return 'le_60'
  if (durationSec <= 120) return 'le_120'
  if (durationSec <= 180) return 'le_180'
  return 'gt_180'
}

export function createAutofetch(options: AutofetchOptions): Autofetch {
  const now = options.now ?? (() => new Date())
  options.storage.tx((db) => {
    db.prepare(
      "UPDATE job_run SET outcome = 'interrupted', ended_at = ? WHERE kind = 'autofetch' AND ended_at IS NULL"
    ).run(now().toISOString())
    db.prepare(
      `DELETE FROM autofetch_delivery_key WHERE job_run_id IN (
      SELECT job_run_id FROM autofetch_delivery WHERE claimed_at IS NULL
    )`
    ).run()
  })

  /** True when the chat may get autofetch: an active group with the switch on, not muted. */
  function allowedChat(waId: string): string | undefined {
    const chat = getChatByWaId(options.storage, waId)
    if (chat?.status !== 'active' || chat.type !== 'group') return undefined
    const settings = resolveSettings(options.storage, chat)
    if (settings['features.autofetch']?.value !== true || settings['muted']?.value) return undefined
    return chat.chatId
  }

  type Skip = 'repeat' | 'platform_excluded'

  function reserveRepeat(db: Db, chatId: string, lookupKey: string, at: Date): boolean {
    const digest = createHmac('sha256', chatId).update(lookupKey).digest('hex')
    const expiry = new Date(at.getTime() + AUTOFETCH_REPEAT_MS).toISOString()
    return (
      db
        .prepare(
          `INSERT INTO autofetch_repeat (digest, expires_at) VALUES (?, ?)
      ON CONFLICT(digest) DO UPDATE SET expires_at = excluded.expires_at WHERE expires_at <= ?`
        )
        .run(digest, expiry, at.toISOString()).changes === 1
    )
  }

  function freshTargets(chatId: string, text: string) {
    const targets = findSocialPostTargets(text, (entry) => options.logger?.info('social.unknown_host', entry))
    if (targets.length === 0) return { picked: [], selected: 0 }
    return options.storage.tx((db) => {
      const at = now()
      db.prepare('DELETE FROM autofetch_repeat WHERE expires_at <= ?').run(at.toISOString())
      const picked: { target: SocialPostTarget; skip?: Skip }[] = []
      let selected = 0
      let skips = 0
      for (const target of targets) {
        let skip: Skip | undefined
        if (groupOperations(target.platform, options.mirrors, chatId).length === 0) skip = 'platform_excluded'
        else if (selected >= AUTOFETCH_MAX_LINKS) continue
        else if (!reserveRepeat(db, chatId, target.lookupKey, at)) skip = 'repeat'
        if (skip) {
          if (skips++ < 8) picked.push({ target, skip })
        } else {
          picked.push({ target })
          selected++
        }
      }
      return { picked, selected }
    })
  }

  async function save(
    item: ReturnType<typeof postMedia>[number],
    signal: AbortSignal
  ): Promise<{ downloaded: boolean; media?: AutofetchMedia }> {
    let downloaded = false
    const maxBytes = item.kind === 'video' ? AUTOFETCH_MAX_VIDEO_BYTES : AUTOFETCH_MAX_IMAGE_BYTES
    try {
      const budget = AbortSignal.any([
        signal,
        AbortSignal.timeout(item.downloadTimeoutMs ?? AUTOFETCH_ASSET_TIMEOUT_MS)
      ])
      const compressor =
        item.kind === 'video' && (item.durationSec ?? Infinity) <= COMPRESSION_MAX_SECONDS
          ? options.compressVideo
          : undefined
      const cap = compressor ? COMPRESSION_MAX_INPUT_BYTES : maxBytes
      const file =
        item.rangeBytes !== undefined && item.rangeBytes <= cap
          ? await options.download(item.url, budget, cap, item.headers, item.rangeBytes)
          : await options.download(item.url, budget, cap, item.headers)
      if (budget.aborted) return { downloaded }
      const mime = file.contentType.split(';')[0]?.trim().toLowerCase() ?? ''
      const ext = EXTENSIONS[mime]
      const kindMatches = item.kind === 'video' ? mime === 'video/mp4' : mime.startsWith('image/')
      if (
        !ext ||
        !kindMatches ||
        file.data.length > (compressor ? COMPRESSION_MAX_INPUT_BYTES : maxBytes) ||
        !matchesSignature(mime, file.data)
      )
        return { downloaded }
      downloaded = true
      const data =
        file.data.length <= maxBytes
          ? file.data
          : await compressor?.(file.data, maxBytes, COMPRESSION_MAX_SECONDS, signal)
      if (!data || signal.aborted || data.length > maxBytes || !matchesSignature(mime, data)) return { downloaded }
      const name = `${createHash('sha256').update(data).digest('hex')}${ext}`
      writeFileAtomic(join(options.cacheDir, name), data)
      return { downloaded, media: { kind: item.kind, path: join(options.hostCacheDir, name) } }
    } catch {
      return { downloaded }
    }
  }

  return {
    async fetch(input) {
      const chatId = allowedChat(input.chat)
      if (!chatId) return { media: [] }
      const { picked, selected } = freshTargets(chatId, input.text)
      if (picked.length === 0) return { media: [] }

      const runId = options.storage.tx((db) => startJobRun(db, { kind: 'autofetch', chatId }, now))
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), AUTOFETCH_TIMEOUT_MS)
      const media: AutofetchMedia[] = []
      let failed = 0
      let threw = false
      let deliveryKey: string | undefined
      try {
        for (const [ordinal, { target, skip: initialSkip }] of picked.entries()) {
          let skip = initialSkip
          const started = now()
          let trace: SocialLookupTrace | undefined
          const lookup =
            skip || controller.signal.aborted
              ? undefined
              : await options.viewer
                  .lookup(target, controller.signal, (value) => {
                    trace = value
                  })
                  .catch(() => undefined)
          const items =
            lookup?.status === 'found' && !controller.signal.aborted
              ? postMedia(lookup.post, target, chatId, options.mirrors)
              : []
          if (lookup?.status === 'found') {
            // Reserve the canonical post too, so another share link to it is not looked up again, media or not.
            const canonical = parseOfficialSocialPostUrl(lookup.post.canonicalUrl)
            if (
              canonical &&
              canonical.lookupKey !== target.lookupKey &&
              !options.storage.tx((db) => reserveRepeat(db, chatId, canonical.lookupKey, now())) &&
              items.length
            ) {
              skip = 'repeat'
              items.length = 0
            }
          }
          const downloads = await Promise.all(items.map((item) => save(item, controller.signal)))
          const downloaded = downloads.filter((item) => item.downloaded).length
          const saved = downloads.flatMap((item) => (item.media ? [item.media] : []))
          failed += items.length - saved.length
          media.push(...saved)
          try {
            options.storage.tx((db) =>
              recordSocialLookup(
                db,
                { runId },
                {
                  ordinal,
                  target,
                  started,
                  ended: now(),
                  lookup,
                  trace,
                  skip,
                  eligible: items.length,
                  downloaded,
                  videoDurationBand:
                    !skip && lookup?.status === 'found' ? videoDurationBand(lookup.post, items) : undefined
                }
              )
            )
          } catch {
            options.logger?.warn('autofetch.record_failed', { phase: 'lookup' })
          }
        }
        if (media.length) {
          deliveryKey = options.storage.tx((db) =>
            recordAutofetchHandoff(
              db,
              runId,
              media.map((item) => item.kind),
              now()
            )
          )
        }
      } catch (error) {
        threw = true
        throw error
      } finally {
        clearTimeout(timer)
        const counts = {
          links: selected,
          images: media.filter((item) => item.kind === 'image').length,
          videos: media.filter((item) => item.kind === 'video').length,
          failed
        }
        try {
          options.storage.tx((db) =>
            endJobRun(db, runId, { outcome: threw ? 'failed' : media.length > 0 ? 'ready' : 'nothing', counts }, now)
          )
        } catch {
          options.logger?.warn('autofetch.record_failed', { phase: 'job' })
        }
        options.logger?.info('autofetch.done', counts)
      }
      return deliveryKey ? { media, deliveryKey } : { media }
    }
  }
}
