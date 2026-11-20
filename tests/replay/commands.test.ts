import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { App } from '../../src/app.js'
import { loadPacks } from '../../src/character/loader.js'
import { createLogger } from '../../src/records/logger.js'
import { createRedactor } from '../../src/records/redact.js'
import { ensureChat, setChatStatus } from '../../src/settings/chats.js'
import { setSetting } from '../../src/settings/settings.js'
import { createCommandRouter } from '../../src/tools/commands.js'
import { createToolRegistry } from '../../src/tools/registry.js'
import type { ToolFailureKind } from '../../src/tools/types.js'
import { basicPromptBuilder, plainCleaner } from '../../src/turn/defaults.js'
import { createTurnService } from '../../src/turn/pipeline.js'
import { type Answer, lastTurn, msg, queueModel, startApp } from '../support/app.js'
import { scriptedRunner, testConfig } from '../support/core.js'
import { tmpStorage } from '../support/tmp.js'

// Text commands through the whole service (docs/trd/tools.md#explicit-calls-text-commands).

const rows = <T>(app: App, sql: string, ...args: unknown[]) =>
  app.storage.read((db) => db.prepare(sql).all(...args) as T[])
const names = (request: { tools: { name: string }[] } | undefined) => request?.tools.map((tool) => tool.name) ?? []
const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString()

describe('direct commands', () => {
  it('/help lists the commands this chat may use, with no model call', async () => {
    const model = queueModel([{ text: 'must not be asked' }])
    const { app, gateway, chatId } = await startApp(model)
    const delivery = await gateway.send(msg('m-1', '/help'))
    expect(model.requests).toHaveLength(0)
    expect(delivery.content).toContain('/remind')
    expect(delivery.content).toContain('/mute')
    expect(delivery.content).toContain('/think')
    expect(delivery.content).not.toContain('- **/think**')
    expect(lastTurn(app)).toMatchObject({ kind: 'command', state: 'delivered', length_bypass: 'command_list' })
    expect(rows(app, 'SELECT tool, source, outcome FROM tool_call')).toEqual([
      { tool: 'help', source: 'command', outcome: 'ok' }
    ])

    setSetting(app.storage, { level: 'chat', scope: chatId, key: 'features.think', value: false, actor: 'test' })
    expect((await gateway.send(msg('m-2', '/help'))).content).not.toContain('/think')
  })

  it('replays a code-written answer labelled as code, and strips the label if the model copies it', async () => {
    const model = queueModel([
      {
        text: '[Code wrote this reply from stored data for a command. It is accurate; you did not write it.]\nYes, that list is real.'
      }
    ])
    const { gateway } = await startApp(model)
    await gateway.send(msg('m-1', '/help'))
    const reply = await gateway.send(msg('m-2', 'did you make that list up?'))
    const replayed = JSON.stringify(model.requests[0]?.messages)
    expect(replayed).toContain('Code wrote this reply from stored data for a command')
    expect(reply.content).toContain('Yes, that list is real.')
    expect(reply.content).not.toContain('Code wrote this reply')
  })

  it('/mute and /unmute change the setting, each with a receipt', async () => {
    const model = queueModel([{ text: 'must not be asked' }])
    const { app, gateway } = await startApp(model)
    const muted = () =>
      JSON.parse(rows<{ value: string }>(app, "SELECT value FROM setting WHERE key = 'muted'")[0]?.value ?? 'false')
    expect((await gateway.send(msg('m-1', '/mute'))).content).toBe('Proactive messages are off for this chat.')
    expect(muted()).toMatchObject({ by: lastTurn(app)['sender_id'] })
    expect((await gateway.send(msg('m-2', '/UNMUTE'))).content).toBe('Proactive messages are on for this chat.')
    expect(muted()).toBe(false)
    expect(rows(app, 'SELECT kind FROM receipt ORDER BY created_at, rowid')).toEqual([
      { kind: 'mute.on' },
      { kind: 'mute.off' }
    ])
    expect(JSON.parse(lastTurn(app)['receipts'] as string)).toHaveLength(1)
    expect(model.requests).toHaveLength(0)
  })

  it('/reminders lists this chat only', async () => {
    const { gateway } = await startApp(queueModel([{ text: 'unused' }]))
    expect((await gateway.send(msg('m-1', '/reminders'))).content).toBe('No reminders in this chat.')
  })
})

