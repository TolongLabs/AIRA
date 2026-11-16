import { describe, expect, it } from 'vitest'
import { setSetting } from '../../src/settings/settings.js'
import type { Storage } from '../../src/storage/database.js'
import type { GatewayMessage } from '../harness/gateway.js'
import { loadScenario, scenarioIds, scenarioMessages } from '../harness/scenario.js'
import { addPack, modelError, scriptedRunner, startTestCore, testConfig } from '../support/core.js'

// The turn pipeline, driven through the fake gateway over HTTP (docs/trd/harness.md#principle).

const CHAT = 'test-chat-g1'
const ALICE = 'test-member-alice'
const BOB = 'test-member-bob'
const msg = (
  mid: string,
  text: string,
  sender = ALICE,
  chat = CHAT,
  kind: 'dm' | 'group' = 'group'
): GatewayMessage => ({
  chat: { waId: chat, kind },
  sender,
  mid,
  text
})
const rows = <T>(storage: Storage, sql: string, ...args: unknown[]) =>
  storage.read((db) => db.prepare(sql).all(...args) as T[])
const one = <T>(storage: Storage, sql: string, ...args: unknown[]) =>
  storage.read(
    (db) =>
      db
        .prepare(sql)
        .pluck()
        .get(...args) as T
  )
const userText = (input: { messages: { role: string; content: string }[] }) =>
  input.messages.filter((message) => message.role === 'user').at(-1)?.content ?? ''

describe('a scripted conversation', () => {
  it('gets one reply per turn, with a full turn record for each', async () => {
    const scenario = loadScenario('tests/harness/scenarios/example.yml')
    const core = await startTestCore()
    const chatId = core.activate(scenarioIds(scenario).chatWaId)
    const replies: string[] = []
    for (const message of scenarioMessages(scenario)) {
      const delivery = await core.gateway.send(message)
      expect(delivery).toMatchObject({ status: 'delivered', attempts: 1 })
      expect(delivery.bubbles).toHaveLength(1)
      replies.push(delivery.content)
    }
    expect(replies).toEqual(['scripted reply 1', 'scripted reply 2', 'scripted reply 3'])

    const turns = rows<Record<string, unknown>>(core.storage, 'SELECT * FROM turn ORDER BY received_at')
    expect(turns).toHaveLength(3)
    for (const turn of turns) {
      expect(turn).toMatchObject({
        chat_id: chatId,
        kind: 'reply',
        state: 'delivered',
        outcome: 'delivered',
        character_id: 'example',
        model: 'scripted-model',
        transport: 'api',
        attempts: 1,
        input_tokens: 10,
        bubble_count: 1
      })
      for (const stamp of ['admitted_at', 'built_at', 'model_done_at', 'cleaned_at', 'returned_at', 'ended_at']) {
        expect(turn[stamp], stamp).toEqual(expect.any(String))
      }
    }
    expect(one(core.storage, 'SELECT count(*) FROM model_call')).toBe(3)
    // The window alternates: what was said, then the reply.
    expect(
      rows<{ role: string }>(core.storage, 'SELECT role FROM session_message ORDER BY id').map((row) => row.role)
    ).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant'])
  })

  it('never writes a WhatsApp id into a record table or a log line', async () => {
    const core = await startTestCore()
    core.activate(CHAT)
    await core.gateway.send(msg('m-1', 'hello'))
    for (const table of ['turn', 'inbound_message', 'session_message', 'model_call', 'failure', 'setting_change']) {
      const dump = JSON.stringify(rows(core.storage, `SELECT * FROM ${table}`))
      expect(dump, table).not.toContain(CHAT)
      expect(dump, table).not.toContain(ALICE)
    }
    const logged = JSON.stringify(core.logs)
    expect(logged).not.toContain(CHAT)
    expect(logged).not.toContain(ALICE)
    expect(logged).not.toContain('hello')
  })

  it('gives the model the whole window, rebuilt from storage after a restart', async () => {
    const first = await startTestCore()
    first.activate(CHAT)
    await first.gateway.send(msg('m-1', 'my cat is called Biscuit'))
    await first.close()

    const runner = scriptedRunner(() => 'second reply')
    const second = await startTestCore({ dataDir: first.dataDir, runner })
    await second.gateway.send(msg('m-2', 'what is my cat called?'))
    expect(runner.inputs[0]?.messages).toEqual([
      { role: 'user', content: 'my cat is called Biscuit' },
      { role: 'assistant', content: 'scripted reply 1' },
      { role: 'user', content: 'what is my cat called?' }
    ])
  })
})

