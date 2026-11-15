import { normaliseKey, normaliseText } from './store.js'
import { FORGOTTEN_MESSAGE, MAX_VALUE_CHARS, type MemoryOperation, RESERVED_KEY_PREFIXES } from './types.js'

// Steps 4 and 7 of the write path (docs/trd/memory.md#write-path). Code decides here; no model is asked.

/** One window message of an episode, as the write path sees it. */
export interface EpisodeMessage {
  id: number
  role: 'user' | 'assistant'
  senderId?: string
  content: string
  /** A member already stored this message by hand with `note`. */
  skip: boolean
}

/** What the model proposes, before code has checked anything. */
export interface ProposedOperation {
  op: 'add' | 'update' | 'supersede' | 'retire'
  /** A member label of the episode, such as `member 2`, or `chat`. */
  subject: string
  key: string
  value?: string
  quote: string
  validUntil?: string
}

/** The label of a fact about the chat itself. */
export const CHAT_LABEL = 'chat'

const SCHEDULED = /^\s*\[AIRA-SCHEDULED v1 /
const WORD = /[\p{L}\p{N}]+/gu
const NUMBER = /\d+(?:[.,]\d+)*/g

/** The text of a user message that may support a fact: attachment lines never count. */
function ownText(content: string): string {
  return content
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('MEDIA:'))
    .join('\n')
}

function words(text: string): number {
  return text.match(WORD)?.length ?? 0
}

function isQuestion(text: string): boolean {
  return /[?？]\s*$/u.test(text)
}

/** The messages a quote may come from: a member's own words, not stored by hand, not scheduled, not removed. */
export function quotable(messages: EpisodeMessage[]): EpisodeMessage[] {
  return messages.filter(
    (message) =>
      message.role === 'user' &&
      message.senderId !== undefined &&
      !message.skip &&
      message.content !== FORGOTTEN_MESSAGE &&
      !SCHEDULED.test(message.content)
  )
}

/**
 * Step 4. False when no message of the episode could support any fact: only short lines, questions, AIRA's own
 * lines, scheduled messages or messages already stored by hand. The rule is the quote rule of step 7, so an
 * episode that fails it could never yield an accepted operation.
 */
export function precheck(messages: EpisodeMessage[]): boolean {
  return quotable(messages).some((message) => {
    const text = ownText(message.content)
    return words(text) >= 3 && !isQuestion(text)
  })
}

/** The member labels of an episode, in order of first appearance: subject id to `member N`. */
export function memberLabels(messages: EpisodeMessage[]): Map<string, string> {
  const labels = new Map<string, string>()
  for (const message of messages) {
    if (message.role !== 'user' || message.senderId === undefined || labels.has(message.senderId)) continue
    labels.set(message.senderId, `member ${labels.size + 1}`)
  }
  return labels
}

export type Validated = { ok: true; operation: MemoryOperation } | { ok: false; reason: string }

/**
 * Step 7. Checks one proposed operation against the schema and against its quote, and maps its subject label to
 * a subject id. Identity comes from code: a label the episode does not hold is rejected.
 */
export function validateOperation(
  proposed: ProposedOperation,
  messages: EpisodeMessage[],
  labels: Map<string, string>
): Validated {
  let subjectId: string | undefined
  if (proposed.subject !== CHAT_LABEL) {
    subjectId = [...labels].find(([, label]) => label === proposed.subject)?.[0]
    if (subjectId === undefined) return { ok: false, reason: 'unknown_subject' }
  }
  const key = normaliseKey(proposed.key)
  if (key === undefined) return { ok: false, reason: 'invalid_key' }
  if (RESERVED_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) return { ok: false, reason: 'reserved_key' }

  const value = proposed.value?.trim()
  if (proposed.op !== 'retire' && (value === undefined || value === '' || value.length > MAX_VALUE_CHARS)) {
    return { ok: false, reason: 'invalid_value' }
  }

  const quote = normaliseText(proposed.quote)
  if (words(quote) < 3) return { ok: false, reason: 'quote_too_short' }
  const holders = quotable(messages).filter((message) => normaliseText(ownText(message.content)).includes(quote))
  if (holders.length === 0) return { ok: false, reason: 'quote_not_found' }

  const numbers = value?.match(NUMBER) ?? []
  let reason = 'quote_not_found'
  for (const message of holders) {
    const text = ownText(message.content)
    if (subjectId !== undefined && message.senderId !== subjectId) {
      reason = 'third_party'
      continue
    }
    if (isQuestion(text)) {
      reason = 'quote_is_question'
      continue
    }
    const said = new Set(text.match(NUMBER) ?? [])
    if (numbers.some((number) => !said.has(number))) {
      reason = 'number_not_in_message'
      continue
    }
    return {
      ok: true,
      operation: {
        op: proposed.op,
        ...(subjectId === undefined ? {} : { subjectId }),
        key,
        ...(proposed.op === 'retire' || value === undefined ? {} : { value }),
        quote: proposed.quote,
        sourceMessageId: message.id,
        ...(proposed.validUntil === undefined ? {} : { validUntil: proposed.validUntil })
      }
    }
  }
  return { ok: false, reason }
}

/** A summary is stored only when it is short, and holds no number the members did not write. */
export function validateSummary(summary: string, messages: EpisodeMessage[]): Validated['ok'] {
  const text = summary.trim()
  if (text === '' || text.length > MAX_VALUE_CHARS) return false
  const said = new Set(quotable(messages).flatMap((message) => ownText(message.content).match(NUMBER) ?? []))
  return (text.match(NUMBER) ?? []).every((number) => said.has(number))
}
