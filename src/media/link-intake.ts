import type { ModelFailureKind } from '../models/types.js'
import type { Logger } from '../records/logger.js'
import { type ModelPostResult, modelPostResult, toPostPortResult } from '../social/result.js'
import type { SocialLookupObserver, SocialLookupTrace, SocialPost, SocialPostLookup } from '../social/types.js'
import { PLATFORM_NAME } from '../social/urls.js'
import type { PagePort } from '../tools/ports.js'
import type { ModelCallRecord } from '../turn/types.js'
import type { MediaUnreadable } from './files.js'
import type { MediaReading, MediaWatcher, WatchUrlSource } from './gemini-watcher.js'
import { type MediaOutcome, readMedia, readMediaUrl } from './intake.js'
import { type MediaKind, type MediaLimits, mediaKindOf } from './limits.js'
import {
  DEFAULT_LINK_FIRST_SEGMENT_SECONDS,
  DEFAULT_LINK_FPS,
  DEFAULT_LINK_SEGMENT_SECONDS,
  DEFAULT_LINK_WATCH_MS,
  DEFAULT_MAX_LINK_SEGMENTS,
  formatClock,
  mergeLinkReadings,
  planLinkSegments
} from './link-segments.js'

export const DEFAULT_MAX_LINK_VIDEO_SECONDS = 600

/** The most photos watched from one link (docs/trd/models.md#post-links). */
export const MAX_LINK_PHOTOS = 4

export type LinkPlatform = SocialPost['platform']
export type LinkTarget = SocialPost['target']

export interface LinkAllow {
  media: boolean
  social: boolean
}

export interface LinkPostViewer {
  lookup(
    target: LinkTarget,
    signal?: AbortSignal,
    trace?: (value: SocialLookupTrace) => void
  ): Promise<SocialPostLookup>
}

export interface LinkReading {
  post: SocialPost
  /** Same model payload as `read_post` for a successful or partial read. */
  result?: ModelPostResult
  mediaKind?: Extract<MediaKind, 'image' | 'video'>
  reading?: MediaReading
  /** Set when the post was only partly read: a fixed sentence saying what was visible. */
  note?: string
}

/** A social address intake opened. `failed` closes it to read_post and read_page for the rest of the turn. */
export interface LinkTried {
  url: string
  failed: boolean
}

export interface LinkReadResult {
  readings: { kind: MediaKind; reading: MediaReading }[]
  links?: LinkReading[]
  unreadable: { kind: string; reason: MediaUnreadable }[]
  partial?: { kind: string; reason: MediaUnreadable }[]
  tried?: LinkTried[]
  calls: ModelCallRecord[]
}

export interface LinkReader {
  /** Finds and reads at most one allowed link from candidate texts within `timeoutMs`. Never throws. */
  read(
    texts: readonly string[],
    timeoutMs: number,
    allow: LinkAllow,
    onMatch?: () => void,
    observe?: SocialLookupObserver
  ): Promise<LinkReadResult>
}

export interface LinkReaderOptions {
  viewer: LinkPostViewer
  /** Extracts the first supported post or YouTube target from a text string. */
  findTarget: (text: string) => LinkTarget | null | undefined
  watcher?: MediaWatcher
  download?: PagePort['download']
  model: string
  limits: MediaLimits & {
    maxLinkVideoSeconds?: number
    linkWatchMs?: number
    linkSegmentSeconds?: number
    linkFirstSegmentSeconds?: number
    maxLinkSegments?: number
    linkFps?: number
  }
  logger?: Logger
  now?: () => Date
}

function isPlatformAllowed(platform: LinkPlatform, allow: LinkAllow): boolean {
  return platform === 'youtube' ? allow.media : allow.social
}

function pickTarget(
  texts: readonly string[],
  findTarget: (text: string) => LinkTarget | null | undefined,
  allow: LinkAllow
): LinkTarget | undefined {
  for (const text of texts) {
    let cursor = 0
    while (cursor < text.length) {
      const candidate = cursor === 0 ? text : text.slice(cursor)
      const target = findTarget(candidate)
      if (!target) break
      if (isPlatformAllowed(target.platform, allow)) return target
      // A disabled-platform URL (e.g. YouTube when features.media is off) must not shadow a later allowed URL.
      const urlMatch = /https?:\/\/\S+/i.exec(candidate)
      if (!urlMatch) break
      cursor += urlMatch.index + urlMatch[0].length
    }
  }
  return undefined
}

function normalizeImageMime(contentType: string): string {
  const [rawMime, ...rest] = contentType.split(';')
  const mime = (rawMime ?? '').trim().toLowerCase()
  if (mime === 'image/jpg') return ['image/jpeg', ...rest].join(';')
  return contentType
}

