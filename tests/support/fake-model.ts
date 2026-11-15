import { type ModelClient, ModelError, type ModelRequest, type ModelResponse } from '../../src/models/types.js'

export function textResponse(text: string, costUsd = 0): ModelResponse {
  return {
    text,
    toolCalls: [],
    usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
    costUsd,
    model: 'fake-model'
  }
}

/** A ModelClient that answers from a queue: each entry is a response, or a ModelError to throw. It records the requests. */
export function fakeModel(queue: (Partial<ModelResponse> | ModelError)[]): ModelClient & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = []
  let index = 0

  return {
    requests,
    async call(request, signal) {
      requests.push(request)
      if (signal?.aborted) {
        throw new ModelError('transient', 'aborted')
      }
      const next = queue[index++]
      if (next === undefined) {
        throw new ModelError('transient', 'the fake model has no more answers')
      }
      if (next instanceof ModelError) {
        throw next
      }
      return {
        text: next.text ?? '',
        toolCalls: next.toolCalls ?? [],
        usage: next.usage ?? { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
        costUsd: next.costUsd ?? 0,
        model: next.model ?? request.model
      }
    }
  }
}
