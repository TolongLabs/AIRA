import type { FailureCode, ToolFailure, ToolFailureKind } from './types.js'

// The sentence a model reads when a call fails (docs/trd/prompt-engine.md#staying-in-role). Each sentence is plain
// and holds no reason, mechanism or persona text, so the character can say it in its own words. The one exception is
// schema guidance: the issue text follows its prefix, because the model needs it to make the call again.

export const TOOL_FAILURE_KINDS: readonly ToolFailureKind[] = ['timeout', 'refused', 'invalid', 'unavailable', 'error']
export const FAILURE_CODES: readonly FailureCode[] = [
  'already_read',
  'already_tried',
  'after_read',
  'read_failed',
  'schema',
  'tool_limit',
  'not_now',
  'unseen_link',
  'linkedin_recognition_only',
  'rednote_recognition_only'
]

const BY_KIND: Record<ToolFailureKind, string> = {
  timeout: 'It took too long, so you stopped trying for now.',
  refused: 'You cannot do that here.',
  invalid: 'Try once more with corrected details.',
  unavailable: 'You cannot do that here.',
  error: 'That did not work this time.'
}

const BY_CODE: Record<Exclude<FailureCode, 'schema'>, string> = {
  already_read: 'You have already looked at that link in this message.',
  already_tried: 'You already tried that link and it would not open.',
  read_failed: 'You could not get that post or page to open. It may be private, removed or blocked.',
  tool_limit: 'You cannot do any more of that for this message.',
  not_now: 'You cannot do that right now.',
  unseen_link: 'You only open links that came up in this chat or in your own search.',
  linkedin_recognition_only: 'You cannot open LinkedIn links here.',
  rednote_recognition_only: 'You cannot open Rednote links here.',
  after_read: 'You will not change anything based on that page.'
}

const SCHEMA_PREFIX = 'Try once more with corrected details:'

/** The plain sentence for a failed call: its code when it has one, else its kind. */
export function outcomeOf(failure: Pick<ToolFailure, 'kind' | 'reason'> & { code?: FailureCode }): string {
  if (failure.code === 'schema') return `${SCHEMA_PREFIX} ${failure.reason}`
  if (failure.code !== undefined) return BY_CODE[failure.code]
  return BY_KIND[failure.kind]
}

/** The content a model reads for a failed call. The raw kind and reason never go in it. */
export function outcomePayload(failure: Pick<ToolFailure, 'kind' | 'reason'> & { code?: FailureCode }): string {
  return JSON.stringify({ ok: false, outcome: outcomeOf(failure) })
}