describe('turn admission', () => {
  it('gives a pending chat no reply, with a failure record and one alert', async () => {
    const core = await startTestCore()
    for (const mid of ['m-1', 'm-2']) {
      expect(await core.gateway.send(msg(mid, 'hello'))).toMatchObject({ status: 'delivered', content: 'NO_REPLY' })
    }
    expect(rows(core.storage, 'SELECT state, outcome, failure_kind FROM turn')).toEqual([
      { state: 'failed', outcome: 'failed', failure_kind: 'binding_invalid' },
      { state: 'failed', outcome: 'failed', failure_kind: 'binding_invalid' }
    ])
    expect(one(core.storage, "SELECT count(*) FROM failure WHERE kind = 'binding_invalid'")).toBe(2)
    // Alerts are rate limited per kind.
    expect(core.alerts.map((alert) => alert.kind)).toEqual(['binding_invalid'])
  })

  it('stops a chat whose character is missing, and never answers as another character', async () => {
    const runner = scriptedRunner(() => 'must not run')
    const core = await startTestCore({ runner })
    const chatId = core.activate(CHAT)
    setSetting(core.storage, { level: 'chat', scope: chatId, key: 'character', value: 'no-such-pack', actor: 'test' })
    expect(await core.gateway.send(msg('m-1', 'hello'))).toMatchObject({ content: 'NO_REPLY' })
    expect(runner.inputs).toHaveLength(0)
    expect(one(core.storage, 'SELECT failure_kind FROM turn')).toBe('binding_invalid')
    expect(core.alerts).toHaveLength(1)
  })

  it('stops a chat with no character at all', async () => {
    const runner = scriptedRunner(() => 'must not run')
    const core = await startTestCore({ runner, defaultCharacter: null })
    core.activate(CHAT)
    expect(await core.gateway.send(msg('m-1', 'hello'))).toMatchObject({ content: 'NO_REPLY' })
    expect(runner.inputs).toHaveLength(0)
  })

  it('stops only the chat with the broken binding', async () => {
    const core = await startTestCore()
    const broken = core.activate(CHAT)
    core.activate('test-chat-g2')
    setSetting(core.storage, { level: 'chat', scope: broken, key: 'character', value: 'no-such-pack', actor: 'test' })
    expect((await core.gateway.send(msg('m-1', 'hello'))).content).toBe('NO_REPLY')
    expect((await core.gateway.send(msg('m-1', 'hello', ALICE, 'test-chat-g2'))).content).toBe('scripted reply 1')
  })

  it('answers two chats as two characters at the same time', async () => {
    const runner = scriptedRunner((input) => `core: ${input.system[0]?.text}`)
    const core = await startTestCore({ runner })
    addPack(core.dataDir, 'second')
    const one_ = core.activate(CHAT)
    const two = core.activate('test-chat-g2')
    setSetting(core.storage, { level: 'chat', scope: two, key: 'character', value: 'second', actor: 'test' })
    const [first, second] = await Promise.all([
      core.gateway.send(msg('m-1', 'who are you?')),
      core.gateway.send(msg('m-1', 'who are you?', ALICE, 'test-chat-g2'))
    ])
    expect(first.content).toContain('You are Example')
    expect(second.content).toBe('core: You are the second test character.')
    expect(rows(core.storage, 'SELECT chat_id, character_id FROM turn ORDER BY character_id')).toEqual([
      { chat_id: one_, character_id: 'example' },
      { chat_id: two, character_id: 'second' }
    ])
  })

  it('gives no reply to a sender who is not allowed, and records the turn as declined', async () => {
    const runner = scriptedRunner(() => 'ok')
    const core = await startTestCore({ runner })
    const chatId = core.activate(CHAT)
    await core.gateway.send(msg('m-1', 'hello'))
    const alice = one<string>(core.storage, 'SELECT sender_id FROM turn')
    setSetting(core.storage, { level: 'chat', scope: chatId, key: 'allowedSenders', value: [alice], actor: 'test' })

    expect((await core.gateway.send(msg('m-2', 'hello', BOB))).content).toBe('NO_REPLY')
    expect((await core.gateway.send(msg('m-3', 'hello again'))).content).toBe('ok')
    expect(rows(core.storage, 'SELECT state, outcome FROM turn ORDER BY received_at')).toEqual([
      { state: 'delivered', outcome: 'delivered' },
      { state: 'declined', outcome: 'declined' },
      { state: 'delivered', outcome: 'delivered' }
    ])
    expect(one(core.storage, 'SELECT count(*) FROM failure')).toBe(0)
    expect(runner.inputs).toHaveLength(2)
  })

  it('sends the limit line when the spend cap stops replies', async () => {
    const core = await startTestCore({ deps: { hooks: { spendAllows: () => false } } })
    core.activate(CHAT)
    const delivery = await core.gateway.send(msg('m-1', 'hello'))
    expect(delivery.content).toBe(core.packs().packs.get('example')?.lines.limit)
    expect(one(core.storage, 'SELECT failure_kind FROM turn')).toBe('budget')
  })
})

