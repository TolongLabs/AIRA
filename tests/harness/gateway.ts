/** The character that, alone on a line, separates two bubbles (U+2063, invisible separator). */
export const BUBBLE_BREAK = String.fromCodePoint(0x2063)

const MEDIA_PREFIX = 'MEDIA:'
const DEFAULT_ATTEMPTS = 6

export interface GatewayMessage {
  chat: { waId: string; kind: 'dm' | 'group' }
  sender: string
  mid: string
  text: string
  /** The message this one quotes, written as the gateway writes it: a reply note before the marker, and `qid`. */
  quote?: { text: string; id: string; ofAira?: boolean }
}

/** The request body for one message, exactly as the gateway builds it. Pure. */
export function buildRequest(input: {
  message: GatewayMessage
  transcript: { role: 'user' | 'assistant'; content: string }[]
  unanswered: string[]
  firstMessage: boolean
}): Record<string, unknown> {
  const { message, transcript, unanswered, firstMessage } = input
  const unansweredPrefix = unanswered.map((text) => `${text}\n\n`).join('')
  const qid = message.quote ? ` qid=${message.quote.id}` : ''
  const scopeMarker = `[HERMES-SCOPE v1 platform=whatsapp kind=${message.chat.kind} chat=${message.chat.waId} sender=${message.sender} mid=${message.mid}${qid}]`
  const replyNote = message.quote
    ? `[Replying to${message.quote.ofAira ? ' your previous message' : ''}: "${message.quote.text.slice(0, 500)}"]\n\n`
    : ''
  const firstNote = firstMessage ? '\n\n[System note: this is the first message of the conversation.]' : ''
  const newestUserContent = `${unansweredPrefix}${replyNote}${scopeMarker}\n${message.text}${firstNote}`

  return {
    model: 'aira',
    messages: [
      { role: 'system', content: "(the gateway's own prompt; the core ignores it)" },
      ...transcript.map((turn) => ({ role: turn.role, content: turn.content })),
      { role: 'user', content: newestUserContent }
    ],
    stream: true,
    stream_options: { include_usage: true },
    tools: [
      {
        type: 'function',
        function: {
          name: 'gateway_tool',
          description: 'ignored by the core',
          parameters: { type: 'object', properties: {} }
        }
      }
    ]
  }
}

/** Splits reply content into text bubbles and attachment paths. Pure. */
export function parseContent(content: string): { bubbles: string[]; media: string[] } {
  const lines = content.split(/\r?\n/)
  const media: string[] = []

  while (lines.length > 0) {
    const last = lines[lines.length - 1]!
    if (last === '') {
      lines.pop()
    } else if (last.startsWith(MEDIA_PREFIX)) {
      media.unshift(last.slice(MEDIA_PREFIX.length).trim())
      lines.pop()
    } else {
      break
    }
  }

  const bubbles: string[] = []
  let current: string[] = []
  for (const line of lines) {
    if (line === BUBBLE_BREAK) {
      const bubble = current.join('\n').trim()
      if (bubble.length > 0) bubbles.push(bubble)
      current = []
    } else {
      current.push(line)
    }
  }
  const tail = current.join('\n').trim()
  if (tail.length > 0) bubbles.push(tail)

  return { bubbles, media }
}

export interface Delivery {
  status: 'delivered' | 'failed'
  attempts: number
  httpStatus?: number
  content: string
  bubbles: string[]
  media: string[]
}

function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve()
}

function extractJsonContent(json: unknown): string {
  const data = json as { choices?: { message?: { content?: unknown } }[] }
  const content = data?.choices?.[0]?.message?.content
  return typeof content === 'string' ? content : ''
}

