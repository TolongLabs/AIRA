import { readFileSync } from 'node:fs'
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type ModelClient, ModelError, type ModelRequest, type ModelResponse } from '../../src/models/types.js'
import { tmpDir } from '../support/tmp.js'
import { BUBBLE_BREAK, FakeGateway, type GatewayMessage, buildRequest, parseContent } from './gateway.js'
import { RecordingMissError, createRecordingClient, hashRequest } from './recordings.js'
import { ScenarioError, loadScenario, parseScenario, scenarioIds, scenarioMessages } from './scenario.js'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()))
        })
    )
  )
})

async function startStub(
  handler: (req: IncomingMessage, body: Record<string, unknown>, res: ServerResponse) => void | Promise<void>
): Promise<string> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const body = raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {}
      void handler(req, body, res)
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('expected TCP address')
  return `http://127.0.0.1:${addr.port}`
}

function makeMessage(overrides: Partial<GatewayMessage> = {}): GatewayMessage {
  return {
    chat: { waId: 'test-chat-one', kind: 'group' },
    sender: 'test-member-alice',
    mid: 'msg-1',
    text: 'hello there',
    ...overrides
  }
}

function makeModelRequest(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    role: 'main',
    model: 'gemini-test',
    system: [{ name: 'core', text: 'be kind' }],
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'remind', description: 'set reminder', parameters: { type: 'object', properties: {} } }],
    params: { temperature: 0.4, maxTokens: 200 },
    ...overrides
  }
}

function makeModelResponse(text = 'hey!'): ModelResponse {
  return {
    text,
    toolCalls: [],
    usage: { inputTokens: 10, outputTokens: 5, cachedTokens: 2 },
    costUsd: 0.0001,
    model: 'gemini-test'
  }
}

describe('buildRequest', () => {
  it('builds exact scope marker, stream options, tools, unanswered prefix, transcript, and first-message note', () => {
    const req = buildRequest({
      message: makeMessage(),
      transcript: [
        { role: 'user', content: 'earlier user' },
        { role: 'assistant', content: 'earlier reply' }
      ],
      unanswered: ['missed one', 'missed two'],
      firstMessage: true
    })

    expect(req['model']).toBe('aira')
    expect(req['stream']).toBe(true)
    expect(req['stream_options']).toEqual({ include_usage: true })
    expect(Array.isArray(req['tools'])).toBe(true)
    expect((req['tools'] as unknown[]).length).toBe(1)

    const messages = req['messages'] as { role: string; content: string }[]
    expect(messages[0]?.role).toBe('system')
    expect(messages[1]).toEqual({ role: 'user', content: 'earlier user' })
    expect(messages[2]).toEqual({ role: 'assistant', content: 'earlier reply' })
    expect(messages[3]).toEqual({
      role: 'user',
      content:
        'missed one\n\nmissed two\n\n' +
        '[HERMES-SCOPE v1 platform=whatsapp kind=group chat=test-chat-one sender=test-member-alice mid=msg-1]\n' +
        'hello there\n\n' +
        '[System note: this is the first message of the conversation.]'
    })
  })

  it('omits the system note when firstMessage is false', () => {
    const req = buildRequest({
      message: makeMessage({ chat: { waId: 'test-chat-dm', kind: 'dm' }, mid: 'msg-2' }),
      transcript: [],
      unanswered: [],
      firstMessage: false
    })
    const messages = req['messages'] as { role: string; content: string }[]
    expect(messages[messages.length - 1]?.content).toBe(
      '[HERMES-SCOPE v1 platform=whatsapp kind=dm chat=test-chat-dm sender=test-member-alice mid=msg-2]\nhello there'
    )
  })
})

