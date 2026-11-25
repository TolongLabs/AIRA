import { setTimeout as delay } from 'node:timers/promises'
import type { Attachment } from '../gateway/request.js'
import { retryDelayMs } from '../models/retry-delay.js'
import type { SocialLookupObserver, SocialPost } from '../social/types.js'
import { PLATFORM_NAME } from '../social/urls.js'
import type { ModelCallRecord } from '../turn/types.js'
import { type GatewayDir, type LoadedFile, loadGatewayFile, type MediaUnreadable } from './files.js'
import type { MediaReading, MediaWatcher } from './gemini-watcher.js'
import { mediaBlock, readMedia, sanitizeMediaText } from './intake.js'
import type { MediaKind, MediaLimits } from './limits.js'
import { type LinkAllow, type LinkReader, type LinkReading, type LinkTried } from './link-intake.js'
import { clipLinkText, LINK_TRANSCRIPT_PREFIX, linkEvidenceReserve, renderLinkEvidence } from './link-segments.js'

// The media of one turn: which files are read, the reading of each, and the text for prompt block 4
// (docs/trd/models.md#media-watching).

/** The most files read from one message, and from one turn. */
export const MAX_MEDIA_PER_MESSAGE = 3
export const MAX_MEDIA_PER_TURN = 6

/** The size of the media text in block 4, in characters, shared evenly between the files and links. */
const MEDIA_TEXT_BUDGET = 4500

export interface TurnMediaResult {
  readings: { kind: MediaKind; reading: MediaReading }[]
  links?: LinkReading[]
  unreadable: { kind: string; reason: MediaUnreadable; error?: unknown }[]
  partial?: { kind: string; reason: MediaUnreadable }[]
  /** Social addresses intake opened this turn, with whether reading them failed. */
  tried?: LinkTried[]
  /** One row for each request to the media model, for the model_call table. */
  calls: ModelCallRecord[]
  /** The files that are valid pictures, in the order given. Set only when a picture was checked (identify_image). */
  pictures?: Attachment[]
}

export interface TurnMedia {
  /**
   * Reads the files of a turn at once, inside the turn deadline. Never throws. Each file is checked once and the check
   * serves both the watcher and `pictures`. `pictures` also checks the pictures when no watcher reads them.
   */
  read(
    attachments: Attachment[],
    deadline: number,
    options?: { enabled?: boolean; pictures?: boolean }
  ): Promise<TurnMediaResult>
  /** Finds and reads at most one social or YouTube link from candidate texts, inside the turn deadline. Never throws. */
  readLink(
    texts: readonly string[],
    deadline: number,
    allow: LinkAllow,
    onMatch?: () => void,
    observe?: SocialLookupObserver
  ): Promise<TurnMediaResult>
}

export interface TurnMediaOptions {
  /** Absent: media is off, and every file is unreadable with the reason `off`. */
  watcher?: MediaWatcher
  /** Absent: link intake is off. */
  links?: LinkReader
  /** The media model's id, for the records of a call that failed before it answered. */
  model: string
  limits: MediaLimits
  gatewayDirs: readonly GatewayDir[]
  timeoutMs: number
  now?: () => Date
}

/** The attachments a turn reads: the first few of each message, the newest messages first when there are too many. */
export function mediaToRead(perMessage: readonly (readonly Attachment[])[]): Attachment[] {
  const picked = perMessage.map((files) => files.slice(0, MAX_MEDIA_PER_MESSAGE))
  const kept: Attachment[][] = []
  let room = MAX_MEDIA_PER_TURN
  for (let i = picked.length - 1; i >= 0 && room > 0; i--) {
    const files = (picked[i] ?? []).slice(0, room)
    room -= files.length
    kept.unshift(files)
  }
  return kept.flat()
}

const KIND_NAME: Record<Attachment['kind'], string> = {
  image: 'image',
  voice: 'voice note',
  audio: 'audio file',
  video: 'video',
  document: 'document',
  file: 'file'
}
const ATTACHMENT_KIND_NAMES = new Set(Object.values(KIND_NAME))

interface OneRead {
  reading?: { kind: MediaKind; reading: MediaReading }
  unreadable?: { kind: string; reason: MediaUnreadable; error?: unknown }
  calls?: ModelCallRecord[]
  /** The file, when it is an image attachment whose content is a picture. Set whether or not a watcher read it. */
  picture?: Attachment
}

