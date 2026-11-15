import type { Pack } from '../character/loader.js'
import type { LineKind } from '../character/schema.js'
import type { ModelFailureKind, ModelMessage, ModelUsage, PromptBlock, ToolSchema } from '../models/types.js'
import type { TurnRecordFields } from '../records/turn-record.js'
import type { Chat } from '../settings/chats.js'
import type { Resolved } from '../settings/settings.js'
import type { Db } from '../storage/database.js'
import type { DeliveryKind } from './deliver.js'

// The turn context and the seams of the turn pipeline (docs/trd/system.md#one-turn).
// The pipeline owns the order of the steps. Each seam is one step that another module implements.

/** Built by code at step 2. A model never supplies or changes any of it. */
export interface TurnContext {
  turnId: string
  chat: Chat
  /** The sender's subject id. */
  senderId: string
  character: Pack
  settings: Record<string, Resolved>
  kind: 'reply' | 'command' | 'scheduled'
  /** The delivery this turn is, for the mute and quiet rule. */
  delivery: DeliveryKind
  /** When all model work of this turn must end, in milliseconds since the epoch. */
  deadline: number
}

export interface WindowMessage {
  role: 'user' | 'assistant'
  /** The subject who wrote a user message. */
  senderId?: string
  /** The turn that answers a user message, or the turn that wrote a reply. */
  turnId?: string
  content: string
  at: string
}

export interface TurnInput {
  context: TurnContext
  /** The conversation window, oldest first, up to and including the messages this turn answers. */
  window: WindowMessage[]
  /** The user messages this turn answers. */
  pending: WindowMessage[]
}

/** Step 5. Prompt Engine implements it. */
export interface BuiltPrompt {
  system: PromptBlock[]
  messages: ModelMessage[]
  /** What the build decided, for the turn record: mood, its source, the shape seed, the length bypass. */
  record: TurnRecordFields
  /** Anything the cleaner needs from the build, such as the reply shape. Opaque to the pipeline. */
  shape?: unknown
}
export interface PromptBuilder {
  build(input: TurnInput): Promise<BuiltPrompt> | BuiltPrompt
}

export interface OfferedTool {
  schema: ToolSchema
  /** Runs one call. It never throws: a failure is a typed result. */
  call(
    args: unknown,
    callId: string,
    signal: AbortSignal
  ): Promise<{ ok: boolean; content: string; receiptId?: string }>
}

/** One model request the runner made, for the model_call table. */
export interface ModelCallRecord {
  role: string
  model: string
  transport: string
  attempt: number
  startedAt: Date
  durationMs: number
  usage?: ModelUsage
  costUsd?: number
  failureKind?: ModelFailureKind
}

export interface RunResult {
  text: string
  usage: ModelUsage
  costUsd: number
  model: string
  role: string
  transport: string
  calls: ModelCallRecord[]
  /** Which chain limit ended the tool chain, if one did. */
  chainLimit?: 'calls' | 'time'
  receipts: string[]
}

/** Step 6. Models implements it: one loop, one tool set, one voice. It rejects with a ModelError. */
export interface TurnRunner {
  run(input: {
    system: PromptBlock[]
    messages: ModelMessage[]
    tools: OfferedTool[]
    context: TurnContext
    signal: AbortSignal
  }): Promise<RunResult>
}

/** Step 7. Format implements it. */
export interface CleanedReply {
  /** The content returned to the gateway: bubbles separated by break lines, then attachment lines. */
  content: string
  bubbleCount: number
  /** The cleaning steps that changed the text. */
  steps: string[]
  /** Set when the chain replaced the reply with a pack line. */
  replacedBy?: LineKind
  stickerId?: string
  attachments?: string[]
}
export interface ReplyCleaner {
  clean(input: { text: string; context: TurnContext; built: BuiltPrompt; run: RunResult }): CleanedReply
}

/** Tools offered to this turn, already filtered by the chat's features and permissions. Tools implements it. */
export interface ToolOffer {
  offered(context: TurnContext): OfferedTool[]
}

/** Step 4. Commands implements it. A match skips the model loop unless the command needs it. */
export interface CommandRouter {
  /** Pure: says whether the text starts with a command this chat may use. */
  match(text: string, chat: Chat, settings: Record<string, Resolved>): { name: string } | undefined
  run(input: TurnInput & { text: string }): Promise<{ text: string; receipts: string[]; record?: TurnRecordFields }>
}

/** Hooks that commit with the close of a turn or decide before it runs. */
export interface TurnHooks {
  /** False when the monthly cap stops replies. Models implements it. */
  spendAllows?: () => boolean
  /** Runs in the closing transaction of a delivered turn: queue memory work here. */
  onDelivered?: (db: Db, context: TurnContext) => void
}
