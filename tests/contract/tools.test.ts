import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { loadPack } from '../../src/character/loader.js'
import { createLogger } from '../../src/records/logger.js'
import { createRedactor } from '../../src/records/redact.js'
import { ensureChat, setChatStatus } from '../../src/settings/chats.js'
import { resolveSettings, setSetting } from '../../src/settings/settings.js'
import type { Storage } from '../../src/storage/database.js'
import { openTurn, receiveInbound } from '../../src/storage/turns.js'
import { registerCoreTools } from '../../src/tools/core/index.js'
import { TOOL_FAILURE_KINDS } from '../../src/tools/outcomes.js'
import type { MemoryPort, SchedulePort } from '../../src/tools/ports.js'
import { createToolRegistry, type ToolRegistry } from '../../src/tools/registry.js'
import type { ToolDefinition } from '../../src/tools/types.js'
import { createTurnSources } from '../../src/turn/sources.js'
import type { TurnContext } from '../../src/turn/types.js'
import { tmpDir, tmpStorage } from '../support/tmp.js'

const pack = loadPack('characters/example', 'repository')

function makeRegistry(storage: Storage, defaultTimeoutMs = 200): ToolRegistry {
  return createToolRegistry({
    storage,
    config: { tools: { defaultTimeoutMs } },
    logger: createLogger({ level: 'error', module: 'tools-test', sink: () => {} }),
    redactor: createRedactor()
  })
}

let seq = 0
function makeContext(
  storage: Storage,
  options: { chatWaId?: string; senderId?: string; turnId?: string; mid?: string } = {}
): TurnContext {
  seq++
  const chat = ensureChat(storage, { waId: options.chatWaId ?? `fake-chat-${seq}`, type: 'group' })
  setChatStatus(storage, { chatId: chat.chatId, status: 'active', actor: 'test' })
  const senderId = options.senderId ?? `subj-${seq}`
  const mid = options.mid ?? `mid-${seq}`
  const turnId = options.turnId ?? `turn-${seq}`
  receiveInbound(storage, { chatId: chat.chatId, mid, senderId })
  openTurn(storage, { turnId, chatId: chat.chatId, senderId, kind: 'reply', mids: [mid] })
  return {
    turnId,
    chat,
    senderId,
    character: pack,
    settings: resolveSettings(storage, chat),
    kind: 'reply',
    delivery: { kind: 'reply' },
    deadline: Date.now() + 10_000,
    sources: createTurnSources()
  }
}

function fakeMemory(items: { itemId: string; text: string }[] = []): MemoryPort {
  return {
    recall: () => items,
    history: () => [],
    checkNote: async () => ({ ok: true }),
    note: () => ({ itemId: 'mem_1', effect: 'added' }),
    forget: () => true,
    forgetPending: () => {},
    lingo: () => 'lingo_1'
  }
}

