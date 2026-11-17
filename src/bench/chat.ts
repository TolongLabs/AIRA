import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type App, createApp } from '../app.js'
import type { Config } from '../config/schema.js'
import type { ModelClient } from '../models/types.js'
import { ensureChat, setChatStatus } from '../settings/chats.js'
import { setSetting } from '../settings/settings.js'

// Gateway request helpers copied from tests/harness/gateway.ts so src/ never imports tests/.

export interface BenchGatewayMessage {
  chat: { waId: string; kind: 'dm' | 'group' }
  sender: string
  mid: string
  text: string
}

export function buildBenchRequest(input: {
  message: BenchGatewayMessage
  transcript: { role: 'user' | 'assistant'; content: string }[]
  firstMessage: boolean
}): { body: Record<string, unknown>; newestUserContent: string } {
  const { message, transcript, firstMessage } = input
  const scopeMarker = `[HERMES-SCOPE v1 platform=whatsapp kind=${message.chat.kind} chat=${message.chat.waId} sender=${message.sender} mid=${message.mid}]`
  const firstNote = firstMessage ? '\n\n[System note: this is the first message of the conversation.]' : ''
  const newestUserContent = `${scopeMarker}\n${message.text}${firstNote}`

  return {
    newestUserContent,
    body: {
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

export async function sendBenchRequest(
  baseUrl: string,
  body: Record<string, unknown>
): Promise<{ status: number; content: string }> {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (response.status !== 200) return { status: response.status, content: '' }
  const contentType = response.headers.get('content-type') ?? ''
  const content = contentType.includes('application/json')
    ? extractJsonContent(await response.json())
    : await readSseContent(response.body)
  return { status: response.status, content }
}

// Chat session against the real core service.

export interface ChatSession {
  /** Sends one message as one invented member of one invented chat, and returns what came back. */
  send(text: string): Promise<{
    content: string
    ms: number
    turn: Record<string, unknown> | undefined
    toolCalls: number
    /** The names of the tools the turn called, in call order. */
    tools: string[]
  }>
  close(): Promise<void>
}

type TurnRow = Record<string, unknown>

function readNewestTurn(app: App): { turn: TurnRow | undefined; toolCalls: number; tools: string[] } {
  return app.storage.read((db) => {
    const sql = 'SELECT * FROM turn ORDER BY received_at DESC, rowid DESC LIMIT 1'
    const turn = db.prepare(sql).get() as TurnRow | undefined
    if (!turn || typeof turn['turn_id'] !== 'string') {
      return { turn: undefined, toolCalls: 0, tools: [] }
    }
    const rows = db.prepare('SELECT tool FROM tool_call WHERE turn_id = ? ORDER BY id').all(turn['turn_id']) as {
      tool: string
    }[]
    return { turn, toolCalls: rows.length, tools: rows.map((row) => row.tool) }
  })
}

export async function openChatSession(options: {
  config: Config
  env: NodeJS.ProcessEnv
  /** Model clients to use instead of the configured endpoints. Tests pass a scripted model here. */
  clients?: { main?: ModelClient; fallback?: ModelClient }
  /** The data folder. A scratch folder when absent; it is removed on close. */
  dataDir?: string
  chat?: { waId: string; kind: 'dm' | 'group' }
  character?: string
}): Promise<ChatSession> {
  const scratch = options.dataDir === undefined
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'aira-bench-'))
  const config: Config = {
    ...options.config,
    storage: { ...options.config.storage, path: dataDir }
  }

  let app: App
  try {
    app = await createApp({ config, env: options.env, clients: options.clients })
  } catch (error) {
    if (scratch) rmSync(dataDir, { recursive: true, force: true })
    throw error
  }

  try {
    const address = (await app.listen(0, '127.0.0.1')) as AddressInfo
    const baseUrl = `http://127.0.0.1:${address.port}`
    const chatTarget = options.chat ?? { waId: 'bench-chat-1', kind: 'dm' }
    const sender = 'bench-member-1'

    setSetting(app.storage, {
      level: 'global',
      scope: '',
      key: 'character',
      value: options.character ?? 'example',
      actor: 'bench'
    })
    const chat = ensureChat(app.storage, { waId: chatTarget.waId, type: chatTarget.kind })
    setChatStatus(app.storage, { chatId: chat.chatId, status: 'active', actor: 'bench' })

    const transcript: { role: 'user' | 'assistant'; content: string }[] = []
    let firstMessage = true
    let seq = 0
    // A message id is stored once per chat. A run id keeps two sessions on one data folder from repeating one.
    const run = Date.now().toString(36)
    let lastTurnId: unknown

    return {
      async send(text: string) {
        seq += 1
        const mid = `bench-${run}-${seq}`
        const { body, newestUserContent } = buildBenchRequest({
          message: { chat: chatTarget, sender, mid, text },
          transcript,
          firstMessage
        })
        firstMessage = false

        const start = performance.now()
        let content = ''
        try {
          const reply = await sendBenchRequest(baseUrl, body)
          content = reply.content
          if (reply.status === 200) {
            transcript.push({ role: 'user', content: newestUserContent })
            transcript.push({ role: 'assistant', content })
          }
        } catch {
          content = ''
        }
        const ms = Math.round(performance.now() - start)
        const newest = readNewestTurn(app)
        // A request that opened no turn must not be reported with the numbers of the turn before it.
        if (newest.turn?.['turn_id'] === lastTurnId) return { content, ms, turn: undefined, toolCalls: 0, tools: [] }
        lastTurnId = newest.turn?.['turn_id']
        return { content, ms, turn: newest.turn, toolCalls: newest.toolCalls, tools: newest.tools }
      },
      async close() {
        try {
          await app.close()
        } finally {
          if (scratch) rmSync(dataDir, { recursive: true, force: true })
        }
      }
    }
  } catch (error) {
    try {
      await app.close()
    } finally {
      if (scratch) rmSync(dataDir, { recursive: true, force: true })
    }
    throw error
  }
}