describe('parseContent', () => {
  it('parses a single bubble', () => {
    expect(parseContent('hello world')).toEqual({ bubbles: ['hello world'], media: [] })
  })

  it('the bubble break is the invisible separator U+2063, one character', () => {
    expect(BUBBLE_BREAK).toHaveLength(1)
    expect(BUBBLE_BREAK.codePointAt(0)).toBe(0x2063)
  })

  it('splits three bubbles at break lines and drops empty bubbles', () => {
    const B = BUBBLE_BREAK
    expect(parseContent(`  one  \n${B}\n${B}\n  two\n${B}\nthree  \n${B}\n`)).toEqual({
      bubbles: ['one', 'two', 'three'],
      media: []
    })
  })

  it('keeps a blank line inside a bubble: only a break line splits', () => {
    expect(parseContent(`first paragraph\n\nsecond paragraph\n${BUBBLE_BREAK}\nnext bubble`)).toEqual({
      bubbles: ['first paragraph\n\nsecond paragraph', 'next bubble'],
      media: []
    })
  })

  it('does not split at a line that holds a break and other text', () => {
    expect(parseContent(`one ${BUBBLE_BREAK} still one`).bubbles).toHaveLength(1)
  })

  it('extracts trailing MEDIA lines in order and keeps middle MEDIA lines as text', () => {
    const input = `MEDIA:/middle/stays.png\nhere is a note\n${BUBBLE_BREAK}\nsecond bubble\nMEDIA:/tmp/one.jpg\nMEDIA:/tmp/two.webp`
    expect(parseContent(input)).toEqual({
      bubbles: ['MEDIA:/middle/stays.png\nhere is a note', 'second bubble'],
      media: ['/tmp/one.jpg', '/tmp/two.webp']
    })
  })
})