export function createTurnMedia(options: TurnMediaOptions): TurnMedia {
  const now = options.now ?? (() => new Date())

  async function readOne(attachment: Attachment, deadline: number, pictures: boolean): Promise<OneRead> {
    const kind = KIND_NAME[attachment.kind]
    // Without a watcher, only a picture that identify_image may index is checked, and nothing else is read.
    if (!options.watcher && !(pictures && attachment.kind === 'image')) return { unreadable: { kind, reason: 'off' } }

    // Measure elapsed time independently of the turn's injected wall clock.
    const expiresAt = performance.now() + effectiveTimeout(deadline)
    const remainingMs = () => Math.ceil(expiresAt - performance.now())
    const loaded = await loadGatewayFile(attachment, options.gatewayDirs, options.limits.maxBytes, remainingMs())
    const picked = isPicture(attachment, loaded) ? { picture: attachment } : {}
    if (!options.watcher) return { unreadable: { kind, reason: 'off' }, ...picked }
    if (!loaded.ok) return { unreadable: { kind, reason: loaded.reason } }

    const calls: ModelCallRecord[] = []
    let unreadable: NonNullable<OneRead['unreadable']> = { kind, reason: 'unreadable' }
    for (let attempt = 1; ; attempt++) {
      const timeoutMs = remainingMs()
      if (timeoutMs <= 0) break
      const startedAt = now()
      const outcome = await readMedia(loaded.file, { watcher: options.watcher, limits: options.limits, timeoutMs })
      const record = { role: 'media', transport: 'api', attempt, startedAt, durationMs: outcome.durationMs } as const
      if (outcome.ok) {
        calls.push({ ...record, model: outcome.model, usage: outcome.usage, costUsd: 0 })
        return { reading: { kind: outcome.kind, reading: outcome.reading }, calls, ...picked }
      }

      unreadable = { kind, reason: outcome.reason, ...(outcome.error !== undefined ? { error: outcome.error } : {}) }
      if (!outcome.failureKind) break // A local limit refused the file before the watcher was called.
      calls.push({ ...record, model: options.model, failureKind: outcome.failureKind })
      if (outcome.failureKind !== 'transient') break
      const waitMs = retryDelayMs(attempt - 1)
      if (waitMs >= remainingMs()) break
      await delay(waitMs)
    }
    return { unreadable, calls, ...picked }
  }

  function effectiveTimeout(deadline: number): number {
    // The main model keeps at least a third of the time that is left.
    return Math.min(options.timeoutMs, Math.floor(((deadline - now().getTime()) * 2) / 3))
  }

  // A gateway-admitted image whose content is a picture. A watcher failure does not change this.
  const isPicture = (attachment: Attachment, loaded: LoadedFile): boolean =>
    attachment.kind === 'image' && loaded.ok === true && loaded.kind === 'image'

  return {
    async read(attachments, deadline, readOptions) {
      const off = attachments.map((attachment) => ({ kind: KIND_NAME[attachment.kind], reason: 'off' as const }))
      if (readOptions?.enabled === false) return { readings: [], unreadable: off, calls: [] }
      const pictures = readOptions?.pictures === true
      // Without a watcher, a file is checked only to index its picture; nothing is read otherwise.
      if (!options.watcher && !pictures) return { readings: [], unreadable: off, calls: [] }
      const items = await Promise.all(attachments.map((attachment) => readOne(attachment, deadline, pictures)))
      const result: TurnMediaResult = { readings: [], unreadable: [], calls: [] }
      for (const item of items) {
        if (item.reading) result.readings.push(item.reading)
        if (item.unreadable) result.unreadable.push(item.unreadable)
        if (item.calls) result.calls.push(...item.calls)
      }
      const valid = items.flatMap((item) => (item.picture ? [item.picture] : []))
      if (pictures && valid.length > 0) result.pictures = valid
      return result
    },

    async readLink(texts, deadline, allow, onMatch, observe) {
      if (!options.links) return { readings: [], unreadable: [], calls: [] }
      const timeoutMs = effectiveTimeout(deadline)
      if (timeoutMs <= 0) return { readings: [], unreadable: [], calls: [] }
      return options.links.read(texts, timeoutMs, allow, onMatch, observe)
    }
  }
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

function formatAuthor(post: SocialPost): string {
  const handle = post.authorHandle.trim()
  if (handle) {
    const clean = sanitizeMediaText(handle)
    if (clean.startsWith('@') || clean.startsWith('u/') || clean.startsWith('r/')) return clean
    return `@${clean}`
  }
  const name = post.authorName.trim()
  return name ? sanitizeMediaText(name) : ''
}

function formatDate(createdAt: string | null): string {
  if (!createdAt) return ''
  const clean = sanitizeMediaText(createdAt.trim())
  const isoMatch = /^\d{4}-\d{2}-\d{2}/.exec(clean)
  return isoMatch ? isoMatch[0] : clean
}

function formatPostLine(link: LinkReading, budget: number): string {
  const { post } = link
  const platform = PLATFORM_NAME[post.platform]
  const author = formatAuthor(post)
  const date = formatDate(post.createdAt)
  const meta = [author ? `${platform} ${author}` : platform, ...(date ? [date] : [])].join(', ')
  const prefix = `- post (${meta}): `

  const tailParts: string[] = []
  if (post.replyCount !== null) {
    tailParts.push(`${post.replyCount} ${post.replyCount === 1 ? 'reply' : 'replies'}`)
  }
  if (post.canonicalUrl) {
    tailParts.push(`url: ${sanitizeMediaText(post.canonicalUrl)}`)
  }
  const suffix = tailParts.length > 0 ? ` | ${tailParts.join(' | ')}` : ''

  const bodyBudget = Math.max(40, budget - prefix.length - suffix.length)
  const title = sanitizeMediaText(post.externalTitle.trim())
  const text = sanitizeMediaText(post.text.trim())
  const quotedText = sanitizeMediaText(post.quotedText.trim())
  const quotedAuthor = sanitizeMediaText(post.quotedAuthorHandle.trim().replace(/^@+/, ''))

  const bodySegments: string[] = []
  const mainParts: string[] = []
  if (title && !text.startsWith(title)) mainParts.push(title)
  if (text) mainParts.push(text)
  const mainText = mainParts.join(' — ')
  if (mainText) {
    const mainMax = quotedText ? Math.floor(bodyBudget * 0.65) : bodyBudget
    bodySegments.push(`"${clip(mainText, Math.max(10, mainMax - 2))}"`)
  }
  if (quotedText) {
    const quotePrefix = quotedAuthor ? `quoting @${quotedAuthor}: ` : 'quoting: '
    const used = bodySegments.join(' | ').length + (bodySegments.length > 0 ? 3 : 0)
    const quoteMax = Math.max(10, bodyBudget - used - quotePrefix.length - 2)
    bodySegments.push(`${quotePrefix}"${clip(quotedText, quoteMax)}"`)
  }

  const body = bodySegments.join(' | ')
  if (body.length === 0) return `${prefix}${tailParts.join(' | ')}`
  return `${prefix}${body}${suffix}`
}

/** One line per earlier post of the thread, oldest first, each clipped to an even part of `budget`. */
function formatThreadLines(post: SocialPost, budget: number): string[] {
  if (post.thread.length === 0) return []
  const platform = PLATFORM_NAME[post.platform]
  const each = Math.max(60, Math.floor(budget / post.thread.length))
  return post.thread.map((item) => {
    const handle = sanitizeMediaText(item.authorHandle.trim().replace(/^@+/, ''))
    const prefix = `- earlier post (${handle ? `${platform} @${handle}` : platform}): `
    const photos = item.photoUrls.length
    const suffix = photos > 0 ? ` | ${photos} ${photos === 1 ? 'photo' : 'photos'}` : ''
    const text = sanitizeMediaText(item.text.trim())
    return `${prefix}"${clip(text || 'no text', Math.max(10, each - prefix.length - suffix.length - 2))}"${suffix}`
  })
}

/** Structured YouTube evidence owns its final share; metadata never forces a second tail clip. */
function formatYouTubeLines(link: LinkReading, share: number, source: string | undefined): string[] {
  const evidence = link.youtubeEvidence!
  const videoPrefix = '  video: '
  const available = Math.max(0, share - videoPrefix.length)
  const reserve = linkEvidenceReserve(evidence, available)
  const metadataCap = Math.min(450, Math.floor(share * 0.2), available - reserve)
  const lines: string[] = []
  let used = 0

  function metadata(line: string) {
    const remaining = metadataCap - used - 1 // the newline before the next metadata or video line
    if (remaining <= 0) return
    const text = clipLinkText(sanitizeMediaText(line), remaining)
    if (text) {
      lines.push(text)
      used += text.length + 1
    }
  }

  const url = sanitizeMediaText(link.post.canonicalUrl)
  if (source !== undefined) metadata(`- [${source}] ${url}`)
  const postLine = formatPostLine(link, metadataCap - used - 1)
  // The canonical address and source label outrank a long title or author. Avoid charging the URL twice.
  if (source === undefined && postLine.length > metadataCap - used - 1) metadata(`- post (YouTube): url: ${url}`)
  const postMetadata =
    lines.length > 0
      ? formatPostLine({ ...link, post: { ...link.post, canonicalUrl: '' } }, metadataCap - used - 1)
      : postLine
  metadata(postMetadata)
  const note = link.note ?? link.result?.note
  if (note) metadata(`(${note})`)

  const reading = renderLinkEvidence(evidence, available - used)
  if (reading) {
    lines.push(videoPrefix + reading.description)
    if (reading.transcript) lines.push(LINK_TRANSCRIPT_PREFIX + reading.transcript)
  }
  return lines
}

function formatLinkLines(link: LinkReading, share: number): string[] {
  // The earlier posts of a thread hold the content a reply builds on, so they take up to half the post's share.
  const threadBudget = link.post.thread.length > 0 ? Math.floor(share * (link.reading ? 0.2 : 0.5)) : 0
  const threadLines = formatThreadLines(link.post, threadBudget)
  const rest = share - threadLines.join('\n').length
  const noteText = link.note ?? link.result?.note
  const note = noteText ? [`  (${noteText})`] : []
  const readKind = link.reading ? (link.mediaKind ?? 'video') : undefined
  if (readKind !== 'video' && (link.post.videoCount > 0 || link.post.video)) {
    note.push(
      '  Only describe the post text and any images actually seen. No video or audio was observed. Do not infer a playback problem.'
    )
  }
  if (!link.reading) return [...threadLines, formatPostLine(link, rest), ...note]
  const postBudget = Math.max(120, Math.floor(rest * 0.4))
  const postLine = formatPostLine(link, postBudget)
  const readingBudget = Math.max(80, rest - postLine.length)
  const safeDesc = sanitizeMediaText(link.reading.description)
  const safeTranscript =
    readKind === 'video' && link.reading.transcript ? sanitizeMediaText(link.reading.transcript) : undefined
  const description = clip(safeDesc, safeTranscript ? Math.floor(readingBudget * 0.4) : readingBudget)
  const transcript = safeTranscript ? clip(safeTranscript, Math.max(0, readingBudget - description.length)) : undefined
  const label = link.preview ? 'preview image' : readKind
  const lines = [...threadLines, postLine, ...note, `  ${label}: ${description}`]
  if (transcript && transcript.length > 0) lines.push(`  transcript: ${transcript}`)
  return lines
}

// The model speaks of media as seen, in character: "I only have a description" breaks the role (owner, 19 Nov).
const AS_SEEN = 'Speak of them as things you saw or heard yourself, and do not mention this description:'

function mediaIntro(hasFiles: boolean, hasLinks: boolean): string {
  if (hasFiles && hasLinks) {
    return `The sender attached files and shared a link. The link is already open; do not open it again. This is what each one shows. ${AS_SEEN}`
  }
  if (hasLinks) {
    return 'The sender shared a link. It is already open; do not open it again. This is what it shows. Speak of it as something you saw yourself, and do not mention this description:'
  }
  return `The sender attached files. This is what each one shows. ${AS_SEEN}`
}

/**
 * The media text for prompt block 4: what each readable file or link shows, in one untrusted block, and a note for
 * each unreadable file or link that carries the pack's line. Empty when there were none. The text is clipped so that
 * media cannot push the prompt over its ceiling.
 */
export function mediaPromptText(
  result: Pick<TurnMediaResult, 'readings' | 'links' | 'unreadable'>,
  unreadableLine: string,
  sourceForUrl?: (url: string) => string | undefined
): string {
  const parts: string[] = []
  const links = result.links ?? []
  const totalItems = result.readings.length + links.length
  if (totalItems > 0) {
    const share = Math.floor(MEDIA_TEXT_BUDGET / totalItems)
    const clipped = result.readings.map(({ kind, reading }) => {
      const description = clip(reading.description, reading.transcript ? Math.floor(share * 0.4) : share)
      const transcript = reading.transcript ? clip(reading.transcript, share - description.length) : undefined
      return { kind, reading: { description, ...(transcript ? { transcript } : {}) } }
    })
    const linkLines = links.flatMap((link) => {
      const url = link.post.canonicalUrl
      const source = sourceForUrl?.(url)
      if (link.youtubeEvidence) return formatYouTubeLines(link, share, source)
      const header = source === undefined ? [] : [`- [${source}] ${url}`]
      return [...header, ...formatLinkLines(link, share - (header[0]?.length ?? 0))]
    })
    parts.push(mediaIntro(result.readings.length > 0, links.length > 0), mediaBlock(clipped, linkLines))
  }
  if (result.unreadable.length > 0) {
    parts.push(
      '<media-unreadable>',
      ...result.unreadable.map((item) => {
        const displayKind = item.kind.endsWith(' link') ? `${item.kind.slice(0, -5)} post` : item.kind
        return `(The ${displayKind} could not be opened.)`
      }),
      result.unreadable.some((item) => ATTACHMENT_KIND_NAMES.has(item.kind))
        ? 'Briefly acknowledge what you could not read in your own voice. Do not ask the sender to resend attached files.'
        : `Tell the sender so in your own voice, in the sense of: "${unreadableLine}"`,
      '</media-unreadable>'
    )
  }
  return parts.join('\n')
}
