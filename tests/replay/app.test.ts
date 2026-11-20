import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type App, createApp } from '../../src/app.js'
import { ConfigError } from '../../src/config/loader.js'
import { type ModelClient, ModelError, type ModelRequest } from '../../src/models/types.js'
import { createLogger } from '../../src/records/logger.js'
import { ensureChat, setChatStatus } from '../../src/settings/chats.js'
import { setSetting } from '../../src/settings/settings.js'
import { FakeGateway } from '../harness/gateway.js'
import { CHAT, msg, queueModel, startApp } from '../support/app.js'
import { addPack, testConfig } from '../support/core.js'
import { gatewayMarkdown } from '../support/gateway-markdown.js'
import { tmpDir } from '../support/tmp.js'

// The whole service as the entry point builds it: the real prompt builder, cleaning chain, tool registry, agent
// loop and routed client. Only the model is replaced, by a queue of answers. Driven by the fake gateway over HTTP.

const apps: App[] = []
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close()
})
const start = startApp

const turn = (app: App) =>
  app.storage.read(
    (db) => db.prepare('SELECT * FROM turn ORDER BY received_at DESC LIMIT 1').get() as Record<string, unknown>
  )

describe('the whole service', () => {
  it('loads a private pack without a feedback line and answers /report in plain words', async () => {
    const dataDir = tmpDir('aira-legacy-pack-')
    addPack(dataDir, 'legacy')
    const path = join(dataDir, 'characters', 'legacy', 'lines.yml')
    writeFileSync(path, readFileSync(path, 'utf8').replace(/^feedback:.*\n/m, ''))
    const model = queueModel([])
    const { app, chatId, gateway } = await start(model, {
      dataDir,
      character: 'legacy',
      config: (config) => {
        config.feedback.formUrl = 'https://form.invalid/viewform'
        config.feedback.referenceEntryId = '12345'
      }
    })
    setSetting(app.storage, { level: 'chat', scope: chatId, key: 'features.feedback', value: true, actor: 'test' })

    const reply = await gateway.send(msg('feedback-legacy', '/report'))
    expect(reply.content).toMatch(
      /^Use this form to report a problem\.\nhttps:\/\/form\.invalid\/viewform\?usp=pp_url&entry\.12345=[a-z2-7]{10}$/
    )
    expect(turn(app)['character_id']).toBe('legacy')
    expect(model.requests).toHaveLength(0)
  })

  it('counts cleared feedback answers once in the daily retention job', async () => {
    const first = await start(queueModel([{ text: 'context' }]), {
      config: (config) => {
        config.archive.enabled = 'off'
      }
    })
    await first.gateway.send(msg('retention-feedback-1', 'context'))
    const turnId = turn(first.app)['turn_id'] as string
    first.app.storage.tx((db) => {
      db.prepare(
        `INSERT INTO feedback_report
           (report_id, ref, chat_id, subject_id, turn_id, turn_ids, state, issued_at, expires_at,
            received_at, form_seq, answers)
         VALUES ('fb_old', 'abcdefghij', ?, 'test-member-alice', ?, '[]', 'received', ?, ?, ?, 1, '{}')`
      ).run(first.chatId, turnId, '2020-01-01T00:00:00.000Z', '2020-01-08T00:00:00.000Z', '2020-01-01T00:00:00.000Z')
      db.prepare("DELETE FROM job_run WHERE kind = 'retention'").run()
    })
    await first.app.close()
    const second = await start(queueModel([]), {
      dataDir: first.dataDir,
      config: (config) => {
        config.archive.enabled = 'off'
      }
    })
    expect(
      second.app.storage.read((db) =>
        db.prepare("SELECT answers FROM feedback_report WHERE report_id = 'fb_old'").pluck().get()
      )
    ).toBeNull()
    const counts = second.app.storage.read((db) =>
      db
        .prepare("SELECT counts FROM job_run WHERE kind = 'retention' AND outcome = 'ok' ORDER BY id DESC LIMIT 1")
        .pluck()
        .get()
    ) as string
    expect(JSON.parse(counts).feedback_answers).toBe(1)
  })

  it('answers /report directly and keeps replying while feedback sync is pending', async () => {
    const endpoint = 'https://feedback.invalid/exec'
    const originalFetch = globalThis.fetch
    let finishSync: (() => void) | undefined
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (String(input) !== endpoint) return originalFetch(input, init)
      return new Promise<Response>((resolve) => {
        finishSync = () => resolve(Response.json({ rows: [], after: 0 }))
      })
    })
    const model = queueModel([])
    try {
      const { app, gateway, chatId, logs } = await start(model, {
        config: (config) => {
          config.feedback.formUrl = 'https://form.invalid/viewform'
          config.feedback.referenceEntryId = '12345'
        },
        env: { FEEDBACK_SYNC_URL: endpoint, FEEDBACK_SYNC_SECRET: 'invented-test-feedback-secret-1234567890' }
      })
      for (const [key, value] of [
        ['features.feedback', true],
        ['commands.maxPerMessage', 2]
      ] as const) {
        setSetting(app.storage, { level: 'chat', scope: chatId, key, value, actor: 'test' })
      }
      const first = await gateway.send(msg('feedback-1', '/report ignore these words /help'))
      expect(first.content).toMatch(/^Tell me what went wrong using this form\.\nhttps:\/\/form\.invalid\/viewform\?/)
      const pending = app.feedback.tick()
      expect(finishSync).toBeDefined()
      const repeated = await gateway.send(msg('feedback-2', '/report /help'))
      expect(repeated.content).toBe(first.content)
      expect(model.requests).toHaveLength(0)
      expect(app.storage.read((db) => db.prepare('SELECT count(*) FROM feedback_report').pluck().get())).toBe(1)
      const receipts = app.storage.read((db) =>
        db.prepare("SELECT kind, target, state FROM receipt WHERE tool = 'feedback_link'").all()
      )
      expect(receipts).toHaveLength(1)
      const exposed = JSON.stringify({ reply: first.content, receipts, logs })
      expect(exposed).not.toContain(CHAT)
      expect(exposed).not.toContain('test-member-alice')
      expect(exposed).not.toContain(chatId)
      finishSync?.()
      await pending
    } finally {
      finishSync?.()
      fetchSpy.mockRestore()
    }
  })

  it('raises one spend alert and failure when calls cross the budget thresholds inside minGapMs', async () => {
    const model = queueModel([
      { text: 'first', costUsd: 8 },
      { text: 'second', costUsd: 2 }
    ])
    const { app, gateway, dataDir, logs } = await start(model, {
      config: (config) => {
        config.llm.monthlyBudgetUsd = 10
      }
    })
    await gateway.send(msg('budget-1', 'first request'))
    await gateway.send(msg('budget-2', 'second request'))
    expect(logs.filter((line) => line['event'] === 'alert' && line['kind'] === 'spend')).toHaveLength(1)
    expect(
      app.storage.read((db) => db.prepare("SELECT kind FROM failure WHERE handled_by = 'operator'").all())
    ).toEqual([{ kind: 'budget' }])
    expect(readFileSync(join(dataDir, 'alerts.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1)
  })

  it('answers a message: six prompt blocks in, a cleaned and rendered reply out, a full turn record', async () => {
    const model = queueModel([
      { text: 'Example: Sure!\n\n# Plan\n* **Dinner** at *six*\n* [menu](https://example.test/menu)' }
    ])
    const { app, gateway } = await start(model)
    const delivery = await gateway.send(msg('m-1', 'what is the plan?'))

    expect(model.requests[0]?.system.map((block) => block.name)).toEqual([
      'core',
      'speech',
      'harness',
      'context',
      'tone',
      'shape'
    ])
    expect(JSON.stringify(model.requests[0]?.system)).not.toContain('what is the plan?')
    expect(model.requests[0]?.messages).toEqual([{ role: 'user', content: '[member 1] what is the plan?' }])
    // The model is offered the tools this chat may use, from the one registry.
    expect(model.requests[0]?.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['reminder_set', 'set_mute'])
    )
    expect(model.requests[0]?.tools.map((tool) => tool.name)).not.toContain('help')

    expect(delivery.content).toBe('Sure!\n\n**Plan**\n\n- **Dinner** at _six_\n- menu https://example.test/menu')
    expect(gatewayMarkdown(delivery.content)).toBe(
      'Sure!\n\n*Plan*\n\n- *Dinner* at _six_\n- menu https://example.test/menu'
    )
    expect(turn(app)).toMatchObject({
      state: 'delivered',
      character_id: 'example',
      mood: 'neutral',
      mood_source: 'rules',
      role: 'main',
      model: 'main-model',
      transport: 'api',
      input_tokens: 100,
      cost_usd: 0.01,
      bubble_count: 1
    })
    expect(turn(app)['shape_seed']).toEqual(expect.any(Number))
    expect(turn(app)['system_tokens']).toBeGreaterThan(100)
    expect(JSON.parse(turn(app)['cleaning_steps'] as string)).toEqual(
      expect.arrayContaining(['speaker_tags', 'lists', 'render'])
    )
  })

  it('runs a tool the model calls: the change, its receipt and the turn record agree', async () => {
    const model = queueModel([
      { toolCalls: [{ id: 'call-1', name: 'set_mute', args: { muted: true } }] },
      { text: 'Okay, I will stay quiet until you unmute me.' }
    ])
    const { app, gateway, chatId } = await start(model)
    const delivery = await gateway.send(msg('m-1', 'please stop the proactive messages'))
    expect(delivery.content).toBe('Okay, I will stay quiet until you unmute me.\n\n_🛠️ changed mute_')

    const read = <T>(sql: string, ...args: unknown[]) => app.storage.read((db) => db.prepare(sql).get(...args) as T)
    const receipt = read<{ receipt_id: string; kind: string; target: string }>(
      'SELECT receipt_id, kind, target FROM receipt'
    )
    expect(receipt).toMatchObject({ kind: 'mute.on', target: chatId })
    expect(JSON.parse(turn(app)['receipts'] as string)).toEqual([receipt.receipt_id])
    expect(read('SELECT tool, source, outcome, args_shape FROM tool_call')).toEqual({
      tool: 'set_mute',
      source: 'model',
      outcome: 'ok',
      args_shape: '{"muted":"boolean"}'
    })
    const muted = JSON.parse(read<{ value: string }>("SELECT value FROM setting WHERE key = 'muted'").value)
    expect(muted.by).toBe(turn(app)['sender_id'])
    // The model read the tool's result before it answered.
    expect(model.requests[1]?.messages.at(-1)).toMatchObject({ role: 'tool', name: 'set_mute' })
    expect(turn(app)['attempts']).toBe(2)
  })

  it('keeps a default reply inside the shape length, and lifts it when the person asks for detail', async () => {
    const long = Array.from({ length: 30 }, (_, n) => `Sentence number ${n + 1} of a long answer.`).join(' ')
    const model = queueModel([{ text: long }])
    const { app, gateway } = await start(model)

    const short = await gateway.send(msg('m-1', 'how does it work?'))
    expect(short.content.length).toBeLessThanOrEqual(280)
    expect(turn(app)['length_bypass']).toBeNull()
    expect(JSON.parse(turn(app)['cleaning_steps'] as string)).toContain('length')

    const full = await gateway.send(msg('m-2', 'explain in detail how it works'))
    expect(full.bubbles.join(' ')).toContain('Sentence number 30 of a long answer.')
    expect(turn(app)['length_bypass']).toBe('format:detail')
    // One text message per reply (format.maxBubbles 1).
    expect(full.bubbles.length).toBe(1)
  })

  it('falls back to the second model with the same prompt and tools: only the model changes', async () => {
    const main = queueModel([new ModelError('rate_limit', 'scripted limit')])
    const fallback = queueModel([{ text: 'The fallback answers' }])
    const { app, gateway } = await start(main, { fallback })
    expect((await gateway.send(msg('m-1', 'hello'))).content).toBe('The fallback answers')

    const { role: _mainRole, model: _mainModel, ...mainRest } = main.requests[0] as ModelRequest
    const { role, model, ...fallbackRest } = fallback.requests[0] as ModelRequest
    expect({ role, model }).toEqual({ role: 'fallback', model: 'fallback-model' })
    expect(fallbackRest).toEqual(mainRest)
    expect(turn(app)).toMatchObject({ state: 'delivered', role: 'fallback', model: 'fallback-model', attempts: 2 })
    const calls = app.storage.read((db) => db.prepare('SELECT role, failure_kind FROM model_call ORDER BY id').all())
    expect(calls).toEqual([
      { role: 'main', failure_kind: 'rate_limit' },
      { role: 'fallback', failure_kind: null }
    ])
    // The breaker is open: the next turn goes straight to the fallback.
    await gateway.send(msg('m-2', 'hello again'))
    expect(main.requests).toHaveLength(1)
  })

  it('sends the error line when both models fail', async () => {
    const { app, gateway } = await start(queueModel([new ModelError('auth', 'scripted')]), {
      fallback: queueModel([new ModelError('transient', 'scripted')]),
      config: (config) => {
        config.llm.maxRetries = 0
      }
    })
    const delivery = await gateway.send(msg('m-1', 'hello'))
    expect(delivery.content).toBe(app.packs().packs.get('example')?.lines.error)
    expect(turn(app)).toMatchObject({ state: 'failed', failure_kind: 'transient' })
  })

  it('stops replies with the limit line at the monthly spend cap', async () => {
    const model = queueModel([{ text: 'An expensive answer', costUsd: 0.6 }])
    const { app, gateway } = await start(model, {
      config: (config) => {
        config.llm.monthlyBudgetUsd = 1
      }
    })
    expect((await gateway.send(msg('m-1', 'one'))).content).toBe('An expensive answer')
    expect((await gateway.send(msg('m-2', 'two'))).content).toBe('An expensive answer')
    const capped = await gateway.send(msg('m-3', 'three'))
    expect(capped.content).toBe(app.packs().packs.get('example')?.lines.limit)
    expect(model.requests).toHaveLength(2)
    expect(turn(app)).toMatchObject({ state: 'failed', failure_kind: 'budget' })
  })

  it('attaches a file a tool made as a MEDIA line with the host path, after the text', async () => {
    const model = queueModel([
      {
        toolCalls: [
          {
            id: 'call-1',
            name: 'make_report',
            args: { title: 'Weekly notes', sections: [{ heading: 'Summary', body: 'An invented report body.' }] }
          }
        ]
      },
      { text: 'Here is the report.' }
    ])
    const { app, gateway, dataDir } = await start(model)
    const delivery = await gateway.send(msg('m-1', '/doc weekly notes in markdown'))
    expect(delivery.bubbles).toEqual(['Here is the report.\n\n_🛠️ wrote a report_'])
    expect(delivery.media).toHaveLength(1)
    expect(delivery.media[0]).toMatch(/^\/host\/aira-data\/files\/[0-9a-f]{2}\/[0-9a-f]{64}\.md$/)
    // The same file exists on the data volume, where the gateway reads it through the host path.
    const local = (delivery.media[0] as string).replace('/host/aira-data', dataDir)
    expect(readFileSync(local, 'utf8')).toBe('# Weekly notes\n\n## Summary\n\nAn invented report body.')
    expect(JSON.parse(turn(app)['attachments'] as string)).toEqual(delivery.media)
  })

  it('/doc writes a PDF by default', async () => {
    const noteRenderer = async () => ({ pdf: Buffer.from('%PDF-1.4\nnote'), pages: 1 })
    const model = queueModel([
      {
        toolCalls: [
          {
            id: 'call-1',
            name: 'make_report',
            args: { title: 'Weekly notes', sections: [{ heading: 'Overview', body: 'All tasks on track.' }] }
          }
        ]
      },
      { text: 'Here is the PDF.' }
    ])
    const { app, gateway, dataDir } = await start(model, { ports: { noteRenderer } })
    const delivery = await gateway.send(msg('m-1', '/doc weekly notes'))
    expect(delivery.media).toHaveLength(1)
    expect(delivery.media[0]).toMatch(/^\/host\/aira-data\/files\/[0-9a-f]{2}\/[0-9a-f]{64}\.pdf$/)
    const local = (delivery.media[0] as string).replace('/host/aira-data', dataDir)
    expect(readFileSync(local).toString('ascii')).toBe('%PDF-1.4\nnote')
    expect(turn(app)).toMatchObject({ kind: 'command', state: 'delivered' })
    expect(model.requests[0]?.tools.map((tool) => tool.name)).toEqual(['make_report'])
  })

  it('/doc writes Markdown when the message says md or markdown', async () => {
    let renderedPdfCount = 0
    const noteRenderer = async () => {
      renderedPdfCount += 1
      return { pdf: Buffer.from('%PDF-1.4\nnote'), pages: 1 }
    }
    const model = queueModel([
      {
        toolCalls: [
          {
            id: 'call-1',
            name: 'make_report',
            args: { title: 'Short MD', sections: [{ heading: 'One', body: 'First body.' }] }
          }
        ]
      },
      { text: 'Sent as md.' },
      {
        toolCalls: [
          {
            id: 'call-2',
            name: 'make_report',
            args: { title: 'Long Markdown', sections: [{ heading: 'Two', body: 'Second body.' }] }
          }
        ]
      },
      { text: 'Sent as markdown.' }
    ])
    const { gateway, dataDir } = await start(model, { ports: { noteRenderer } })

    const mdDelivery = await gateway.send(msg('m-1', '/doc notes in MD please'))
    expect(mdDelivery.media[0]).toMatch(/\.md$/)
    expect(readFileSync((mdDelivery.media[0] as string).replace('/host/aira-data', dataDir), 'utf8')).toBe(
      '# Short MD\n\n## One\n\nFirst body.'
    )

    const markdownDelivery = await gateway.send(msg('m-2', '/doc notes as Markdown'))
    expect(markdownDelivery.media[0]).toMatch(/\.md$/)
    expect(readFileSync((markdownDelivery.media[0] as string).replace('/host/aira-data', dataDir), 'utf8')).toBe(
      '# Long Markdown\n\n## Two\n\nSecond body.'
    )
    expect(renderedPdfCount).toBe(0)
  })

  it("the chat's report.defaultFormat picks the format when the message names none", async () => {
    const noteRenderer = async () => ({ pdf: Buffer.from('%PDF-1.4\noverride'), pages: 1 })
    const model = queueModel([
      {
        toolCalls: [
          {
            id: 'call-1',
            name: 'make_report',
            args: { title: 'Default MD', sections: [{ heading: 'Notes', body: 'From chat default.' }] }
          }
        ]
      },
      { text: 'Default markdown sent.' },
      {
        toolCalls: [
          {
            id: 'call-2',
            name: 'make_report',
            args: { title: 'Explicit PDF', sections: [{ heading: 'Notes', body: 'Message wins.' }] }
          }
        ]
      },
      { text: 'PDF override sent.' }
    ])
    const { app, gateway, chatId, dataDir } = await start(model, { ports: { noteRenderer } })
    setSetting(app.storage, {
      level: 'chat',
      scope: chatId,
      key: 'report.defaultFormat',
      value: 'markdown',
      actor: 'test'
    })

    const d1 = await gateway.send(msg('m-1', '/doc project notes'))
    expect(d1.media[0]).toMatch(/\.md$/)
    expect(readFileSync((d1.media[0] as string).replace('/host/aira-data', dataDir), 'utf8')).toBe(
      '# Default MD\n\n## Notes\n\nFrom chat default.'
    )

    const d2 = await gateway.send(msg('m-2', '/doc project notes as PDF'))
    expect(d2.media[0]).toMatch(/\.pdf$/)
  })

  it('/report no longer runs make_report', async () => {
    const model = queueModel([{ text: 'I noted your feedback.' }])
    const { app, gateway } = await start(model)
    const delivery = await gateway.send(msg('m-1', '/report reminders broke today'))
    expect(delivery.content).toBe('I noted your feedback.')
    expect(delivery.media).toEqual([])
    expect(turn(app)).toMatchObject({ kind: 'reply', state: 'delivered' })
    expect(model.requests[0]?.tools.map((tool) => tool.name)).toContain('make_report')
    expect(model.requests[0]?.tools.length).toBeGreaterThan(1)
    expect(
      app.storage.read((db) =>
        db.prepare('SELECT count(*) FROM tool_call WHERE turn_id = ?').pluck().get(turn(app)['turn_id'])
      )
    ).toBe(0)
  })

  it('writes the wanted-jobs file for the gateway schedule at start-up', async () => {
    const dataDir = tmpDir('aira-app-')
    await start(queueModel([]), { dataDir })
    const body = JSON.parse(readFileSync(join(dataDir, 'gateway', 'schedule.json'), 'utf8'))
    expect(body).toMatchObject({ version: 1, reminders: [] })
  })

  it('follows a reply with one sticker for its mood, never the same one twice in a row, and none when switched off', async () => {
    const dataDir = tmpDir('aira-app-')
    addPack(dataDir, 'second')
    const pack = join(dataDir, 'characters', 'second')
    mkdirSync(join(pack, 'stickers'))
    // The header of an extended WebP file with a 512 by 512 canvas: all the validator reads.
    const sticker = Buffer.alloc(30)
    sticker.write('RIFF', 0, 'ascii')
    sticker.writeUInt32LE(22, 4)
    sticker.write('WEBPVP8X', 8, 'ascii')
    sticker.writeUIntLE(511, 24, 3)
    sticker.writeUIntLE(511, 27, 3)
    for (const file of ['calm-one.webp', 'calm-two.webp']) writeFileSync(join(pack, 'stickers', file), sticker)
    const moods = join(pack, 'moods.yml')
    writeFileSync(
      moods,
      readFileSync(moods, 'utf8').replace(
        '    stickers: []',
        '    stickers:\n      - calm-one.webp\n      - calm-two.webp'
      )
    )

    const { app, gateway, chatId } = await start(queueModel([{ text: 'A calm answer.' }]), {
      dataDir,
      character: 'second'
    })
    const sent: string[] = []
    for (const mid of ['m-1', 'm-2', 'm-3', 'm-4']) {
      const delivery = await gateway.send(msg(mid, 'is that okay?'))
      expect(delivery.bubbles).toEqual(['A calm answer.'])
      expect(delivery.media).toHaveLength(1)
      expect(delivery.media[0]).toMatch(/^\/host\/aira-data\/characters\/second\/stickers\/calm-(one|two)\.webp$/)
      // The sticker is the last line of the content, after the text.
      expect(delivery.content.split('\n').at(-1)).toBe(`MEDIA:${delivery.media[0]}`)
      sent.push(delivery.media[0] as string)
    }
    for (let n = 1; n < sent.length; n++) expect(sent[n]).not.toBe(sent[n - 1])
    expect(turn(app)).toMatchObject({ mood: 'neutral', sticker_id: expect.stringMatching(/^calm-/) })

    setSetting(app.storage, { level: 'chat', scope: chatId, key: 'expressions', value: false, actor: 'test' })
    expect((await gateway.send(msg('m-5', 'is that okay?'))).media).toEqual([])
  })

  it('sends text only for a pack with no sticker', async () => {
    const { gateway } = await start(queueModel([{ text: 'Plain text.' }]))
    expect(await gateway.send(msg('m-1', 'hello?'))).toMatchObject({ bubbles: ['Plain text.'], media: [] })
  })

  it('writes the default pack line the gateway sends when the core cannot be reached, and follows a new default', async () => {
    const dataDir = tmpDir('aira-app-')
    addPack(dataDir, 'second')
    const { app, gateway } = await start(queueModel([{ text: 'hello' }]), { dataDir })
    const file = join(dataDir, 'gateway', 'unavailable.txt')
    // The default character is set after start-up in this test, so the line appears with the first turn.
    await gateway.send(msg('m-1', 'hello'))
    expect(readFileSync(file, 'utf8')).toBe(`${app.packs().packs.get('example')?.lines.unavailable}\n`)

    const line = 'A different invented line for the second pack.'
    const lines = join(dataDir, 'characters', 'second', 'lines.yml')
    writeFileSync(lines, readFileSync(lines, 'utf8').replace(/^unavailable: .*$/m, `unavailable: '${line}'`))
    setSetting(app.storage, { level: 'global', scope: '', key: 'character', value: 'second', actor: 'test' })
    app.refreshUnavailableLine()
    expect(readFileSync(file, 'utf8')).toBe(`${line}\n`)
  })

  it('reports ready, the turns in flight and the newest snapshot on the health endpoint', async () => {
    const { app, baseUrl } = await start(queueModel([{ text: 'hello' }]))
    expect(await (await fetch(`${baseUrl}/health`)).json()).toEqual({ status: 'ready', activeTurns: 0 })
    const snapshot = await app.snapshot('deploy')
    expect(snapshot.state).toBe('verified')
    expect(await (await fetch(`${baseUrl}/health`)).json()).toEqual({
      status: 'ready',
      activeTurns: 0,
      snapshot: { id: snapshot.id, state: 'verified', reason: 'deploy' }
    })
  })

  it('masks a secret from the environment in every log line', async () => {
    const dataDir = tmpDir('aira-app-')
    const secret = ['an', 'invented', 'model', 'key'].join('-')
    const lines: string[] = []
    const original = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string) => {
      lines.push(String(chunk))
      return true
    }) as typeof process.stdout.write
    try {
      const config = testConfig((config) => {
        config.storage.path = dataDir
        config.storage.minFreeMb = 2
        config.storage.criticalFreeMb = 1
        config.llm.main = {
          ...config.llm.main,
          provider: 'openai-compatible',
          model: 'm',
          baseUrl: 'https://main.invalid/v1'
        }
      })
      const failing: ModelClient = {
        call: async () => {
          throw new ModelError('auth', `401 for ${secret}`)
        }
      }
      const app = await createApp({ config, env: { LLM_API_KEY: secret }, clients: { main: failing } })
      apps.push(app)
      const address = await app.listen(0, '127.0.0.1')
      setSetting(app.storage, { level: 'global', scope: '', key: 'character', value: 'example', actor: 'test' })
      const chat = ensureChat(app.storage, { waId: CHAT, type: 'group' })
      setChatStatus(app.storage, { chatId: chat.chatId, status: 'active', actor: 'test' })
      await new FakeGateway({ baseUrl: `http://127.0.0.1:${address.port}` }).send(msg('m-1', 'hello'))
      const stored = app.storage.read((db) => JSON.stringify(db.prepare('SELECT message, stack FROM failure').all()))
      expect(stored).not.toContain(secret)
    } finally {
      process.stdout.write = original
    }
    expect(lines.join('')).toContain('[secret]')
    expect(lines.join('')).not.toContain(secret)
  })

  it('logs records.weak_secret with key names only when an env secret is shorter than 4 characters', async () => {
    const weakValue = 'xyz'
    const { logs } = await start(queueModel([{ text: 'ok' }]), {
      env: { EXA_API_KEY: weakValue, LLM_API_KEY: 'abcd', OPENAI_API_KEY: '' }
    })
    const warnings = logs.filter((line) => line['event'] === 'records.weak_secret')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatchObject({ level: 'warn', event: 'records.weak_secret', keys: ['EXA_API_KEY'] })
    expect(JSON.stringify(warnings[0])).not.toContain(weakValue)
  })

  it('has the page reader built in, and it refuses a private address', async () => {
    const model = queueModel([
      { toolCalls: [{ id: 'c1', name: 'read_page', args: { url: 'http://127.0.0.1:1/private' } }] },
      { text: 'I cannot open that address.' }
    ])
    const { app, gateway } = await startApp(model)
    await gateway.send(msg('m-1', 'read http://127.0.0.1:1/private for me'))
    const toolResult = model.requests[1]?.messages.at(-1)?.content ?? ''
    expect(toolResult).toContain('You cannot do that here.')
    expect(toolResult).not.toContain('forbidden address')
    expect(toolResult).not.toContain('not set up')
    expect(
      app.storage.read((db) => db.prepare('SELECT outcome FROM tool_call').all()) as { outcome: string }[]
    ).toEqual([{ outcome: 'refused' }])
  })

  it('alerts the operator when a write fails with an I/O error, and keeps running', async () => {
    const { app, gateway, logs, baseUrl } = await startApp(queueModel([{ text: 'hello' }]))
    await gateway.send(msg('m-1', 'first'))
    // Fill the database file: cap its size, then write until a write is refused.
    app.storage.tx((db) => db.pragma(`max_page_count = ${db.pragma('page_count', { simple: true }) as number}`))
    let refused = false
    for (let index = 0; index < 500 && !refused; index += 1) {
      try {
        app.storage.tx((db) =>
          db
            .prepare("INSERT INTO session_message (chat_id, role, content, created_at) VALUES ('filler', 'user', ?, ?)")
            .run('x'.repeat(2000), new Date().toISOString())
        )
      } catch {
        refused = true
      }
    }
    expect(refused).toBe(true)
    expect(logs.some((line) => line['event'] === 'storage.write_failed' && line['kind'] === 'storage_error')).toBe(true)
    expect(
      logs.some((line) => line['event'] === 'alert' && line['kind'] === 'storage' && line['level'] === 'error')
    ).toBe(true)
    expect((await fetch(`${baseUrl}/health`)).status).toBeLessThan(600)
  })

  it('stops start-up with one clear message when the model is not configured', async () => {
    const config = testConfig((config) => {
      config.storage.path = tmpDir('aira-app-')
      config.storage.minFreeMb = 2
      config.storage.criticalFreeMb = 1
    })
    const quiet = createLogger({ level: 'error', module: 'core', sink: () => {} })
    await expect(createApp({ config, env: {}, logger: quiet })).rejects.toThrow(ConfigError)
    config.llm.main = {
      ...config.llm.main,
      provider: 'openai-compatible',
      model: 'm',
      baseUrl: 'https://main.invalid/v1'
    }
    await expect(createApp({ config, env: {}, logger: quiet })).rejects.toThrow(/LLM_API_KEY/)
    // The subscription transport needs no main model behind a key, but it needs the host runner's secret.
    config.llm.transport = 'subscription'
    config.llm.main = { ...config.llm.main, provider: '', model: '', baseUrl: '' }
    await expect(createApp({ config, env: {}, logger: quiet })).rejects.toThrow(/RUNNER_TOKEN/)
    expect(existsSync(join(config.storage.path, 'aira.db'))).toBe(true)
  })

  it('records a failure row and model_call row with job_id when research fails with ModelError', async () => {
    const secret = 'app-research-secret-999'
    const failing: ModelClient = {
      call: async () => {
        throw new ModelError('malformed', `HTTP 400: invalid_request_error (${secret})`)
      }
    }
    const { app, gateway, logs } = await start(failing, { env: { LLM_API_KEY: secret } })
    await gateway.send(msg('m-1', '/research private subject 1234567890@lid'))
    const job = app.storage.read((db) => db.prepare('SELECT job_id FROM research_job').get()) as { job_id: string }
    expect(await app.research.tick()).toBe('failed')

    const failure = app.storage.read((db) =>
      db.prepare('SELECT job_id, stage, kind, message, handled_by FROM failure WHERE job_id = ?').get(job.job_id)
    ) as Record<string, unknown>
    expect(failure).toEqual({
      job_id: job.job_id,
      stage: 'research',
      kind: 'malformed',
      message: 'HTTP 400: invalid_request_error ([secret])',
      handled_by: 'line:researchFailed'
    })

    const modelCalls = app.storage.read((db) =>
      db
        .prepare(
          'SELECT job_id, turn_id, role, model, transport, attempt, failure_kind FROM model_call WHERE job_id = ?'
        )
        .all(job.job_id)
    ) as Record<string, unknown>[]
    expect(modelCalls).toEqual([
      {
        job_id: job.job_id,
        turn_id: null,
        role: 'main',
        model: 'main-model',
        transport: 'api',
        attempt: 1,
        failure_kind: 'malformed'
      }
    ])

    const failedLog = logs.find((entry) => entry['event'] === 'research.job_failed')
    expect(failedLog).toMatchObject({
      job_id: job.job_id,
      kind: 'malformed',
      message: 'HTTP 400: invalid_request_error ([secret])'
    })
    expect(JSON.stringify(failedLog)).not.toContain('private subject')
    expect(JSON.stringify(failedLog)).not.toContain('1234567890@lid')
    expect(JSON.stringify(failedLog)).not.toContain(secret)
  })

  it('records model_call rows with job_id when research succeeds', async () => {
    const doc = {
      title: 'A report',
      question: 'A question?',
      summary: 'A summary',
      keyFindings: [1, 2, 3].map((n) => ({ text: `Finding ${n}`, sources: [1] })),
      sections: [1, 2].map((n) => ({ heading: `Section ${n}`, body: 'Body', sources: [1] })),
      limitations: [],
      sources: [{ n: 1, title: 'Source', url: 'https://example.com/' }]
    }
    const model = queueModel([
      { text: JSON.stringify({ queries: ['q1', 'q2', 'q3'] }), costUsd: 0.02 },
      { text: JSON.stringify(doc), costUsd: 0.03 }
    ])
    const { app, gateway } = await start(model, {
      ports: {
        search: { search: async () => [{ title: 'Source', url: 'https://example.com/', snippet: '' }] },
        page: {
          read: async () => ({ title: 'Source', text: 'Read text.' }),
          download: async () => ({ data: Buffer.alloc(0), contentType: 'text/plain' })
        }
      }
    })
    await gateway.send(msg('m-1', '/research test topic'))
    const job = app.storage.read((db) => db.prepare('SELECT job_id FROM research_job').get()) as { job_id: string }
    expect(await app.research.tick()).toBe('done')

    const modelCalls = app.storage.read((db) =>
      db
        .prepare(
          'SELECT job_id, turn_id, role, model, failure_kind, cost_usd FROM model_call WHERE job_id = ? ORDER BY id'
        )
        .all(job.job_id)
    ) as Record<string, unknown>[]
    expect(modelCalls).toEqual([
      { job_id: job.job_id, turn_id: null, role: 'main', model: 'main-model', failure_kind: null, cost_usd: 0.02 },
      { job_id: job.job_id, turn_id: null, role: 'main', model: 'main-model', failure_kind: null, cost_usd: 0.03 }
    ])
  })
})

