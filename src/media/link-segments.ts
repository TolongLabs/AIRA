import type { MediaReading } from './gemini-watcher.js'
import { sanitizeMediaText } from './text.js'

export const DEFAULT_LINK_WATCH_MS = 22_000
export const DEFAULT_LINK_SEGMENT_SECONDS = 180
export const DEFAULT_LINK_FIRST_SEGMENT_SECONDS = 60
export const DEFAULT_MAX_LINK_SEGMENTS = 4
export const DEFAULT_LINK_FPS = 0.25
export const MIN_SEGMENT_SECONDS = 30
export const MERGED_EVIDENCE_CHARS = 4200

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

export interface LinkSegmentEvidence {
  plan: LinkSegmentPlan
  durationSec: number | null
  readings: readonly (MediaReading | undefined)[]
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

/** Clips bounded evidence without splitting a Unicode scalar or a word where possible. */
export function clipLinkText(raw: string, maxChars: number): string {
  const text = raw.trim().toWellFormed()
  maxChars = Math.floor(maxChars)
  if (maxChars <= 0) return ''
  if (text.length <= maxChars) return text
  if (maxChars === 1) return '…'

  const limit = maxChars - 1
  const end = /[\uD800-\uDBFF]/.test(text[limit - 1] ?? '') ? limit - 1 : limit
  const slice = text.slice(0, end)
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
  // Do not discard most of an allocated share for a distant space (e.g. CJK or an unbroken token).
  if (lastSpace > 0 && lastSpace >= end - Math.min(32, Math.floor(end / 4))) {
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

interface EvidencePart {
  label: string
  text: string
  seconds: number
}
interface EvidenceParts {
  coverage: string
  descriptions: EvidencePart[]
  transcripts: EvidencePart[]
  gapCount: number
}

export const LINK_TRANSCRIPT_PREFIX = '  transcript: '
const PROSE_FLOOR = 160

function evidenceParts(evidence: LinkSegmentEvidence): EvidenceParts {
  const { plan, readings, durationSec } = evidence
  const descriptions: EvidencePart[] = []
  const transcripts: EvidencePart[] = []
  const gaps: LinkSegment[] = []
  const whole = plan.segments.length === 1 && !plan.clipped && !plan.unknownLength && plan.segments[0]?.startSec === 0
  for (const [index, segment] of plan.segments.entries()) {
    const reading = readings[index]
    if (!reading) {
      gaps.push(segment)
      continue
    }
    const seconds = Math.max(1, segment.endSec - segment.startSec)
    const start = formatClock(segment.startSec)
    const end = formatClock(segment.endSec)
    descriptions.push({
      label: whole ? '' : `[${start}–${end}] `,
      text: sanitizeMediaText(reading.description).trim().toWellFormed() || '…',
      seconds
    })
    const speech = reading.transcript ? sanitizeMediaText(reading.transcript).trim().toWellFormed() : ''
    if (speech) transcripts.push({ label: whole ? '' : `[${start}] `, text: speech, seconds })
  }
  return { coverage: buildCoverageLine(plan, gaps, durationSec), descriptions, transcripts, gapCount: gaps.length }
}

function labelsSize(parts: readonly EvidencePart[]): number {
  return parts.reduce((sum, part) => sum + part.label.length, Math.max(0, parts.length - 1))
}

function prefixOf(coverage: string): string {
  return coverage ? `${coverage} ` : ''
}

/** Reserve exact coverage, labels and nonempty prose where possible; otherwise the best compact coverage. */
export function linkEvidenceReserve(evidence: LinkSegmentEvidence, budget: number): number {
  const parts = evidenceParts(evidence)
  const minimum = prefixOf(parts.coverage).length + labelsSize(parts.descriptions) + parts.descriptions.length
  if (minimum <= budget) return minimum
  return compactCandidates(evidence, parts).find((text) => text.length <= budget)?.length ?? 0
}

function textSize(parts: readonly EvidencePart[]): number {
  return parts.reduce((sum, part) => sum + part.text.length, 0)
}

function floorSize(parts: readonly EvidencePart[]): number {
  return parts.reduce((sum, part) => sum + Math.min(PROSE_FLOOR, part.text.length), 0)
}

/** Give each range a floor, then distribute spare characters by duration, reclaiming short ranges' excess. */
function renderParts(parts: readonly EvidencePart[], budget: number): string {
  const floor = Math.min(PROSE_FLOOR, Math.floor(budget / parts.length))
  const sizes = parts.map((part) => Math.min(part.text.length, floor))
  let remaining = budget - sizes.reduce((sum, size) => sum + size, 0)
  while (remaining > 0) {
    const active = parts.flatMap((part, i) => (sizes[i]! < part.text.length ? [i] : []))
    if (active.length === 0) break
    const totalSeconds = active.reduce((sum, i) => sum + parts[i]!.seconds, 0)
    const available = remaining
    for (const i of active) {
      const part = parts[i]!
      const add = Math.min(part.text.length - sizes[i]!, Math.floor((available * part.seconds) / totalSeconds))
      sizes[i]! += add
      remaining -= add
    }
    // Integer rounding can leave fewer characters than ranges. Spend them in chronological order.
    if (remaining === available) {
      for (const i of active) {
        if (remaining === 0) break
        sizes[i]!++
        remaining--
      }
    }
  }
  return parts.map((part, i) => part.label + clipLinkText(part.text, sizes[i]!)).join(' ')
}

function compactCandidates(evidence: LinkSegmentEvidence, parts: EvidenceParts): string[] {
  const { plan, durationSec } = evidence
  const first = plan.segments[0]
  const last = plan.segments[plan.segments.length - 1]
  const context =
    buildCoverageLine(plan, [], durationSec).replace(/:$/, '.') ||
    (first && last && first.startSec > 0 ? `Planned ${formatClock(first.startSec)}–${formatClock(last.endSec)}.` : '')
  const readCount = `${parts.descriptions.length}/${plan.segments.length} ranges read`
  const counts = `${readCount}; ${parts.gapCount} not watched`
  const flags = [...(plan.clipped ? ['clipped span'] : []), ...(plan.unknownLength ? ['length unknown'] : [])]
  // Even when successful labels cannot all fit, keep the actual known gaps and clipping context if possible.
  const exact = parts.coverage.replace(/:$/, '.')
  return [
    ...(exact
      ? [`${exact} Evidence compressed: ${readCount}.`, `${exact} Evidence compressed.`, `${exact} Compressed.`, exact]
      : []),
    `Evidence compressed: ${counts}.${context ? ` ${context}` : ''}`,
    `${counts}; ${[...flags, 'compressed'].join('; ')}.`,
    'Coverage limited; evidence compressed.',
    'Coverage limited',
    'Compressed',
    '…'
  ]
}

function compactCoverage(evidence: LinkSegmentEvidence, parts: EvidenceParts, maxChars: number): string {
  return compactCandidates(evidence, parts).find((text) => text.length <= maxChars) ?? ''
}

/**
 * Renders the final URL readings directly within the item's remaining character budget.
 * The budget includes the optional transcript line separator and prefix, but not the video prefix.
 */
export function renderLinkEvidence(evidence: LinkSegmentEvidence, maxChars: number): MediaReading | undefined {
  const parts = evidenceParts(evidence)
  const { descriptions, transcripts, coverage } = parts
  if (descriptions.length === 0 || maxChars <= 0) return undefined
  const budget = Math.floor(maxChars)
  let prefix = prefixOf(coverage)
  const labelChars = labelsSize(descriptions)
  let prose = budget - prefix.length - labelChars
  if (prose < descriptions.length) return { description: compactCoverage(evidence, parts, budget) }
  const descFloor = floorSize(descriptions)
  // Mark severe compression explicitly when the normal floor for successful descriptions cannot fit.
  const compressed = 'Evidence compressed. '
  if (prose < descFloor && prose >= descriptions.length + compressed.length) {
    prefix += compressed
    prose -= compressed.length
  }

  const totalDescription = textSize(descriptions)
  const totalTranscript = textSize(transcripts)
  const speechLabels = 1 + LINK_TRANSCRIPT_PREFIX.length + labelsSize(transcripts)
  let descriptionBudget = Math.min(totalDescription, prose)
  let transcriptBudget = 0
  if (transcripts.length > 0 && prose >= descriptions.length + speechLabels + transcripts.length) {
    const available = prose - speechLabels
    const speechFloor = floorSize(transcripts)
    const targetDescription =
      available >= descFloor + speechFloor
        ? Math.max(descFloor, Math.floor(available * 0.4))
        : Math.floor((available * descFloor) / (descFloor + speechFloor))
    const minimumSpeech = Math.min(totalTranscript, transcripts.length)
    descriptionBudget = Math.min(
      totalDescription,
      Math.max(descriptions.length, Math.min(available - minimumSpeech, targetDescription))
    )
    transcriptBudget = Math.min(totalTranscript, available - descriptionBudget)
    // Short speech or description gives its unused allocation to the other kind of evidence.
    descriptionBudget = Math.min(totalDescription, available - transcriptBudget)
  }
  const description = prefix + renderParts(descriptions, descriptionBudget)
  return transcriptBudget > 0
    ? { description, transcript: renderParts(transcripts, transcriptBudget) }
    : { description }
}

/** Derived reading for legacy consumers; final prompt rendering uses the original structured evidence. */
export function mergeLinkReadings(
  plan: LinkSegmentPlan,
  results: readonly (MediaReading | undefined)[],
  durationSec: number | null
): MediaReading | undefined {
  return renderLinkEvidence({ plan, durationSec, readings: results }, MERGED_EVIDENCE_CHARS)
}
