import type { Attachment } from '../gateway/request.js'
import type { SocialPost } from '../social/types.js'
import type { ModelCallRecord } from '../turn/types.js'
import { type GatewayDir, loadGatewayFile, type MediaUnreadable } from './files.js'
import type { MediaReading, MediaWatcher } from './gemini-watcher.js'
import { mediaBlock, readMedia, sanitizeMediaText } from './intake.js'
import type { MediaKind, MediaLimits } from './limits.js'
import { type LinkAllow, type LinkReader, type LinkReading, PLATFORM_NAME } from './link-intake.js'

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
  /** One row for each request to the media model, for the model_call table. */
  calls: ModelCallRecord[]
}

export interface TurnMedia {
  /** Reads the files of a turn at once, inside the turn deadline. Never throws. */
  read(attachments: Attachment[], deadline: number, options?: { enabled?: boolean }): Promise<TurnMediaResult>
  /** Finds and reads at most one social or YouTube link from candidate texts, inside the turn deadline. Never throws. */
  readLink(texts: readonly string[], deadline: number, allow: LinkAllow, onMatch?: () => void): Promise<TurnMediaResult>
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

export function createTurnMedia(options: TurnMediaOptions): TurnMedia {
  const now = options.now ?? (() => new Date())

  async function readOne(
    attachment: Attachment,
    timeoutMs: number
  ): Promise<{
    reading?: { kind: MediaKind; reading: MediaReading }
    unreadable?: { kind: string; reason: MediaUnreadable; error?: unknown }
    call?: ModelCallRecord
  }> {
    const kind = KIND_NAME[attachment.kind]
    if (!options.watcher) return { unreadable: { kind, reason: 'off' } }

    const loaded = await loadGatewayFile(attachment, options.gatewayDirs, options.limits.maxBytes)
    if (!loaded.ok) return { unreadable: { kind, reason: loaded.reason } }

    const startedAt = now()
    const outcome = await readMedia(loaded.file, {
      watcher: options.watcher,
      limits: options.limits,
      timeoutMs
    })
    if (outcome.ok) {
      return {
        reading: { kind: outcome.kind, reading: outcome.reading },
        call: {
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
    }
    // A failure kind means the watcher was called and failed. Any other refusal came from a limit, before a call.
    return {
      unreadable: { kind, reason: outcome.reason, ...(outcome.error !== undefined ? { error: outcome.error } : {}) },
      ...(outcome.failureKind
        ? {
            call: {
              role: 'media',
              model: options.model,
              transport: 'api',
              attempt: 1,
              startedAt,
              durationMs: outcome.durationMs,
              failureKind: outcome.failureKind
            }
          }
        : {})
    }
  }

  function effectiveTimeout(deadline: number): number {
    // The main model keeps at least a third of the time that is left.
    return Math.max(1, Math.min(options.timeoutMs, Math.floor(((deadline - now().getTime()) * 2) / 3)))
  }

  return {
    async read(attachments, deadline, readOptions) {
      if (readOptions?.enabled === false || !options.watcher) {
        return {
          readings: [],
          unreadable: attachments.map((attachment) => ({ kind: KIND_NAME[attachment.kind], reason: 'off' as const })),
          calls: []
        }
      }
      const timeoutMs = effectiveTimeout(deadline)
      const items = await Promise.all(attachments.map((attachment) => readOne(attachment, timeoutMs)))
      const result: TurnMediaResult = { readings: [], unreadable: [], calls: [] }
      for (const item of items) {
        if (item.reading) result.readings.push(item.reading)
        if (item.unreadable) result.unreadable.push(item.unreadable)
        if (item.call) result.calls.push(item.call)
      }
      return result
    },

    async readLink(texts, deadline, allow, onMatch) {
      if (!options.links) return { readings: [], unreadable: [], calls: [] }
      const timeoutMs = effectiveTimeout(deadline)
      return options.links.read(texts, timeoutMs, allow, onMatch)
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

function formatLinkLines(link: LinkReading, share: number): string[] {
  // The earlier posts of a thread hold the content a reply builds on, so they take up to half the post's share.
  const threadBudget = link.post.thread.length > 0 ? Math.floor(share * (link.reading ? 0.2 : 0.5)) : 0
  const threadLines = formatThreadLines(link.post, threadBudget)
  const rest = share - threadLines.join('\n').length
  if (!link.reading) return [...threadLines, formatPostLine(link, rest)]
  const postBudget = Math.max(120, Math.floor(rest * 0.4))
  const postLine = formatPostLine(link, postBudget)
  const readingBudget = Math.max(80, rest - postLine.length)
  const safeDesc = sanitizeMediaText(link.reading.description)
  const safeTranscript = link.reading.transcript ? sanitizeMediaText(link.reading.transcript) : undefined
  const description = clip(safeDesc, safeTranscript ? Math.floor(readingBudget * 0.4) : readingBudget)
  const transcript = safeTranscript ? clip(safeTranscript, Math.max(0, readingBudget - description.length)) : undefined
  const lines = [...threadLines, postLine, `  ${link.mediaKind ?? 'video'}: ${description}`]
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
  unreadableLine: string
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
    const linkLines = links.flatMap((link) => formatLinkLines(link, share))
    parts.push(mediaIntro(result.readings.length > 0, links.length > 0), mediaBlock(clipped, linkLines))
  }
  if (result.unreadable.length > 0) {
    parts.push(
      '<media-unreadable>',
      ...result.unreadable.map((item) => {
        const displayKind = item.kind.endsWith(' link') ? `${item.kind.slice(0, -5)} post` : item.kind
        return `(The ${displayKind} could not be opened.)`
      }),
      `Tell the sender so in your own voice, in the sense of: "${unreadableLine}"`,
      '</media-unreadable>'
    )
  }
  return parts.join('\n')
}
