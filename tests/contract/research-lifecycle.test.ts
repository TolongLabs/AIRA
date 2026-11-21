import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { loadPack } from '../../src/character/loader.js'
import { withAttachments } from '../../src/format/attachments.js'
import { createReplyCleaner } from '../../src/format/clean.js'
import { parseGatewayRequest } from '../../src/gateway/request.js'
import { scheduleEntries, writeScheduleFile } from '../../src/gateway/schedule.js'
import { ModelError } from '../../src/models/types.js'
import { createLogger } from '../../src/records/logger.js'
import { createRedactor } from '../../src/records/redact.js'
import { createResearchOffers } from '../../src/research/offer.js'
import { createResearchWorker } from '../../src/research/worker.js'
import { ensureChat, ensureSubject, setChatStatus } from '../../src/settings/chats.js'
import { resolveSettings, setSetting } from '../../src/settings/settings.js'
import { enqueueJob, leaseNextJob, releaseLeases } from '../../src/storage/leases.js'
import { openTurn, receiveInbound } from '../../src/storage/turns.js'
import { createCommandRouter } from '../../src/tools/commands.js'
import { registerCoreTools } from '../../src/tools/core/index.js'
import { createToolRegistry } from '../../src/tools/registry.js'
import { basicPromptBuilder } from '../../src/turn/defaults.js'
import { createTurnService } from '../../src/turn/pipeline.js'
import { createTurnSources } from '../../src/turn/sources.js'
import type { TurnContext } from '../../src/turn/types.js'
import { scriptedRunner, testConfig } from '../support/core.js'
import { tmpDir, tmpStorage } from '../support/tmp.js'

const pack = loadPack('characters/example', 'repository')
const instant = '2026-11-17T00:00:00.000Z'
const document = {
  title: 'Test findings',
  question: 'What is known?',
  summary: 'A short summary.',
  keyFindings: [1, 2, 3].map((n) => ({ text: `Finding ${n}`, sources: [1] })),
  sections: [1, 2].map((n) => ({ heading: `Section ${n}`, body: 'Source text.', sources: [1] })),
  limitations: [],
  sources: [{ n: 1, title: 'Source', url: 'https://example.com/', domain: 'example.com', accessedAt: instant }]
}

function fixture(replyText = 'The findings are ready.') {
  const storage = tmpStorage()
  const filesDir = tmpDir()
  let clock = new Date(instant)
  const now = () => clock
  const chat = ensureChat(storage, { waId: '0000000000@g.us', type: 'group' })
  setChatStatus(storage, { chatId: chat.chatId, status: 'active', actor: 'test' })
  const senderId = ensureSubject(storage, '0000000000@lid', now)
  setSetting(storage, { level: 'global', scope: '', key: 'character', value: 'example', actor: 'test' })
  const logger = createLogger({ level: 'error', module: 'test', sink: () => {} })
  const redactor = createRedactor()
  const renderer = vi.fn(async () => ({ pdf: Buffer.from('%PDF-test'), pages: 1 }))
  const research = createResearchOffers({ storage, filesDir, hostDataDir: '/host', renderer, offerMinutes: 30, now })
  const registry = createToolRegistry({ storage, config: { tools: { defaultTimeoutMs: 1000 } }, logger, redactor, now })
  registerCoreTools(registry, { filesDir, research })
  const commands = createCommandRouter(registry)
  let seq = 0
  const context = (): TurnContext => {
    const turnId = `turn-${++seq}`
    receiveInbound(storage, { chatId: chat.chatId, mid: turnId, senderId }, now)
    openTurn(storage, { turnId, chatId: chat.chatId, senderId, kind: 'reply', mids: [turnId] }, now)
    return {
      turnId,
      chat,
      senderId,
      character: pack,
      settings: resolveSettings(storage, chat),
      kind: 'reply',
      delivery: { kind: 'reply' },
      deadline: clock.getTime() + 10000,
      sources: createTurnSources()
    }
  }
  const queue = (id = 'res_test', wantsPdf = false) =>
    storage.tx((db) => {
      enqueueJob(
        db,
        'research_job',
        {
          jobId: id,
          chatId: chat.chatId,
          payload: JSON.stringify({ topic: 'A topic' }),
          requesterId: senderId,
          topic: 'A topic',
          wantsPdf
        },
        now
      )
    })
  const ready = (wantsPdf = false) => {
    queue('res_test', wantsPdf)
    storage.tx((db) =>
      db
        .prepare("UPDATE research_job SET state = 'done', findings = ?, ended_at = ? WHERE job_id = 'res_test'")
        .run(JSON.stringify(document), instant)
    )
  }
  const row = () => storage.read((db) => db.prepare('SELECT * FROM research_job').get()) as Record<string, unknown>
  const runner = scriptedRunner(() => replyText)
  const baseCleaner = createReplyCleaner(testConfig())
  let spendAllows = true
  const turns = createTurnService({
    storage,
    config: testConfig(),
    logger,
    redactor,
    packs: () => ({ packs: new Map([['example', pack]]), faults: [] }),
    runner,
    prompt: basicPromptBuilder,
    research,
    commands,
    tools: registry,
    alerter: { raise: () => true },
    hooks: { spendAllows: () => spendAllows },
    now,
    cleaner: withAttachments(
      {
        clean: (input) => {
          const cleaned = baseCleaner.clean(input)
          return { ...cleaned, content: `${cleaned.content}\nMEDIA:/host/stickers/test.webp` }
        }
      },
      { storage, hostDataDir: '/host' }
    )
  })
  const message = (text: string, sender = '0000000000@lid') =>
    turns.handle({
      type: 'turn',
      marker: { platform: 'whatsapp', kind: 'group', chat: '0000000000@g.us', sender, mid: `message-${++seq}` },
      text,
      earlier: '',
      attachments: [],
      stream: false,
      includeUsage: false
    })
  const deliver = () =>
    turns.handleScheduled({
      type: 'scheduled',
      kind: 'research',
      jobId: 'res_test',
      stream: false,
      includeUsage: false
    })
  return {
    storage,
    filesDir,
    research,
    renderer,
    registry,
    commands,
    context,
    queue,
    ready,
    row,
    runner,
    turns,
    message,
    deliver,
    now,
    logger,
    chat,
    setSpend: (value: boolean) => {
      spendAllows = value
    },
    setTime: (value: string) => {
      clock = new Date(value)
    }
  }
}

