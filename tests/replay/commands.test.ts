import { describe, expect, it } from 'vitest'
import type { App } from '../../src/app.js'
import { setSetting } from '../../src/settings/settings.js'
import { type Answer, lastTurn, msg, queueModel, startApp } from '../support/app.js'

// Text commands through the whole service (docs/trd/tools.md#explicit-calls-text-commands).

const rows = <T>(app: App, sql: string, ...args: unknown[]) =>
  app.storage.read((db) => db.prepare(sql).all(...args) as T[])
const names = (request: { tools: { name: string }[] } | undefined) => request?.tools.map((tool) => tool.name) ?? []
const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString()

describe('direct commands', () => {
  it('/help lists the commands this chat may use, with no model call', async () => {
    const model = queueModel([{ text: 'must not be asked' }])
    const { app, gateway } = await startApp(model)
    const delivery = await gateway.send(msg('m-1', '/help'))
    expect(model.requests).toHaveLength(0)
    expect(delivery.content).toContain('/remind')
    expect(delivery.content).toContain('/mute')
    expect(lastTurn(app)).toMatchObject({ kind: 'command', state: 'delivered', length_bypass: 'command_list' })
    expect(rows(app, 'SELECT tool, source, outcome FROM tool_call')).toEqual([
      { tool: 'help', source: 'command', outcome: 'ok' }
    ])
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
    expect(delivery.content).toBe('Okay, I will remind you about the meeting.')
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
    expect(model.requests[1]?.messages.at(-1)?.content).toContain('"error":"invalid"')
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

    expect((await gateway.send(msg('m-3', '/cancel the first one'))).content).toBe('Cancelled the first one.')
    const asked = model.requests[4]
    expect(names(asked)).toEqual(['reminder_cancel'])
    expect(asked?.messages.at(-1)?.content).toContain('<command_context untrusted="true">')
    expect(asked?.messages.at(-1)?.content).toContain(first?.reminder_id)
    expect(rows(app, 'SELECT text, state FROM reminder ORDER BY text')).toEqual([
      { text: 'first', state: 'cancelled' },
      { text: 'second', state: 'active' }
    ])
  })

  it('/read routes a social address to the post reader', async () => {
    const model = queueModel([
      { toolCalls: [{ id: 'c1', name: 'read_post', args: { url: 'https://x.com/someone/status/1' } }] },
      { text: 'I cannot open that post.' }
    ])
    const { gateway } = await startApp(model)
    await gateway.send(msg('m-1', '/read https://x.com/someone/status/1'))
    expect(names(model.requests[0])).toEqual(['read_post'])
    await gateway.send(msg('m-2', '/read https://example.test/article'))
    expect(names(model.requests[2])).toEqual(['read_page'])
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

  it('only the first word of a message is a command', async () => {
    const model = queueModel([{ text: 'It lists the commands.' }])
    const { app, gateway } = await startApp(model)
    await gateway.send(msg('m-1', 'what does /help do?'))
    expect(model.requests).toHaveLength(1)
    expect(lastTurn(app)['kind']).toBe('reply')
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

    expect((await gateway.send(msg('m-3', '/song morning rain'))).content).toBe('Here it is.')
    expect(names(model.requests[3])).toEqual(['song_get'])
    expect(model.requests[4]?.messages.at(-1)?.content).toContain('rain on the tin roof')
    expect(lastTurn(app)).toMatchObject({ kind: 'command', state: 'delivered' })
  })
})