describe('a repeated message id', () => {
  it('returns the stored reply and runs no second turn', async () => {
    const runner = scriptedRunner((_, call) => `reply ${call}`)
    const core = await startTestCore({ runner })
    core.activate(CHAT)
    const first = await core.gateway.send(msg('m-1', 'hello'))
    const again = await core.gateway.send(msg('m-1', 'hello'))
    expect(again.content).toBe(first.content)
    expect(runner.inputs).toHaveLength(1)
    expect(one(core.storage, 'SELECT count(*) FROM turn')).toBe(1)
    expect(one(core.storage, "SELECT count(*) FROM session_message WHERE role = 'user'")).toBe(1)
  })

  it('waits for the turn that is still running, and both requests get the one reply', async () => {
    let release: (text: string) => void = () => {}
    const runner = scriptedRunner(
      () =>
        new Promise<string>((resolve) => {
          release = resolve
        })
    )
    const core = await startTestCore({ runner })
    core.activate(CHAT)
    const first = core.gateway.send(msg('m-1', 'hello'))
    await expect.poll(() => runner.inputs.length).toBe(1)
    const second = core.gateway.send(msg('m-1', 'hello'))
    await new Promise((resolve) => setTimeout(resolve, 50))
    release('the one reply')
    expect((await first).content).toBe('the one reply')
    expect((await second).content).toBe('the one reply')
    expect(runner.inputs).toHaveLength(1)
  })
})

