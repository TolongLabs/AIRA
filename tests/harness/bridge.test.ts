import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { tmpDir } from '../support/tmp.js'
import { checkStep, injectScenario, sentMessages } from './bridge-scenario.js'
import { type FakeBridge, type FakeBridgeOptions, createFakeBridge } from './bridge.js'
import { loadScenario } from './scenario.js'

const activeBridges: FakeBridge[] = []

afterEach(async () => {
  await Promise.all(activeBridges.splice(0).map((bridge) => bridge.stop()))
})

async function startBridge(options: Partial<FakeBridgeOptions> = {}): Promise<{ bridge: FakeBridge; baseUrl: string }> {
  const bridge = createFakeBridge({
    filesDir: options.filesDir ?? tmpDir(),
    ...(options.chats ? { chats: options.chats } : {}),
    ...(options.now ? { now: options.now } : {})
  })
  activeBridges.push(bridge)
  const baseUrl = await bridge.start(0)
  return { bridge, baseUrl }
}

describe('FakeBridge', () => {
  it('listens on 127.0.0.1 and answers all standard routes', async () => {
    const chats = [
      {
        id: 'test-chat-group',
        name: 'Weekend Crew',
        isGroup: true,
        members: [
          { id: 'test-member-alice', name: 'Alice' },
          { id: 'test-member-bob', name: 'Bob' }
        ]
      },
      {
        id: 'test-chat-dm',
        name: 'Alice',
        isGroup: false,
        members: [{ id: 'test-member-alice', name: 'Alice' }]
      }
    ]
    const { bridge, baseUrl } = await startBridge({ chats })
    expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

    const health = await fetch(`${baseUrl}/health`)
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ status: 'connected' })

    const send = await fetch(`${baseUrl}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: 'test-chat-group', message: 'hello' })
    })
    expect(send.status).toBe(200)
    expect(await send.json()).toEqual({ success: true, messageId: 'out-1' })

    const edit = await fetch(`${baseUrl}/edit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageId: 'out-1', message: 'hello!' })
    })
    expect(edit.status).toBe(200)
    expect(await edit.json()).toEqual({ success: true })

    for (const route of ['/react', '/typing', '/read']) {
      const res = await fetch(`${baseUrl}${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId: 'test-chat-group' })
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ success: true })
    }

    const foundChat = await fetch(`${baseUrl}/chat/test-chat-group`)
    expect(foundChat.status).toBe(200)
    expect(await foundChat.json()).toEqual({
      id: 'test-chat-group',
      name: 'Weekend Crew',
      isGroup: true,
      participants: chats[0]!.members
    })

    const missingChat = await fetch(`${baseUrl}/chat/no-such-chat`)
    expect(missingChat.status).toBe(404)

    const groups = await fetch(`${baseUrl}/groups`)
    expect(groups.status).toBe(200)
    expect(await groups.json()).toEqual([chats[0]])

    const presence = await fetch(`${baseUrl}/presence`)
    expect(presence.status).toBe(200)
    expect(await presence.json()).toEqual({ presence: 'available' })

    const lid = await fetch(`${baseUrl}/resolve-lid`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lid: 'test-lid-one' })
    })
    expect(lid.status).toBe(200)
    expect(await lid.json()).toEqual({ id: 'test-lid-one' })

    expect(bridge.calls().map((c) => c.route)).toEqual([
      '/health',
      '/send',
      '/edit',
      '/react',
      '/typing',
      '/read',
      '/chat/test-chat-group',
      '/chat/no-such-chat',
      '/groups',
      '/presence',
      '/resolve-lid'
    ])
    expect(bridge.calls().map((c) => c.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    expect(bridge.callsTo('/send')).toHaveLength(1)
  })

  it('delivers injected plain, quoted, mention, and media messages once at GET /messages', async () => {
    const fixedNow = new Date('2026-11-16T09:00:00.000Z')
    const { bridge, baseUrl } = await startBridge({ now: () => fixedNow })

    const id1 = bridge.inject({
      chat: 'test-chat-one',
      sender: 'test-member-alice',
      senderName: 'Alice',
      text: 'plain hello',
      isGroup: false
    })
    const id2 = bridge.inject({
      chat: 'test-chat-one',
      sender: 'test-member-bob',
      text: 'replying to you',
      isGroup: true,
      quoted: { id: 'sim-1', text: 'plain hello', fromMe: false }
    })
    const id3 = bridge.inject({
      chat: 'test-chat-one',
      sender: 'test-member-alice',
      text: '@aira check this',
      isGroup: true,
      mentionsBot: true
    })
    const id4 = bridge.inject({
      chat: 'test-chat-one',
      sender: 'test-member-bob',
      text: 'see photo',
      isGroup: false,
      media: { path: '/tmp/photo.png', contentType: 'image/png' }
    })

    expect([id1, id2, id3, id4]).toEqual(['sim-1', 'sim-2', 'sim-3', 'sim-4'])

    const firstPoll = await fetch(`${baseUrl}/messages`)
    expect(firstPoll.status).toBe(200)
    expect(await firstPoll.json()).toEqual([
      {
        id: 'sim-1',
        chatId: 'test-chat-one',
        senderId: 'test-member-alice',
        senderName: 'Alice',
        body: 'plain hello',
        isGroup: false,
        timestamp: 1794819600,
        fromMe: false
      },
      {
        id: 'sim-2',
        chatId: 'test-chat-one',
        senderId: 'test-member-bob',
        body: 'replying to you',
        isGroup: true,
        timestamp: 1794819600,
        fromMe: false,
        quotedMessage: { id: 'sim-1', body: 'plain hello', fromMe: false }
      },
      {
        id: 'sim-3',
        chatId: 'test-chat-one',
        senderId: 'test-member-alice',
        body: '@aira check this',
        isGroup: true,
        timestamp: 1794819600,
        fromMe: false,
        mentionsBot: true
      },
      {
        id: 'sim-4',
        chatId: 'test-chat-one',
        senderId: 'test-member-bob',
        body: 'see photo',
        isGroup: false,
        timestamp: 1794819600,
        fromMe: false,
        media: { path: '/tmp/photo.png', mimetype: 'image/png' }
      }
    ])

    const secondPoll = await fetch(`${baseUrl}/messages`)
    expect(secondPoll.status).toBe(200)
    expect(await secondPoll.json()).toEqual([])
  })

  it('injects messages via POST /control/inject', async () => {
    const { baseUrl } = await startBridge()

    const injectRes = await fetch(`${baseUrl}/control/inject`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat: 'test-chat-one',
        sender: 'test-member-alice',
        text: 'via control route',
        isGroup: false
      })
    })
    expect(injectRes.status).toBe(200)
    expect(await injectRes.json()).toEqual({ id: 'sim-1' })

    const messagesRes = await fetch(`${baseUrl}/messages`)
    const messages = (await messagesRes.json()) as { id: string; body: string }[]
    expect(messages).toHaveLength(1)
    expect(messages[0]?.id).toBe('sim-1')
    expect(messages[0]?.body).toBe('via control route')
  })

  it('copies sent media into filesDir for both JSON filePath and multipart uploads', async () => {
    const filesDir = tmpDir()
    const sourceDir = tmpDir()
    const sourcePath = join(sourceDir, 'sticker.webp')
    const sourceBytes = Buffer.from('RIFF-fake-webp-bytes')
    writeFileSync(sourcePath, sourceBytes)

    const { bridge, baseUrl } = await startBridge({ filesDir })

    const jsonRes = await fetch(`${baseUrl}/send-media`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chatId: 'test-chat-one',
        filePath: sourcePath,
        caption: 'from json'
      })
    })
    expect(jsonRes.status).toBe(200)
    expect(await jsonRes.json()).toEqual({ success: true, messageId: 'out-1' })

    const form = new FormData()
    form.set('chatId', 'test-chat-one')
    form.set('caption', 'from multipart')
    form.set('file', new File([Buffer.from('png-bytes-here')], 'photo.png', { type: 'image/png' }))

    const multipartRes = await fetch(`${baseUrl}/send-media`, {
      method: 'POST',
      body: form
    })
    expect(multipartRes.status).toBe(200)
    expect(await multipartRes.json()).toEqual({ success: true, messageId: 'out-2' })

    const mediaCalls = bridge.callsTo('/send-media')
    expect(mediaCalls).toHaveLength(2)

    const firstFile = mediaCalls[0]!.file!
    expect(firstFile.name).toBe('sticker.webp')
    expect(firstFile.contentType).toBe('image/webp')
    expect(firstFile.bytes).toBe(sourceBytes.byteLength)
    expect(firstFile.path.startsWith(filesDir)).toBe(true)
    expect(readFileSync(firstFile.path)).toEqual(sourceBytes)

    const secondFile = mediaCalls[1]!.file!
    expect(secondFile.name).toBe('photo.png')
    expect(secondFile.contentType).toBe('image/png')
    expect(secondFile.bytes).toBe(14)
    expect(secondFile.path.startsWith(filesDir)).toBe(true)
    expect(readFileSync(secondFile.path).toString('utf8')).toBe('png-bytes-here')
  })

  it('records unknown routes with 404 and invalid JSON bodies with 400', async () => {
    const { bridge, baseUrl } = await startBridge()

    const unknownRes = await fetch(`${baseUrl}/does-not-exist?foo=1`)
    expect(unknownRes.status).toBe(404)
    expect(await unknownRes.json()).toEqual({ error: 'no such route' })

    const badJsonRes = await fetch(`${baseUrl}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not-valid-json'
    })
    expect(badJsonRes.status).toBe(400)

    const calls = bridge.calls()
    expect(calls).toHaveLength(2)
    expect(calls[0]?.route).toBe('/does-not-exist')
    expect(calls[1]?.route).toBe('/send')
    expect(calls[1]?.payload).toBe('{not-valid-json')
  })

  it('forgets recorded calls and queued messages on reset()', async () => {
    const { bridge, baseUrl } = await startBridge()
    bridge.inject({
      chat: 'test-chat-one',
      sender: 'test-member-alice',
      text: 'before reset',
      isGroup: false
    })
    await fetch(`${baseUrl}/health`)
    expect(bridge.calls()).toHaveLength(1)

    bridge.reset()
    expect(bridge.calls()).toEqual([])

    const res = await fetch(`${baseUrl}/messages`)
    expect(await res.json()).toEqual([])
  })
})

