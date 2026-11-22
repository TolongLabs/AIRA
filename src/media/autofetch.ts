import { createHmac } from 'node:crypto'
import { join } from 'node:path'
import {
  AUTOFETCH_KEY_LIFETIME_MS,
  claimAutofetchDelivery,
  completeAutofetchDelivery,
  invalidateAutofetchDelivery,
  recordAutofetchHandoff,
  recordSocialLookup,
  type VideoSkipReason
} from '../records/autofetch.js'
import type { Logger } from '../records/logger.js'
import { endJobRun, startJobRun } from '../records/turn-record.js'
import { getChatByWaId } from '../settings/chats.js'
import { platformSwitchOn, resolveSettings } from '../settings/settings.js'
import { mirrorVideoRangeBytes } from '../social/mirror-readers.js'
import { groupOperations, type SocialMirrorSettings } from '../social/readers.js'
import type { SocialLookupTrace, SocialPost, SocialPostLookup } from '../social/types.js'
import {
  findSocialPostTargets,
  parseOfficialSocialPostUrl,
  type SocialPlatform,
  type SocialPostTarget
} from '../social/urls.js'
import type { Db, Storage } from '../storage/database.js'
import type { PagePort } from '../tools/ports.js'
import { openDeliveryFiles } from './autofetch-files.js'
import {
  COMPRESSION_MAX_INPUT_BYTES,
  COMPRESSION_MAX_SECONDS,
  type CompressVideo,
  isMp4,
  type ProbeVideoDuration,
  probeVideoDuration
} from './video-compression.js'

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
  /** Accepts the gateway's claim of a batch once. False for an unknown, expired, claimed or completed key. */
  claim(key: string): boolean
  /** Accepts the gateway's outcomes once, one per slot, and removes the batch's files. False when refused. */
  complete(key: string, outcomes: boolean[]): boolean
  /** Ends a batch the gateway never received, and removes its files. */
  abandon(key: string): void
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
  /** Measures a downloaded MP4 whose native duration is unknown. Defaults to ffprobe. */
  probeDuration?: ProbeVideoDuration
  mirrors?: SocialMirrorSettings
  /** `<dataDir>/cache/autofetch`, where the core writes. */
  cacheDir: string
  /** The same folder as the gateway sees it on the host. */
  hostCacheDir: string
  logger?: Logger
  now?: () => Date
}

/**
 * The post's own canonical target, when it is the post the link named: same platform and id, and either the link
 * itself or a share or alias link that resolves to it. Anything else may be another post.
 */
/** A Threads short or share link, which names no post until it redirects. */
function isThreadsAlias(target: SocialPostTarget): boolean {
  return target.platform === 'threads' && /^\/(?:t|share)\//.test(new URL(target.canonicalUrl).pathname)
}

function canonicalTarget(post: SocialPost, target: SocialPostTarget): SocialPostTarget | undefined {
  const resolved = parseOfficialSocialPostUrl(post.canonicalUrl)
  if (
    !resolved ||
    resolved.needsRedirect ||
    isThreadsAlias(resolved) ||
    resolved.platform !== target.platform ||
    post.platform !== target.platform ||
    resolved.id !== post.id
  ) {
    return undefined
  }
  if (resolved.lookupKey !== target.lookupKey && !target.needsRedirect && !isThreadsAlias(target)) return undefined
  return resolved
}

/** A duration in seconds when the source states a positive finite one, else undefined. */
function positiveSeconds(seconds: number | null | undefined): number | undefined {
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? seconds : undefined
}

type PostMediaItem = ReturnType<typeof postMedia>[number]

type DurationBand = 'le_60' | 'le_120' | 'le_180' | 'gt_180' | 'unknown'

/** What one save reports: the file if kept, the video's skip reason, and a duration measured by ffprobe. */
interface SaveOutcome {
  downloaded: boolean
  file?: { name: string; media: AutofetchMedia }
  skip?: VideoSkipReason
  measuredSec?: number
}

function durationBand(seconds: number | null | undefined): DurationBand {
  const sec = positiveSeconds(seconds)
  if (sec === undefined) return 'unknown'
  if (sec <= 60) return 'le_60'
  if (sec <= 120) return 'le_120'
  return sec <= 180 ? 'le_180' : 'gt_180'
}

/**
 * The band of the post's video, from its own native duration or its measurement. Without a video asset, the post's
 * own known duration. A video asset never borrows a duration from elsewhere.
 */
function videoDurationBand(
  post: SocialPost,
  items: readonly PostMediaItem[],
  saved: readonly SaveOutcome[]
): DurationBand | undefined {
  const video = items.findIndex((item) => item.kind === 'video')
  if (video >= 0) return durationBand(items[video]!.durationSec ?? saved[video]?.measuredSec)
  if (post.videoCount === 0 && !post.video) return undefined
  return durationBand(post.durationSec)
}

