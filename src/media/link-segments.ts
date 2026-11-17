import type { MediaReading } from './gemini-watcher.js'

export const DEFAULT_LINK_WATCH_MS = 12_000
export const DEFAULT_LINK_SEGMENT_SECONDS = 180
export const DEFAULT_LINK_FIRST_SEGMENT_SECONDS = 60
export const DEFAULT_MAX_LINK_SEGMENTS = 4
export const DEFAULT_LINK_FPS = 0.25
export const MIN_SEGMENT_SECONDS = 30
export const MERGED_DESCRIPTION_CHARS = 1800
export const MERGED_TRANSCRIPT_CHARS = 2400

export interface LinkSegmentPlanInput {
  durationSec: number | null
  startSec: number
  maxLinkVideoSeconds: number
  firstSegmentSeconds: number
  segmentSeconds: number
  maxSegments: number
}

export interface LinkSegment {
  startSec: number
  endSec: number
}

export interface LinkSegmentPlan {
  segments: LinkSegment[]
  clipped: boolean
  unknownLength: boolean
}

/** Formats non-negative whole seconds as `m:ss` or `h:mm:ss`. Pure. */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const hours = Math.floor(s / 3600)
  const minutes = Math.floor((s % 3600) / 60)
  const seconds = s % 60
  const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes)
  const ss = String(seconds).padStart(2, '0')
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`
}

/** Plans parallel watch segments for a YouTube video within the configured cap and segment rules. Pure. */
export function planLinkSegments(input: LinkSegmentPlanInput): LinkSegmentPlan {
  const durationSec =
    input.durationSec !== null && Number.isFinite(input.durationSec) && input.durationSec > 0
      ? Math.floor(input.durationSec)
      : null
  const maxLinkVideoSeconds = Math.max(1, Math.floor(input.maxLinkVideoSeconds))
  const firstSegmentSeconds = Math.max(1, Math.floor(input.firstSegmentSeconds))
  const segmentSeconds = Math.max(1, Math.floor(input.segmentSeconds))
  const maxSegments = Math.max(1, Math.floor(input.maxSegments))

  let startSec = Math.max(0, Math.floor(input.startSec))
  if (durationSec !== null && startSec >= durationSec) startSec = 0

  if (durationSec === null) {
    return {
      segments: [{ startSec, endSec: startSec + segmentSeconds }],
      clipped: false,
      unknownLength: true
    }
  }

  const end = Math.min(durationSec, startSec + maxLinkVideoSeconds)
  let clipped = durationSec > end

  if (end - startSec <= segmentSeconds) {
    return {
      segments: [{ startSec, endSec: end }],
      clipped,
      unknownLength: false
    }
  }

  const firstEnd = Math.min(end, startSec + firstSegmentSeconds)
  const segments: LinkSegment[] = [{ startSec, endSec: firstEnd }]
  let cursor = firstEnd
  while (cursor < end) {
    const nextEnd = Math.min(end, cursor + segmentSeconds)
    segments.push({ startSec: cursor, endSec: nextEnd })
    cursor = nextEnd
  }

  const last = segments[segments.length - 1]
  if (segments.length > 1 && last && last.endSec - last.startSec < MIN_SEGMENT_SECONDS) {
    segments.pop()
    const prev = segments[segments.length - 1]
    if (prev) prev.endSec = last.endSec
  }

  if (segments.length > maxSegments) {
    segments.length = maxSegments
    clipped = true
  }

  return { segments, clipped, unknownLength: false }
}

function cutAtWord(raw: string, maxChars: number): string {
  const text = raw.trim()
  if (maxChars <= 0) return ''
  if (text.length <= maxChars) return text
  if (maxChars === 1) return '…'

  const limit = maxChars - 1
  const slice = text.slice(0, limit)
  if (/\s/.test(text[limit] ?? '')) {
    const candidate = slice.trimEnd()
    if (candidate.length > 0) return `${candidate}…`
  }

  let lastSpace = -1
  for (let i = slice.length - 1; i >= 0; i--) {
    if (/\s/.test(slice[i]!)) {
      lastSpace = i
      break
    }
  }
  if (lastSpace > 0) {
    const candidate = slice.slice(0, lastSpace).trimEnd()
    if (candidate.length > 0) return `${candidate}…`
  }

  return `${slice.trimEnd()}…`
}

function clippedPrefix(startSec: number, endSec: number, durationSec: number): string {
  const span = `${formatClock(startSec)}–${formatClock(endSec)} of ${formatClock(durationSec)}`
  return startSec === 0
    ? `Covers only the first part (${span}):`
    : `Covers only the first part from ${formatClock(startSec)} (${span}):`
}

function buildCoverageLine(plan: LinkSegmentPlan, gaps: readonly LinkSegment[], durationSec: number | null): string {
  const first = plan.segments[0]
  const last = plan.segments[plan.segments.length - 1]
  if (!first || !last) return ''

  let colonText = ''
  if (plan.unknownLength) {
    colonText = `Covers only ${formatClock(first.startSec)}–${formatClock(last.endSec)}; the video's length is unknown:`
  } else if (plan.clipped && durationSec !== null && durationSec > 0) {
    colonText = clippedPrefix(first.startSec, last.endSec, durationSec)
  }

  const gapText =
    gaps.length > 0
      ? `Not watched: ${gaps.map((seg) => `${formatClock(seg.startSec)}–${formatClock(seg.endSec)}`).join(', ')}.`
      : ''

  if (gapText && colonText) return `${gapText} ${colonText}`
  return gapText || colonText
}

/** Merges answered segment readings in order with coverage notes and equal character shares. Pure. */
export function mergeLinkReadings(
  plan: LinkSegmentPlan,
  results: readonly (MediaReading | undefined)[],
  durationSec: number | null
): MediaReading | undefined {
  const answeredItems: { segment: LinkSegment; reading: MediaReading }[] = []
  const gaps: LinkSegment[] = []

  for (let i = 0; i < plan.segments.length; i++) {
    const segment = plan.segments[i]!
    const reading = results[i]
    if (reading) answeredItems.push({ segment, reading })
    else gaps.push(segment)
  }

  if (answeredItems.length === 0) return undefined

  if (plan.segments.length === 1 && !plan.clipped && !plan.unknownLength && gaps.length === 0) {
    const only = answeredItems[0]!.reading
    const transcript = only.transcript?.trim()
    return transcript ? { description: only.description, transcript } : { description: only.description }
  }

  const descShare = Math.floor(MERGED_DESCRIPTION_CHARS / answeredItems.length)
  const coverage = buildCoverageLine(plan, gaps, durationSec)
  const descParts = answeredItems.map(
    ({ segment, reading }) =>
      `[${formatClock(segment.startSec)}–${formatClock(segment.endSec)}] ${cutAtWord(reading.description, descShare)}`
  )
  const description = coverage ? `${coverage} ${descParts.join(' ')}` : descParts.join(' ')

  const transcriptItems = answeredItems.filter(
    (item): item is { segment: LinkSegment; reading: MediaReading & { transcript: string } } =>
      typeof item.reading.transcript === 'string' && item.reading.transcript.trim().length > 0
  )
  if (transcriptItems.length === 0) return { description }

  const transcriptShare = Math.floor(MERGED_TRANSCRIPT_CHARS / transcriptItems.length)
  const transcript = transcriptItems
    .map(
      ({ segment, reading }) => `[${formatClock(segment.startSec)}] ${cutAtWord(reading.transcript, transcriptShare)}`
    )
    .join(' ')

  return { description, transcript }
}
