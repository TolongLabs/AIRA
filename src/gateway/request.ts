// Reads a gateway request (docs/trd/system.md#gateway-contract).
// Identity comes only from the scope marker in the newest user content. Nothing here trusts a model.

export interface ScopeMarker {
  platform: string
  kind: 'dm' | 'group'
  /** The chat's WhatsApp id. */
  chat: string
  /** The sender's WhatsApp id. */
  sender: string
  /** The gateway's message id. */
  mid: string
  /** The id of the message this one quotes, when it quotes one. */
  qid?: string
}

/** The message the newest one quotes, from the gateway's reply note. The text is the member's, so untrusted. */
export interface Quote {
  text: string
  /** The quoted message's id, from the marker's `qid`. */
  id?: string
  /** True when the quoted message is one AIRA sent. */
  ofAira: boolean
}

/** A file the gateway saved for the newest message, by its path on the host. Intake reads it. */
export interface Attachment {
  kind: 'image' | 'voice' | 'audio' | 'video' | 'document' | 'file'
  path: string
}

export type GatewayRequest =
  /** A user message for a turn. */
  | {
      type: 'turn'
      marker: ScopeMarker
      /** The newest message text, with gateway notes removed. */
      text: string
      /** Earlier messages from the same sender that got no reply, as the gateway prepended them. */
      earlier: string
      quote?: Quote
      attachments: Attachment[]
      stream: boolean
      includeUsage: boolean
    }
  /** A gateway chore such as a session title: no tools. */
  | { type: 'auxiliary'; stream: boolean; includeUsage: boolean }
  /** Tools but no scope marker: the gateway's own background work, or a scope stamp that is off. */
  | { type: 'unmarked'; stream: boolean; includeUsage: boolean }
  /** A job of the gateway's schedule that the core declared. Only the reminder row says whose it is. */
  | { type: 'scheduled'; kind: 'reminder'; reminderId: string; due: string; stream: boolean; includeUsage: boolean }

/** A request the core cannot accept. It is a deployment fault and the only case that gets an error status. */
export class MalformedRequestError extends Error {
  override name = 'MalformedRequestError'
  readonly kind = 'gateway_malformed'
}

