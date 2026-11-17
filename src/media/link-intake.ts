import type { ModelFailureKind } from '../models/types.js'
import type { Logger } from '../records/logger.js'
import type { SocialPost, SocialPostLookup } from '../social/types.js'
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

export type LinkPlatform = SocialPost['platform']
export type LinkTarget = SocialPost['target']

export const PLATFORM_NAME: Record<LinkPlatform, string> = {
  x: 'X',
  bluesky: 'Bluesky',
  threads: 'Threads',
  youtube: 'YouTube',
  tiktok: 'TikTok',
  reddit: 'Reddit',
  instagram: 'Instagram',
  bilibili: 'Bilibili'
}

export interface LinkAllow {
  media: boolean
  social: boolean
}

export interface LinkPostViewer {
  lookup(target: LinkTarget, signal?: AbortSignal): Promise<SocialPostLookup>
}

export interface LinkReading {
  post: SocialPost
  mediaKind?: Extract<MediaKind, 'image' | 'video'>
  reading?: MediaReading
}

export interface LinkReadResult {
  readings: { kind: MediaKind; reading: MediaReading }[]
  links?: LinkReading[]
  unreadable: { kind: string; reason: MediaUnreadable }[]
  partial?: { kind: string; reason: MediaUnreadable }[]
  calls: ModelCallRecord[]
}

export interface LinkReader {
  /** Finds and reads at most one allowed link from candidate texts within `timeoutMs`. Never throws. */
  read(texts: readonly string[], timeoutMs: number, allow: LinkAllow, onMatch?: () => void): Promise<LinkReadResult>
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
  signal: AbortSignal
): Promise<SocialPostLookup> {
  if (signal.aborted) return { status: 'failed', platform: target.platform, reason: 'timeout' }
  try {
    return await Promise.race([
      viewer.lookup(target, signal),
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

function hasPostMetadata(post: SocialPost): boolean {
  return (
    post.text.trim().length > 0 ||
    post.externalTitle.trim().length > 0 ||
    post.authorHandle.trim().length > 0 ||
    post.authorName.trim().length > 0 ||
    post.quotedText.trim().length > 0
  )
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
    async read(texts, timeoutMs, allow, onMatch) {
      const target = pickTarget(texts, options.findTarget, allow)
      if (!target) return { readings: [], unreadable: [], calls: [] }

      onMatch?.()

      const controller = new AbortController()
      const endAt = now().getTime() + Math.max(1, timeoutMs)
      const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs))
      const remainingMs = () => Math.max(1, endAt - now().getTime())

      try {
        const lookup = await lookupWithTimeout(options.viewer, target, controller.signal)
        if (lookup.status === 'none') return { readings: [], unreadable: [], calls: [] }
        if (lookup.status === 'failed') {
          options.logger?.warn('media.link_failed', { platform: lookup.platform, reason: lookup.reason })
          return {
            readings: [],
            unreadable: [{ kind: `${PLATFORM_NAME[lookup.platform]} link`, reason: 'link' }],
            calls: []
          }
        }

        const { post } = lookup
        if (post.platform === 'youtube') {
          if (!options.watcher?.watchUrl) {
            return {
              readings: [],
              ...(hasPostMetadata(post) ? { links: [{ post }] } : {}),
              unreadable: [{ kind: 'YouTube video', reason: 'off' }],
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
              links: [{ post, mediaKind: 'video', reading: merged }],
              unreadable: [],
              ...(partial.length > 0 ? { partial } : {}),
              calls
            }
          }

          const wholeReason: MediaUnreadable = hasUnavailable ? 'unavailable' : 'unreadable'
          options.logger?.warn('media.link_watch_failed', { platform: post.platform, reason: wholeReason })
          return {
            readings: [],
            ...(hasPostMetadata(post) ? { links: [{ post }] } : {}),
            unreadable: [{ kind: 'YouTube video', reason: wholeReason }],
            calls
          }
        }

        const calls: ModelCallRecord[] = []
        const canWatch = Boolean(options.watcher) && allow.media && Boolean(options.download)

        async function watchRemoteMedia(
          url: string,
          expectedKind: 'video' | 'image',
          durationSeconds?: number
        ): Promise<{ kind: 'video' | 'image'; reading: MediaReading } | undefined> {
          if (!options.download || !options.watcher) return undefined
          let downloaded: { data: Buffer; contentType: string }
          try {
            downloaded = await options.download(url, controller.signal, options.limits.maxBytes)
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

        let watched: { kind: 'video' | 'image'; reading: MediaReading } | undefined
        if (canWatch && post.video) {
          const withinBytes = post.video.bytes === null || post.video.bytes <= options.limits.maxBytes
          const withinDuration = post.durationSec === null || post.durationSec <= options.limits.maxVideoSeconds
          if (withinBytes && withinDuration) {
            watched = await watchRemoteMedia(post.video.url, 'video', post.durationSec ?? undefined)
          }
        }
        if (!watched && canWatch && post.imageUrl) {
          watched = await watchRemoteMedia(post.imageUrl, 'image')
        }

        return {
          readings: [],
          links: [{ post, ...(watched ? { mediaKind: watched.kind, reading: watched.reading } : {}) }],
          unreadable: [],
          calls
        }
      } finally {
        clearTimeout(timer)
      }
    }
  }
}