describe('per-chat tool call limit', () => {
  const TEST_CHAT = '0000000000@g.us'
  const TEST_SENDER = '0000000000@s.whatsapp.net'
  const sendToTestChat = (gateway: FakeGateway, mid: string, text: string) =>
    gateway.send({ chat: { waId: TEST_CHAT, kind: 'group' }, sender: TEST_SENDER, mid, text })
  const activateTestChat = (app: App) => {
    const chat = ensureChat(app.storage, { waId: TEST_CHAT, type: 'group' })
    setChatStatus(app.storage, { chatId: chat.chatId, status: 'active', actor: 'test' })
    return chat.chatId
  }

  it('defaults to 3 tool calls per message', async () => {
    const model = queueModel([
      { toolCalls: [{ id: 'c1', name: 'recall', args: { query: 'one' } }] },
      { toolCalls: [{ id: 'c2', name: 'recall', args: { query: 'two' } }] },
      { toolCalls: [{ id: 'c3', name: 'recall', args: { query: 'three' } }] },
      { text: 'Stopped at three.', toolCalls: [{ id: 'c4', name: 'recall', args: { query: 'four' } }] }
    ])
    const { app, gateway } = await start(model)
    const chatId = activateTestChat(app)
    const delivery = await sendToTestChat(gateway, 'm-1', 'check memory')
    expect(delivery.content).toContain('Stopped at three.')
    expect(model.requests[2]?.tools.length).toBeGreaterThan(0)
    expect(model.requests[3]?.tools).toEqual([])
    const calls = app.storage.read((db) =>
      db.prepare('SELECT tool FROM tool_call WHERE turn_id = ?').all(turn(app)['turn_id'])
    )
    expect(calls).toHaveLength(3)
    expect(turn(app)).toMatchObject({ chat_id: chatId, chain_limit: 'calls' })
  })

  it('stops after one call when tools.maxPerMessage is 1', async () => {
    const model = queueModel([
      { toolCalls: [{ id: 'c1', name: 'recall', args: { query: 'one' } }] },
      { text: 'Stopped at one.', toolCalls: [{ id: 'c2', name: 'recall', args: { query: 'two' } }] }
    ])
    const { app, gateway } = await start(model)
    const chatId = activateTestChat(app)
    setSetting(app.storage, { level: 'chat', scope: chatId, key: 'tools.maxPerMessage', value: 1, actor: 'test' })
    const delivery = await sendToTestChat(gateway, 'm-1', 'check one thing')
    expect(delivery.content).toContain('Stopped at one.')
    expect(model.requests[0]?.tools.length).toBeGreaterThan(0)
    expect(model.requests[1]?.tools).toEqual([])
    const calls = app.storage.read((db) =>
      db.prepare('SELECT tool FROM tool_call WHERE turn_id = ?').all(turn(app)['turn_id'])
    )
    expect(calls).toHaveLength(1)
    expect(turn(app)).toMatchObject({ chat_id: chatId, chain_limit: 'calls' })
  })

  it('caps a higher per-chat setting at the config ceiling', async () => {
    const model = queueModel([
      { toolCalls: [{ id: 'c1', name: 'recall', args: { query: 'one' } }] },
      { toolCalls: [{ id: 'c2', name: 'recall', args: { query: 'two' } }] },
      { text: 'Capped at two.', toolCalls: [{ id: 'c3', name: 'recall', args: { query: 'three' } }] }
    ])
    const { app, gateway } = await start(model, {
      config: (config) => {
        config.tools.maxCallsPerTurn = 2
      }
    })
    const chatId = activateTestChat(app)
    setSetting(app.storage, { level: 'chat', scope: chatId, key: 'tools.maxPerMessage', value: 6, actor: 'test' })
    const delivery = await sendToTestChat(gateway, 'm-1', 'check ceiling')
    expect(delivery.content).toContain('Capped at two.')
    expect(model.requests[1]?.tools.length).toBeGreaterThan(0)
    expect(model.requests[2]?.tools).toEqual([])
    const calls = app.storage.read((db) =>
      db.prepare('SELECT tool FROM tool_call WHERE turn_id = ?').all(turn(app)['turn_id'])
    )
    expect(calls).toHaveLength(2)
    expect(turn(app)).toMatchObject({ chat_id: chatId, chain_limit: 'calls' })
  })

  it('allows N commands to make N calls even when tools.maxPerMessage is 1', async () => {
    const dueAt = new Date(Date.now() + 3_600_000).toISOString()
    const model = queueModel([
      {
        toolCalls: [
          { id: 'c1', name: 'reminder_set', args: { text: 'buy milk', dueAt } },
          { id: 'c2', name: 'history_search', args: { query: 'tea' } },
          { id: 'c3', name: 'recall', args: { query: 'tea' } }
        ]
      },
      { text: 'All three commands ran.' }
    ])
    const { app, gateway } = await start(model)
    const chatId = activateTestChat(app)
    setSetting(app.storage, { level: 'chat', scope: chatId, key: 'tools.maxPerMessage', value: 1, actor: 'test' })
    setSetting(app.storage, { level: 'chat', scope: chatId, key: 'commands.maxPerMessage', value: 3, actor: 'test' })
    const delivery = await sendToTestChat(gateway, 'm-1', '/remind me to buy milk /history tea /recall tea')
    expect(delivery.content).toContain('All three commands ran.')
    expect(model.requests[1]?.tools).toEqual([])
    const calls = app.storage.read((db) =>
      db.prepare('SELECT tool, outcome FROM tool_call WHERE turn_id = ? ORDER BY rowid').all(turn(app)['turn_id'])
    )
    expect(calls).toEqual([
      { tool: 'reminder_set', outcome: 'ok' },
      { tool: 'history_search', outcome: 'ok' },
      { tool: 'recall', outcome: 'ok' }
    ])
    expect(turn(app)).toMatchObject({ chat_id: chatId, chain_limit: 'calls' })
  })
})

