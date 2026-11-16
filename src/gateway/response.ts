import type { ServerResponse } from 'node:http'

// Writes the reply in the two shapes the gateway reads (docs/trd/system.md#gateway-contract): a server-sent
// event stream when the request asked for one, else one JSON body. The status is always 200.

/** A line holding only this character separates two bubbles. */
export const BUBBLE_BREAK = String.fromCodePoint(0x2063)

/** The content that makes the gateway send nothing. Empty content would make it retry, then send a notice. */
export const NO_REPLY = 'NO_REPLY'

export interface ReplyBody {
  /** Used as the completion id. */
  id: string
  content: string
  usage?: { inputTokens: number; outputTokens: number }
}

const MODEL_NAME = 'aira'

/** The content the gateway receives: never empty. */
const deliverable = (content: string): string => (content.trim() === '' ? NO_REPLY : content)

function usageOf(reply: ReplyBody) {
  const prompt = reply.usage?.inputTokens ?? 0
  const completion = reply.usage?.outputTokens ?? 0
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion }
}

/** The server-sent events of one reply, each without its trailing blank line. */
export function sseEvents(reply: ReplyBody, options: { includeUsage: boolean; created: number }): string[] {
  const base = {
    id: `chatcmpl-${reply.id}`,
    object: 'chat.completion.chunk',
    created: options.created,
    model: MODEL_NAME
  }
  const chunk = (delta: Record<string, unknown>, finish: string | null) =>
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })}`
  const events = [chunk({ role: 'assistant', content: deliverable(reply.content) }, null), chunk({}, 'stop')]
  if (options.includeUsage) events.push(`data: ${JSON.stringify({ ...base, choices: [], usage: usageOf(reply) })}`)
  events.push('data: [DONE]')
  return events
}

export function jsonBody(reply: ReplyBody, created: number): Record<string, unknown> {
  return {
    id: `chatcmpl-${reply.id}`,
    object: 'chat.completion',
    created,
    model: MODEL_NAME,
    choices: [{ index: 0, message: { role: 'assistant', content: deliverable(reply.content) }, finish_reason: 'stop' }],
    usage: usageOf(reply)
  }
}

/** Opens the event stream at once, so the gateway sees an answer in progress while the turn runs. */
export function openStream(response: ServerResponse): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  })
  response.flushHeaders()
}

export function writeReply(
  response: ServerResponse,
  reply: ReplyBody,
  options: { stream: boolean; includeUsage: boolean; now?: () => Date }
): void {
  if (response.destroyed || response.writableEnded) return
  const created = Math.floor((options.now ?? (() => new Date()))().getTime() / 1000)
  if (options.stream) {
    if (!response.headersSent) openStream(response)
    for (const event of sseEvents(reply, { includeUsage: options.includeUsage, created }))
      response.write(event + '\n\n')
    response.end()
    return
  }
  const body = JSON.stringify(jsonBody(reply, created))
  response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(body)
}
