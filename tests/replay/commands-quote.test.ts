import { describe, expect, it } from 'vitest'
import type { App } from '../../src/app.js'
import { ensureChat, setChatStatus } from '../../src/settings/chats.js'
import type { GatewayMessage } from '../harness/gateway.js'
import { lastTurn, queueModel, startApp } from '../support/app.js'

// Skill commands in a reply that quotes another message (docs/trd/tools.md, docs/trd/system.md#gateway-contract).

const GROUP = '12345678901@g.us'
const SENDER = '1234567890@s.whatsapp.net'

const rows = <T>(app: App, sql: string, ...args: unknown[]) =>
  app.storage.read((db) => db.prepare(sql).all(...args) as T[])
const names = (request: { tools: { name: string }[] } | undefined) => request?.tools.map((tool) => tool.name) ?? []
const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString()

const groupReply = (mid: string, text: string, quote: NonNullable<GatewayMessage['quote']>): GatewayMessage => ({
  chat: { waId: GROUP, kind: 'group' },
  sender: SENDER,
  mid,
  text,
  quote
})

function activateGroup(app: App): void {
  const chat = ensureChat(app.storage, { waId: GROUP, type: 'group' })
  setChatStatus(app.storage, { chatId: chat.chatId, status: 'active', actor: 'test' })
}

describe('skill commands in quoted replies', () => {
  it('a skill command in a reply sees the quoted message as a labelled block', async () => {
    const dueAt = inAnHour()
    const model = queueModel([
      { toolCalls: [{ id: 'c1', name: 'reminder_set', args: { text: 'the earlier text', dueAt } }] },
      { text: 'Okay, I will remind you about that.' }
    ])
    const { app, gateway } = await startApp(model)
    activateGroup(app)

    const delivery = await gateway.send(
      groupReply('m-1', 'please /remind me about this in an hour', { text: 'the earlier text', id: 'q-1' })
    )

    const gatewayMessages = gateway.requests[0]?.['messages'] as { role: string; content: string }[]
    expect(gatewayMessages.at(-1)?.content ?? '').toMatch(/\[Replying to: "the earlier text"\][\s\S]*\[HERMES-SCOPE /)

    const userInput = model.requests[0]?.messages.filter((m) => m.role === 'user').at(-1)?.content ?? ''
    expect(userInput).toContain('<quoted from="member" untrusted="true">the earlier text</quoted>')
    expect(userInput).toContain('please /remind me about this in an hour')
    expect(names(model.requests[0])).toEqual(['reminder_set'])
    expect(names(model.requests[1]).length).toBeGreaterThan(1)
    expect(delivery.status).toBe('delivered')
    expect(delivery.content).toBe('Okay, I will remind you about that.\n\n_🛠️ set a reminder_')
    expect(lastTurn(app)).toMatchObject({ kind: 'command', state: 'delivered', outcome: 'delivered', attempts: 2 })
    expect(rows(app, 'SELECT state, text FROM reminder')).toEqual([{ state: 'active', text: 'the earlier text' }])
  })

  it("a quote of AIRA's own message is labelled from aira", async () => {
    const dueAt = inAnHour()
    const model = queueModel([
      { toolCalls: [{ id: 'c1', name: 'reminder_set', args: { text: 'follow up on the earlier reply', dueAt } }] },
      { text: 'Got it, I will remind you later.' }
    ])
    const { app, gateway } = await startApp(model)
    activateGroup(app)

    const delivery = await gateway.send(
      groupReply('m-1', 'please /remind me about that later', {
        text: 'the earlier reply',
        id: 'q-2',
        ofAira: true
      })
    )

    const gatewayMessages = gateway.requests[0]?.['messages'] as { role: string; content: string }[]
    expect(gatewayMessages.at(-1)?.content ?? '').toMatch(
      /\[Replying to your previous message: "the earlier reply"\][\s\S]*\[HERMES-SCOPE /
    )

    const userInput = model.requests[0]?.messages.filter((m) => m.role === 'user').at(-1)?.content ?? ''
    expect(userInput).toContain('<quoted from="aira" untrusted="true">the earlier reply</quoted>')
    expect(userInput).toContain('please /remind me about that later')
    expect(names(model.requests[0])).toEqual(['reminder_set'])
    expect(names(model.requests[1]).length).toBeGreaterThan(1)
    expect(delivery.status).toBe('delivered')
    expect(delivery.content).toBe('Got it, I will remind you later.\n\n_🛠️ set a reminder_')
    expect(lastTurn(app)).toMatchObject({ kind: 'command', state: 'delivered', outcome: 'delivered', attempts: 2 })
    expect(rows(app, 'SELECT state, text FROM reminder')).toEqual([
      { state: 'active', text: 'follow up on the earlier reply' }
    ])
  })
})
