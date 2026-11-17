import { afterEach, describe, expect, it } from 'vitest'
import { tmpDir } from '../../support/tmp.js'
import { createFakeBridge, type FakeBridge } from '../bridge.js'
import type { MessagesResult, SimChat, SimInfo } from './backend.js'
import { type Level2, startLevel2 } from './level2.js'
import { type SimServer, startSimServer } from './server.js'

// Level 2: the preview injects into a fake bridge and draws the calls a gateway made to it. No gateway runs here: the
// test makes the gateway's calls itself, in the shapes the bridge records.

const open: { close(): Promise<void> }[] = []
afterEach(async () => {
  for (const item of open.splice(0).reverse()) await item.close()
})

async function startPreview(options: { ownBridge?: boolean } = {}) {
  let bridge: FakeBridge | undefined
  let level2: Level2
  if (options.ownBridge) {
    level2 = await startLevel2({ bridgePort: 0 })
  } else {
    bridge = createFakeBridge({ filesDir: tmpDir('aira-sim-bridge-files-') })
    const bridgeUrl = await bridge.start(0)
    const started = bridge
    open.push({ close: () => started.stop() })
    level2 = await startLevel2({ bridgeUrl })
  }
  open.push(level2)
  const server: SimServer = await startSimServer(level2)
  open.push(server)

  const call = async <T>(path: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const response = await fetch(`${server.url}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    })
    return { status: response.status, body: (await response.json()) as T }
  }
  const info = (await call<SimInfo>('/api/info')).body
  const group = info.chats.find((chat) => chat.kind === 'group') as SimChat
  const dm = info.chats.find((chat) => chat.kind === 'dm') as SimChat
  const poll = (chat: SimChat, after = 0) => call<MessagesResult>(`/api/chats/${chat.id}/messages?after=${after}`)
  /** What the gateway does to the bridge. */
  const gateway = (route: string, body: unknown) =>
    fetch(`${level2.bridgeUrl}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
  return { bridge, level2, server, call, info, group, dm, poll, gateway }
}

describe('level 2: the preview over a fake bridge', () => {
  it('injects a member message into the bridge, with the mention, the sender and the chat', async () => {
    const { bridge, call, group, level2 } = await startPreview()
    const sent = await call<{ message: { id: string }; addressed: boolean }>(`/api/chats/${group.id}/send`, {
      sender: 'Alice',
      text: 'hello *there*',
      mention: true
    })
    expect(sent.status).toBe(200)
    // The gateway decides whether a group message is for AIRA, so the preview never says "not addressed".
    expect(sent.body.addressed).toBe(true)

    const inbound = (await (await fetch(`${level2.bridgeUrl}/messages`)).json()) as Record<string, unknown>[]
    expect(inbound).toHaveLength(1)
    expect(inbound[0]).toMatchObject({
      id: sent.body.message.id,
      chatId: group.id,
      senderId: 'sim-member-alice',
      senderName: 'Alice',
      body: 'hello *there*',
      isGroup: true,
      mentionsBot: true
    })
    expect(bridge?.callsTo('/control/inject')).toHaveLength(1)
  })

  it('draws what the gateway sent: bubbles in order, the sticker after them, a reaction, an edit and typing', async () => {
    const { call, group, poll, gateway, level2, server } = await startPreview()
    const asked = await call<{ message: { id: string } }>(`/api/chats/${group.id}/send`, {
      sender: 'Alice',
      text: 'question',
      mention: true
    })
    const askedId = asked.body.message.id

    await gateway('/typing', { chatId: group.id })
    expect((await poll(group)).body.typing).toBe(true)

    const first = (await (
      await gateway('/send', { chatId: group.id, message: '*hello* **raw**', replyTo: askedId })
    ).json()) as {
      messageId: string
    }
    const second = (await (await gateway('/send', { chatId: group.id, message: 'second' })).json()) as {
      messageId: string
    }
    const form = new FormData()
    form.set('chatId', group.id)
    form.set('mediaType', 'sticker')
    form.set('file', new File([Buffer.from('sticker-bytes')], 'calm.webp', { type: 'image/webp' }))
    await fetch(`${level2.bridgeUrl}/send-media`, { method: 'POST', body: form })
    await gateway('/react', { chatId: group.id, messageId: askedId, emoji: '👍' })
    await gateway('/edit', { chatId: group.id, messageId: second.messageId, message: 'second, edited' })

    const drawn = (await poll(group)).body
    expect(drawn.typing).toBe(false)
    expect(drawn.messages.map((m) => m.kind)).toEqual(['member', 'aira', 'aira', 'aira'])
    const [member, one, two, sticker] = drawn.messages

    // Rendered from what the bridge received: *hello* is bold; **raw** stays as typed.
    expect(one?.id).toBe(first.messageId)
    expect(one?.html).toBe('<div class="t"><b>hello</b> **raw**</div>')
    expect(one?.quote).toMatchObject({ id: askedId, sender: 'Alice', text: 'question' })
    expect(two).toMatchObject({ text: 'second, edited', edited: true })
    expect(member?.reaction).toBe('👍')
    expect(one?.turn?.ms).toBeGreaterThanOrEqual(0)

    // The sticker comes last, and its image is read through the bridge's copy of the file.
    expect(sticker?.sticker?.name).toBe('calm.webp')
    const image = await fetch(`${server.url}${sticker?.sticker?.url}`)
    expect(image.status).toBe(200)
    expect(image.headers.get('content-type')).toBe('image/webp')
    expect(Buffer.from(await image.arrayBuffer()).toString()).toBe('sticker-bytes')

    // A page that already has revision N asks for what came after it, edits and reactions included.
    const again = (await poll(group, drawn.rev)).body
    expect(again.messages).toEqual([])
    await gateway('/edit', { chatId: group.id, messageId: first.messageId, message: 'first, edited' })
    const changed = (await poll(group, drawn.rev)).body
    expect(changed.messages.map((m) => m.text)).toEqual(['first, edited'])
  })

  it('draws a photo with its caption, and a document as a file', async () => {
    const { group, poll, level2 } = await startPreview()
    const photo = new FormData()
    photo.set('chatId', group.id)
    photo.set('caption', 'look')
    photo.set('file', new File([Buffer.from('png')], 'p.png', { type: 'image/png' }))
    await fetch(`${level2.bridgeUrl}/send-media`, { method: 'POST', body: photo })
    const doc = new FormData()
    doc.set('chatId', group.id)
    doc.set('file', new File([Buffer.from('pdf')], 'r.pdf', { type: 'application/pdf' }))
    await fetch(`${level2.bridgeUrl}/send-media`, { method: 'POST', body: doc })

    const [one, two] = (await poll(group)).body.messages
    expect(one).toMatchObject({ text: 'look', attachment: { kind: 'photo', name: 'p.png' } })
    expect(one?.attachment?.url).toMatch(/^\/file\/\d+$/)
    expect(two).toMatchObject({ attachment: { kind: 'file', name: 'r.pdf' } })
    expect(two?.attachment?.url).toBeUndefined()
  })

  it('keeps chats apart, ignores calls for a chat it does not draw, and follows a bridge that was reset', async () => {
    const { bridge, group, dm, poll, gateway, call } = await startPreview()
    await gateway('/send', { chatId: dm.id, message: 'to the dm' })
    await gateway('/send', { chatId: 'someone-elses-chat', message: 'not drawn' })
    expect((await poll(dm)).body.messages.map((m) => m.text)).toEqual(['to the dm'])
    expect((await poll(group)).body.messages).toEqual([])

    bridge?.reset()
    await gateway('/send', { chatId: group.id, message: 'after the reset' })
    expect((await poll(group)).body.messages.map((m) => m.text)).toEqual(['after the reset'])

    // Level 2 owns neither the chats nor the settings.
    expect((await call(`/api/chats/${group.id}/reset`, {})).status).toBe(404)
    expect((await call(`/api/chats/${group.id}/free-response`, { value: true })).status).toBe(404)
    expect((await call('/api/turn/any')).status).toBe(404)
  })

  it('says so when the bridge cannot be reached', async () => {
    const { bridge, group, poll, call } = await startPreview()
    await bridge?.stop()
    const result = await poll(group)
    expect(result.status).toBe(502)
    expect(JSON.stringify(result.body)).toContain('not reachable')
    const sent = await call(`/api/chats/${group.id}/send`, { sender: 'Alice', text: 'hi' })
    expect(sent.status).toBe(502)
  })

  it('starts a bridge of its own when none is given, and tells the gateway the chats', async () => {
    const { level2, info, group } = await startPreview({ ownBridge: true })
    expect(info).toMatchObject({ level: 2, canReset: false, hasRecords: false })
    expect(level2.bridgeUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(await (await fetch(`${level2.bridgeUrl}/health`)).json()).toEqual({ status: 'connected' })
    const known = (await (await fetch(`${level2.bridgeUrl}/chat/${group.id}`)).json()) as { isGroup: boolean }
    expect(known.isGroup).toBe(true)
  })
})