/** Why the post's video was not kept, when it was skipped for its duration or its compression. */
function videoSkipOf(items: readonly PostMediaItem[], saved: readonly SaveOutcome[]): VideoSkipReason | undefined {
  const video = items.findIndex((item) => item.kind === 'video')
  return saved[video]?.skip
}

function postMedia(
  post: SocialPost,
  target: SocialPostTarget,
  chatId: string,
  inGroup: boolean,
  mirrors?: SocialMirrorSettings
): {
  kind: AutofetchMedia['kind']
  url: string
  headers?: Record<string, string> | null
  durationSec?: number | null
  downloadTimeoutMs?: number
  rangeBytes?: number
}[] {
  const resolved = canonicalTarget(post, target)
  if (!resolved) return []
  const operations = groupOperations(resolved.platform, mirrors, chatId, inGroup)
  const attachments = (post.attachments ?? []).filter(
    (item) => item.owner === resolved.lookupKey && operations.includes(item.kind === 'image' ? 'photos' : 'video')
  )
  const video = attachments.find((item) => item.kind === 'video')
  const photos = attachments.flatMap((item) => (item.kind === 'image' ? [{ kind: item.kind, url: item.url }] : []))
  return [
    ...(video?.kind === 'video'
      ? [
          {
            kind: video.kind,
            url: video.video.url,
            headers: video.video.headers,
            durationSec: positiveSeconds(video.durationSec) ?? null,
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

export function createAutofetch(options: AutofetchOptions): Autofetch {
  const now = options.now ?? (() => new Date())
  const probeDuration = options.probeDuration ?? probeVideoDuration
  // A process starts with no key: every outstanding key is invalidated and every leftover file is removed.
  const files = openDeliveryFiles(options.cacheDir)
  options.storage.tx((db) => {
    db.prepare(
      "UPDATE job_run SET outcome = 'interrupted', ended_at = ? WHERE kind = 'autofetch' AND ended_at IS NULL"
    ).run(now().toISOString())
    db.prepare('DELETE FROM autofetch_delivery_key').run()
  })
  if (files.purged > 0) options.logger?.info('autofetch.purged', { files: files.purged })

  // The files each outstanding key holds, with the timer that ends the key. Held in memory only.
  const held = new Map<string, { names: string[]; timer: ReturnType<typeof setTimeout> }>()

  /** Removes a key's files and stops its timer. Does nothing for a key it does not hold. */
  function release(key: string): void {
    const entry = held.get(key)
    if (!entry) return
    clearTimeout(entry.timer)
    held.delete(key)
    if (files.remove(entry.names) > 0) options.logger?.warn('autofetch.record_failed', { phase: 'remove' })
  }

  /** Ends a key without a receipt: its files go and the key is invalidated. Never throws. */
  function end(key: string): void {
    release(key)
    try {
      invalidateAutofetchDelivery(options.storage, key)
    } catch {
      options.logger?.warn('autofetch.record_failed', { phase: 'invalidate' })
    }
  }

  function hold(key: string, names: string[]): void {
    const timer = setTimeout(() => end(key), AUTOFETCH_KEY_LIFETIME_MS)
    timer.unref()
    held.set(key, { names, timer })
  }

  /** True when an active group or DM has the switch on and is not muted. Also its platform switches. */
  function allowedChat(
    waId: string
  ): { chatId: string; inGroup: boolean; platformOn: (platform: SocialPlatform) => boolean } | undefined {
    const chat = getChatByWaId(options.storage, waId)
    if (chat?.status !== 'active') return undefined
    const settings = resolveSettings(options.storage, chat)
    if (settings['features.autofetch']?.value !== true || settings['muted']?.value) return undefined
    return {
      chatId: chat.chatId,
      inGroup: chat.type === 'group',
      platformOn: (platform) => platformSwitchOn(settings, 'autofetch', platform)
    }
  }

  type Skip = 'repeat' | 'platform_excluded' | 'platform_disabled'

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

  function freshTargets(
    chatId: string,
    inGroup: boolean,
    text: string,
    platformOn: (platform: SocialPlatform) => boolean
  ) {
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
        if (target.invalidPart || groupOperations(target.platform, options.mirrors, chatId, inGroup).length === 0)
          skip = 'platform_excluded'
        else if (!platformOn(target.platform)) skip = 'platform_disabled'
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

  async function save(item: PostMediaItem, signal: AbortSignal): Promise<SaveOutcome> {
    const isVideo = item.kind === 'video'
    const maxBytes = isVideo ? AUTOFETCH_MAX_VIDEO_BYTES : AUTOFETCH_MAX_IMAGE_BYTES
    const nativeSec = positiveSeconds(item.durationSec)
    // A native duration over the limit is refused before any byte is fetched, whatever the file's size.
    if (nativeSec !== undefined && nativeSec > COMPRESSION_MAX_SECONDS) return { downloaded: false, skip: 'too_long' }
    let downloaded = false
    let measuredSec: number | undefined
    try {
      const budget = AbortSignal.any([
        signal,
        AbortSignal.timeout(item.downloadTimeoutMs ?? AUTOFETCH_ASSET_TIMEOUT_MS)
      ])
      // A video may be compressed, so it may download up to the compressor's input cap.
      const cap = isVideo && options.compressVideo ? COMPRESSION_MAX_INPUT_BYTES : maxBytes
      const file =
        item.rangeBytes !== undefined && item.rangeBytes <= cap
          ? await options.download(item.url, budget, cap, item.headers, item.rangeBytes)
          : await options.download(item.url, budget, cap, item.headers)
      if (budget.aborted) return { downloaded }
      const mime = file.contentType.split(';')[0]?.trim().toLowerCase() ?? ''
      const ext = EXTENSIONS[mime]
      const kindMatches = isVideo ? mime === 'video/mp4' : mime.startsWith('image/')
      if (!ext || !kindMatches || file.data.length > cap || !matchesSignature(mime, file.data)) return { downloaded }
      downloaded = true
      if (isVideo && nativeSec === undefined) {
        // No native duration: measure the downloaded MP4 before it is compressed or delivered.
        measuredSec = positiveSeconds(await probeDuration(file.data, signal).catch(() => undefined))
        if (signal.aborted) return { downloaded }
        if (measuredSec === undefined) return { downloaded, skip: 'unknown_duration' }
        if (measuredSec > COMPRESSION_MAX_SECONDS) return { downloaded, measuredSec, skip: 'too_long' }
      }
      let data = file.data
      if (data.length > maxBytes) {
        // One bounded compression attempt. Its output must be a valid MP4 within the delivery limit.
        const compressed = await options
          .compressVideo?.(data, maxBytes, COMPRESSION_MAX_SECONDS, signal)
          .catch(() => undefined)
        if (signal.aborted) return { downloaded, measuredSec }
        if (!compressed || compressed.length > maxBytes || !matchesSignature(mime, compressed)) {
          return { downloaded, measuredSec, skip: 'compression_failed' }
        }
        data = compressed
      }
      const name = files.write(data, ext)
      return {
        downloaded,
        measuredSec,
        file: { name, media: { kind: item.kind, path: join(options.hostCacheDir, name) } }
      }
    } catch {
      return { downloaded }
    }
  }

  return {
    async fetch(input) {
      const allowed = allowedChat(input.chat)
      if (!allowed) return { media: [] }
      const chatId = allowed.chatId
      const { picked, selected } = freshTargets(chatId, allowed.inGroup, input.text, allowed.platformOn)
      if (picked.length === 0) return { media: [] }

      const runId = options.storage.tx((db) => startJobRun(db, { kind: 'autofetch', chatId }, now))
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), AUTOFETCH_TIMEOUT_MS)
      const media: AutofetchMedia[] = []
      const written: string[] = []
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
              ? postMedia(lookup.post, target, chatId, allowed.inGroup, options.mirrors)
              : []
          if (lookup?.status === 'found') {
            // Reserve the canonical post too, so another share link to it is not looked up again, media or not.
            const canonical = canonicalTarget(lookup.post, target)
            if (
              canonical &&
              canonical.lookupKey !== target.lookupKey &&
              !options.storage.tx((db) => reserveRepeat(db, chatId, canonical.lookupKey, now()))
            ) {
              skip = 'repeat'
              items.length = 0
            }
          }
          const downloads = await Promise.all(items.map((item) => save(item, controller.signal)))
          const downloaded = downloads.filter((item) => item.downloaded).length
          const saved = downloads.flatMap((item) => (item.file ? [item.file] : []))
          failed += downloads.filter((result) => !result.file && result.skip !== 'too_long').length
          written.push(...saved.map((file) => file.name))
          media.push(...saved.map((file) => file.media))
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
                    !skip && lookup?.status === 'found' ? videoDurationBand(lookup.post, items, downloads) : undefined,
                  videoSkip: videoSkipOf(items, downloads)
                }
              )
            )
          } catch {
            options.logger?.warn('autofetch.record_failed', { phase: 'lookup' })
          }
        }
        if (media.length) {
          const key = options.storage.tx((db) =>
            recordAutofetchHandoff(
              db,
              runId,
              media.map((item) => item.kind),
              now()
            )
          )
          hold(key, written)
          deliveryKey = key
        }
      } catch (error) {
        threw = true
        throw error
      } finally {
        clearTimeout(timer)
        // A batch that was never handed over leaves no files behind.
        if (!deliveryKey && files.remove(written) > 0) {
          options.logger?.warn('autofetch.record_failed', { phase: 'discard' })
        }
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
    },
    claim(key) {
      return claimAutofetchDelivery(options.storage, key, now())
    },
    complete(key, outcomes) {
      const accepted = completeAutofetchDelivery(options.storage, key, outcomes, now())
      if (accepted) release(key)
      return accepted
    },
    abandon: end
  }
}