function okCall(outcome: Extract<MediaOutcome, { ok: true }>, startedAt: Date): ModelCallRecord {
  return {
    role: 'media',
    model: outcome.model,
    transport: 'api',
    attempt: 1,
    startedAt,
    durationMs: outcome.durationMs,
    usage: outcome.usage,
    costUsd: 0
  }
}

function failCall(model: string, failureKind: ModelFailureKind, durationMs: number, startedAt: Date): ModelCallRecord {
  return {
    role: 'media',
    model,
    transport: 'api',
    attempt: 1,
    startedAt,
    durationMs,
    failureKind
  }
}

async function lookupWithTimeout(
  viewer: LinkPostViewer,
  target: LinkTarget,
  signal: AbortSignal,
  onTrace?: (trace: SocialLookupTrace) => void
): Promise<SocialPostLookup> {
  if (signal.aborted) return { status: 'failed', platform: target.platform, reason: 'timeout' }
  try {
    return await Promise.race([
      viewer.lookup(target, signal, onTrace),
      new Promise<SocialPostLookup>((resolve) => {
        signal.addEventListener(
          'abort',
          () => resolve({ status: 'failed', platform: target.platform, reason: 'timeout' }),
          { once: true }
        )
      })
    ])
  } catch {
    return { status: 'failed', platform: target.platform, reason: signal.aborted ? 'timeout' : 'error' }
  }
}

