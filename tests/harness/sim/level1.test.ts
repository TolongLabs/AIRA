import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { type ModelClient, ModelError } from '../../../src/models/types.js'
import { createLogger } from '../../../src/records/logger.js'
import { getChatByWaId } from '../../../src/settings/chats.js'
import { setSetting } from '../../../src/settings/settings.js'
import { addPack, testConfig } from '../../support/core.js'
import { fakeModel, textResponse } from '../../support/fake-model.js'
import { tmpDir } from '../../support/tmp.js'
import type { MessagesResult, SimChat, SimInfo, TurnPanel } from './backend.js'
import { type Level1, startLevel1 } from './level1.js'
import type { PreviewMessage } from './model.js'
import { type SimServer, startSimServer } from './server.js'

// Level 1 end to end: the preview's HTTP API over a core in this process, with a scripted model and no network.

const running: { level1: Level1; server: SimServer }[] = []
afterEach(async () => {
  for (const { level1, server } of running.splice(0)) {
    await server.close()
    await level1.close()
  }
})

/** A pack named `second` with one sticker for every mood. */
function packWithSticker(dataDir: string): void {
  addPack(dataDir, 'second')
  const dir = join(dataDir, 'characters', 'second')
  mkdirSync(join(dir, 'stickers'))
  const sticker = Buffer.alloc(30)
  sticker.write('RIFF', 0, 'ascii')
  sticker.writeUInt32LE(22, 4)
  sticker.write('WEBPVP8X', 8, 'ascii')
  sticker.writeUIntLE(511, 24, 3)
  sticker.writeUIntLE(511, 27, 3)
  writeFileSync(join(dir, 'stickers', 'calm.webp'), sticker)
  const moods = join(dir, 'moods.yml')
  writeFileSync(moods, readFileSync(moods, 'utf8').replaceAll('    stickers: []', '    stickers:\n      - calm.webp'))
}