describe('skill-style commands', () => {
  it('/remind: the command decides the tool, the model fills the arguments, code runs it', async () => {
    const dueAt = inAnHour()
    const model = queueModel([
      { toolCalls: [{ id: 'c1', name: 'reminder_set', args: { text: 'meeting', dueAt } }] },
      { text: 'Okay, I will remind you about the meeting.' }
    ])
    const { app, gateway } = await startApp(model)
    const delivery = await gateway.send(msg('m-1', '/remind i have a mtg ltr at 6pm, ping me by then'))
    expect(delivery.content).toBe('Okay, I will remind you about the meeting.\n\n_🛠️ set a reminder_')
    // Until the named tool has been called, it is the only tool the model is offered.
    expect(names(model.requests[0])).toEqual(['reminder_set'])
    expect(names(model.requests[1]).length).toBeGreaterThan(1)
    expect(rows(app, 'SELECT state, text FROM reminder')).toEqual([{ state: 'active', text: 'meeting' }])
    expect(rows(app, 'SELECT tool, source, outcome FROM tool_call')).toEqual([
      { tool: 'reminder_set', source: 'command', outcome: 'ok' }
    ])
    expect(rows(app, 'SELECT kind FROM receipt')).toEqual([{ kind: 'reminder.created' }])
    expect(lastTurn(app)).toMatchObject({ kind: 'command', state: 'delivered', attempts: 2 })
  })

  it('unclear means ask: the model may ask one question, and then nothing runs', async () => {
    const model = queueModel([{ text: 'When should I remind you?' }])
    const { app, gateway } = await startApp(model)
    expect((await gateway.send(msg('m-1', '/remind the thing'))).content).toBe('When should I remind you?')
    expect(rows(app, 'SELECT * FROM reminder')).toEqual([])
    expect(rows(app, 'SELECT * FROM tool_call')).toEqual([])
  })

  it('the model cannot pick another tool first', async () => {
    const model = queueModel([
      { toolCalls: [{ id: 'c1', name: 'set_mute', args: { muted: true } }], text: 'I muted the chat instead.' }
    ])
    const { app, gateway } = await startApp(model)
    await gateway.send(msg('m-1', '/remind me tomorrow'))
    expect(rows(app, "SELECT * FROM setting WHERE key = 'muted'")).toEqual([])
    expect(rows(app, 'SELECT * FROM tool_call')).toEqual([])
  })

  it('validates what the model filled in: a reminder in the past is refused and none is stored', async () => {
    const model = queueModel([
      { toolCalls: [{ id: 'c1', name: 'reminder_set', args: { text: 'late', dueAt: '2020-01-01T00:00:00.000Z' } }] },
      { text: 'That time has passed. When should it be?' }
    ])
    const { app, gateway } = await startApp(model)
    expect((await gateway.send(msg('m-1', '/remind me yesterday'))).content).toBe(
      'That time has passed. When should it be?'
    )
    expect(rows(app, 'SELECT * FROM reminder')).toEqual([])
    expect(rows(app, 'SELECT outcome FROM tool_call')).toEqual([{ outcome: 'invalid' }])
    expect(model.requests[1]?.messages.at(-1)?.content).toContain('"outcome":"Try once more with corrected details."')
    expect(model.requests[1]?.messages.at(-1)?.content).not.toContain('dueAt must be in the future')
  })

  it('/cancel shows the model the reminders to choose from, and cancels exactly the one it names', async () => {
    const answers: Answer[] = [
      { toolCalls: [{ id: 'c1', name: 'reminder_set', args: { text: 'first', dueAt: inAnHour() } }] },
      { text: 'set' },
      { toolCalls: [{ id: 'c2', name: 'reminder_set', args: { text: 'second', dueAt: inAnHour() } }] },
      { text: 'set' }
    ]
    const model = queueModel(answers)
    const { app, gateway } = await startApp(model)
    await gateway.send(msg('m-1', '/remind first'))
    await gateway.send(msg('m-2', '/remind second'))
    const [first] = rows<{ reminder_id: string }>(app, "SELECT reminder_id FROM reminder WHERE text = 'first'")
    answers.push(
      { toolCalls: [{ id: 'c3', name: 'reminder_cancel', args: { reminderId: first?.reminder_id } }] },
      { text: 'Cancelled the first one.' }
    )

    expect((await gateway.send(msg('m-3', '/cancel the first one'))).content).toBe(
      'Cancelled the first one.\n\n_🛠️ checked reminders · cancelled a reminder_'
    )
    const asked = model.requests[4]
    expect(names(asked)).toEqual(['reminder_cancel'])
    expect(asked?.messages.at(-1)?.content).toContain('<command_context untrusted="true">')
    expect(asked?.messages.at(-1)?.content).toContain(first?.reminder_id)
    expect(rows(app, 'SELECT text, state FROM reminder ORDER BY text')).toEqual([
      { text: 'first', state: 'cancelled' },
      { text: 'second', state: 'active' }
    ])
  })

  it('/read is no longer a command: the message goes to the model with the usual tools', async () => {
    const model = queueModel([{ text: 'Here is what the page says.' }])
    const { gateway } = await startApp(model)
    await gateway.send(msg('m-1', '/read https://example.test/article'))
    const offered = names(model.requests[0])
    expect(offered).toEqual(expect.arrayContaining(['read_page', 'read_post', 'web_search']))
  })
})