describe('batching', () => {
  it('merges messages sent in quick succession into one turn, and replies once', async () => {
    const runner = scriptedRunner((input) => `saw: ${userText(input)}`)
    const core = await startTestCore({
      runner,
      config: testConfig((config) => {
        config.turn.batchMs = 150
      })
    })
    core.activate(CHAT)
    const [first, second] = await Promise.all([
      core.gateway.send(msg('m-1', 'first half')),
      new Promise((resolve) => setTimeout(resolve, 30)).then(() => core.gateway.send(msg('m-2', 'second half')))
    ])
    expect(runner.inputs).toHaveLength(1)
    expect(second.content).toBe('saw: first half\n\nsecond half')
    expect(first.content).toBe('NO_REPLY')
    expect(one(core.storage, 'SELECT count(*) FROM turn')).toBe(1)
    // A repeat of the merged message returns nothing, so the reply goes out once.
    expect((await core.gateway.send(msg('m-1', 'first half'))).content).toBe('NO_REPLY')
  })

  it('runs one turn per chat: a message that arrives while a turn runs joins the next turn', async () => {
    const releases: ((text: string) => void)[] = []
    const runner = scriptedRunner(() => new Promise<string>((resolve) => releases.push(resolve)))
    const core = await startTestCore({ runner })
    core.activate(CHAT)
    const first = core.gateway.send(msg('m-1', 'one'))
    await expect.poll(() => runner.inputs.length).toBe(1)
    const second = core.gateway.send(msg('m-2', 'two', BOB))
    const third = core.gateway.send(msg('m-3', 'three'))
    await new Promise((resolve) => setTimeout(resolve, 80))
    // The second turn has not started: one turn per chat.
    expect(runner.inputs).toHaveLength(1)
    releases[0]?.('reply one')
    expect((await first).content).toBe('reply one')
    await expect.poll(() => runner.inputs.length).toBe(2)
    expect(userText(runner.inputs[1] as never)).toBe('two\n\nthree')
    // The reply to the first turn sits before the messages that arrived while it ran.
    expect(runner.inputs[1]?.messages).toEqual([
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'reply one' },
      { role: 'user', content: 'two\n\nthree' }
    ])
    releases[1]?.('reply two and three')
    expect([(await second).content, (await third).content].sort()).toEqual(['NO_REPLY', 'reply two and three'])
    expect(one(core.storage, 'SELECT count(*) FROM turn')).toBe(2)
  })

  it('runs turns of different chats at the same time', async () => {
    const releases: ((text: string) => void)[] = []
    const runner = scriptedRunner(() => new Promise<string>((resolve) => releases.push(resolve)))
    const core = await startTestCore({ runner })
    core.activate(CHAT)
    core.activate('test-chat-g2')
    const a = core.gateway.send(msg('m-1', 'one'))
    const b = core.gateway.send(msg('m-1', 'one', ALICE, 'test-chat-g2'))
    await expect.poll(() => runner.inputs.length).toBe(2)
    for (const release of releases) release('done')
    expect([(await a).content, (await b).content]).toEqual(['done', 'done'])
  })
})

describe('mute and quiet hours', () => {
  const reminder = '[AIRA-SCHEDULED v1 kind=reminder owner=s_other target=s_someone id=r1]\nTime for dinner.'
  const proactive = '[AIRA-SCHEDULED v1 kind=proactive]\nSay good morning.'

  it('sends nothing for a scheduled turn in a muted chat, and records why', async () => {
    const runner = scriptedRunner(() => 'must not run')
    const core = await startTestCore({ runner })
    const chatId = core.activate(CHAT)
    setSetting(core.storage, {
      level: 'chat',
      scope: chatId,
      key: 'muted',
      value: { by: 's_someone', at: '2026-01-01T00:00:00.000Z' },
      actor: 'test'
    })
    expect((await core.gateway.send(msg('m-1', proactive))).content).toBe('NO_REPLY')
    expect((await core.gateway.send(msg('m-2', reminder))).content).toBe('NO_REPLY')
    expect(runner.inputs).toHaveLength(0)
    expect(rows(core.storage, 'SELECT kind, state, outcome, stage FROM turn')).toEqual([
      { kind: 'scheduled', state: 'declined', outcome: 'muted', stage: 'admit:muted' },
      { kind: 'scheduled', state: 'declined', outcome: 'muted', stage: 'admit:muted' }
    ])
  })

  it('sends nothing for a scheduled turn in quiet hours, and still replies to a person', async () => {
    const runner = scriptedRunner(() => 'a reply')
    const core = await startTestCore({ runner })
    const chatId = core.activate(CHAT)
    // A window that covers the whole day but one minute, so the test does not depend on the clock.
    setSetting(core.storage, {
      level: 'chat',
      scope: chatId,
      key: 'quietHours',
      value: { start: '00:00', end: '23:59', timeZone: 'UTC' },
      actor: 'test'
    })
    if (new Date().toISOString().slice(11, 16) === '23:59') await new Promise((resolve) => setTimeout(resolve, 61_000))
    expect((await core.gateway.send(msg('m-1', proactive))).content).toBe('NO_REPLY')
    expect(one(core.storage, 'SELECT stage FROM turn')).toBe('admit:quiet')
    expect((await core.gateway.send(msg('m-2', 'are you there?'))).content).toBe('a reply')
  }, 90_000)

  it('asks again before the return: a mute that arrives while a scheduled turn runs stops it', async () => {
    let release: (text: string) => void = () => {}
    const runner = scriptedRunner(
      () =>
        new Promise<string>((resolve) => {
          release = resolve
        })
    )
    const core = await startTestCore({ runner })
    const chatId = core.activate(CHAT)
    const sending = core.gateway.send(msg('m-1', proactive))
    await expect.poll(() => runner.inputs.length).toBe(1)
    setSetting(core.storage, {
      level: 'chat',
      scope: chatId,
      key: 'muted',
      value: { by: 's_someone', at: '2026-01-01T00:00:00.000Z' },
      actor: 'test'
    })
    release('good morning')
    expect((await sending).content).toBe('NO_REPLY')
    expect(rows(core.storage, 'SELECT state, outcome FROM turn')).toEqual([{ state: 'declined', outcome: 'muted' }])
    expect(one(core.storage, "SELECT count(*) FROM session_message WHERE role = 'assistant'")).toBe(0)
  })

  it('lets a scheduled turn through when the chat is neither muted nor quiet', async () => {
    const core = await startTestCore()
    core.activate(CHAT)
    expect((await core.gateway.send(msg('m-1', proactive))).content).toBe('scripted reply 1')
    expect(one(core.storage, 'SELECT kind FROM turn')).toBe('scheduled')
  })
})