describe('research jobs and delivery', () => {
  it('starts only by direct command and never offers either tool to a model', async () => {
    const f = fixture()
    const ctx = f.context()
    expect(f.registry.offered(ctx).map((tool) => tool.schema.name)).not.toContain('research_start')
    expect(f.registry.offered(ctx).map((tool) => tool.schema.name)).not.toContain('report_pdf')
    expect(
      await f.registry.call('research_start', { topic: 'ignored' }, ctx, { callId: 'implicit', source: 'model' })
    ).toMatchObject({ ok: false })
    expect(f.row()).toBeUndefined()
    const empty = await f.commands.runDirect(f.commands.match('/research', ctx)[0]!, ctx)
    expect(empty.text).toBe(pack.lines.researchTopic)
    expect(f.row()).toBeUndefined()
    const start = f.context()
    expect(await f.commands.runDirect(f.commands.match('/research make a PDF report', start)[0]!, start)).toMatchObject(
      { ok: true, text: pack.lines.researchStarted }
    )
    expect(f.row()).toMatchObject({ wants_pdf: 1, state: 'queued' })
    const busy = f.context()
    expect((await f.commands.runDirect(f.commands.match('/research another topic', busy)[0]!, busy)).text).toBe(
      pack.lines.researchBusy
    )
  })

  it('requeues one running job after restart and fails the next interruption', () => {
    const f = fixture()
    f.queue()
    expect(leaseNextJob(f.storage, 'research_job', { owner: 'dead', leaseMs: 1000 }, f.now)?.attempts).toBe(1)
    releaseLeases(f.storage, 'research_job', undefined, f.now)
    expect(f.row()).toMatchObject({ state: 'queued', attempts: 1 })
    expect(leaseNextJob(f.storage, 'research_job', { owner: 'dead-again', leaseMs: 1000 }, f.now)?.attempts).toBe(2)
    releaseLeases(f.storage, 'research_job', undefined, f.now)
    expect(f.row()).toMatchObject({ state: 'failed', attempts: 2 })
    expect(f.storage.read((db) => scheduleEntries(db))).toHaveLength(1)
  })

  it('writes a done job into the wanted-jobs file and parses its tag', () => {
    const f = fixture()
    f.ready()
    const dir = tmpDir()
    expect(writeScheduleFile(f.storage, dir, f.now)).toBe(1)
    const entries = JSON.parse(readFileSync(join(dir, 'gateway/schedule.json'), 'utf8')).reminders
    expect(entries[0].text).toBe('[AIRA-SCHEDULED v1 kind=research id=res_test]')
    expect(parseGatewayRequest({ tools: [{}], messages: [{ role: 'user', content: entries[0].text }] })).toMatchObject({
      type: 'scheduled',
      kind: 'research',
      jobId: 'res_test'
    })
    expect(
      parseGatewayRequest({
        tools: [{}],
        messages: [
          {
            role: 'user',
            content: `[HERMES-SCOPE v1 platform=whatsapp kind=group chat=0000000000@g.us sender=0000000000@lid mid=1] ${entries[0].text}`
          }
        ]
      })
    ).toMatchObject({ type: 'turn' })
  })

  it('appends the offer in code, stores delivery with the reply, and replays a firing', async () => {
    const f = fixture()
    f.ready()
    const reply = await f.deliver()
    expect(reply?.content).toContain('The findings are ready.')
    expect(reply?.content).toContain(pack.lines.offerPdf)
    expect(reply?.content).toContain('_🔗 example.com_')
    expect(f.row()).toMatchObject({ offer: 'open', delivered_at: instant })
    expect(f.runner.inputs[0]?.messages.at(-1)?.content).toContain('<research_findings untrusted="true">')
    expect(f.runner.inputs[0]?.tools).toHaveLength(0)
    expect((await f.deliver())?.content).toBe(reply?.content)
    expect(f.runner.inputs).toHaveLength(1)
    expect(f.storage.read((db) => scheduleEntries(db))).toHaveLength(0)
  })

  it('wants_pdf skips the offer and attaches the PDF after the sticker', async () => {
    const f = fixture()
    f.ready(true)
    const reply = await f.deliver()
    expect(reply?.content).not.toContain(pack.lines.offerPdf)
    expect(reply?.content).toMatch(/MEDIA:.*stickers.*\nMEDIA:.*\.pdf$/)
    expect(f.renderer).toHaveBeenCalledTimes(1)
    expect(f.row()).toMatchObject({ offer: 'none', delivered_at: instant, report_file_id: expect.any(String) })
  })

  it('accepts only the requester whole-message yes within the expiry', async () => {
    const f = fixture()
    f.ready()
    await f.deliver()
    await f.message('yes', 'other-member')
    await f.message('yes please explain more')
    expect(f.renderer).not.toHaveBeenCalled()
    expect(f.row().offer).toBe('open')
    const accepted = await f.message('YES! 👍')
    expect(accepted.content).toMatch(/MEDIA:.*\.pdf$/)
    expect(f.row().offer).toBe('accepted')
    expect(f.renderer).toHaveBeenCalledTimes(1)
    expect(f.runner.inputs.at(-1)?.tools).toHaveLength(0)
  })

  it('closes on no and handles that message as usual', async () => {
    const f = fixture()
    f.ready()
    await f.deliver()
    await f.message('no')
    expect(f.row().offer).toBe('declined')
    expect(f.runner.inputs).toHaveLength(2)
    expect(f.renderer).not.toHaveBeenCalled()
  })

  it('expires lazily and refuses a late yes', async () => {
    const f = fixture()
    f.ready()
    await f.deliver()
    f.setTime('2026-11-17T00:30:00.000Z')
    await f.message('yes')
    expect(f.row().offer).toBe('expired')
    expect(f.renderer).not.toHaveBeenCalled()
  })

  it('/pdf renders the open offer without a model call', async () => {
    const f = fixture()
    f.ready()
    await f.deliver()
    const reply = await f.message('/pdf')
    expect(reply.content).toMatch(/MEDIA:.*stickers.*\nMEDIA:.*\.pdf$/)
    expect(f.row().offer).toBe('accepted')
    expect(f.runner.inputs).toHaveLength(1)
  })

  it('the worker leases a committed row and records failures for delivery', async () => {
    const f = fixture()
    f.queue()
    const worker = createResearchWorker({
      storage: f.storage,
      config: testConfig(),
      client: { call: vi.fn().mockRejectedValue(new Error('failed')) },
      search: { search: vi.fn() },
      page: { read: vi.fn(), download: vi.fn() },
      schedule: { sync: vi.fn() },
      logger: f.logger,
      now: f.now
    })
    expect(await worker.tick()).toBe('failed')
    expect(f.row().state).toBe('failed')
    expect((await f.deliver())?.content).toBe(pack.lines.researchFailed)
    expect(
      f.storage.read((db) => db.prepare("SELECT count(*) FROM failure WHERE stage = 'research'").pluck().get())
    ).toBe(1)
  })
  it('keeps a research answer within long length and appends the offer outside that limit', async () => {
    const f = fixture('A finding. '.repeat(200))
    f.ready()
    const reply = await f.deliver()
    const text = reply?.content.split('\n\n_')[0] ?? ''
    expect(text.length).toBeGreaterThan(600)
    expect(text.length).toBeLessThanOrEqual(1400)
    expect(reply?.content).toContain(pack.lines.offerPdf)
  })

  it('delivers stored evidence without another model call after the spend cap', async () => {
    const f = fixture()
    f.ready()
    f.setSpend(false)
    const reply = await f.deliver()
    expect(reply?.content).toContain(document.summary)
    expect(reply?.content).toContain(pack.lines.offerPdf)
    expect(f.runner.inputs).toHaveLength(0)
  })

  it('ends a firing with the error line if rendering fails and leaves no hanging wanted job', async () => {
    const f = fixture()
    f.ready(true)
    f.renderer.mockRejectedValueOnce(new Error('engine'))
    const reply = await f.deliver()
    expect(reply?.content).toBe(pack.lines.error)
    expect(f.row()).toMatchObject({ offer: 'none', delivered_at: instant })
    expect(f.storage.read((db) => scheduleEntries(db))).toHaveLength(0)
  })

  it('records the error kind and redacted message on failure rows and logs without topic text', async () => {
    const f = fixture()
    const secret = 'secret-token-999'
    const privateTopic = 'confidential subject 1234567890'
    f.storage.tx((db) =>
      enqueueJob(
        db,
        'research_job',
        {
          jobId: 'res_secret',
          chatId: f.chat.chatId,
          payload: JSON.stringify({ topic: privateTopic }),
          requesterId: 'req-1',
          topic: privateTopic,
          wantsPdf: false
        },
        f.now
      )
    )
    const logs: Record<string, unknown>[] = []
    const redactor = createRedactor({ secrets: [secret] })
    const logger = createLogger({
      level: 'warn',
      module: 'test',
      redactor,
      sink: (line) => logs.push(JSON.parse(line))
    })
    const worker = createResearchWorker({
      storage: f.storage,
      config: testConfig(),
      client: {
        call: vi.fn().mockRejectedValue(new ModelError('malformed', `HTTP 400 with ${secret} and 1234567890@lid`))
      },
      search: { search: vi.fn() },
      page: { read: vi.fn(), download: vi.fn() },
      schedule: { sync: vi.fn() },
      logger,
      redactor,
      now: f.now
    })
    expect(await worker.tick()).toBe('failed')
    const row = f.storage.read((db) =>
      db.prepare('SELECT job_id, stage, kind, message, handled_by FROM failure WHERE job_id = ?').get('res_secret')
    ) as Record<string, unknown>
    expect(row['stage']).toBe('research')
    expect(row['kind']).toBe('malformed')
    expect(row['handled_by']).toBe('line:researchFailed')
    expect(row['message']).toContain('HTTP 400 with [secret] and h:')
    expect(String(row['message'])).not.toContain(secret)
    expect(String(row['message'])).not.toContain('1234567890@lid')
    expect(String(row['message'])).not.toContain(privateTopic)

    const failedLog = logs.find((entry) => entry['event'] === 'research.job_failed')
    expect(failedLog).toMatchObject({ job_id: 'res_secret', kind: 'malformed', message: row['message'] })
    expect(JSON.stringify(failedLog)).not.toContain(secret)
    expect(JSON.stringify(failedLog)).not.toContain('1234567890@lid')
    expect(JSON.stringify(failedLog)).not.toContain(privateTopic)

    f.storage.tx((db) =>
      enqueueJob(
        db,
        'research_job',
        {
          jobId: 'res_internal',
          chatId: f.chat.chatId,
          payload: JSON.stringify({ topic: 'another topic' }),
          requesterId: 'req-1',
          topic: 'another topic',
          wantsPdf: false
        },
        f.now
      )
    )
    const internalWorker = createResearchWorker({
      storage: f.storage,
      config: testConfig(),
      client: { call: vi.fn().mockRejectedValue(new Error('unexpected failure')) },
      search: { search: vi.fn() },
      page: { read: vi.fn(), download: vi.fn() },
      schedule: { sync: vi.fn() },
      logger,
      redactor,
      now: f.now
    })
    expect(await internalWorker.tick()).toBe('failed')
    expect(
      f.storage.read((db) => db.prepare('SELECT kind, message FROM failure WHERE job_id = ?').get('res_internal'))
    ).toEqual({ kind: 'internal', message: 'unexpected failure' })
    expect(
      logs.find((entry) => entry['event'] === 'research.job_failed' && entry['job_id'] === 'res_internal')
    ).toMatchObject({
      kind: 'internal',
      message: 'unexpected failure'
    })
  })
})
