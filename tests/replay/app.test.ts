import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { type App, createApp } from '../../src/app.js'
import { ConfigError } from '../../src/config/loader.js'
import type { Config } from '../../src/config/schema.js'
import { type ModelClient, ModelError, type ModelRequest, type ModelResponse } from '../../src/models/types.js'
import { createLogger } from '../../src/records/logger.js'
import { ensureChat, setChatStatus } from '../../src/settings/chats.js'
import { setSetting } from '../../src/settings/settings.js'
import { FakeGateway, type GatewayMessage } from '../harness/gateway.js'
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
    expect(delivery.content).toBe('Okay, I will stay quiet until you unmute me.')

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
    expect(full.bubbles.length).toBeGreaterThan(1)
    expect(full.bubbles.length).toBeLessThanOrEqual(3)
  })

  it('falls back to the second model with the same prompt and tools: only the model changes', async () => {
    const main = queueModel([new ModelError('rate_limit', 'scripted limit')])
    const fallback = queueModel([{ text: 'the fallback answers' }])
    const { app, gateway } = await start(main, { fallback })
    expect((await gateway.send(msg('m-1', 'hello'))).content).toBe('the fallback answers')

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
    const model = queueModel([{ text: 'an expensive answer', costUsd: 0.6 }])
    const { app, gateway } = await start(model, {
      config: (config) => {
        config.llm.monthlyBudgetUsd = 1
      }
    })
    expect((await gateway.send(msg('m-1', 'one'))).content).toBe('an expensive answer')
    expect((await gateway.send(msg('m-2', 'two'))).content).toBe('an expensive answer')
    const capped = await gateway.send(msg('m-3', 'three'))
    expect(capped.content).toBe(app.packs().packs.get('example')?.lines.limit)
    expect(model.requests).toHaveLength(2)
    expect(turn(app)).toMatchObject({ state: 'failed', failure_kind: 'budget' })
  })

  it('attaches a file a tool made as a MEDIA line with the host path, after the text', async () => {
    const model = queueModel([
      {
        toolCalls: [
          { id: 'call-1', name: 'make_report', args: { title: 'Weekly notes', body: 'An invented report body.' } }
        ]
      },
      { text: 'Here is the report.' }
    ])
    const { app, gateway, dataDir } = await start(model)
    const delivery = await gateway.send(msg('m-1', '/report weekly notes'))
    expect(delivery.bubbles).toEqual(['Here is the report.'])
    expect(delivery.media).toHaveLength(1)
    expect(delivery.media[0]).toMatch(/^\/host\/aira-data\/files\/[0-9a-f]{2}\/[0-9a-f]{64}\.md$/)
    // The same file exists on the data volume, where the gateway reads it through the host path.
    const local = (delivery.media[0] as string).replace('/host/aira-data', dataDir)
    expect(readFileSync(local, 'utf8')).toBe('# Weekly notes\n\nAn invented report body.')
    expect(JSON.parse(turn(app)['attachments'] as string)).toEqual(delivery.media)
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
    await expect(createApp({ config, env: {}, logger: quiet })).rejects.toThrow(/key for llm\.main/)
    // The subscription transport needs no main model behind a key, but it needs the host runner's secret.
    config.llm.transport = 'subscription'
    config.llm.main = { ...config.llm.main, provider: '', model: '', baseUrl: '' }
    await expect(createApp({ config, env: {}, logger: quiet })).rejects.toThrow(/RUNNER_TOKEN/)
    expect(existsSync(join(config.storage.path, 'aira.db'))).toBe(true)
  })
})