describe('failures become pack lines', () => {
  const lines = async (core: Awaited<ReturnType<typeof startTestCore>>) => core.packs().packs.get('example')?.lines

  it.each([
    ['refusal', 'refusal'],
    ['malformed', 'fallback'],
    ['budget', 'limit'],
    ['transient', 'error'],
    ['rate_limit', 'error'],
    ['auth', 'error']
  ] as const)('a %s failure sends the %s line, never the error text', async (kind, line) => {
    const core = await startTestCore({
      runner: {
        run: async () => {
          throw modelError(kind)
        }
      }
    })
    core.activate(CHAT)
    const delivery = await core.gateway.send(msg('m-1', 'hello'))
    expect(delivery.content).toBe((await lines(core))?.[line])
    expect(delivery.content).not.toContain('scripted')
    expect(rows(core.storage, 'SELECT state, outcome, failure_kind FROM turn')).toEqual([
      { state: 'failed', outcome: 'failed', failure_kind: kind }
    ])
    expect(one(core.storage, 'SELECT kind FROM failure')).toBe(kind)
    // The request of a failed turn is kept verbatim, in the diagnostics table only.
    expect(one(core.storage, 'SELECT request FROM failure_diagnostics')).toBe('hello')
  })

  it('ends a turn at its deadline with the slow line', async () => {
    const core = await startTestCore({
      runner: scriptedRunner(() => new Promise<string>(() => {})),
      config: testConfig((config) => {
        config.llm.turnDeadlineMs = 80
      })
    })
    core.activate(CHAT)
    const delivery = await core.gateway.send(msg('m-1', 'hello'))
    expect(delivery.content).toBe((await lines(core))?.slow)
    expect(one(core.storage, 'SELECT state FROM turn')).toBe('failed')
  })

  it('sends the error line for an uncaught exception, and the process keeps answering', async () => {
    let calls = 0
    const core = await startTestCore({
      runner: {
        run: async () => {
          if (++calls === 1) throw new TypeError('a bug in a handler')
          return (await import('../support/core.js')).runResult('fine again')
        }
      }
    })
    core.activate(CHAT)
    const broken = await core.gateway.send(msg('m-1', 'hello'))
    expect(broken.content).toBe((await lines(core))?.error)
    expect(one(core.storage, 'SELECT kind FROM failure WHERE turn_id IS NOT NULL')).toBe('internal')
    expect((await core.gateway.send(msg('m-2', 'hello again'))).content).toBe('fine again')
  })

  it('sends the fallback line when the reply is empty after cleaning', async () => {
    const core = await startTestCore({ runner: scriptedRunner(() => '   ') })
    core.activate(CHAT)
    expect((await core.gateway.send(msg('m-1', 'hello'))).content).toBe((await lines(core))?.fallback)
  })
})