const MARKER = /\[HERMES-SCOPE v1\b([^\]\n]*)\]/g
const SYSTEM_NOTE = /\[System note:[^\]]*\]/g
const FIELD = /^[A-Za-z0-9@._:+-]+$/
/** The core's tag, written by the core into a gateway job (docs/trd/system.md#scheduled-turns). */
const SCHEDULED_TAG = /^\[AIRA-SCHEDULED v1 kind=reminder id=([A-Za-z0-9_-]{1,64}) due=(\d{8}T\d{6}Z)\]$/m
/** The start of a note the gateway writes before a message's marker. */
const NOTE_OPEN =
  /^\[(?:Replying to(?: your previous message)?: "|The user sent |User sent |If you need a closer look, use vision_analyze)/gm

function parseMarker(body: string): ScopeMarker {
  const fields = new Map<string, string>()
  for (const part of body.trim().split(/\s+/)) {
    const at = part.indexOf('=')
    if (at > 0) fields.set(part.slice(0, at), part.slice(at + 1))
  }
  const need = (name: string): string => {
    const value = fields.get(name)
    if (value === undefined || !FIELD.test(value)) {
      throw new MalformedRequestError(`the scope marker has no usable ${name}`)
    }
    return value
  }
  const kind = need('kind')
  if (kind !== 'dm' && kind !== 'group') throw new MalformedRequestError('the scope marker kind is not dm or group')
  const marker: ScopeMarker = {
    platform: need('platform'),
    kind,
    chat: need('chat'),
    sender: need('sender'),
    mid: need('mid')
  }
  const qid = fields.get('qid')
  if (qid !== undefined && FIELD.test(qid)) marker.qid = qid
  return marker
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  // Multi-part content: the text parts in order. Media parts are read at intake, not here.
  return content
    .map((part: unknown) =>
      typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text'
        ? String((part as { text?: unknown }).text ?? '')
        : ''
    )
    .filter((text) => text !== '')
    .join('\n')
}

const clean = (text: string): string =>
  text
    .replace(SYSTEM_NOTE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

interface Notes {
  /** The text before the notes: the end of the previous message. */
  plain: string
  quote?: Omit<Quote, 'id'>
  attachments: Attachment[]
  /** Voice notes the gateway transcribed, each as the gateway quoted it. */
  transcripts: string[]
}

const TRANSCRIPT = /^"([\s\S]*)"$/

function attachmentOf(note: string): Attachment | undefined {
  const path = (pattern: RegExp) => note.match(pattern)?.[1]?.trim()
  // A described picture is two notes: the description, then the path in "If you need a closer look".
  if (/^\[(?:The user sent an image\b|If you need a closer look)/.test(note)) {
    const found = path(/image_url: (.+?)(?: ~)?\]$/)
    return found ? { kind: 'image', path: found } : undefined
  }
  if (/^\[The user sent a voice message: /.test(note)) {
    const found = path(/^\[The user sent a voice message: (.+?)(?: \(duration: [^)]*\))?\]$/)
    return found ? { kind: 'voice', path: found } : undefined
  }
  const saved = path(/ saved at: (.+?)(?:\]$|\. )/)
  if (saved) {
    if (/^\[The user sent an audio file/.test(note)) return { kind: 'audio', path: saved }
    if (/^\[The user sent a video/.test(note)) return { kind: 'video', path: saved }
    if (/^\[The user sent a (?:text )?document/.test(note)) return { kind: 'document', path: saved }
  }
  const placeholder = note.match(/^\[User sent (an image|audio|a video|a file): (.+)\]$/)
  if (placeholder?.[2]) {
    const kinds: Record<string, Attachment['kind']> = {
      'an image': 'image',
      audio: 'audio',
      'a video': 'video',
      'a file': 'file'
    }
    return { kind: kinds[placeholder[1] ?? ''] ?? 'file', path: placeholder[2].trim() }
  }
  return undefined
}

/** Splits the text before a marker into the previous message's text and the notes for the next message. */
function splitNotes(segment: string): Notes {
  const opens = [...segment.matchAll(NOTE_OPEN)].map((match) => match.index ?? 0)
  const notes: Notes = { plain: segment, attachments: [], transcripts: [] }
  if (opens.length === 0) return notes
  notes.plain = segment.slice(0, opens[0])
  for (let i = 0; i < opens.length; i++) {
    let block = segment.slice(opens[i], opens[i + 1] ?? segment.length).trim()
    // A transcribed voice note is a quoted line after the notes, before the marker.
    const tail = block.match(/^([\s\S]*\])\s*\n\n("[\s\S]*")$/)
    if (tail?.[1] && tail[2]) {
      block = tail[1]
      notes.transcripts.push(tail[2])
    }
    const quote = block.match(/^\[Replying to( your previous message)?: "([\s\S]*)"\]$/)
    if (quote) {
      notes.quote = { text: quote[2] ?? '', ofAira: quote[1] !== undefined }
      continue
    }
    const attachment = attachmentOf(block)
    if (attachment) notes.attachments.push(attachment)
  }
  return notes
}

export function parseGatewayRequest(body: unknown): GatewayRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new MalformedRequestError('the request body is not a JSON object')
  }
  const request = body as { messages?: unknown; tools?: unknown; stream?: unknown; stream_options?: unknown }
  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    throw new MalformedRequestError('the request has no messages')
  }
  const stream = request.stream === true
  const includeUsage =
    typeof request.stream_options === 'object' &&
    request.stream_options !== null &&
    (request.stream_options as { include_usage?: unknown }).include_usage === true

  // A chore such as a title or a summary has no tools. Its text can quote the transcript, markers included.
  const hasTools = Array.isArray(request.tools) && request.tools.length > 0
  if (!hasTools) return { type: 'auxiliary', stream, includeUsage }

  const newestUser = request.messages.findLast(
    (message: unknown) =>
      typeof message === 'object' && message !== null && (message as { role?: unknown }).role === 'user'
  ) as { content?: unknown } | undefined
  const content = textOf(newestUser?.content)
  const markers = [...content.matchAll(MARKER)]
  if (markers.length === 0) {
    // Only a request with no marker can be scheduled: a member's message always carries one.
    const tag = SCHEDULED_TAG.exec(content)
    if (tag?.[1] && tag[2]) {
      return { type: 'scheduled', kind: 'reminder', reminderId: tag[1], due: tag[2], stream, includeUsage }
    }
    return { type: 'unmarked', stream, includeUsage }
  }

  // The gateway writes one marker per message. Message text is the user's, so it can hold a forged one. Every
  // marker must name the same chat and sender, or the request is refused: a forged marker can then change nothing
  // but the forger's own message id.
  const parsed = markers.map((match) => parseMarker(match[1] ?? ''))
  const marker = parsed[parsed.length - 1] as ScopeMarker
  for (const other of parsed) {
    if (
      other.platform !== marker.platform ||
      other.kind !== marker.kind ||
      other.chat !== marker.chat ||
      other.sender !== marker.sender
    ) {
      throw new MalformedRequestError('the user content holds scope markers that disagree')
    }
  }

  // Segment i is the text before marker i. Its notes belong to message i; its plain text ends message i - 1.
  const starts = markers.map((match) => match.index ?? 0)
  const segments = starts.map((start, i) => {
    const from = i === 0 ? 0 : (starts[i - 1] ?? 0) + (markers[i - 1]?.[0].length ?? 0)
    return splitNotes(content.slice(from, start))
  })
  const last = markers[markers.length - 1] as RegExpMatchArray
  const newest = segments[segments.length - 1] as Notes
  let text = clean(content.slice((last.index ?? 0) + last[0].length))
  if (text === '' && newest.transcripts.length > 0) {
    text = newest.transcripts.map((line) => line.match(TRANSCRIPT)?.[1] ?? line).join('\n\n')
  }
  const earlier = clean(
    segments
      .map((segment) => clean(segment.plain))
      .filter((part) => part !== '')
      .join('\n\n')
  )
  const quote = newest.quote ? { ...newest.quote, ...(marker.qid ? { id: marker.qid } : {}) } : undefined
  return {
    type: 'turn',
    marker,
    text,
    earlier,
    ...(quote ? { quote } : {}),
    attachments: newest.attachments,
    stream,
    includeUsage
  }
}