describe('what is not a command', () => {
  it('an unknown /name is ordinary text and goes to the model with the usual tools', async () => {
    const model = queueModel([{ text: 'I do not know that one.' }])
    const { app, gateway } = await startApp(model)
    expect((await gateway.send(msg('m-1', '/dance now'))).content).toBe('I do not know that one.')
    expect(names(model.requests[0]).length).toBeGreaterThan(1)
    expect(lastTurn(app)['kind']).toBe('reply')
  })

  it('a command for a feature that is switched off is ordinary text', async () => {
    const model = queueModel([{ text: 'Reminders are off here.' }])
    const { app, gateway, chatId } = await startApp(model)
    setSetting(app.storage, { level: 'chat', scope: chatId, key: 'features.reminders', value: false, actor: 'test' })
    await gateway.send(msg('m-1', '/remind me at six'))
    expect(names(model.requests[0])).not.toContain('reminder_set')
    expect(lastTurn(app)['kind']).toBe('reply')
    expect((await gateway.send(msg('m-2', '/help'))).content).not.toContain('/remind')
  })

  it('a direct command anywhere in a message runs directly', async () => {
    const model = queueModel([])
    const { app, gateway } = await startApp(model)
    await gateway.send(msg('m-1', 'what does /help do?'))
    expect(model.requests).toHaveLength(0)
    expect(lastTurn(app)['kind']).toBe('command')
  })
})