async function readSseContent(body: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!body) throw new Error('response body is null')
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let sawDone = false
  const parts: string[] = []

  const processLine = (rawLine: string) => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (!line.startsWith('data:')) return
    const payload = line.slice(5).trim()
    if (payload === '[DONE]') {
      sawDone = true
      return
    }
    const chunk = JSON.parse(payload) as { choices?: { delta?: { content?: unknown } }[] }
    const delta = chunk?.choices?.[0]?.delta?.content
    if (typeof delta === 'string') parts.push(delta)
  }

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newlineIndex = buffer.indexOf('\n')
      while (newlineIndex !== -1) {
        processLine(buffer.slice(0, newlineIndex))
        buffer = buffer.slice(newlineIndex + 1)
        newlineIndex = buffer.indexOf('\n')
      }
    }
    buffer += decoder.decode()
    if (buffer.length > 0) processLine(buffer)
  } finally {
    reader.releaseLock()
  }

  if (!sawDone) throw new Error('stream ended before data: [DONE]')
  return parts.join('')
}

export class FakeGateway {
  private readonly baseUrl: string
  private readonly maxAttempts: number
  private readonly retryDelayMs: number
  private readonly transcripts = new Map<string, { role: 'user' | 'assistant'; content: string }[]>()
  private readonly unanswered = new Map<string, string[]>()
  private readonly seenChats = new Set<string>()
  readonly requests: Record<string, unknown>[] = []

  constructor(options: { baseUrl: string; attempts?: number; retryDelayMs?: number }) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.maxAttempts = options.attempts ?? DEFAULT_ATTEMPTS
    this.retryDelayMs = options.retryDelayMs ?? 0
  }

  private unansweredKey(chatWaId: string, sender: string): string {
    return `${chatWaId}\0${sender}`
  }

  async send(message: GatewayMessage): Promise<Delivery> {
    const chatWaId = message.chat.waId
    const firstMessage = !this.seenChats.has(chatWaId)
    this.seenChats.add(chatWaId)

    const transcript = this.transcripts.get(chatWaId) ?? []
    const uKey = this.unansweredKey(chatWaId, message.sender)
    const pending = this.unanswered.get(uKey) ?? []

    const body = buildRequest({
      message,
      transcript,
      unanswered: pending,
      firstMessage
    })

    const messages = body['messages'] as { role: 'user' | 'assistant'; content: string }[]
    const newestUserContent = messages[messages.length - 1]!.content

    let lastHttpStatus: number | undefined

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      if (attempt > 1) await delay(this.retryDelayMs)
      this.requests.push(body)

      try {
        const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body)
        })
        lastHttpStatus = response.status

        if (response.status !== 200) {
          this.rememberUnanswered(uKey, message.text)
          return {
            status: 'failed',
            attempts: attempt,
            httpStatus: response.status,
            content: '',
            bubbles: [],
            media: []
          }
        }

        const contentType = response.headers.get('content-type') ?? ''
        const content = contentType.includes('application/json')
          ? extractJsonContent(await response.json())
          : await readSseContent(response.body)

        transcript.push({ role: 'user', content: newestUserContent })
        transcript.push({ role: 'assistant', content })
        this.transcripts.set(chatWaId, transcript)
        this.unanswered.delete(uKey)

        const { bubbles, media } = parseContent(content)
        return {
          status: 'delivered',
          attempts: attempt,
          httpStatus: 200,
          content,
          bubbles,
          media
        }
      } catch {
        // Retryable network or truncated-stream failure
      }
    }

    this.rememberUnanswered(uKey, message.text)
    return {
      status: 'failed',
      attempts: this.maxAttempts,
      ...(lastHttpStatus !== undefined ? { httpStatus: lastHttpStatus } : {}),
      content: '',
      bubbles: [],
      media: []
    }
  }

  private rememberUnanswered(key: string, text: string): void {
    const list = this.unanswered.get(key) ?? []
    list.push(text)
    this.unanswered.set(key, list)
  }

  /** A chore request such as a session title: no tools, no scope marker, not streamed. Returns the content. */
  async auxiliary(prompt: string): Promise<string> {
    const body: Record<string, unknown> = {
      model: 'aira',
      messages: [{ role: 'user', content: prompt }],
      stream: false
    }
    this.requests.push(body)

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (response.status !== 200) {
      throw new Error(`auxiliary request failed with status ${response.status}`)
    }
    return extractJsonContent(await response.json())
  }
}
