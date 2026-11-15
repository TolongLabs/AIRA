// Reads a gateway request (docs/trd/system.md#gateway-contract).
// Identity comes only from the scope marker in the newest user content. Nothing here trusts a model.

export interface ScopeMarker {
  platform: string
  kind: 'dm' | 'group'
  /** The chat's WhatsApp id. */
  chat: string
  /** The sender's WhatsApp id. */
  sender: string
  /** The gateway's message id. */
  mid: string
}

export type GatewayRequest =
  /** A user message for a turn. */
  | {
      type: 'turn'
      marker: ScopeMarker
      /** The newest message text, with gateway notes removed. */
      text: string
      /** Earlier messages from the same sender that got no reply, as the gateway prepended them. */
      earlier: string
      stream: boolean
      includeUsage: boolean
    }
  /** A gateway chore such as a session title: no tools and no marker. */
  | { type: 'auxiliary'; stream: boolean; includeUsage: boolean }

/** A request the core cannot accept. It is a deployment fault and the only case that gets an error status. */
export class MalformedRequestError extends Error {
  override name = 'MalformedRequestError'
  readonly kind = 'gateway_malformed'
}

const MARKER = /\[HERMES-SCOPE v1\b([^\]\n]*)\]/g
const SYSTEM_NOTE = /\[System note:[^\]]*\]/g
const FIELD = /^[A-Za-z0-9@._:+-]+$/

function parseMarker(body: string): ScopeMarker {
  const fields = new Map<string, string>()
  for (const part of body.trim().split(/\s+/)) {
    const at = part.indexOf('=')
    if (at > 0) fields.set(part.slice(0, at), part.slice(at + 1))
  }
  const need = (name: string): string => {
    const value = fields.get(name)
    if (value === undefined || !FIELD.test(value)) {
      throw new MalformedRequestError(`the scope marker has no usable ${name}`)
    }
    return value
  }
  const kind = need('kind')
  if (kind !== 'dm' && kind !== 'group') throw new MalformedRequestError('the scope marker kind is not dm or group')
  return { platform: need('platform'), kind, chat: need('chat'), sender: need('sender'), mid: need('mid') }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  // Multi-part content: the text parts in order. Media parts are read at intake, not here.
  return content
    .map((part: unknown) =>
      typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text'
        ? String((part as { text?: unknown }).text ?? '')
        : ''
    )
    .filter((text) => text !== '')
    .join('\n')
}

const clean = (text: string): string =>
  text
    .replace(SYSTEM_NOTE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

export function parseGatewayRequest(body: unknown): GatewayRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new MalformedRequestError('the request body is not a JSON object')
  }
  const request = body as { messages?: unknown; tools?: unknown; stream?: unknown; stream_options?: unknown }
  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    throw new MalformedRequestError('the request has no messages')
  }
  const stream = request.stream === true
  const includeUsage =
    typeof request.stream_options === 'object' &&
    request.stream_options !== null &&
    (request.stream_options as { include_usage?: unknown }).include_usage === true

  const newestUser = request.messages.findLast(
    (message: unknown) =>
      typeof message === 'object' && message !== null && (message as { role?: unknown }).role === 'user'
  ) as { content?: unknown } | undefined
  const content = textOf(newestUser?.content)
  const markers = [...content.matchAll(MARKER)]
  const hasTools = Array.isArray(request.tools) && request.tools.length > 0

  if (markers.length === 0) {
    if (hasTools) {
      throw new MalformedRequestError(
        'a turn request has no scope marker: the gateway scope stamp is off (set WHATSAPP_SCOPE_STAMP=1)'
      )
    }
    return { type: 'auxiliary', stream, includeUsage }
  }

  // The gateway writes one marker. Message text is the user's, so it can hold a forged one. Every marker must
  // name the same chat and sender, or the request is refused: a forged marker can then change nothing but the
  // forger's own message id.
  const parsed = markers.map((match) => parseMarker(match[1] ?? ''))
  const marker = parsed[parsed.length - 1] as ScopeMarker
  for (const other of parsed) {
    if (
      other.platform !== marker.platform ||
      other.kind !== marker.kind ||
      other.chat !== marker.chat ||
      other.sender !== marker.sender
    ) {
      throw new MalformedRequestError('the user content holds scope markers that disagree')
    }
  }

  const first = markers[0] as RegExpMatchArray
  const last = markers[markers.length - 1] as RegExpMatchArray
  const earlier = clean(content.slice(0, first.index))
  const between = markers.length > 1 ? content.slice((first.index ?? 0) + first[0].length, last.index) : ''
  const text = clean(content.slice((last.index ?? 0) + last[0].length))
  return {
    type: 'turn',
    marker,
    text,
    earlier: clean([earlier, between.replace(MARKER, '')].filter((part) => part.trim() !== '').join('\n\n')),
    stream,
    includeUsage
  }
}