/** The post's photos in watch order: its own, then those of the earlier posts of its thread, oldest first. */
export function linkPhotos(post: SocialPost): { url: string; label: string }[] {
  const own = post.photoUrls.map((url, index) => ({ url, label: `photo ${index + 1}` }))
  const earlier = post.thread.flatMap((item, postIndex) =>
    item.photoUrls.map((url, index) => ({
      url,
      label: `earlier post${post.thread.length > 1 ? ` ${postIndex + 1}` : ''}, photo ${index + 1}`
    }))
  )
  return [...own, ...earlier]
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

/** One answer as it is; several in order, each labelled, with what was not read named at the end. */
function mergePostReadings(
  parts: { label: string; reading: MediaReading }[],
  failedPhotos: number,
  unwatchedPhotos: number
): MediaReading {
  const transcript = parts.find((part) => part.label === 'video')?.reading.transcript
  if (parts.length === 1 && failedPhotos === 0 && unwatchedPhotos === 0) return parts[0]!.reading
  const missing = [
    ...(failedPhotos > 0 ? [`${plural(failedPhotos, 'photo')} could not be read`] : []),
    ...(unwatchedPhotos > 0 ? [`${unwatchedPhotos} more not watched`] : [])
  ]
  // Block 4 folds a reading onto one line, so the parts are kept apart the way the post line keeps its fields.
  const lines = parts.map((part) => `${part.label}: ${part.reading.description}`)
  if (missing.length > 0) lines.push(`(${missing.join('; ')})`)
  return { description: lines.join(' | '), ...(transcript ? { transcript } : {}) }
}

function hasPostMetadata(post: SocialPost): boolean {
  return (
    post.text.trim().length > 0 ||
    post.externalTitle.trim().length > 0 ||
    post.authorHandle.trim().length > 0 ||
    post.authorName.trim().length > 0 ||
    post.quotedText.trim().length > 0
  )
}

function triedUrls(urls: readonly (string | undefined)[], failed: boolean): LinkTried[] {
  const unique = [...new Set(urls.filter((url): url is string => typeof url === 'string' && url.length > 0))]
  return unique.map((url) => ({ url, failed }))
}

/** The addresses a read post answers to: the original, target canonical and post canonical, each once. */
function triedOf(target: LinkTarget, post: SocialPost): LinkTried[] {
  return triedUrls([target.originalUrl, target.canonicalUrl, post.canonicalUrl], false)
}

/** The addresses a failed read tried, including any original spelling and resolved share canonical URL. */
function triedFailed(target: LinkTarget, resolvedCanonicalUrl?: string): LinkTried[] {
  return triedUrls([target.originalUrl, target.canonicalUrl, resolvedCanonicalUrl], true)
}

/** Creates a LinkReader that opens at most one social post or YouTube link per turn. Never throws. */
export function createLinkReader(options: LinkReaderOptions): LinkReader {
  const now = options.now ?? (() => new Date())
  const maxLinkVideoSeconds = options.limits.maxLinkVideoSeconds ?? DEFAULT_MAX_LINK_VIDEO_SECONDS
  const linkWatchMs = options.limits.linkWatchMs ?? DEFAULT_LINK_WATCH_MS
  const linkSegmentSeconds = options.limits.linkSegmentSeconds ?? DEFAULT_LINK_SEGMENT_SECONDS
  const linkFirstSegmentSeconds = options.limits.linkFirstSegmentSeconds ?? DEFAULT_LINK_FIRST_SEGMENT_SECONDS
  const maxLinkSegments = options.limits.maxLinkSegments ?? DEFAULT_MAX_LINK_SEGMENTS
  const linkFps = options.limits.linkFps ?? DEFAULT_LINK_FPS

  return {
    async read(texts, timeoutMs, allow, onMatch, observe) {
      const target = pickTarget(texts, options.findTarget, allow)
      if (!target) return { readings: [], unreadable: [], calls: [] }

      onMatch?.()

      const controller = new AbortController()
      const endAt = now().getTime() + Math.max(1, timeoutMs)
      const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs))
      const remainingMs = () => Math.max(1, endAt - now().getTime())

      try {
        const started = now()
        let trace: SocialLookupTrace | undefined
        const lookup = await lookupWithTimeout(options.viewer, target, controller.signal, (value) => {
          trace = value
        })
        observe?.({ target, started, ended: now(), lookup, trace })
        if (lookup.status === 'none') return { readings: [], unreadable: [], calls: [] }
        if (lookup.status === 'failed') {
          options.logger?.warn('media.link_failed', { platform: lookup.platform, reason: lookup.reason })
          const tried = triedFailed(target, lookup.canonicalUrl)
          return {
            readings: [],
            unreadable: [{ kind: `${PLATFORM_NAME[lookup.platform]} link`, reason: 'link' }],
            ...(tried.length > 0 ? { tried } : {}),
            calls: []
          }
        }

        const { post } = lookup
        // Carry the same ModelPostResult on readable and partial reads, keeping the rich post for attachments.
        const modelResult = modelPostResult(toPostPortResult(post, { missing: lookup.missing }))
        const note = modelResult.note ? { note: modelResult.note } : {}
        const tried = triedOf(target, post)
        if (post.platform === 'youtube') {
          if (!options.watcher?.watchUrl) {
            return {
              readings: [],
              ...(hasPostMetadata(post) ? { links: [{ post, result: modelResult, ...note }] } : {}),
              unreadable: [{ kind: 'YouTube video', reason: 'off' }],
              tried,
              calls: []
            }
          }

          const knownDuration =
            post.durationSec !== null && Number.isFinite(post.durationSec) && post.durationSec > 0
              ? Math.floor(post.durationSec)
              : null
          const rawStartSec = Math.max(0, Math.floor(post.target.startSec ?? 0))
          const plan = planLinkSegments({
            durationSec: knownDuration,
            startSec: rawStartSec,
            maxLinkVideoSeconds,
            firstSegmentSeconds: linkFirstSegmentSeconds,
            segmentSeconds: linkSegmentSeconds,
            maxSegments: maxLinkSegments
          })

          const singleWhole =
            plan.segments.length === 1 &&
            !plan.clipped &&
            !plan.unknownLength &&
            (plan.segments[0]?.startSec ?? 0) === 0

          const sources: WatchUrlSource[] = singleWhole
            ? [{ url: post.canonicalUrl, mimeType: 'video/mp4', fps: linkFps }]
            : plan.segments.map((segment) => ({
                url: post.canonicalUrl,
                mimeType: 'video/mp4',
                startSec: segment.startSec,
                endSec: segment.endSec,
                fps: linkFps
              }))

          const watchMs = Math.min(linkWatchMs, remainingMs())
          const watchController = new AbortController()
          const onOuterAbort = () => watchController.abort()
          if (controller.signal.aborted) watchController.abort()
          else controller.signal.addEventListener('abort', onOuterAbort, { once: true })
          const watchTimer = setTimeout(() => watchController.abort(), watchMs)

          const watchStartedAt = now()
          let segmentOutcomes: { startedAt: Date; outcome: MediaOutcome }[]
          try {
            segmentOutcomes = await Promise.all(
              sources.map(async (source) => {
                const startedAt = now()
                const outcome = await readMediaUrl(
                  source,
                  { watcher: options.watcher, timeoutMs: watchMs },
                  watchController.signal
                )
                return { startedAt, outcome }
              })
            )
          } finally {
            clearTimeout(watchTimer)
            controller.signal.removeEventListener('abort', onOuterAbort)
          }

          const elapsedWatchMs = Math.max(0, now().getTime() - watchStartedAt.getTime())
          const calls: ModelCallRecord[] = []
          const segmentReadings: (MediaReading | undefined)[] = []
          const partial: { kind: string; reason: MediaUnreadable }[] = []
          let hasUnavailable = false

          for (let i = 0; i < plan.segments.length; i++) {
            const segment = plan.segments[i]!
            const { startedAt, outcome } = segmentOutcomes[i]!
            if (outcome.ok) {
              calls.push(okCall(outcome, startedAt))
              segmentReadings.push(outcome.reading)
            } else {
              if (outcome.failureKind) {
                calls.push(failCall(options.model, outcome.failureKind, outcome.durationMs, startedAt))
              }
              const reason: MediaUnreadable = outcome.reason === 'unavailable' ? 'unavailable' : 'unreadable'
              if (reason === 'unavailable') hasUnavailable = true
              partial.push({
                kind: `YouTube video part ${i + 1} (${formatClock(segment.startSec)}–${formatClock(segment.endSec)})`,
                reason
              })
              segmentReadings.push(undefined)
            }
          }

          const answered = segmentReadings.filter((reading) => reading !== undefined).length
          const failed = plan.segments.length - answered
          options.logger?.info('media.link_segments', {
            segments: plan.segments.length,
            answered,
            failed,
            watchMs: elapsedWatchMs
          })

          const merged = mergeLinkReadings(plan, segmentReadings, knownDuration)
          if (merged) {
            return {
              readings: [],
              links: [{ post, result: modelResult, mediaKind: 'video', reading: merged, ...note }],
              unreadable: [],
              ...(partial.length > 0 ? { partial } : {}),
              tried,
              calls
            }
          }

          const wholeReason: MediaUnreadable = hasUnavailable ? 'unavailable' : 'unreadable'
          options.logger?.warn('media.link_watch_failed', { platform: post.platform, reason: wholeReason })
          return {
            readings: [],
            ...(hasPostMetadata(post) ? { links: [{ post, result: modelResult, ...note }] } : {}),
            unreadable: [{ kind: 'YouTube video', reason: wholeReason }],
            tried,
            calls
          }
        }

        const calls: ModelCallRecord[] = []
        const canWatch = Boolean(options.watcher) && allow.media && Boolean(options.download)

        async function watchRemoteMedia(
          url: string,
          expectedKind: 'video' | 'image',
          durationSeconds?: number,
          headers?: Record<string, string> | null
        ): Promise<{ kind: 'video' | 'image'; reading: MediaReading } | undefined> {
          if (!options.download || !options.watcher) return undefined
          let downloaded: { data: Buffer; contentType: string }
          try {
            downloaded = await options.download(url, controller.signal, options.limits.maxBytes, headers)
          } catch {
            return undefined
          }
          const contentType =
            expectedKind === 'image' ? normalizeImageMime(downloaded.contentType) : downloaded.contentType
          if (mediaKindOf(contentType) !== expectedKind) return undefined

          const startedAt = now()
          const outcome = await readMedia(
            {
              data: downloaded.data,
              contentType,
              ...(durationSeconds !== undefined ? { durationSeconds } : {})
            },
            { watcher: options.watcher, limits: options.limits, timeoutMs: remainingMs() },
            controller.signal
          )
          if (outcome.ok) {
            calls.push(okCall(outcome, startedAt))
            return { kind: expectedKind, reading: outcome.reading }
          }
          if (outcome.failureKind) {
            calls.push(failCall(options.model, outcome.failureKind, outcome.durationMs, startedAt))
          }
          options.logger?.warn('media.link_watch_failed', { platform: post.platform, reason: outcome.reason })
          return undefined
        }

        // The video and the photos are watched at once, each its own call under the link's time limit.
        const video =
          canWatch &&
          post.video &&
          (post.video.bytes === null || post.video.bytes <= options.limits.maxBytes) &&
          (post.durationSec === null || post.durationSec <= options.limits.maxVideoSeconds)
            ? post.video
            : null
        const photos = canWatch ? linkPhotos(post) : []
        const attempted = photos.slice(0, MAX_LINK_PHOTOS)
        const [videoWatch, ...photoWatches] = await Promise.all([
          video ? watchRemoteMedia(video.url, 'video', post.durationSec ?? undefined, video.headers) : undefined,
          ...attempted.map((photo) => watchRemoteMedia(photo.url, 'image'))
        ])
        const parts = [
          ...(videoWatch ? [{ label: 'video', reading: videoWatch.reading }] : []),
          ...attempted.flatMap((photo, index) => {
            const result = photoWatches[index]
            return result ? [{ label: photo.label, reading: result.reading }] : []
          })
        ]

        let watched: { kind: 'video' | 'image'; reading: MediaReading } | undefined
        if (parts.length > 0) {
          watched = {
            kind: videoWatch ? 'video' : 'image',
            reading: mergePostReadings(
              parts,
              photoWatches.filter((result) => !result).length,
              photos.length - attempted.length
            )
          }
        } else if (canWatch && post.imageUrl && !attempted.some((photo) => photo.url === post.imageUrl)) {
          watched = await watchRemoteMedia(post.imageUrl, 'image')
        }

        return {
          readings: [],
          links: [
            {
              post,
              result: modelResult,
              ...(watched ? { mediaKind: watched.kind, reading: watched.reading } : {}),
              ...note
            }
          ],
          unreadable: [],
          tried,
          calls
        }
      } finally {
        clearTimeout(timer)
      }
    }
  }
}
