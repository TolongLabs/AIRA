import type { PreviewMessage } from './model.js'
import type { StickerRoots } from './stickers.js'

// What the preview server needs from the thing behind it: a core in process (level 1), or a fake bridge that a real
// gateway talks to (level 2). The page is the same for both.

export interface SimChat {
  /** The id the core, or the bridge, knows the chat by. An invented id, never a real WhatsApp id. */
  id: string
  title: string
  kind: 'dm' | 'group'
  /** The names to send as. A direct chat has one; a group has a few. */
  members: string[]
  /** A group answers any message when this is on. Absent where the sim does not own the setting. */
  freeResponse?: boolean
}

export interface SimInfo {
  level: 1 | 2
  /** The character the chats are bound to. Absent at level 2, where the gateway's core decides. */
  character?: string
  chats: SimChat[]
  /** Level 1 only: a fresh chat id can be started, and a turn record can be opened. */
  canReset: boolean
  hasRecords: boolean
}

export interface SendInput {
  sender: string
  text: string
  /** A group message that mentions AIRA. */
  mention: boolean
  /** The id of a message in this chat that the new one replies to. */
  replyTo?: string
}

export interface SendResult {
  message: PreviewMessage
  /** False when the gateway would not forward the message: a group message that neither mentions nor replies. */
  addressed: boolean
  /** Settles when the turn is over and every bubble has been drawn. */
  done: Promise<void>
}

export interface MessagesResult {
  /** The messages added or changed since the revision the page asked from. */
  messages: PreviewMessage[]
  typing: boolean
  /** The revision to ask from next time. */
  rev: number
}

export interface TurnPanel {
  id: string
  /** The record as `bun run turn` prints it. */
  text: string
  summary: Record<string, unknown>
  stages: { stage: string; ms: number }[]
  modelCalls: Record<string, unknown>[]
  toolCalls: Record<string, unknown>[]
  failures: Record<string, unknown>[]
}

export const MAX_TEXT = 4000
export const MAX_NAME = 40
export const GROUP_MEMBERS = ['Alice', 'Bob', 'Carol']
export const DM_MEMBER = 'Alex'

/** A name as an id: the sim writes `sim-member-<slug>` as a member's sender id. */
export function slug(name: string): string {
  const slugged = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slugged === '' ? 'member' : slugged.slice(0, 24)
}

export class SimInputError extends Error {
  override name = 'SimInputError'
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message)
  }
}

export interface SimBackend {
  readonly level: 1 | 2
  info(): SimInfo
  messages(chatId: string, after: number): Promise<MessagesResult>
  send(chatId: string, input: SendInput): Promise<SendResult>
  /** Level 1: starts the chat again under a fresh id. Returns the new chat. */
  reset?(chatId: string): SimChat
  /** Level 1: the group's free-response setting. */
  setFreeResponse?(chatId: string, value: boolean): void
  /** Level 1: one turn's record. Undefined for an unknown turn. */
  turn?(turnId: string): TurnPanel | undefined
  /** Level 1: where the sticker route looks. */
  stickerRoots?: StickerRoots
  /** Level 2: a file the bridge kept, by the number of the call that sent it. */
  file?(seq: number): Promise<{ type: string; body: Buffer } | undefined>
  close(): Promise<void>
}
