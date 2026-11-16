import type { Attachment } from '../gateway/request.js'
import type { ModelCallRecord } from '../turn/types.js'
import { type GatewayDir, type MediaUnreadable, loadGatewayFile } from './files.js'
import type { MediaReading, MediaWatcher } from './gemini-watcher.js'
import { mediaBlock, readMedia } from './intake.js'
import type { MediaKind, MediaLimits } from './limits.js'

// The media of one turn: which files are read, the reading of each, and the text for prompt block 4
// (docs/trd/models.md#media-watching).

/** The most files read from one message, and from one turn. */
export const MAX_MEDIA_PER_MESSAGE = 3
export const MAX_MEDIA_PER_TURN = 6

/** The size of the media text in block 4, in characters, shared evenly between the files. */
const MEDIA_TEXT_BUDGET = 4500

export interface TurnMediaResult {
  readings: { kind: MediaKind; reading: MediaReading }[]
  unreadable: { kind: string; reason: MediaUnreadable }[]
  /** One row for each request to the media model, for the model_call table. */
  calls: ModelCallRecord[]
}

export interface TurnMedia {
  /** Reads the files of a turn at once, inside the turn deadline. Never throws. */
  read(attachments: Attachment[], deadline: number): Promise<TurnMediaResult>
}

export interface TurnMediaOptions {
  /** Absent: media is off, and every file is unreadable with the reason `off`. */
  watcher?: MediaWatcher
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
    unreadable?: { kind: string; reason: MediaUnreadable }
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
      unreadable: { kind, reason: outcome.reason },
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

  return {
    async read(attachments, deadline) {
      // The main model keeps at least a third of the time that is left.
      const timeoutMs = Math.max(1, Math.min(options.timeoutMs, Math.floor(((deadline - now().getTime()) * 2) / 3)))
      const items = await Promise.all(attachments.map((attachment) => readOne(attachment, timeoutMs)))
      const result: TurnMediaResult = { readings: [], unreadable: [], calls: [] }
      for (const item of items) {
        if (item.reading) result.readings.push(item.reading)
        if (item.unreadable) result.unreadable.push(item.unreadable)
        if (item.call) result.calls.push(item.call)
      }
      return result
    }
  }
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

const REASON_TEXT: Record<MediaUnreadable, string> = {
  off: 'media reading is off',
  refused: 'not available to read',
  missing: 'file not found',
  'unsupported type': 'unsupported type',
  'empty file': 'empty file',
  'too large': 'too large',
  'too long': 'too long',
  unreadable: 'the read failed'
}

/**
 * The media text for prompt block 4: what each readable file shows, in one untrusted block, and a note for each
 * unreadable file that carries the pack's line. Empty when there were no files. The text is clipped so that media
 * cannot push the prompt over its ceiling.
 */
export function mediaPromptText(
  result: Pick<TurnMediaResult, 'readings' | 'unreadable'>,
  unreadableLine: string
): string {
  const parts: string[] = []
  if (result.readings.length > 0) {
    const share = Math.floor(MEDIA_TEXT_BUDGET / result.readings.length)
    const clipped = result.readings.map(({ kind, reading }) => {
      const description = clip(reading.description, reading.transcript ? Math.floor(share * 0.4) : share)
      const transcript = reading.transcript ? clip(reading.transcript, share - description.length) : undefined
      return { kind, reading: { description, ...(transcript ? { transcript } : {}) } }
    })
    parts.push('The sender attached files. You cannot open them. This is what each one shows:', mediaBlock(clipped))
  }
  if (result.unreadable.length > 0) {
    parts.push(
      '<media-unreadable>',
      ...result.unreadable.map((item) => `- ${item.kind}: could not be read (${REASON_TEXT[item.reason]})`),
      `Tell the sender so in your own voice, in the sense of: "${unreadableLine}"`,
      '</media-unreadable>'
    )
  }
  return parts.join('\n')
}
