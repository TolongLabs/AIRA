import type { Pack } from '../character/loader.js'
import type { LineKind } from '../character/schema.js'
import type { Attachment } from '../gateway/request.js'
import type { ModelFailureKind, ModelMessage, ModelUsage, PromptBlock, ToolSchema } from '../models/types.js'
import type { TurnRecordFields } from '../records/turn-record.js'
import type { Chat } from '../settings/chats.js'
import type { Resolved } from '../settings/settings.js'
import type { Db } from '../storage/database.js'
import type { DeliveryKind } from './deliver.js'
import type { TurnSources } from './sources.js'

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
  /** The turn's URLs, registered at steps 2 and 5. Read tools open only these (docs/trd/tools.md#turn-sources). */
  sources: TurnSources
  /** For a skill-style command: the tool the command names. Its call is recorded with source `command`. */
  commandTool?: string
  /** Read sources of a completed research job, supplied by code for its footer. */
  researchSources?: string[]
  /** Footer kinds read at intake before the model ran: files first, then the link. */
  intakeKinds?: string[]
  /** Canonical URLs of links read at intake, so web tools do not open them again. */
  intakeUrls?: string[]
  /** Links whose video or image intake watched; read_post and read_page refuse only these. */
  intakeWatchedUrls?: string[]
  /** Social addresses intake opened this turn. A failed one closes read_post and read_page to it. */
  intakeTriedSocialUrls?: { url: string; failed: boolean }[]
  /** Text of the message(s) this turn answers, supplied by code. */
  messageText?: string
  /** True when `/think` raised effort for this turn. */
  think?: boolean
  /** Pictures identify_image may look up, in index order (docs/trd/tools.md#reverse-image-hints). */
  images?: TurnImage[]
}

/** A picture of this turn: a file the gateway saved, or a photo URL of a post read at intake. */
export type TurnImage = { kind: 'file'; attachment: Attachment } | { kind: 'url'; url: string }

export interface WindowMessage {
  role: 'user' | 'assistant'
  /** The subject who wrote a user message. */
  senderId?: string
  /** The turn that answers a user message, or the turn that wrote a reply. */
  turnId?: string
  content: string
  /** A reply code wrote with no model call, such as a direct command's answer. */
  byCode?: boolean
  /** The message a user message quotes. It is untrusted and never part of the sender's own text. */
  quote?: { text: string; ofAira: boolean }
  at: string
}

export interface TurnInput {
  context: TurnContext
  /** The conversation window, oldest first, up to and including the messages this turn answers. */
  window: WindowMessage[]
  /** The user messages this turn answers. */
  pending: WindowMessage[]
  /** What the files those messages carried show, as labelled text for prompt block 4. Absent: no files. */
  media?: string
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
  /** False while withdrawn from later model steps. A call the model still makes is refused by the registry. */
  available?(): boolean
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
  /** Effort sent for this call, when set. */
  effort?: string
  attempt: number
  startedAt: Date
  durationMs: number
  usage?: ModelUsage
  costUsd?: number
  error?: unknown
  failureKind?: ModelFailureKind
}

export interface RunResult {
  text: string
  usage: ModelUsage
  costUsd: number
  model: string
  role: string
  transport: string
  toolMs?: number
  calls: ModelCallRecord[]
  /** Which chain limit ended the tool chain, if one did. */
  chainLimit?: 'calls' | 'time'
  receipts: string[]
}

/** The route that gave a first reply. A regeneration answers on that route or fails; it never moves to another. */
export interface ReplyTarget {
  transport: string
  role: string
  /** The model id as the routed client records it: the configured id, not the provider's report. */
  model: string
}

/** Step 6. Models implements it: one loop, one tool set, one voice. It rejects with a ModelError. */
export interface TurnRunner {
  run(input: {
    system: PromptBlock[]
    messages: ModelMessage[]
    tools: OfferedTool[]
    context: TurnContext
    signal: AbortSignal
    /**
     * For commands: until each named tool has been called once, only the named tools not yet called are offered.
     * The model fills their arguments, or asks one question and calls nothing.
     */
    onCall?: (record: ModelCallRecord) => void
    onSpendError?: (error: unknown) => void
    firstTools?: string[]
    /** Maximum tool calls this turn may make (never above the deployment ceiling in the runner). */
    maxToolCalls?: number
    /** Regeneration only: the route that gave the first reply. The runner answers on it, or throws. */
    replyTarget?: ReplyTarget
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
  /** Set when the reply stepped out of its role: the name of the pattern it matched, never its text. */
  fourthWall?: string
  stickerId?: string
  attachments?: string[]
  /** The chosen source URLs and their original footer line, for optional short links. */
  footerSources?: { urls: string[]; line: string }
}
export interface ReplyCleaner {
  clean(input: { text: string; context: TurnContext; built: BuiltPrompt; run: RunResult }): CleanedReply
}

/** Tools offered to this turn, already filtered by the chat's features and permissions. Tools implements it. */
export interface ToolOffer {
  offered(context: TurnContext): OfferedTool[]
}

/** A command this chat may use (docs/trd/tools.md#explicit-calls-text-commands). */
export interface CommandMatch {
  /** The command name as typed, lower case, without the slash. */
  name: string
  /** The tool the command names, after routing. */
  tool: string
  kind: 'direct' | 'skill'
  /** For a direct command: the tool's arguments, built by code. */
  args?: unknown
  /** The text following this command, up to the next matched command or end of message. */
  rest: string
}

/** Step 4. Commands implements it. */
export interface CommandRouter {
  /** Pure. Empty for text with no command this chat may use. Returns matches in order, up to commands.maxPerMessage. */
  match(text: string, context: TurnContext): CommandMatch[]
  /** Runs a direct command: code runs the handler and writes the answer. No model call. */
  runDirect(match: CommandMatch, context: TurnContext): Promise<{ ok: boolean; text: string; receipts: string[] }>
  /** Data a skill-style command needs before the model fills the arguments, as one labelled, untrusted block. */
  contextFor(match: CommandMatch, context: TurnContext): Promise<string | undefined>
}

/** Hooks that commit with the close of a turn or decide before it runs. */
export interface TurnHooks {
  /** False when the monthly cap stops replies. Models implements it. */
  spendAllows?: () => boolean
  /** Runs in the closing transaction of a delivered turn: queue memory work here. */
  onDelivered?: (db: Db, context: TurnContext) => void
}