describe('per-chat live context', () => {
  const TEST_CHAT = '0000000000@g.us'
  const TEST_SENDER = '0000000000@s.whatsapp.net'
  const sendToTestChat = (gateway: FakeGateway, mid: string, text: string) =>
    gateway.send({ chat: { waId: TEST_CHAT, kind: 'group' }, sender: TEST_SENDER, mid, text })
  const activateTestChat = (app: App) => {
    const chat = ensureChat(app.storage, { waId: TEST_CHAT, type: 'group' })
    setChatStatus(app.storage, { chatId: chat.chatId, status: 'active', actor: 'test' })
    return chat.chatId
  }

  it('sends no earlier messages to the model when features.context is false, while still logging to session_message', async () => {
    const model = queueModel([{ text: 'First reply.' }, { text: 'Second reply.' }, { text: 'Third reply.' }])
    const { app, gateway } = await start(model)
    const chatId = activateTestChat(app)
    setSetting(app.storage, { level: 'chat', scope: chatId, key: 'features.context', value: false, actor: 'test' })

    await sendToTestChat(gateway, 'm-1', 'first secret word pineapple')
    await sendToTestChat(gateway, 'm-2', 'second question now')
    setSetting(app.storage, { level: 'chat', scope: chatId, key: 'context.maxMessages', value: 0, actor: 'test' })
    await sendToTestChat(gateway, 'm-3', 'third question now')

    expect(model.requests[1]?.messages).toEqual([{ role: 'user', content: '[member 1] second question now' }])
    expect(model.requests[2]?.messages).toEqual([{ role: 'user', content: '[member 1] third question now' }])
    const logged = app.storage.read((db) =>
      db.prepare('SELECT role, content FROM session_message WHERE chat_id = ? ORDER BY id').all(chatId)
    )
    expect(logged).toEqual([
      { role: 'user', content: 'first secret word pineapple' },
      { role: 'assistant', content: 'First reply.' },
      { role: 'user', content: 'second question now' },
      { role: 'assistant', content: 'Second reply.' },
      { role: 'user', content: 'third question now' },
      { role: 'assistant', content: 'Third reply.' }
    ])
  })

  it('limits the prompt window to context.maxMessages 5', async () => {
    const model = queueModel([
      { text: 'Reply 1.' },
      { text: 'Reply 2.' },
      { text: 'Reply 3.' },
      { text: 'Reply 4.' },
      { text: 'Reply 5.' }
    ])
    const { app, gateway } = await start(model)
    const chatId = activateTestChat(app)
    setSetting(app.storage, { level: 'chat', scope: chatId, key: 'context.maxMessages', value: 5, actor: 'test' })

    for (let index = 1; index <= 5; index += 1) {
      await sendToTestChat(gateway, `m-${index}`, `turn ${index}`)
    }

    expect(model.requests[4]?.messages).toEqual([
      { role: 'user', content: '[member 1] turn 3' },
      { role: 'assistant', content: 'Reply 3.' },
      { role: 'user', content: '[member 1] turn 4' },
      { role: 'assistant', content: 'Reply 4.' },
      { role: 'user', content: '[member 1] turn 5' }
    ])
    expect(turn(app)).toMatchObject({ chat_id: chatId, window_size: 5 })
  })
})
