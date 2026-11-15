// The model seam (docs/trd/models.md). Every request to any model role goes through a ModelClient, so the
// harness can record and replay it and the runners can retry and fall back without knowing the transport.

export type ModelRole = 'main' | 'fallback' | 'judge' | 'media'

/** One block of the system prompt, in the fixed order of docs/trd/prompt-engine.md#prompt-blocks. */
export interface PromptBlock {
  name: 'core' | 'speech' | 'harness' | 'context' | 'tone' | 'shape'
  text: string
}

export interface ToolCallRequest {
  id: string
  name: string
  args: Record<string, unknown>
}

/** One message of the conversation window, or a step of the loop in progress. */
export type ModelMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCallRequest[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string }

export interface ToolSchema {
  name: string
  description: string
  /** JSON Schema of the arguments. */
  parameters: Record<string, unknown>
}

export interface ModelRequest {
  role: ModelRole
  model: string
  system: PromptBlock[]
  messages: ModelMessage[]
  tools: ToolSchema[]
  /** Sampling and output parameters, such as temperature or a response schema. */
  params: Record<string, unknown>
}

export interface ModelUsage {
  inputTokens: number
  outputTokens: number
  cachedTokens: number
}

export interface ModelResponse {
  text: string
  toolCalls: ToolCallRequest[]
  /** Real numbers from the provider's response, never an estimate. */
  usage: ModelUsage
  costUsd: number
  /** The model id the provider reports. */
  model: string
}

/** The failure kinds of docs/trd/models.md#failure-kinds. */
export type ModelFailureKind = 'transient' | 'rate_limit' | 'auth' | 'refusal' | 'malformed' | 'budget'

export class ModelError extends Error {
  override name = 'ModelError'
  constructor(
    readonly kind: ModelFailureKind,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
  }
}

export interface ModelClient {
  /** Resolves with the response, or rejects with a ModelError. The signal carries the turn deadline. */
  call(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse>
}