describe('the seven atomic rules', () => {
  it('One action: a schema with an action key is refused at registration', () => {
    const storage = tmpStorage()
    const registry = makeRegistry(storage)
    expect(() =>
      registry.register({
        name: 'bad_action',
        description: 'bad',
        schema: z.strictObject({ action: z.string() }),
        mode: 'implicit',
        mutates: false,
        handler: () => ({ ok: true, data: {} })
      })
    ).toThrow(/bad_action.*action/)
  })

  it('One transaction: a second commit throws and a throw inside write rolls back everything', async () => {
    const storage = tmpStorage()
    const registry = makeRegistry(storage)
    const context = makeContext(storage)

    registry.register({
      name: 'double_commit',
      description: 'commits twice',
      schema: z.strictObject({}),
      mode: 'implicit',
      mutates: true,
      handler: (_args, ctx) => {
        ctx.commit((db) => {
          db.prepare(
            `INSERT INTO reminder (reminder_id, chat_id, owner_id, target_id, state, due_at, text, created_at, updated_at)
             VALUES ('rem_first', ?, ?, ?, 'active', '2026-12-01T00:00:00.000Z', 'first', '2026-11-16T00:00:00.000Z', '2026-11-16T00:00:00.000Z')`
          ).run(ctx.chat.chatId, ctx.senderId, ctx.senderId)
          return { data: { first: true }, receipt: { kind: 'test.first', target: 'rem_first' } }
        })
        expect(() => ctx.commit(() => ({ data: { second: true }, receipt: { kind: 'test.second' } }))).toThrow(
          /already committed/
        )
        return { ok: true, data: { first: true } }
      }
    })

    const res1 = await registry.call('double_commit', {}, context, { callId: 'c-double', source: 'model' })
    expect(res1.ok).toBe(true)
    const reminderCount = storage.read((db) => db.prepare('SELECT count(*) FROM reminder').pluck().get())
    const receiptCount = storage.read((db) => db.prepare('SELECT count(*) FROM receipt').pluck().get())
    expect(reminderCount).toBe(1)
    expect(receiptCount).toBe(1)

    registry.register({
      name: 'failing_write',
      description: 'throws inside write',
      schema: z.strictObject({}),
      mode: 'implicit',
      mutates: true,
      handler: (_args, ctx) => {
        ctx.commit((db) => {
          db.prepare(
            `INSERT INTO reminder (reminder_id, chat_id, owner_id, target_id, state, due_at, text, created_at, updated_at)
             VALUES ('rem_boom', ?, ?, ?, 'active', '2026-12-01T00:00:00.000Z', 'boom', '2026-11-16T00:00:00.000Z', '2026-11-16T00:00:00.000Z')`
          ).run(ctx.chat.chatId, ctx.senderId, ctx.senderId)
          throw new Error('write failed')
        })
        return { ok: true, data: {} }
      }
    })

    const res2 = await registry.call('failing_write', {}, context, { callId: 'c-boom', source: 'model' })
    expect(res2).toEqual({ ok: false, kind: 'error', reason: 'the tool failed' })
    expect(
      storage.read((db) => db.prepare("SELECT count(*) FROM reminder WHERE reminder_id = 'rem_boom'").pluck().get())
    ).toBe(0)
    expect(
      storage.read((db) => db.prepare("SELECT count(*) FROM tool_result WHERE call_id = 'c-boom'").pluck().get())
    ).toBe(0)
    expect(
      storage.read((db) => db.prepare("SELECT count(*) FROM receipt WHERE call_id = 'c-boom'").pluck().get())
    ).toBe(0)
  })

  it('Safe to repeat: same call id runs once and returns stored result; wrong tool is refused', async () => {
    const storage = tmpStorage()
    const registry = makeRegistry(storage)
    const context = makeContext(storage)
    const spy = vi.fn(() => ({ saved: true }))

    registry.register({
      name: 'save_once',
      description: 'saves once',
      schema: z.strictObject({}),
      mode: 'implicit',
      mutates: true,
      handler: (_args, ctx) => {
        const { data } = ctx.commit(() => ({
          data: spy(),
          receipt: { kind: 'test.saved', target: 'item-1' }
        }))
        return { ok: true, data }
      }
    })
    registry.register({
      name: 'other_tool',
      description: 'other',
      schema: z.strictObject({}),
      mode: 'implicit',
      mutates: false,
      handler: () => ({ ok: true, data: {} })
    })

    const first = await registry.call('save_once', {}, context, { callId: 'c-repeat', source: 'model' })
    const second = await registry.call('save_once', {}, context, { callId: 'c-repeat', source: 'model' })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(second).toEqual(first)

    const wrongTool = await registry.call('other_tool', {}, context, { callId: 'c-repeat', source: 'model' })
    expect(wrongTool).toEqual({ ok: false, kind: 'invalid', reason: 'call id belongs to another call' })
  })

  it('No hidden second effect: non-mutating tool cannot commit and one call writes at most one receipt', async () => {
    const storage = tmpStorage()
    const registry = makeRegistry(storage)
    const context = makeContext(storage)

    registry.register({
      name: 'read_only_bad',
      description: 'tries to commit',
      schema: z.strictObject({}),
      mode: 'implicit',
      mutates: false,
      handler: (_args, ctx) => {
        ctx.commit(() => ({ data: {}, receipt: { kind: 'illegal' } }))
        return { ok: true, data: {} }
      }
    })

    const res = await registry.call('read_only_bad', {}, context, { callId: 'c-ro', source: 'model' })
    expect(res).toEqual({ ok: false, kind: 'error', reason: 'the tool failed' })
    expect(storage.read((db) => db.prepare('SELECT count(*) FROM receipt').pluck().get())).toBe(0)
  })

  it('One target for a removal: forget search forgets nothing and only an itemId forgets one row', async () => {
    const storage = tmpStorage()
    const registry = makeRegistry(storage)
    const forgetSpy = vi.fn(() => true)
    let matches = [
      { itemId: 'm_1', text: 'likes green tea' },
      { itemId: 'm_2', text: 'drinks tea daily' }
    ]
    const memory: MemoryPort = {
      ...fakeMemory(),
      recall: () => matches,
      forget: forgetSpy
    }
    registerCoreTools(registry, { memory, filesDir: tmpDir() })
    const context = makeContext(storage)

    const twoMatches = await registry.call('forget', { query: 'tea' }, context, {
      callId: 'c-forget-2',
      source: 'model'
    })
    expect(twoMatches).toMatchObject({
      ok: true,
      data: { forgotten: false, candidates: matches },
      receipt: { kind: 'memory.forget_barrier' }
    })
    expect(forgetSpy).not.toHaveBeenCalled()

    matches = [{ itemId: 'm_1', text: 'likes green tea' }]
    const oneMatch = await registry.call('forget', { query: 'green' }, context, {
      callId: 'c-forget-1',
      source: 'model'
    })
    expect(oneMatch).toMatchObject({
      ok: true,
      data: { forgotten: false, candidates: matches },
      receipt: { kind: 'memory.forget_barrier' }
    })
    expect(forgetSpy).not.toHaveBeenCalled()

    const byId = await registry.call('forget', { itemId: 'm_1' }, context, { callId: 'c-forget-id', source: 'model' })
    expect(byId).toMatchObject({
      ok: true,
      data: { forgotten: true, candidates: [] },
      receipt: { kind: 'memory.forgotten', target: 'm_1' }
    })
    expect(forgetSpy).toHaveBeenCalledTimes(1)
    expect(forgetSpy).toHaveBeenCalledWith(expect.anything(), { chatId: context.chat.chatId, itemId: 'm_1' })

    const r1 = await registry.call('reminder_set', { text: 'first', dueAt: '2030-01-01T10:00:00Z' }, context, {
      callId: 'c-rem-1',
      source: 'model'
    })
    const r2 = await registry.call('reminder_set', { text: 'second', dueAt: '2030-01-02T10:00:00Z' }, context, {
      callId: 'c-rem-2',
      source: 'model'
    })
    expect(r1.ok && r2.ok).toBe(true)
    if (r1.ok) {
      const rem1 = (r1.data as { reminderId: string }).reminderId
      const cancelRes = await registry.call('reminder_cancel', { reminderId: rem1 }, context, {
        callId: 'c-cancel',
        source: 'model'
      })
      expect(cancelRes.ok).toBe(true)
      const activeCount = storage.read((db) =>
        db.prepare("SELECT count(*) FROM reminder WHERE state = 'active'").pluck().get()
      )
      expect(activeCount).toBe(1)
    }
  })

  it('Bounded: a handler that is still running after its timeout cannot commit late', async () => {
    const storage = tmpStorage()
    const registry = makeRegistry(storage, 500)
    const context = makeContext(storage)
    let late: unknown
    registry.register({
      name: 'slow_save',
      description: 'commits after its timeout',
      schema: z.strictObject({}),
      mode: 'implicit',
      mutates: true,
      timeoutMs: 20,
      handler: async (_args, toolContext) => {
        await new Promise((resolve) => setTimeout(resolve, 60))
        try {
          toolContext.commit(() => ({ data: {}, receipt: { kind: 'late.change' } }))
        } catch (error) {
          late = error
        }
        return { ok: true, data: {} }
      }
    })
    const result = await registry.call('slow_save', {}, context, { callId: 'c-late', source: 'model' })
    expect(result).toMatchObject({ ok: false, kind: 'timeout' })
    await new Promise((resolve) => setTimeout(resolve, 80))
    // The caller was told the call failed, so the change must not appear afterwards.
    expect(late).toBeInstanceOf(Error)
    expect(storage.read((db) => db.prepare('SELECT count(*) FROM receipt').pluck().get())).toBe(0)
    expect(storage.read((db) => db.prepare('SELECT count(*) FROM tool_result').pluck().get())).toBe(0)
  })

  it('Bounded: hanging handler times out and throwing handler returns error without rejecting', async () => {
    const storage = tmpStorage()
    const registry = makeRegistry(storage, 500)
    const context = makeContext(storage)

    registry.register({
      name: 'hangs',
      description: 'never resolves',
      schema: z.strictObject({}),
      mode: 'implicit',
      mutates: false,
      timeoutMs: 25,
      handler: () => new Promise(() => {})
    })
    registry.register({
      name: 'throws',
      description: 'always throws',
      schema: z.strictObject({}),
      mode: 'implicit',
      mutates: false,
      handler: () => {
        throw new Error('boom')
      }
    })

    const timedOut = await registry.call('hangs', {}, context, { callId: 'c-hang', source: 'model' })
    expect(timedOut).toMatchObject({ ok: false, kind: 'timeout' })

    const errored = await registry.call('throws', {}, context, { callId: 'c-throw', source: 'model' })
    expect(errored).toEqual({ ok: false, kind: 'error', reason: 'the tool failed' })
  })

  it('Checked first: disabled feature, false permission, and wrong source refuse without calling handler', async () => {
    const storage = tmpStorage()
    const registry = makeRegistry(storage)
    const spy = vi.fn(() => ({ ok: true as const, data: {} }))

    registry.register({
      name: 'feat_tool',
      description: 'needs feature',
      schema: z.strictObject({}),
      mode: 'both',
      mutates: false,
      feature: 'features.voice',
      command: { names: ['feat'], kind: 'direct', usage: '/feat' },
      handler: spy
    })
    registry.register({
      name: 'perm_tool',
      description: 'needs perm',
      schema: z.strictObject({}),
      mode: 'both',
      mutates: false,
      permission: () => false,
      handler: spy
    })
    registry.register({
      name: 'explicit_tool',
      description: 'explicit only',
      schema: z.strictObject({}),
      mode: 'explicit',
      mutates: false,
      command: { names: ['exp'], kind: 'direct', usage: '/exp' },
      handler: spy
    })

    const context = makeContext(storage)
    expect(await registry.call('feat_tool', {}, context, { callId: 'c-f', source: 'model' })).toMatchObject({
      ok: false,
      kind: 'refused'
    })
    expect(await registry.call('perm_tool', {}, context, { callId: 'c-p', source: 'model' })).toMatchObject({
      ok: false,
      kind: 'refused'
    })
    expect(await registry.call('explicit_tool', {}, context, { callId: 'c-e', source: 'model' })).toMatchObject({
      ok: false,
      kind: 'refused'
    })
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('faults of the old system', () => {
  it('No timeout on a tool call: default timeout stops a hanging handler', async () => {
    const storage = tmpStorage()
    const registry = makeRegistry(storage, 30)
    const context = makeContext(storage)

    registry.register({
      name: 'default_timeout_hang',
      description: 'hangs',
      schema: z.strictObject({}),
      mode: 'implicit',
      mutates: false,
      handler: () => new Promise(() => {})
    })

    const res = await registry.call('default_timeout_hang', {}, context, { callId: 'c-def-to', source: 'model' })
    expect(res).toMatchObject({ ok: false, kind: 'timeout' })
  })

  it('A save reports failure after it worked: commit followed by throw still returns ok with receipt', async () => {
    const storage = tmpStorage()
    const registry = makeRegistry(storage)
    const context = makeContext(storage)

    registry.register({
      name: 'commit_then_throw',
      description: 'commits then throws',
      schema: z.strictObject({}),
      mode: 'implicit',
      mutates: true,
      handler: (_args, ctx) => {
        ctx.commit((db) => {
          db.prepare(
            `INSERT INTO reminder (reminder_id, chat_id, owner_id, target_id, state, due_at, text, created_at, updated_at)
             VALUES ('rem_kept', ?, ?, ?, 'active', '2026-12-01T00:00:00.000Z', 'kept', '2026-11-16T00:00:00.000Z', '2026-11-16T00:00:00.000Z')`
          ).run(ctx.chat.chatId, ctx.senderId, ctx.senderId)
          return { data: { saved: true }, receipt: { kind: 'test.kept', target: 'rem_kept' } }
        })
        throw new Error('post-commit failure')
      }
    })

    const res = await registry.call('commit_then_throw', {}, context, { callId: 'c-ctt', source: 'model' })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.receipt?.kind).toBe('test.kept')
    }
    expect(
      storage.read((db) => db.prepare("SELECT count(*) FROM reminder WHERE reminder_id = 'rem_kept'").pluck().get())
    ).toBe(1)
  })

  it('Forget can retire three facts that share a word: returns three candidates and forgets none', async () => {
    const storage = tmpStorage()
    const registry = makeRegistry(storage)
    const forgetSpy = vi.fn(() => true)
    const candidates = [
      { itemId: 'm_1', text: 'coffee at morning' },
      { itemId: 'm_2', text: 'coffee with milk' },
      { itemId: 'm_3', text: 'coffee beans' }
    ]
    const memory: MemoryPort = {
      ...fakeMemory(candidates),
      forget: forgetSpy
    }
    registerCoreTools(registry, { memory, filesDir: tmpDir() })
    const context = makeContext(storage)

    const res = await registry.call('forget', { query: 'coffee' }, context, { callId: 'c-3facts', source: 'model' })
    expect(res).toMatchObject({
      ok: true,
      data: { forgotten: false, candidates },
      receipt: { kind: 'memory.forget_barrier' }
    })
    expect(forgetSpy).not.toHaveBeenCalled()
  })

  it('A tool with no chat or permission check: make_report refuses when features.reports is off', async () => {
    const storage = tmpStorage()
    const registry = makeRegistry(storage)
    registerCoreTools(registry, { filesDir: tmpDir() })
    const context = makeContext(storage)
    setSetting(storage, {
      level: 'chat',
      scope: context.chat.chatId,
      key: 'features.reports',
      value: false,
      actor: 'test'
    })
    context.settings = resolveSettings(storage, context.chat)

    const res = await registry.call(
      'make_report',
      { title: 'Summary note', sections: [{ heading: 'Details', body: 'All clear.' }] },
      context,
      {
        callId: 'c-rep-off',
        source: 'model'
      }
    )
    expect(res).toMatchObject({ ok: false, kind: 'refused' })
    expect(storage.read((db) => db.prepare('SELECT count(*) FROM file').pluck().get())).toBe(0)
  })

  it('a reminder row commits even when writing the wanted-jobs file fails', async () => {
    const storage = tmpStorage()
    const registry = makeRegistry(storage)
    const schedule: SchedulePort = {
      sync() {
        throw new Error('disk full')
      }
    }
    registerCoreTools(registry, { schedule, filesDir: tmpDir() })
    const context = makeContext(storage)
    const res = await registry.call('reminder_set', { text: 'call dentist', dueAt: '2030-05-01T09:00:00Z' }, context, {
      callId: 'c-rem-rec',
      source: 'model'
    })
    expect(res.ok).toBe(true)
    expect(storage.read((db) => db.prepare("SELECT count(*) FROM reminder WHERE state = 'active'").pluck().get())).toBe(
      1
    )
  })
})

describe('registry registration, filtering, records and offered tools', () => {
  it('rejects every invalid registration definition', () => {
    const storage = tmpStorage()
    const registry = makeRegistry(storage)
    const base: ToolDefinition<{ text: string }> = {
      name: 'valid_tool',
      description: 'valid',
      schema: z.strictObject({ text: z.string() }),
      mode: 'both',
      mutates: false,
      command: { names: ['valid'], kind: 'skill', usage: '/valid' },
      handler: () => ({ ok: true, data: {} })
    }
    registry.register(base)

    expect(() => registry.register({ ...base, name: 'bad.name', command: undefined })).toThrow(/bad\.name/)
    expect(() => registry.register({ ...base, command: undefined })).toThrow(/valid_tool/)
    expect(() =>
      registry.register({
        ...base,
        name: 'non_obj',
        schema: z.string() as unknown as z.ZodType<{ text: string }>,
        command: undefined
      })
    ).toThrow(/non_obj/)
    for (const key of ['action', 'operation', 'op']) {
      expect(() =>
        registry.register({
          ...base,
          name: `has_${key}`,
          schema: z.strictObject({ [key]: z.string() }) as unknown as z.ZodType<{ text: string }>,
          command: undefined
        })
      ).toThrow(new RegExp(`has_${key}`))
    }
    expect(() => registry.register({ ...base, name: 'imp_cmd', mode: 'implicit' })).toThrow(/imp_cmd/)
    expect(() =>
      registry.register({
        ...base,
        name: 'dup_cmd',
        command: { names: ['valid'], kind: 'direct', usage: '/valid' }
      })
    ).toThrow(/dup_cmd/)
    expect(() =>
      registry.register({
        ...base,
        name: 'bad_cmd',
        command: { names: ['bad-cmd'], kind: 'direct', usage: '/bad-cmd' }
      })
    ).toThrow(/bad_cmd/)
    expect(() => registry.register({ ...base, name: 'bad_to_zero', timeoutMs: 0, command: undefined })).toThrow(
      /bad_to_zero/
    )
    expect(() => registry.register({ ...base, name: 'bad_to_float', timeoutMs: 1.5, command: undefined })).toThrow(
      /bad_to_float/
    )
  })

  it('filters offered tools, commands and rulesText, and formats OfferedTool.call', async () => {
    const storage = tmpStorage()
    const registry = makeRegistry(storage)
    const context = makeContext(storage)

    registry.register({
      name: 'alpha_tool',
      description: 'Alpha description',
      schema: z.strictObject({ secretInput: z.string().min(3) }),
      mode: 'both',
      mutates: false,
      command: { names: ['zeta'], kind: 'skill', usage: '/zeta' },
      handler: (args) => ({ ok: true, data: { got: args.secretInput } })
    })
    registry.register({
      name: 'beta_explicit',
      description: 'Beta explicit',
      schema: z.strictObject({}),
      mode: 'explicit',
      mutates: false,
      command: { names: ['alpha'], kind: 'direct', usage: '/alpha' },
      handler: () => ({ ok: true, data: {} })
    })
    registry.register({
      name: 'gamma_off',
      description: 'Gamma off',
      schema: z.strictObject({}),
      mode: 'both',
      mutates: false,
      feature: 'features.lessons',
      command: { names: ['gamma'], kind: 'direct', usage: '/gamma' },
      handler: () => ({ ok: true, data: {} })
    })
    registry.register({
      name: 'delta_denied',
      description: 'Delta denied',
      schema: z.strictObject({}),
      mode: 'implicit',
      mutates: false,
      permission: () => false,
      handler: () => ({ ok: true, data: {} })
    })

    const offered = registry.offered(context)
    expect(offered.map((t) => t.schema.name)).toEqual(['alpha_tool'])
    expect(offered[0]?.schema.parameters).toMatchObject({
      type: 'object',
      properties: { secretInput: { type: 'string' } }
    })

    expect(registry.commands(context).map((c) => c.name)).toEqual(['alpha', 'zeta'])
    expect(registry.rulesText(context)).toContain('- alpha_tool: Alpha description')
    expect(registry.rulesText(context)).not.toContain('beta_explicit')

    const controller = new AbortController()
    const okOffer = await offered[0]?.call({ secretInput: 'hello' }, 'c-off-1', controller.signal)
    expect(okOffer).toEqual({ ok: true, content: JSON.stringify({ got: 'hello' }) })

    const invalidOffer = await offered[0]?.call({ secretInput: 'x' }, 'c-off-2', controller.signal)
    expect(invalidOffer?.ok).toBe(false)
    expect(invalidOffer?.content).not.toContain('"x"')
    const parsedFail = JSON.parse(invalidOffer?.content ?? '{}') as { ok: boolean; outcome: string }
    expect(parsedFail.ok).toBe(false)
    expect(parsedFail.outcome).toMatch(/^Try once more with corrected details: .*secretInput/)

    const recordedArgs = storage.read(
      (db) =>
        db.prepare('SELECT args_shape FROM tool_call WHERE turn_id = ?').all(context.turnId) as { args_shape: string }[]
    )
    expect(recordedArgs).toHaveLength(2)
    expect(recordedArgs[0]?.args_shape).toBe(JSON.stringify({ secretInput: 'string' }))
    expect(recordedArgs[0]?.args_shape).not.toContain('hello')
  })

  it('the model reads a plain outcome for every failure kind and code, never the raw reason', async () => {
    const storage = tmpStorage()
    const registry = makeRegistry(storage)
    const context = makeContext(storage)
    const RAW = 'RAW_REASON_MARKER'
    const failures = [
      ...TOOL_FAILURE_KINDS.map((kind) => ({ kind })),
      { kind: 'error' as const, code: 'read_failed' as const },
      { kind: 'refused' as const, code: 'already_read' as const }
    ]
    failures.forEach((failure, index) => {
      registry.register({
        name: `raw_${index}`,
        description: 'Fails with a raw reason.',
        schema: z.strictObject({}),
        mode: 'implicit',
        mutates: false,
        handler: () => ({ ok: false, ...failure, reason: RAW })
      })
    })

    const offered = registry.offered(context)
    expect(offered).toHaveLength(failures.length)
    for (const tool of offered) {
      const result = await tool.call({}, `c-${tool.schema.name}`, new AbortController().signal)
      expect(result.ok, tool.schema.name).toBe(false)
      expect(result.content, tool.schema.name).not.toContain(RAW)
      expect(JSON.parse(result.content)).toEqual({ ok: false, outcome: expect.any(String) })
    }
  })

  it('writes failure rows of the right kind for timeout, error and refused', async () => {
    const storage = tmpStorage()
    const registry = makeRegistry(storage)
    const context = makeContext(storage)

    registry.register({
      name: 'slow_t',
      description: 'slow',
      schema: z.strictObject({}),
      mode: 'implicit',
      mutates: false,
      timeoutMs: 15,
      handler: () => new Promise(() => {})
    })
    registry.register({
      name: 'err_t',
      description: 'err',
      schema: z.strictObject({}),
      mode: 'implicit',
      mutates: false,
      handler: () => {
        throw new Error('boom')
      }
    })
    registry.register({
      name: 'ref_t',
      description: 'ref',
      schema: z.strictObject({}),
      mode: 'explicit',
      mutates: false,
      handler: () => ({ ok: true, data: {} })
    })

    await registry.call('slow_t', {}, context, { callId: 'c-1', source: 'model' })
    await registry.call('err_t', {}, context, { callId: 'c-2', source: 'model' })
    await registry.call('ref_t', {}, context, { callId: 'c-3', source: 'model' })

    const kinds = storage.read((db) =>
      db.prepare('SELECT kind FROM failure WHERE turn_id = ? ORDER BY id ASC').pluck().all(context.turnId)
    )
    expect(kinds).toEqual(['tool_timeout', 'tool_error', 'tool_refused'])
  })

  it('registry records the refusal code in the failure message', async () => {
    const storage = tmpStorage()
    const registry = makeRegistry(storage)
    const context = makeContext(storage)
    registry.register({
      name: 'coded_t',
      description: 'coded',
      schema: z.strictObject({}),
      mode: 'implicit',
      mutates: false,
      handler: () => ({ ok: false, kind: 'refused', reason: 'address not seen in this turn', code: 'unseen_link' })
    })
    await registry.call('coded_t', {}, context, { callId: 'c-1', source: 'model' })
    const messages = storage.read((db) =>
      db.prepare('SELECT message FROM failure WHERE turn_id = ?').pluck().all(context.turnId)
    )
    expect(messages).toEqual(['coded_t refused (unseen_link)'])
  })

  it('registry records the cause of a failed tool', async () => {
    const storage = tmpStorage()
    const registry = makeRegistry(storage)
    const context = makeContext(storage)
    registerCoreTools(registry, {
      search: {
        async search() {
          throw new Error('boom')
        }
      },
      memory: {
        ...fakeMemory(),
        recall() {
          throw new Error('recall boom')
        }
      },
      filesDir: tmpDir()
    })

    const offered = registry.offered(context)
    const webSearch = offered.find((tool) => tool.schema.name === 'web_search')!
    const modelOutcome = await webSearch.call({ query: 'test' }, 'c-port-boom', new AbortController().signal)
    expect(modelOutcome.ok).toBe(false)
    expect(JSON.parse(modelOutcome.content)).toEqual({ ok: false, outcome: expect.any(String) })
    expect(modelOutcome.content).not.toContain('search failed')
    expect(modelOutcome.content).not.toContain('boom')

    await registry.call('recall', { query: 'test' }, context, { callId: 'c-mem-boom', source: 'model' })

    const failures = storage.read(
      (db) =>
        db
          .prepare('SELECT stage, kind, message, stack FROM failure WHERE turn_id = ? ORDER BY id ASC')
          .all(context.turnId) as {
          stage: string
          kind: string
          message: string
          stack: string | null
        }[]
    )
    expect(failures).toHaveLength(2)
    expect(failures[0]).toMatchObject({ stage: 'tool', kind: 'tool_error' })
    expect(failures[0]?.message).toContain('boom')
    expect(failures[0]?.stack).toContain('Error: boom')
    expect(failures[1]).toMatchObject({ stage: 'tool', kind: 'tool_error' })
    expect(failures[1]?.message).toContain('recall boom')
  })
})
