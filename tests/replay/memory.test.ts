import { describe, expect, it } from 'vitest'
import type { App } from '../../src/app.js'
import type { ModelClient, ModelRequest, ModelResponse } from '../../src/models/types.js'
import { ensureChat, setChatStatus } from '../../src/settings/chats.js'
import { type Answer, msg, startApp } from '../support/app.js'
import { scriptedJudge } from '../support/memory.js'

// Memory through the whole service: a turn, the worker, recall in the next prompt, the note and forget tools.
// Every name and message is invented.

const rows = <T>(app: App, sql: string, ...args: unknown[]) =>
  app.storage.read((db) => db.prepare(sql).all(...args) as T[])

/** One model for both jobs, as in production: an extraction request has a response schema, a turn has none. */
function twoJobs(
  turns: Answer[],
  extraction: () => unknown
): ModelClient & { turns: ModelRequest[]; extractions: number; excerpts: string[] } {
  const client = {
    turns: [] as ModelRequest[],
    extractions: 0,
    excerpts: [] as string[],
    async call(request: ModelRequest): Promise<ModelResponse> {
      const base = {
        text: '',
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 5, cachedTokens: 0 },
        costUsd: 0.001,
        model: request.model
      }
      if ('response_format' in request.params) {
        client.extractions += 1
        client.excerpts.push(JSON.stringify(request.messages))
        return { ...base, text: JSON.stringify(extraction()) }
      }
      client.turns.push(structuredClone(request))
      const answer = turns[Math.min(client.turns.length, turns.length) - 1] as Answer
      if (answer instanceof Error) throw answer
      return { ...base, ...answer }
    }
  }
  return client
}

const systemText = (request: ModelRequest | undefined) => request?.system.map((block) => block.text).join('\n') ?? ''
const fast = (config: { memory: { episodeIdleMs: number } }) => {
  config.memory.episodeIdleMs = 1
}