describe('lessons commands', () => {
  it('are ordinary text until the chat switches lessons on, and then file and fetch a song', async () => {
    const model = queueModel([
      { text: 'I do not know that command.' },
      {
        toolCalls: [
          {
            id: 'c1',
            name: 'song_save',
            args: { title: 'Morning Rain', lines: [{ text: 'rain on the tin roof', meanings: { en: 'it rains' } }] }
          }
        ]
      },
      { text: 'Filed.' },
      { toolCalls: [{ id: 'c2', name: 'song_get', args: { title: 'morning rain' } }] },
      { text: 'Here it is.' }
    ])
    const { app, gateway, chatId } = await startApp(model)
    await gateway.send(msg('m-1', '/song morning rain'))
    expect(names(model.requests[0])).not.toContain('song_get')
    expect(lastTurn(app)).toMatchObject({ kind: 'reply' })

    setSetting(app.storage, { level: 'chat', scope: chatId, key: 'features.lessons', value: true, actor: 'test' })
    await gateway.send(msg('m-2', 'file this song: Morning Rain. rain on the tin roof'))
    expect(names(model.requests[1])).toContain('song_save')
    expect(rows(app, 'SELECT kind FROM receipt')).toEqual([{ kind: 'lesson.song_saved' }])

    expect((await gateway.send(msg('m-3', '/song morning rain'))).content).toBe('Here it is.\n\n_🛠️ opened a song_')
    expect(names(model.requests[3])).toEqual(['song_get'])
    expect(model.requests[4]?.messages.at(-1)?.content).toContain('rain on the tin roof')
    expect(lastTurn(app)).toMatchObject({ kind: 'command', state: 'delivered' })
  })
})

describe('direct command failure mapping', () => {
  it('a failed direct command keeps its result kind', async () => {
    const cases: Array<[ToolFailureKind, string]> = [
      ['invalid', 'malformed'],
      ['refused', 'tool_refused'],
      ['unavailable', 'transient'],
      ['timeout', 'tool_timeout'],
      ['error', 'tool_error']
    ]

    for (const [resultKind, expectedFailureKind] of cases) {
      const storage = tmpStorage()
      const config = testConfig((c) => {
        c.turn.batchMs = 0
      })
      const logger = createLogger({ level: 'error', module: 'commands-test', sink: () => {} })
      const redactor = createRedactor()
      const packs = () => loadPacks({ repositoryDir: 'characters', dataDir: '/tmp/aira-no-private-packs' })
      const chat = ensureChat(storage, { waId: `test-chat-${resultKind}`, type: 'group' })
      setChatStatus(storage, { chatId: chat.chatId, status: 'active', actor: 'test' })
      setSetting(storage, { level: 'global', scope: '', key: 'character', value: 'example', actor: 'test' })

      const registry = createToolRegistry({
        storage,
        config: { tools: { defaultTimeoutMs: 500 } },
        logger,
        redactor
      })
      registry.register({
        name: 'probe_direct',
        description: 'Direct probe tool',
        schema: z.strictObject({}),
        mode: 'explicit',
        mutates: false,
        command: {
          names: ['probe'],
          kind: 'direct',
          usage: '/probe',
          directArgs: () => ({})
        },
        handler: () => ({
          ok: false,
          kind: resultKind,
          reason: `${resultKind} reason`,
          cause: new Error(`${resultKind} cause`)
        })
      })

      const turns = createTurnService({
        storage,
        config,
        logger,
        redactor,
        packs,
        runner: scriptedRunner(() => 'unused'),
        prompt: basicPromptBuilder,
        cleaner: plainCleaner,
        commands: createCommandRouter(registry),
        alerter: { raise: () => false }
      })

      const reply = await turns.handle({
        type: 'turn',
        marker: {
          platform: 'test',
          chat: `test-chat-${resultKind}`,
          kind: 'group',
          sender: 'test-member-probe',
          mid: `mid-${resultKind}`
        },
        text: '/probe',
        earlier: '',
        attachments: [],
        stream: false,
        includeUsage: false
      })

      expect(reply.content).toBe(packs().packs.get('example')?.lines.error)
      expect(reply.content).not.toContain(`${resultKind} cause`)
      const turn = storage.read((db) => db.prepare('SELECT state, outcome, failure_kind FROM turn').get())
      expect(turn).toEqual({ state: 'failed', outcome: 'failed', failure_kind: expectedFailureKind })
      const cmdFailure = storage.read(
        (db) =>
          db.prepare("SELECT kind, message FROM failure WHERE stage = 'command'").get() as {
            kind: string
            message: string
          }
      )
      expect(cmdFailure.kind).toBe(expectedFailureKind)
      expect(cmdFailure.message).toContain(`${resultKind} cause`)
    }
  })
})
