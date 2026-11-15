import type { FakeBridge, RecordedCall } from './bridge.js'
import { type Scenario, scenarioIds } from './scenario.js'

export interface SentMessage {
  seq: number
  chat: string
  text: string
  kind: 'text' | 'media'
  quoted?: string
  file?: RecordedCall['file']
}

export interface BridgeExpectation {
  maxChars?: number
  bubbles?: number
  sticker?: boolean
}

/** Injects every step of a scenario into the bridge as an inbound message, in order. Returns the message ids. */
export function injectScenario(bridge: FakeBridge, scenario: Scenario): string[] {
  const ids = scenarioIds(scenario)
  const isGroup = scenario.chat.type === 'group'
  return scenario.steps.map((step) =>
    bridge.inject({
      chat: ids.chatWaId,
      sender: ids.members[step.from]!,
      senderName: step.from,
      text: step.text,
      isGroup,
      mentionsBot: step.text.toLowerCase().includes('@aira')
    })
  )
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function stringField(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string') return value
  }
  return ''
}

/** The messages the gateway sent, in order, read from the recorded `/send` and `/send-media` calls. */
export function sentMessages(bridge: FakeBridge): SentMessage[] {
  const out: SentMessage[] = []
  for (const call of bridge.calls()) {
    if (call.method !== 'POST') continue
    if (call.route !== '/send' && call.route !== '/send-media') continue
    const body = asRecord(call.payload)
    const chat = stringField(body, 'chatId', 'chat')
    const quoted = typeof body['replyTo'] === 'string' ? body['replyTo'] : undefined

    if (call.route === '/send') {
      out.push({
        seq: call.seq,
        chat,
        text: stringField(body, 'message', 'text'),
        kind: 'text',
        ...(quoted !== undefined ? { quoted } : {})
      })
    } else {
      out.push({
        seq: call.seq,
        chat,
        text: stringField(body, 'caption'),
        kind: 'media',
        ...(quoted !== undefined ? { quoted } : {}),
        ...(call.file !== undefined ? { file: call.file } : {})
      })
    }
  }
  return out
}

/** Checks what was sent after one inbound step against that step's expectations. Returns the faults, or an empty list. */
export function checkStep(sent: SentMessage[], expect: BridgeExpectation): string[] {
  const faults: string[] = []
  const textMessages = sent.filter((m) => m.kind === 'text')

  if (expect.maxChars !== undefined) {
    const totalChars = textMessages.reduce((sum, m) => sum + m.text.length, 0)
    if (totalChars > expect.maxChars) {
      faults.push(`expected at most ${expect.maxChars} chars, got ${totalChars}`)
    }
  }

  if (expect.bubbles !== undefined && textMessages.length !== expect.bubbles) {
    faults.push(`expected ${expect.bubbles} bubbles, got ${textMessages.length}`)
  }

  if (expect.sticker !== undefined) {
    const lastTextIndex = sent.findLastIndex((m) => m.kind === 'text')
    const tail = lastTextIndex === -1 ? sent : sent.slice(lastTextIndex + 1)
    const hasStickerAfterText = tail.some((m) => m.kind === 'media' && m.file?.contentType === 'image/webp')
    const hasAnySticker = sent.some((m) => m.kind === 'media' && m.file?.contentType === 'image/webp')

    if (expect.sticker && !hasStickerAfterText) {
      faults.push('expected a sticker (image/webp) after the last text message')
    } else if (!expect.sticker && hasAnySticker) {
      faults.push('expected no sticker, but found one')
    }
  }

  return faults
}