describe('memory in the service', () => {
  it('remembers what a member said, recalls it in the next turn of that chat only, and forgets it by id', async () => {
    let itemId = ''
    const model = twoJobs(
      [
        { text: 'Nice.' },
        { text: 'You like teh tarik.' },
        { text: 'Hello there.' },
        { toolCalls: [{ id: 'c1', name: 'forget', args: { query: 'teh tarik' } }] },
        { toolCalls: [{ id: 'c2', name: 'forget', args: { itemId: 'set-below' } }] },
        { text: 'Done, I forgot that.' },
        { text: 'I do not know.' }
      ],
      () => ({
        operations: [
          { op: 'add', subject: 'member 1', key: 'likes.drink', value: 'teh tarik', quote: 'I really like teh tarik' }
        ]
      })
    )
    const { app, gateway, chatId } = await startApp(model, { config: fast, memoryJudge: scriptedJudge() })

    await gateway.send(msg('m-1', 'I really like teh tarik in the morning'))
    expect(systemText(model.turns[0])).not.toContain('<memory')
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(await app.memory?.tick()).toBe('done')
    const [fact] = rows<{ id: string; subject_id: string; value: string }>(
      app,
      "SELECT id, subject_id, value FROM memory_item WHERE chat_id = ? AND kind = 'fact'",
      chatId
    )
    expect(fact?.value).toBe('teh tarik')
    itemId = fact?.id ?? ''
    // Background model calls are recorded with their job, and counted in the month's spend.
    expect(rows(app, 'SELECT role FROM model_call WHERE turn_id IS NULL')).toEqual([{ role: 'main' }])

    await gateway.send(msg('m-2', 'what do I like to drink'))
    const recalled = systemText(model.turns[1])
    expect(recalled).toContain('<memory untrusted="true">')
    expect(recalled).toContain('- member 1: likes drink: teh tarik')
    expect(recalled).not.toContain(fact?.subject_id ?? 'none')

    // The same person in another chat: nothing of the first chat is in the prompt.
    const other = ensureChat(app.storage, { waId: 'test-chat-g2', type: 'group' })
    setChatStatus(app.storage, { chatId: other.chatId, status: 'active', actor: 'test' })
    await gateway.send({
      chat: { waId: 'test-chat-g2', kind: 'group' },
      sender: 'test-member-alice',
      mid: 'x-1',
      text: 'what do I like to drink, teh tarik?'
    })
    expect(JSON.stringify(model.turns[2])).not.toContain('likes drink')
    expect(systemText(model.turns[2])).not.toContain('<memory')

    // Forget: a search removes nothing and returns the candidates; the id removes exactly that fact.
    const answers = model.turns
    const original = model.call.bind(model)
    model.call = async (request) => {
      const response = await original(request)
      for (const call of response.toolCalls) if (call.args['itemId'] === 'set-below') call.args['itemId'] = itemId
      return response
    }
    const delivery = await gateway.send(msg('m-3', 'please forget what I like to drink'))
    expect(delivery.content).toBe('Done, I forgot that.\n\n🛠️ ᶠᵒʳᵍᵒᵗ ᵃ ⁿᵒᵗᵉ')
    const afterSearch = answers[4]?.messages.at(-1)?.content ?? ''
    expect(afterSearch).toContain('"forgotten":false')
    expect(afterSearch).toContain(itemId)
    expect(rows(app, 'SELECT kind FROM receipt ORDER BY rowid')).toEqual([
      { kind: 'memory.forget_barrier' },
      { kind: 'memory.forgotten' }
    ])
    expect(rows(app, 'SELECT key, value, status FROM memory_item WHERE id = ?', itemId)).toEqual([
      { key: 'forgotten', value: '', status: 'forgotten' }
    ])
    expect(
      rows(app, "SELECT content FROM session_message WHERE chat_id = ? AND content LIKE '%really like%'", chatId)
    ).toEqual([])

    await gateway.send(msg('m-4', 'what do I like to drink'))
    const last = model.turns.at(-1)
    expect(systemText(last)).not.toContain('<memory')
    expect(JSON.stringify(last?.messages)).not.toContain('I really like teh tarik')
    // Nothing said before the forget is extracted after it.
    await new Promise((resolve) => setTimeout(resolve, 5))
    const extractedBefore = model.extractions
    for (let round = 0; round < 4; round += 1) await app.memory?.tick()
    expect(model.extractions).toBeGreaterThan(extractedBefore)
    for (const excerpt of model.excerpts.slice(extractedBefore)) {
      expect(excerpt).not.toContain('really like')
      expect(excerpt).not.toContain('please forget')
    }
    expect(rows(app, "SELECT id FROM memory_item WHERE chat_id = ? AND status = 'active'", chatId)).toEqual([])
  })

  it('/remember stores a note the judge confirms, and it is not extracted a second time', async () => {
    const model = twoJobs(
      [
        { toolCalls: [{ id: 'c1', name: 'note', args: { text: 'the spare key is under the blue pot' } }] },
        { text: 'Got it.' },
        { text: 'Under the blue pot.' }
      ],
      () => ({
        operations: [
          {
            op: 'add',
            subject: 'member 1',
            key: 'spare.key',
            value: 'under the blue pot',
            quote: 'the spare key is under the blue pot'
          }
        ]
      })
    )
    const { app, gateway, chatId } = await startApp(model, { config: fast, memoryJudge: scriptedJudge() })
    expect((await gateway.send(msg('m-1', '/remember the spare key is under the blue pot'))).content).toBe(
      'Got it.\n\n🛠️ ˢᵃᵛᵉᵈ ᵃ ⁿᵒᵗᵉ'
    )
    expect(rows(app, 'SELECT kind FROM receipt')).toEqual([{ kind: 'memory.noted' }])

    await new Promise((resolve) => setTimeout(resolve, 5))
    await app.memory?.tick()
    const facts = rows<{ key: string; value: string }>(
      app,
      "SELECT key, value FROM memory_item WHERE chat_id = ? AND status = 'active'",
      chatId
    )
    expect(facts).toHaveLength(1)
    expect(facts[0]?.key.startsWith('note.')).toBe(true)

    await gateway.send(msg('m-2', 'where is it'))
    expect(systemText(model.turns.at(-1))).toContain('- member 1: the spare key is under the blue pot')
  })

  it('without a judge nothing is stored: the note is refused and extraction admits nothing', async () => {
    const model = twoJobs(
      [
        { toolCalls: [{ id: 'c1', name: 'note', args: { text: 'the spare key is under the blue pot' } }] },
        { text: 'I could not save that.' }
      ],
      () => ({ operations: [] })
    )
    const { app, gateway, chatId } = await startApp(model, { config: fast })
    await gateway.send(msg('m-1', '/remember the spare key is under the blue pot'))
    expect(model.turns[1]?.messages.at(-1)?.content).toContain('judge_unavailable')
    expect(rows(app, 'SELECT * FROM receipt')).toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(await app.memory?.tick()).toBe('skipped')
    expect(model.extractions).toBe(0)
    expect(rows(app, 'SELECT * FROM memory_item WHERE chat_id = ?', chatId)).toEqual([])
  })
})
