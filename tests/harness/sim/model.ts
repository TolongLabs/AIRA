import { basename } from 'node:path'
import { gatewayMarkdown } from '../../support/gateway-markdown.js'
import { parseContent } from '../gateway.js'
import { previewText, renderMarkup } from './markup.js'

// What the preview draws, and how a reply or a recorded bridge call becomes it (docs/trd/harness.md#chat-preview).

export interface PreviewQuote {
  /** The id of the quoted message, when it has one. */
  id?: string
  /** Who wrote it: a member's name, or `AIRA`. */
  sender: string
  /** One short plain line. The page escapes it. */
  text: string
}

export interface PreviewMessage {
  /** The order in the chat. Starts at 1. */
  seq: number
  /** Counts every change to the chat's messages: a new message, an edit, a reaction. A page asks for `rev > n`. */
  rev: number
  /** The WhatsApp message id: `sim-...` for a member's message, `out-...` for one AIRA sent. */
  id: string
  at: string
  kind: 'member' | 'aira' | 'note'
  /** A member's name. */
  sender?: string
  /** The text as HTML, from {@link renderMarkup}. Empty for a sticker, a photo or a note. */
  html: string
  /** The text as the chat received it, for a quote. */
  text: string
  quote?: PreviewQuote
  /** A group message that mentions AIRA. The page draws a mention chip. */
  mention?: boolean
  sticker?: { url: string; name: string }
  attachment?: { name: string; kind: 'photo' | 'file'; url?: string }
  note?: { tone: 'info' | 'warn' | 'error'; text: string }
  /** The turn that made this message, and how long the reply took. Only on AIRA's messages. */
  turn?: { id?: string; ms: number; faults: string[] }
  reaction?: string
  edited?: boolean
}

export type MessageDraft = Omit<PreviewMessage, 'seq' | 'rev' | 'id' | 'at'> & { id?: string; at?: string }

/** The messages of one chat, in the order they were sent. */
export class ChatLog {
  private readonly messages: PreviewMessage[] = []
  private seq = 0
  private revision = 0
  private nextId = 0

  constructor(
    private readonly prefix: string,
    private readonly now: () => Date = () => new Date()
  ) {}

  add(draft: MessageDraft): PreviewMessage {
    this.seq += 1
    this.revision += 1
    this.nextId += 1
    const message: PreviewMessage = {
      ...draft,
      seq: this.seq,
      rev: this.revision,
      id: draft.id ?? `${this.prefix}-${this.nextId}`,
      at: draft.at ?? this.now().toISOString()
    }
    this.messages.push(message)
    return message
  }

  /** The messages added or changed after revision `after`. */
  since(after: number): PreviewMessage[] {
    return this.messages.filter((message) => message.rev > after)
  }

  /** Changes a message and marks it for the page. */
  update(message: PreviewMessage, change: Partial<PreviewMessage>): void {
    this.revision += 1
    Object.assign(message, change, { rev: this.revision })
  }

  find(id: string): PreviewMessage | undefined {
    return this.messages.find((message) => message.id === id)
  }

  /** The newest revision. */
  get rev(): number {
    return this.revision
  }
}

/** The gateway's rule for a file after the text: a `.webp` under a `stickers/` folder is a native sticker. */
const STICKER_PATH = /(?:^|[\\/])characters[\\/]([^\\/]+)[\\/]stickers[\\/]([^\\/]+\.webp)$/i
const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp)$/i
const FILE_PATH = /(?:^|[\\/])files[\\/]([0-9a-f]{2})[\\/]([0-9a-f]{64}\.(?:png|jpe?g|gif|webp))$/i

export interface Attachment {
  kind: 'sticker' | 'photo' | 'file'
  name: string
  /** For a sticker: the pack and file the sticker route serves. */
  pack?: string
  file?: string
  /** For a picture a tool made: its path under the data folder's `files/`, which the photo route serves. */
  stored?: string
}

/** What a `MEDIA:` path is, by the gateway's own rules. */
export function classifyMedia(path: string): Attachment {
  const sticker = STICKER_PATH.exec(path)
  if (sticker) return { kind: 'sticker', name: basename(path), pack: sticker[1] as string, file: sticker[2] as string }
  const stored = FILE_PATH.exec(path)
  return {
    kind: IMAGE_FILE.test(path) ? 'photo' : 'file',
    name: basename(path.replace(/\\/g, '/')),
    ...(stored ? { stored: `${(stored[1] as string).toLowerCase()}/${(stored[2] as string).toLowerCase()}` } : {})
  }
}

export interface NothingToSend {
  kind: 'none'
  reason: 'no_reply' | 'empty'
}
export interface MessagesToSend {
  kind: 'messages'
  bubbles: string[]
  media: Attachment[]
}
export type ReplyShape = NothingToSend | MessagesToSend

/**
 * What the gateway would send for the core's reply. The text bubbles come first, split at the core's break lines,
 * each through the gateway's Markdown conversion; the files follow, in order. `NO_REPLY` and an empty reply send
 * nothing. Pure.
 */
export function shapeReply(content: string): ReplyShape {
  if (content.trim() === 'NO_REPLY') return { kind: 'none', reason: 'no_reply' }
  const { bubbles, media } = parseContent(content)
  if (bubbles.length === 0 && media.length === 0) return { kind: 'none', reason: 'empty' }
  return { kind: 'messages', bubbles: bubbles.map(gatewayMarkdown), media: media.map(classifyMedia) }
}

/** A text bubble as the preview draws it. */
export function textFields(text: string): Pick<PreviewMessage, 'html' | 'text'> {
  return { html: renderMarkup(text), text }
}

/** How a quote of this message reads: its text, or what kind of thing it is. */
export function quoteText(message: PreviewMessage): string {
  if (message.text.trim() !== '') return previewText(message.text)
  if (message.sticker) return 'Sticker'
  if (message.attachment) return message.attachment.kind === 'photo' ? 'Photo' : message.attachment.name
  return ''
}
