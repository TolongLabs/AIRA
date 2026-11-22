import type { z } from 'zod'
import type { SocialLookupObserver } from '../social/types.js'
import type { Db } from '../storage/database.js'
import type { TurnContext } from '../turn/types.js'

// The tool contract (docs/trd/tools.md). A tool is defined once, with these fields, and reaches the model and the
// commands only through the registry.

export type ToolMode = 'both' | 'implicit' | 'explicit'

/** What a failed call returns to the model: a kind, and an optional code that picks its plain outcome sentence. */
export type ToolFailureKind = 'timeout' | 'refused' | 'invalid' | 'unavailable' | 'error'

/**
 * Picks the sentence the model reads for a failed call (src/tools/outcomes.ts). A handler sets it when its kind does
 * not say what the character should say. `read_failed` is for kind `error` only: a timeout or unavailable read keeps
 * its kind sentence. `schema` marks invalid arguments whose issue text the model needs.
 */
export type FailureCode =
  | 'already_read'
  | 'already_tried'
  | 'after_read'
  | 'read_failed'
  | 'schema'
  | 'tool_limit'
  | 'not_now'
  | 'unseen_link'
  | 'linkedin_recognition_only'
  | 'rednote_recognition_only'
  | 'douyin_recognition_only'

/** What a state change was: built by code from the committed result, never from the model's words. */
export interface ReceiptDraft {
  /** What happened, such as `reminder.created`. */
  kind: string
  /** The id of the one row that changed. */
  target?: string
  /** The row's new state. Ids, times and flags only: no message text. */
  state?: Record<string, unknown>
  /** Reuses a receipt for the same tool and chat when this call found that the state change already exists. */
  reuseReceiptId?: string
}

export interface Receipt extends ReceiptDraft {
  receiptId: string
  callId: string
  tool: string
}

export type ToolFailure = {
  ok: false
  kind: ToolFailureKind
  /** Internal: recorded in the tool call and failure records. Sent to the model only as schema guidance. */
  reason: string
  code?: FailureCode
  /** Internal error that caused the failure; recorded for diagnostics, never sent to the model. */
  cause?: unknown
}

export type ToolResult =
  | {
      ok: true
      /** What the model reads. It must survive JSON.stringify. */
      data: unknown
      receipt?: Receipt
    }
  | ToolFailure

/** What a handler returns. A mutating handler gets its receipt from `commit`. */
export type HandlerResult = { ok: true; data: unknown } | ToolFailure

/** The turn context plus what one call needs. Identity is here; a model never supplies it. */
export interface ToolContext extends TurnContext {
  /** The id of this call. A call id that completed before returns its stored result. */
  callId: string
  /** Aborts at the call's timeout or the turn deadline. */
  signal: AbortSignal
  /** Absolute deadline imposed by the registry on this call. */
  callDeadline?: number
  observeSocialLookup?: SocialLookupObserver
  now: () => Date
  /** Text of the message(s) this turn answers, supplied by code. */
  messageText?: string
  /**
   * The one transaction of a state change. The handler's writes, the stored result of the call and its receipt
   * commit together or not at all. A handler may call it once. Only a tool with `mutates: true` may call it.
   */
  commit<T>(write: (db: Db) => { data: T; receipt: ReceiptDraft }): { data: T; receipt: Receipt }
}

export interface ToolCommand {
  /** The command names without the slash, such as `remind`. A tool may have more than one (`mute`, `unmute`). */
  names: string[]
  /** `direct`: code runs the handler and answers from a template. `skill`: the model fills the arguments. */
  kind: 'direct' | 'skill'
  /** One line for `/help`. */
  usage: string
  /** For a direct command: the tool's arguments from the command name used and the rest of the message. */
  directArgs?: (name: string, rest: string) => unknown
}

export interface ToolDefinition<Args = unknown> {
  /** Stable id, used by the model, by commands and in records. Lower case, digits and underscores. */
  name: string
  /** What the model is told. */
  description: string
  schema: z.ZodType<Args>
  mode: ToolMode
  /** True when the tool changes state. Such a tool must return a receipt, through `commit`. */
  mutates: boolean
  /** The setting a chat needs for this tool, checked by the registry before the handler runs. */
  permission?: (context: TurnContext) => boolean
  /** The per-chat feature switch that enables it, such as `features.reminders`. */
  feature?: string
  /** Hard limit for one call. Defaults to tools.defaultTimeoutMs. */
  timeoutMs?: number
  /** For `both` and `explicit`. */
  command?: ToolCommand
  /** One function. It never throws into the loop: the registry turns a throw into a typed `error` result. */
  handler(args: Args, context: ToolContext): Promise<HandlerResult> | HandlerResult
}