describe('the gateway endpoint', () => {
  it('answers an auxiliary request with fixed text: no model call, no turn record', async () => {
    const runner = scriptedRunner(() => 'must not run')
    const core = await startTestCore({ runner })
    expect(await core.gateway.auxiliary('Write a short title for this conversation')).toBe('Chat')
    expect(runner.inputs).toHaveLength(0)
    expect(one(core.storage, 'SELECT count(*) FROM turn')).toBe(0)
    expect(one(core.storage, 'SELECT count(*) FROM inbound_message')).toBe(0)
  })

  it('answers a request with tools and no scope marker with NO_REPLY and a record, never a turn', async () => {
    const core = await startTestCore()
    const response = await fetch(`${core.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'hello with no marker' }],
        tools: [{ type: 'function', function: { name: 'gateway_tool' } }],
        stream: false
      })
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { choices: { message: { content: string } }[] }
    expect(body.choices[0]?.message.content).toBe('NO_REPLY')
    expect(rows(core.storage, 'SELECT kind, stage FROM failure')).toEqual([
      { kind: 'gateway_unmarked', stage: 'receive' }
    ])
    expect(one(core.storage, 'SELECT count(*) FROM turn')).toBe(0)
    expect(one(core.storage, 'SELECT count(*) FROM inbound_message')).toBe(0)
  })

  it('refuses a body that is not JSON', async () => {
    const core = await startTestCore()
    const response = await fetch(`${core.baseUrl}/v1/chat/completions`, { method: 'POST', body: '{not json' })
    expect(response.status).toBe(400)
  })

  it('answers a request that did not ask for a stream with one JSON body', async () => {
    const core = await startTestCore()
    core.activate(CHAT)
    const response = await fetch(`${core.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({
        messages: [
          {
            role: 'user',
            content: `[HERMES-SCOPE v1 platform=whatsapp kind=group chat=${CHAT} sender=${ALICE} mid=m-1]\nhello`
          }
        ],
        tools: [{ type: 'function', function: { name: 'gateway_tool' } }]
      })
    })
    expect(response.headers.get('content-type')).toContain('application/json')
    const body = (await response.json()) as { choices: { message: { content: string } }[] }
    expect(body.choices[0]?.message.content).toBe('scripted reply 1')
  })

  it('reports health, and 404 for another path', async () => {
    const core = await startTestCore()
    expect((await fetch(`${core.baseUrl}/health`)).status).toBe(200)
    expect((await fetch(`${core.baseUrl}/nothing`)).status).toBe(404)
  })

  it('stores earlier unanswered text the gateway resends, once', async () => {
    const runner = scriptedRunner((input) => `saw: ${userText(input)}`)
    const core = await startTestCore({ runner })
    core.activate(CHAT)
    // The gateway resends text the core never received (it was down), before the marker of the next message.
    const body = (mid: string, content: string) => ({
      messages: [{ role: 'user', content }],
      tools: [{ type: 'function', function: { name: 'gateway_tool' } }]
    })
    const marker = (mid: string) =>
      `[HERMES-SCOPE v1 platform=whatsapp kind=group chat=${CHAT} sender=${ALICE} mid=${mid}]`
    const post = async (payload: unknown) =>
      (
        (await (
          await fetch(`${core.baseUrl}/v1/chat/completions`, { method: 'POST', body: JSON.stringify(payload) })
        ).json()) as {
          choices: { message: { content: string } }[]
        }
      ).choices[0]?.message.content
    expect(await post(body('m-2', `sent while the core was down\n\n${marker('m-2')}\nsent after`))).toBe(
      'saw: sent while the core was down\n\nsent after'
    )
    expect(one(core.storage, "SELECT count(*) FROM session_message WHERE role = 'user'")).toBe(2)
  })
})