describe('bridge scenario support', () => {
  it('injects the example scenario with invented ids and no real-looking ids', async () => {
    const { bridge, baseUrl } = await startBridge()
    const scenario = loadScenario(join(process.cwd(), 'tests/harness/scenarios/example.yml'))
    const ids = injectScenario(bridge, scenario)
    expect(ids).toEqual(['sim-1', 'sim-2', 'sim-3'])

    const res = await fetch(`${baseUrl}/messages`)
    const queued = (await res.json()) as {
      id: string
      chatId: string
      senderId: string
      body: string
      isGroup: boolean
    }[]
    expect(queued).toHaveLength(3)
    expect(queued[0]?.chatId).toBe('test-chat-example-group')
    expect(queued[0]?.senderId).toBe('test-member-alice')
    expect(queued[0]?.isGroup).toBe(true)
    expect(queued[1]?.senderId).toBe('test-member-bob')

    for (const item of queued) {
      expect(item.chatId).not.toMatch(/\d{5,}/)
      expect(item.chatId).not.toContain('@')
      expect(item.senderId).not.toMatch(/\d{5,}/)
      expect(item.senderId).not.toContain('@')
    }
  })

  it('extracts sentMessages from /send and /send-media calls', async () => {
    const mediaDir = tmpDir()
    const stickerPath = join(mediaDir, 'wave.webp')
    writeFileSync(stickerPath, Buffer.from('webp'))

    const { bridge, baseUrl } = await startBridge()

    await fetch(`${baseUrl}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: 'test-chat-one', message: 'first bubble', replyTo: 'sim-1' })
    })
    await fetch(`${baseUrl}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: 'test-chat-one', text: 'second bubble' })
    })
    await fetch(`${baseUrl}/send-media`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: 'test-chat-one', filePath: stickerPath, caption: '' })
    })

    const sent = sentMessages(bridge)
    expect(sent).toHaveLength(3)
    expect(sent[0]).toEqual({ seq: 1, chat: 'test-chat-one', text: 'first bubble', kind: 'text', quoted: 'sim-1' })
    expect(sent[1]).toEqual({ seq: 2, chat: 'test-chat-one', text: 'second bubble', kind: 'text' })
    expect(sent[2]?.kind).toBe('media')
    expect(sent[2]?.file?.contentType).toBe('image/webp')
  })

  it('checks maxChars, bubbles, and sticker expectations in checkStep', () => {
    const textOnly = [
      { seq: 1, chat: 'test-chat-one', text: 'hello', kind: 'text' as const },
      { seq: 2, chat: 'test-chat-one', text: 'world', kind: 'text' as const }
    ]
    const withSticker = [
      ...textOnly,
      {
        seq: 3,
        chat: 'test-chat-one',
        text: '',
        kind: 'media' as const,
        file: { name: 'wave.webp', contentType: 'image/webp', bytes: 4, path: '/tmp/wave.webp' }
      }
    ]
    const stickerBeforeText = [withSticker[2]!, textOnly[0]!]

    expect(checkStep(textOnly, { maxChars: 10, bubbles: 2, sticker: false })).toEqual([])
    expect(checkStep(withSticker, { maxChars: 10, bubbles: 2, sticker: true })).toEqual([])

    expect(checkStep(textOnly, { maxChars: 9 })).toHaveLength(1)
    expect(checkStep(textOnly, { bubbles: 1 })).toHaveLength(1)
    expect(checkStep(textOnly, { sticker: true })).toHaveLength(1)
    expect(checkStep(stickerBeforeText, { sticker: true })).toHaveLength(1)
    expect(checkStep(withSticker, { sticker: false })).toHaveLength(1)
  })
})