describe('FakeGateway', () => {
  it('reads SSE chunks split awkwardly across writes, skips usage chunks, and records requests', async () => {
    const baseUrl = await startStub((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk1 = `data: ${JSON.stringify({ choices: [{ delta: { content: 'hel' } }] })}\n\n`
      const chunk2 = `data: ${JSON.stringify({ choices: [{ delta: { content: 'lo\n\nwor' } }] })}\n\n`
      const chunk3 = `data: ${JSON.stringify({ choices: [{ delta: { content: 'ld' } }] })}\n\n`
      const usageChunk = `data: ${JSON.stringify({ choices: [], usage: { total_tokens: 12 } })}\n\n`
      const done = 'data: [DONE]\n\n'
      const full = chunk1 + chunk2 + chunk3 + usageChunk + done
      res.write(full.slice(0, 17))
      res.write(full.slice(17, 53))
      res.write(full.slice(53, 120))
      res.end(full.slice(120))
    })

    const gateway = new FakeGateway({ baseUrl })
    const delivery = await gateway.send(makeMessage())

    expect(delivery).toEqual({
      status: 'delivered',
      attempts: 1,
      httpStatus: 200,
      content: 'hello\n\nworld',
      bubbles: ['hello\n\nworld'],
      media: []
    })
    expect(gateway.requests).toHaveLength(1)
  })

  it('reads a non-streamed JSON reply', async () => {
    const baseUrl = await startStub((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: 'plain json reply' } }] }))
    })

    const gateway = new FakeGateway({ baseUrl })
    const delivery = await gateway.send(makeMessage())

    expect(delivery.status).toBe('delivered')
    expect(delivery.content).toBe('plain json reply')
    expect(delivery.bubbles).toEqual(['plain json reply'])
  })

  it('retries identical bodies on socket destruction and succeeds on the third attempt', async () => {
    const received: Record<string, unknown>[] = []
    let count = 0
    const baseUrl = await startStub((req, body, res) => {
      count++
      received.push(body)
      if (count <= 2) {
        req.socket.destroy()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: 'recovered' } }] }))
    })

    const gateway = new FakeGateway({ baseUrl })
    const delivery = await gateway.send(makeMessage())

    expect(delivery.status).toBe('delivered')
    expect(delivery.attempts).toBe(3)
    expect(received).toHaveLength(3)
    expect(received[0]).toEqual(received[1])
    expect(received[1]).toEqual(received[2])
  })

  it('fails after 6 attempts, remembers unanswered per chat+sender, and clears after delivery', async () => {
    let fail = true
    const baseUrl = await startStub((req, _body, res) => {
      if (fail) {
        req.socket.destroy()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }))
    })

    const gateway = new FakeGateway({ baseUrl })
    const failed = await gateway.send(makeMessage({ mid: 'm-1', text: 'first try' }))
    expect(failed).toEqual({
      status: 'failed',
      attempts: 6,
      content: '',
      bubbles: [],
      media: []
    })
    expect(gateway.requests).toHaveLength(6)

    fail = false
    // Another sender in the same chat does not carry alice's unanswered text
    const bobDelivery = await gateway.send(makeMessage({ sender: 'test-member-bob', mid: 'm-2', text: 'from bob' }))
    expect(bobDelivery.status).toBe('delivered')
    const bobMsgs = gateway.requests[6]!['messages'] as { role: string; content: string }[]
    expect(bobMsgs[bobMsgs.length - 1]!.content).toBe(
      '[HERMES-SCOPE v1 platform=whatsapp kind=group chat=test-chat-one sender=test-member-bob mid=m-2]\nfrom bob'
    )

    // Alice's next message carries her unanswered text, and delivery clears it
    const aliceSecond = await gateway.send(makeMessage({ mid: 'm-3', text: 'second try' }))
    expect(aliceSecond.status).toBe('delivered')
    const aliceMsgs = gateway.requests[7]!['messages'] as { role: string; content: string }[]
    expect(aliceMsgs[aliceMsgs.length - 1]!.content).toBe(
      'first try\n\n[HERMES-SCOPE v1 platform=whatsapp kind=group chat=test-chat-one sender=test-member-alice mid=m-3]\nsecond try'
    )

    const aliceThird = await gateway.send(makeMessage({ mid: 'm-4', text: 'third try' }))
    expect(aliceThird.status).toBe('delivered')
    const aliceThirdMsgs = gateway.requests[8]!['messages'] as { role: string; content: string }[]
    expect(aliceThirdMsgs[aliceThirdMsgs.length - 1]!.content).toContain(
      '[HERMES-SCOPE v1 platform=whatsapp kind=group chat=test-chat-one sender=test-member-alice mid=m-4]\nthird try'
    )
    expect(aliceThirdMsgs[aliceThirdMsgs.length - 1]!.content).not.toContain('first try')
  })

  it('treats a stream ending without data: [DONE] as a failed attempt', async () => {
    const baseUrl = await startStub((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })}\n\n`)
    })

    const gateway = new FakeGateway({ baseUrl, attempts: 3 })
    const delivery = await gateway.send(makeMessage())

    expect(delivery.status).toBe('failed')
    expect(delivery.attempts).toBe(3)
    expect(delivery.httpStatus).toBe(200)
  })

  it('does not retry a 400 response and returns failed with httpStatus 400', async () => {
    let hits = 0
    const baseUrl = await startStub((_req, _body, res) => {
      hits++
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'bad request' }))
    })

    const gateway = new FakeGateway({ baseUrl })
    const delivery = await gateway.send(makeMessage())

    expect(hits).toBe(1)
    expect(delivery).toEqual({
      status: 'failed',
      attempts: 1,
      httpStatus: 400,
      content: '',
      bubbles: [],
      media: []
    })
  })

  it('auxiliary sends no tools and no scope marker', async () => {
    const baseUrl = await startStub((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: 'Weekend Plans' } }] }))
    })

    const gateway = new FakeGateway({ baseUrl })
    const title = await gateway.auxiliary('summarize a title')

    expect(title).toBe('Weekend Plans')
    expect(gateway.requests).toHaveLength(1)
    const sent = gateway.requests[0]!
    expect(sent['tools']).toBeUndefined()
    expect(sent['stream']).toBe(false)
    expect(JSON.stringify(sent)).not.toContain('HERMES-SCOPE')
  })
})

describe('scenario', () => {
  it('loads the example scenario and builds stable ids and messages', () => {
    const scenario = loadScenario(join(process.cwd(), 'tests/harness/scenarios/example.yml'))
    expect(scenario.name).toBe('example')
    expect(scenario.chat).toEqual({ id: 'example-group', type: 'group', character: 'example' })
    expect(scenario.members).toEqual(['alice', 'bob'])
    expect(scenario.steps).toHaveLength(3)

    const ids = scenarioIds(scenario)
    expect(ids.chatWaId).toBe('test-chat-example-group')
    expect(ids.members).toEqual({ alice: 'test-member-alice', bob: 'test-member-bob' })
    for (const value of [ids.chatWaId, ...Object.values(ids.members)]) {
      expect(value).not.toMatch(/\d{5,}/)
      expect(value).not.toContain('@')
    }

    const messages = scenarioMessages(scenario)
    expect(messages).toHaveLength(3)
    expect(messages[0]).toEqual({
      chat: { waId: 'test-chat-example-group', kind: 'group' },
      sender: 'test-member-alice',
      mid: 'example-1',
      text: scenario.steps[0]!.text
    })
    expect(messages[1]!.mid).toBe('example-2')
    expect(messages[1]!.sender).toBe('test-member-bob')
  })

  it.each([
    [
      'unknown key',
      `chat: { id: g1, type: group, character: example, extra: 1 }\nmembers: [alice]\nsteps:\n  - at: '09:00'\n    from: alice\n    text: hi\n`
    ],
    [
      'unknown from',
      `chat: { id: g1, type: group, character: example }\nmembers: [alice]\nsteps:\n  - at: '09:00'\n    from: charlie\n    text: hi\n`
    ],
    [
      'time going backwards',
      `chat: { id: g1, type: group, character: example }\nmembers: [alice]\nsteps:\n  - at: '10:00'\n    from: alice\n    text: a\n  - at: '09:59'\n    from: alice\n    text: b\n`
    ],
    [
      'bad time',
      `chat: { id: g1, type: group, character: example }\nmembers: [alice]\nsteps:\n  - at: '25:00'\n    from: alice\n    text: hi\n`
    ],
    [
      'duplicate member',
      `chat: { id: g1, type: group, character: example }\nmembers: [alice, alice]\nsteps:\n  - at: '09:00'\n    from: alice\n    text: hi\n`
    ],
    [
      'dm with two members',
      `chat: { id: d1, type: dm, character: example }\nmembers: [alice, bob]\nsteps:\n  - at: '09:00'\n    from: alice\n    text: hi\n`
    ],
    ['empty steps', 'chat: { id: g1, type: group, character: example }\nmembers: [alice]\nsteps: []\n']
  ])('refuses %s with a ScenarioError', (_label, yaml) => {
    expect(() => parseScenario('bad-case', yaml)).toThrow(ScenarioError)
  })
})

describe('recordings', () => {
  it('hashRequest ignores key order and changes on any structural field', () => {
    const base = makeModelRequest()
    const reordered = makeModelRequest({
      params: { maxTokens: 200, temperature: 0.4 }
    })
    expect(hashRequest(base)).toBe(hashRequest(reordered))

    expect(hashRequest(makeModelRequest({ role: 'judge' }))).not.toBe(hashRequest(base))
    expect(hashRequest(makeModelRequest({ model: 'other' }))).not.toBe(hashRequest(base))
    expect(hashRequest(makeModelRequest({ system: [{ name: 'core', text: 'changed' }] }))).not.toBe(hashRequest(base))
    expect(hashRequest(makeModelRequest({ messages: [{ role: 'user', content: 'changed' }] }))).not.toBe(
      hashRequest(base)
    )
    expect(
      hashRequest(
        makeModelRequest({
          tools: [{ name: 'other', description: 'set reminder', parameters: { type: 'object', properties: {} } }]
        })
      )
    ).not.toBe(hashRequest(base))
    expect(hashRequest(makeModelRequest({ params: { temperature: 0.9, maxTokens: 200 } }))).not.toBe(hashRequest(base))
  })

  it('records then replays with zero live calls, and saving twice is byte-for-byte identical', async () => {
    const file = join(tmpDir(), 'rec.json')
    const req = makeModelRequest()
    const expected = makeModelResponse('recorded reply')

    const inner: ModelClient = {
      call: vi.fn(async () => expected)
    }

    const recorder = createRecordingClient({ mode: 'record', file, inner })
    const res1 = await recorder.client.call(req)
    expect(res1).toEqual(expected)
    expect(recorder.liveCalls()).toBe(1)
    recorder.save()
    const firstBytes = readFileSync(file, 'utf8')

    const recorder2 = createRecordingClient({ mode: 'record', file, inner })
    await recorder2.client.call(req)
    recorder2.save()
    expect(readFileSync(file, 'utf8')).toBe(firstBytes)

    const replayInner: ModelClient = {
      call: vi.fn(async () => makeModelResponse('should not run'))
    }
    const replayer = createRecordingClient({ mode: 'replay', file, inner: replayInner })
    const replayed = await replayer.client.call(req)
    expect(replayed).toEqual(expected)
    expect(replayer.liveCalls()).toBe(0)
    expect(replayInner.call).not.toHaveBeenCalled()
  })

  it('records and rethrows a ModelError with its kind in replay', async () => {
    const file = join(tmpDir(), 'err.json')
    const req = makeModelRequest()
    const inner: ModelClient = {
      call: async () => {
        throw new ModelError('rate_limit', 'slow down')
      }
    }

    const recorder = createRecordingClient({ mode: 'record', file, inner })
    await expect(recorder.client.call(req)).rejects.toMatchObject({ name: 'ModelError', kind: 'rate_limit' })
    recorder.save()

    const replayer = createRecordingClient({ mode: 'replay', file })
    await expect(replayer.client.call(req)).rejects.toMatchObject({
      name: 'ModelError',
      kind: 'rate_limit',
      message: 'slow down'
    })
  })

  it('throws RecordingMissError with a diff on miss, and mentions empty on an empty recording', async () => {
    const emptyFile = join(tmpDir(), 'empty.json')
    const emptyReplay = createRecordingClient({ mode: 'replay', file: emptyFile })
    await expect(emptyReplay.client.call(makeModelRequest())).rejects.toThrow(/empty/)

    const file = join(tmpDir(), 'diff.json')
    const storedReq = makeModelRequest({ messages: [{ role: 'user', content: 'original line' }] })
    const recorder = createRecordingClient({
      mode: 'record',
      file,
      inner: { call: async () => makeModelResponse() }
    })
    await recorder.client.call(storedReq)
    recorder.save()

    const changedReq = makeModelRequest({ messages: [{ role: 'user', content: 'modified line' }] })
    const replayer = createRecordingClient({ mode: 'replay', file })
    try {
      await replayer.client.call(changedReq)
      expect.unreachable('expected RecordingMissError')
    } catch (err) {
      expect(err).toBeInstanceOf(RecordingMissError)
      const message = (err as Error).message
      expect(message).toContain(hashRequest(changedReq))
      expect(message).toContain('-       "content": "original line"')
      expect(message).toContain('+       "content": "modified line"')
    }
  })

  it('lists unused stored hashes via unused()', async () => {
    const file = join(tmpDir(), 'unused.json')
    const reqA = makeModelRequest({ messages: [{ role: 'user', content: 'A' }] })
    const reqB = makeModelRequest({ messages: [{ role: 'user', content: 'B' }] })

    const recorder = createRecordingClient({
      mode: 'record',
      file,
      inner: { call: async () => makeModelResponse() }
    })
    await recorder.client.call(reqA)
    await recorder.client.call(reqB)
    recorder.save()

    const replayer = createRecordingClient({ mode: 'replay', file })
    await replayer.client.call(reqA)
    expect(replayer.unused()).toEqual([hashRequest(reqB)])
  })
})
