// The memory contract (docs/trd/memory.md). Every function of the memory module takes a chat id, and no query
// reads a row without one: a fact never leaves its chat.

export type MemoryKind = 'fact' | 'episode' | 'media'
export type MemoryStatus = 'active' | 'upcoming' | 'superseded' | 'retired' | 'forgotten'

export interface MemoryItem {
  id: string
  chatId: string
  kind: MemoryKind
  /** The person a fact is about, or undefined for a fact about the chat itself. */
  subjectId?: string
  key?: string
  value: string
  status: MemoryStatus
  pinned: boolean
  sourceTurn?: string
  sourceJob?: string
  sourceMessageId?: number
  validUntil?: string
  createdAt: string
  updatedAt: string
}

/** One change the write path proposes. Code validates it; the judge verifies it; one transaction applies it. */
export interface MemoryOperation {
  op: 'add' | 'update' | 'supersede' | 'retire'
  /** The subject the fact is about, already mapped by code from a member label, or undefined for the chat. */
  subjectId?: string
  key: string
  /** Absent for `retire`. */
  value?: string
  /** The message text that supports the operation. It must be found in one user message of the episode. */
  quote: string
  /** The window message the quote was found in. Set by code when the operation is validated. */
  sourceMessageId?: number
  /** For a stated future change: when the fact lapses. The fact is stored as `upcoming`. */
  validUntil?: string
}

export type OperationOutcome =
  | { accepted: true; itemId: string; effect: 'added' | 'replaced' | 'retired' | 'unchanged' }
  | { accepted: false; reason: string }

/** The judge model (docs/trd/memory.md#write-path, steps 5 and 8). It answers with a probability. */
export interface MemoryJudge {
  /** How likely the episode holds anything lasting. Rejects on any failure. */
  admit(input: { episode: string }, signal: AbortSignal): Promise<number>
  /** How likely the operation is supported by the episode. Rejects on any failure: the judge fails closed. */
  verify(input: { operation: string; quote: string; episode: string }, signal: AbortSignal): Promise<number>
}

/** A normalised fact slot: lower-case words joined by dots, such as `likes.food`. */
export const MEMORY_KEY = /^[a-z0-9_]+(\.[a-z0-9_]+){0,5}$/
export const MAX_VALUE_CHARS = 500

/** Keys only the note and lingo tools may write. Extraction can never write or change them. */
export const RESERVED_KEY_PREFIXES = ['note.', 'lingo.'] as const
/** What replaces the key of a forgotten fact, and the text of the window message that supported it. */
export const FORGOTTEN_KEY = 'forgotten'
export const FORGOTTEN_MESSAGE = '[removed]'