async function startSim(model: ModelClient, turnDeadlineMs?: number) {
  const dataDir = tmpDir('aira-sim-e2e-')
  packWithSticker(dataDir)
  const config = testConfig((c) => {
    if (turnDeadlineMs !== undefined) c.llm.turnDeadlineMs = turnDeadlineMs
    c.storage.minFreeMb = 2
    c.storage.criticalFreeMb = 1
  })
  const level1 = await startLevel1({
    config,
    env: {},
    clients: { main: model },
    dataDir,
    character: 'second',
    pace: false,
    logger: createLogger({ level: 'error', module: 'core', sink: () => {} })
  })
  const server = await startSimServer(level1)
  running.push({ level1, server })

  const call = async <T>(path: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const response = await fetch(`${server.url}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    })
    return { status: response.status, body: (await response.json()) as T }
  }
  const info = (await call<SimInfo>('/api/info')).body
  const dm = info.chats.find((chat) => chat.kind === 'dm') as SimChat
  const group = info.chats.find((chat) => chat.kind === 'group') as SimChat
  const send = (chat: SimChat, body: Record<string, unknown>) =>
    call<{ message: PreviewMessage; addressed: boolean } & MessagesResult>(`/api/chats/${chat.id}/send`, {
      wait: true,
      ...body
    })
  return { level1, server, call, info, dm, group, send, dataDir }
}

describe('level 1: a message through the preview API to the core and back', () => {
  it('draws the reply with WhatsApp markup, in send order, and the sticker after the text', async () => {
    const model = fakeModel([textResponse('**Hello** from the _core_\n\n- one\n- two')])
    const { dm, send, server, info } = await startSim(model)
    expect(info).toMatchObject({ level: 1, character: 'second', canReset: true, hasRecords: true })

    const result = await send(dm, { sender: 'Alex', text: 'hi there' })
    expect(result.status).toBe(200)
    expect(result.body.addressed).toBe(true)

    const [asked, text, sticker] = result.body.messages
    expect(asked).toMatchObject({ kind: 'member', sender: 'Alex', text: 'hi there' })
    expect(text?.kind).toBe('aira')
    // The core writes **Hello**; the gateway turns it into *Hello*; the preview draws it bold.
    expect(text?.html).toContain('<b>Hello</b> from the <i>core</i>')
    expect(text?.html).toContain('<ul><li>one</li><li>two</li></ul>')
    // Only the first bubble quotes the member's message.
    expect(text?.quote).toMatchObject({ sender: 'Alex', text: 'hi there' })
    expect(sticker?.sticker).toEqual({ url: '/sticker/second/calm.webp', name: 'calm.webp' })
    expect(sticker?.seq).toBeGreaterThan(text?.seq ?? Infinity)
    expect(result.body.messages.map((m) => m.seq)).toEqual([1, 2, 3])
    expect(result.body.typing).toBe(false)

    const image = await fetch(`${server.url}${sticker?.sticker?.url}`)
    expect(image.status).toBe(200)
    expect(image.headers.get('content-type')).toBe('image/webp')

    expect(model.requests).toHaveLength(1)
  })

  it('labels each AIRA message with its turn and latency, and opens the turn record', async () => {
    const { dm, send, call } = await startSim(fakeModel([textResponse('Sure.')]))
    const { body } = await send(dm, { sender: 'Alex', text: 'ok?' })
    const reply = body.messages.find((m) => m.kind === 'aira')
    expect(reply?.turn?.id).toMatch(/\S/)
    expect(reply?.turn?.ms).toBeGreaterThanOrEqual(0)
    expect(reply?.turn?.faults).toEqual([])

    const record = await call<TurnPanel>(`/api/turn/${reply?.turn?.id}`)
    expect(record.status).toBe(200)
    expect(record.body.summary).toMatchObject({ state: 'delivered', character: 'second', sticker: 'calm.webp' })
    expect(record.body.stages.map((s) => s.stage)).toContain('model_done')
    expect(record.body.modelCalls).toHaveLength(1)
    expect(record.body.text).toContain(`turn ${reply?.turn?.id}`)
    expect((await call('/api/turn/no-such-turn')).status).toBe(404)
  })

  it('shows the typing indicator while the turn runs, and lets a page ask for what changed', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const slow: ModelClient = {
      async call(request) {
        await gate
        return { ...textResponse('Late but here.'), model: request.model }
      }
    }
    const { dm, call } = await startSim(slow)

    const sent = await call<{ message: PreviewMessage }>(`/api/chats/${dm.id}/send`, { sender: 'Alex', text: 'hello' })
    expect(sent.status).toBe(200)
    const during = (await call<MessagesResult>(`/api/chats/${dm.id}/messages?after=0`)).body
    expect(during.typing).toBe(true)
    expect(during.messages.map((m) => m.kind)).toEqual(['member'])

    release()
    let after: MessagesResult
    do {
      await new Promise((resolve) => setTimeout(resolve, 20))
      after = (await call<MessagesResult>(`/api/chats/${dm.id}/messages?after=${during.rev}`)).body
    } while (after.typing || after.messages.length === 0)
    expect(after.messages.map((m) => m.kind)).toEqual(['aira', 'aira'])
    expect(after.messages[0]?.text).toBe('Late but here.')
  })

  it('does not forward a group message that neither mentions nor replies, and answers one that does', async () => {
    const model = fakeModel([textResponse('Here.'), textResponse('Again.'), textResponse('Free.')])
    const { group, send, call } = await startSim(model)

    const quiet = await send(group, { sender: 'Bob', text: 'anyone around?', mention: false })
    expect(quiet.body.addressed).toBe(false)
    expect(quiet.body.messages.map((m) => m.kind)).toEqual(['member', 'note'])
    expect(quiet.body.messages[1]?.note?.tone).toBe('info')
    expect(model.requests).toHaveLength(0)

    const mention = await send(group, { sender: 'Bob', text: 'hey', mention: true })
    expect(mention.body.addressed).toBe(true)
    expect(mention.body.messages[0]).toMatchObject({ mention: true })
    const aira = mention.body.messages.find((m) => m.kind === 'aira' && m.html !== '')
    expect(aira?.html).toContain('Here.')

    // A reply to one of AIRA's messages is addressed to her without a mention.
    const reply = await send(group, { sender: 'Carol', text: 'and you?', mention: false, replyTo: aira?.id })
    expect(reply.body.addressed).toBe(true)
    expect(reply.body.messages[0]?.quote).toMatchObject({ sender: 'AIRA', text: 'Here.' })

    // Free response answers any message.
    expect((await call(`/api/chats/${group.id}/free-response`, { value: true })).status).toBe(200)
    const free = await send(group, { sender: 'Alice', text: 'no mention', mention: false })
    expect(free.body.addressed).toBe(true)
    const refreshed = (await call<SimInfo>('/api/info')).body.chats.find((c) => c.id === group.id)
    expect(refreshed?.freeResponse).toBe(true)
  })

  it('draws NO_REPLY as a grey note, and a failed turn as a red note with its reason code', async () => {
    const refusing: ModelClient = {
      async call() {
        throw new ModelError('malformed', 'the scripted model refuses')
      }
    }
    const { dm, send, level1 } = await startSim(refusing, 1_000)

    const failed = await send(dm, { sender: 'Alex', text: 'will this fail?' })
    const notes = failed.body.messages.filter((m) => m.kind === 'note')
    expect(notes.map((m) => m.note?.tone)).toEqual(['error'])
    expect(notes[0]?.note?.text).toContain('malformed')
    const line = failed.body.messages.find((m) => m.kind === 'aira' && m.html !== '')
    expect(line?.turn?.faults).toEqual(['malformed'])

    // A sender the chat does not allow gets NO_REPLY from the core: the gateway sends nothing, and the preview says so.
    const chat = getChatByWaId(level1.app.storage, dm.id)
    setSetting(level1.app.storage, {
      level: 'chat',
      scope: chat?.chatId ?? '',
      key: 'allowedSenders',
      value: ['sim-member-somebody-else'],
      actor: 'test'
    })
    const declined = await send(dm, { sender: 'Alex', text: 'are you there?' })
    expect(declined.body.messages.map((m) => m.kind)).toEqual(['member', 'note'])
    expect(declined.body.messages[1]?.note).toMatchObject({ tone: 'info' })
    expect(declined.body.messages[1]?.note?.text).toMatch(/^No reply sent/)
  })

  it('starts a chat again under a fresh id, with nothing in it', async () => {
    const { dm, send, call, info } = await startSim(fakeModel([textResponse('One.'), textResponse('Two.')]))
    await send(dm, { sender: 'Alex', text: 'first' })

    const reset = await call<{ chat: SimChat }>(`/api/chats/${dm.id}/reset`, {})
    expect(reset.status).toBe(200)
    expect(reset.body.chat.id).not.toBe(dm.id)
    expect(reset.body.chat).toMatchObject({ kind: 'dm', title: dm.title })

    const fresh = await call<MessagesResult>(`/api/chats/${reset.body.chat.id}/messages?after=0`)
    expect(fresh.body.messages).toEqual([])
    expect((await call(`/api/chats/${dm.id}/messages?after=0`)).status).toBe(404)
    const listed = (await call<SimInfo>('/api/info')).body.chats.map((c) => c.id)
    expect(listed).toEqual([reset.body.chat.id, info.chats[1]?.id])

    const again = await send(reset.body.chat, { sender: 'Alex', text: 'second' })
    expect(again.body.messages.find((m) => m.kind === 'aira')?.text).toBe('Two.')
  })

  it('refuses an empty message, an unknown chat and a reply to a message that is not there', async () => {
    const { dm, send, call } = await startSim(fakeModel([]))
    expect((await send(dm, { sender: 'Alex', text: '   ' })).status).toBe(400)
    expect((await send(dm, { sender: '', text: 'hi' })).status).toBe(400)
    expect((await send(dm, { sender: 'Alex', text: 'hi', replyTo: 'nope' })).status).toBe(400)
    expect((await send({ ...dm, id: 'sim-dm-unknown' }, { sender: 'Alex', text: 'hi' })).status).toBe(404)
    expect((await call('/api/chats/x/reset', {})).status).toBe(404)
  })
})
