import type { z } from 'zod'
import type { Db } from '../storage/database.js'
import type { TurnContext } from '../turn/types.js'

// The tool contract (docs/trd/tools.md). A tool is defined once, with these fields, and reaches the model and the
// commands only through the registry.

export type ToolMode = 'both' | 'implicit' | 'explicit'

/** What a failed call returns to the model: a kind it can read and a short reason. Never an exception. */
export type ToolFailureKind = 'timeout' | 'refused' | 'invalid' | 'unavailable' | 'error'

/** What a state change was: built by code from the committed result, never from the model's words. */
export interface ReceiptDraft {
  /** What happened, such as `reminder.created`. */
  kind: string
  /** The id of the one row that changed. */
  target?: string
  /** The row's new state. Ids, times and flags only: no message text. */
  state?: Record<string, unknown>
}

export interface Receipt extends ReceiptDraft {
  receiptId: string
  callId: string
  tool: string
}

export type ToolResult =
  | {
      ok: true
      /** What the model reads. It must survive JSON.stringify. */
      data: unknown
      receipt?: Receipt
    }
  | { ok: false; kind: ToolFailureKind; reason: string }

/** What a handler returns. A mutating handler gets its receipt from `commit`. */
export type HandlerResult = { ok: true; data: unknown } | { ok: false; kind: ToolFailureKind; reason: string }

/** The turn context plus what one call needs. Identity is here; a model never supplies it. */
export interface ToolContext extends TurnContext {
  /** The id of this call. A call id that completed before returns its stored result. */
  callId: string
  /** Aborts at the call's timeout or the turn deadline. */
  signal: AbortSignal
  now: () => Date
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
