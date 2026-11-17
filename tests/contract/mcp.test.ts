import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadPack } from '../../src/character/loader.js'
import { createLogger } from '../../src/records/logger.js'
import { createRedactor } from '../../src/records/redact.js'
import { ensureChat, setChatStatus } from '../../src/settings/chats.js'
import { resolveSettings, setSetting } from '../../src/settings/settings.js'
import type { Storage } from '../../src/storage/database.js'
import { openTurn, receiveInbound } from '../../src/storage/turns.js'
import { connectMcpServers, type McpHost } from '../../src/tools/mcp-client.js'
import { createToolRegistry, type ToolRegistry } from '../../src/tools/registry.js'
import type { TurnContext } from '../../src/turn/types.js'
import { tmpStorage } from '../support/tmp.js'

const pack = loadPack('characters/example', 'repository')
const TEST_SERVER_PATH = 'tests/support/mcp-test-server.mjs'

const hosts: McpHost[] = []

afterEach(async () => {
  while (hosts.length > 0) {
    const host = hosts.pop()
    if (host) await host.close()
  }
})

function makeLogger(sink: (line: string) => void = () => {}) {
  return createLogger({ level: 'warn', module: 'mcp-test', sink })
}

function makeRegistry(storage: Storage, defaultTimeoutMs = 500): ToolRegistry {
  return createToolRegistry({
    storage,
    config: { tools: { defaultTimeoutMs } },
    logger: makeLogger(),
    redactor: createRedactor()
  })
}

let seq = 0
function makeContext(storage: Storage, options: { chatWaId?: string; mcpFeature?: boolean } = {}): TurnContext {
  seq++
  const chat = ensureChat(storage, { waId: options.chatWaId ?? `fake-mcp-chat-${seq}`, type: 'group' })
  setChatStatus(storage, { chatId: chat.chatId, status: 'active', actor: 'test' })
  if (options.mcpFeature !== undefined) {
    setSetting(storage, {
      level: 'chat',
      scope: chat.chatId,
      key: 'mcp.example',
      value: options.mcpFeature,
      actor: 'test'
    })
  }
  const senderId = `subj-${seq}`
  const mid = `mid-${seq}`
  const turnId = `turn-${seq}`
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
    deadline: Date.now() + 10_000
  }
}

describe('MCP external tool servers', () => {
  it('registers only allowlisted tools, ignores others, and logs missing allowlisted tools', async () => {
    const storage = tmpStorage()
    const registry = makeRegistry(storage)
    const context = makeContext(storage, { mcpFeature: true })
    const logs: string[] = []

    const host = await connectMcpServers(
      [
        {
          id: 'example',
          transport: 'stdio',
          command: [process.execPath, TEST_SERVER_PATH],
          tools: ['lookup', 'nonexistent_tool'],
          chats: [context.chat.chatId],
          timeoutMs: 5_000
        }
      ],
      registry,
      makeLogger((line) => logs.push(line))
    )
    hosts.push(host)

    expect(host.states()).toEqual([{ id: 'example', status: 'connected', tools: ['example.lookup'] }])
    const offered = registry.offered(context)
    expect(offered.map((t) => t.schema.name)).toEqual(['example__lookup'])
    expect(offered[0]?.schema.parameters).toMatchObject({
      type: 'object',
      properties: { term: { type: 'string' } }
    })
    expect(registry.toolNames()).toContain('example.lookup')
    expect(registry.toolNames()).not.toContain('example.secret_admin')
    expect(registry.commands(context)).toEqual([])
    expect(registry.rulesText(context)).toContain('- example__lookup:')
    expect(logs.some((line) => line.includes('mcp_missing_tool') && line.includes('nonexistent_tool'))).toBe(true)
  })

  it('offers external tools only to listed chats with mcp.<id> set to true', async () => {
    const storage = tmpStorage()
    const registry = makeRegistry(storage)
    const allowedOn = makeContext(storage, { mcpFeature: true })
    const allowedOff = makeContext(storage, { mcpFeature: false })
    const allowedDefault = makeContext(storage)
    const unlistedOn = makeContext(storage, { mcpFeature: true })

    const host = await connectMcpServers(
      [
        {
          id: 'example',
          transport: 'stdio',
          command: [process.execPath, TEST_SERVER_PATH],
          tools: ['lookup'],
          chats: [allowedOn.chat.chatId, allowedOff.chat.chatId, allowedDefault.chat.chatId],
          timeoutMs: 5_000
        }
      ],
      registry,
      makeLogger()
    )
    hosts.push(host)

    expect(registry.offered(allowedOn).map((t) => t.schema.name)).toEqual(['example__lookup'])
    expect(registry.offered(allowedOff)).toEqual([])
    expect(registry.offered(allowedDefault)).toEqual([])
    expect(registry.offered(unlistedOn)).toEqual([])
  })

  it('returns untrusted text and writes tool_call without receipt or tool_result', async () => {
    const storage = tmpStorage()
    const registry = makeRegistry(storage)
    const context = makeContext(storage, { mcpFeature: true })

    const host = await connectMcpServers(
      [
        {
          id: 'example',
          transport: 'stdio',
          command: [process.execPath, TEST_SERVER_PATH],
          tools: ['lookup'],
          chats: [context.chat.chatId],
          timeoutMs: 5_000
        }
      ],
      registry,
      makeLogger()
    )
    hosts.push(host)

    const result = await registry.call('example.lookup', { term: 'tea' }, context, {
      callId: 'c-ext-ok',
      source: 'model'
    })
    expect(result).toEqual({
      ok: true,
      data: {
        untrusted: true,
        source: 'example.lookup',
        text: 'looked up: tea'
      }
    })

    const toolCalls = storage.read((db) => db.prepare('SELECT tool, outcome, receipt_id FROM tool_call').all())
    expect(toolCalls).toEqual([{ tool: 'example.lookup', outcome: 'ok', receipt_id: null }])
    expect(storage.read((db) => db.prepare('SELECT count(*) FROM receipt').pluck().get())).toBe(0)
    expect(storage.read((db) => db.prepare('SELECT count(*) FROM tool_result').pluck().get())).toBe(0)
  })

  it('refuses calls from disallowed chats, disabled features, or command source without invoking', async () => {
    const storage = tmpStorage()
    const registry = makeRegistry(storage)
    const spy = vi.fn(async () => 'should not run')
    const allowedOn = makeContext(storage, { mcpFeature: true })
    const allowedOff = makeContext(storage, { mcpFeature: false })
    const unlistedOn = makeContext(storage, { mcpFeature: true })

    registry.registerExternal({
      name: 'example.spy',
      description: 'spy tool',
      parameters: { type: 'object' },
      feature: 'mcp.example',
      chats: [allowedOn.chat.chatId, allowedOff.chat.chatId],
      timeoutMs: 500,
      invoke: spy
    })

    expect(await registry.call('example.spy', {}, unlistedOn, { callId: 'c-unlisted', source: 'model' })).toMatchObject(
      { ok: false, kind: 'refused' }
    )
    expect(await registry.call('example.spy', {}, allowedOff, { callId: 'c-off', source: 'model' })).toMatchObject({
      ok: false,
      kind: 'refused'
    })
    expect(await registry.call('example.spy', {}, allowedOn, { callId: 'c-cmd', source: 'command' })).toMatchObject({
      ok: false,
      kind: 'refused'
    })
    expect(spy).not.toHaveBeenCalled()
  })

  it('returns timeout for slow tools and unavailable for broken tools', async () => {
    const storage = tmpStorage()
    const registry = makeRegistry(storage)
    const context = makeContext(storage, { mcpFeature: true })

    const host = await connectMcpServers(
      [
        {
          id: 'example',
          transport: 'stdio',
          command: [process.execPath, TEST_SERVER_PATH],
          tools: ['slow', 'broken'],
          chats: [context.chat.chatId],
          // One limit covers the start of the server and each call. It must leave a slow machine time to start it.
          timeoutMs: 2_000
        }
      ],
      registry,
      makeLogger()
    )
    hosts.push(host)
    expect(host.states()[0]?.status).toBe('connected')

    const slowRes = await registry.call('example.slow', {}, context, { callId: 'c-slow', source: 'model' })
    expect(slowRes).toMatchObject({ ok: false, kind: 'timeout' })

    const brokenRes = await registry.call('example.broken', {}, context, { callId: 'c-broken', source: 'model' })
    expect(brokenRes).toEqual({ ok: false, kind: 'unavailable', reason: 'the external tool failed' })
  })

  it('returns invalid when arguments are not a JSON object', async () => {
    const storage = tmpStorage()
    const registry = makeRegistry(storage)
    const context = makeContext(storage, { mcpFeature: true })
    const spy = vi.fn(async () => 'ok')

    registry.registerExternal({
      name: 'example.obj',
      description: 'expects object',
      parameters: { type: 'object' },
      feature: 'mcp.example',
      chats: [context.chat.chatId],
      timeoutMs: 500,
      invoke: spy
    })

    for (const bad of ['text', 42, true, null, ['a']]) {
      const res = await registry.call('example.obj', bad, context, { callId: 'c-bad-args', source: 'model' })
      expect(res).toMatchObject({ ok: false, kind: 'invalid' })
    }
    expect(spy).not.toHaveBeenCalled()
  })

  it('cuts external tool output text to 8000 characters', async () => {
    const storage = tmpStorage()
    const registry = makeRegistry(storage)
    const context = makeContext(storage, { mcpFeature: true })

    registry.registerExternal({
      name: 'example.long',
      description: 'long output',
      parameters: { type: 'object' },
      feature: 'mcp.example',
      chats: [context.chat.chatId],
      timeoutMs: 500,
      invoke: async () => 'x'.repeat(9_000)
    })

    const res = await registry.call('example.long', {}, context, { callId: 'c-long', source: 'model' })
    expect(res.ok).toBe(true)
    if (res.ok) {
      const data = res.data as { untrusted: boolean; source: string; text: string }
      expect(data.text).toHaveLength(8_000)
    }
  })

  it('marks a server that exits at start unavailable and still connects a second good server', async () => {
    const storage = tmpStorage()
    const registry = makeRegistry(storage)
    const context = makeContext(storage, { mcpFeature: true })

    const host = await connectMcpServers(
      [
        {
          id: 'bad',
          transport: 'stdio',
          command: [process.execPath, TEST_SERVER_PATH, '--exit'],
          tools: ['lookup'],
          chats: [context.chat.chatId],
          timeoutMs: 2_000
        },
        {
          id: 'example',
          transport: 'stdio',
          command: [process.execPath, TEST_SERVER_PATH],
          tools: ['lookup'],
          chats: [context.chat.chatId],
          timeoutMs: 5_000
        }
      ],
      registry,
      makeLogger()
    )
    hosts.push(host)

    const states = host.states()
    expect(states[0]).toMatchObject({ id: 'bad', status: 'unavailable', tools: [] })
    expect(states[0]?.error).toBeTruthy()
    expect(states[1]).toEqual({ id: 'example', status: 'connected', tools: ['example.lookup'] })
    expect(registry.toolNames()).not.toContain('bad.lookup')
    expect(registry.toolNames()).toContain('example.lookup')
  })

  it('marks a second server with a duplicate id unavailable', async () => {
    const storage = tmpStorage()
    const registry = makeRegistry(storage)
    const context = makeContext(storage, { mcpFeature: true })

    const host = await connectMcpServers(
      [
        {
          id: 'example',
          transport: 'stdio',
          command: [process.execPath, TEST_SERVER_PATH],
          tools: ['lookup'],
          chats: [context.chat.chatId],
          timeoutMs: 5_000
        },
        {
          id: 'example',
          transport: 'stdio',
          command: [process.execPath, TEST_SERVER_PATH],
          tools: ['broken'],
          chats: [context.chat.chatId],
          timeoutMs: 5_000
        }
      ],
      registry,
      makeLogger()
    )
    hosts.push(host)

    const states = host.states()
    expect(states[0]).toEqual({ id: 'example', status: 'connected', tools: ['example.lookup'] })
    expect(states[1]).toMatchObject({ id: 'example', status: 'unavailable', tools: [] })
    expect(states[1]?.error).toContain('duplicate')
  })

  it('marks tools unavailable after close() and allows calling close() twice', async () => {
    const storage = tmpStorage()
    const registry = makeRegistry(storage)
    const context = makeContext(storage, { mcpFeature: true })

    const host = await connectMcpServers(
      [
        {
          id: 'example',
          transport: 'stdio',
          command: [process.execPath, TEST_SERVER_PATH],
          tools: ['lookup'],
          chats: [context.chat.chatId],
          timeoutMs: 5_000
        }
      ],
      registry,
      makeLogger()
    )
    hosts.push(host)

    await host.close()
    await host.close()

    expect(host.states()[0]?.status).toBe('unavailable')
    const res = await registry.call('example.lookup', { term: 'after' }, context, {
      callId: 'c-after-close',
      source: 'model'
    })
    expect(res).toEqual({ ok: false, kind: 'unavailable', reason: 'the external tool failed' })
  })

  it('registerExternal refuses bad names and duplicates', () => {
    const storage = tmpStorage()
    const registry = makeRegistry(storage)
    const valid = {
      name: 'srv.tool_1',
      description: 'desc',
      parameters: { type: 'object' },
      feature: 'mcp.srv',
      chats: [],
      timeoutMs: 500,
      invoke: async () => 'ok'
    }

    registry.registerExternal(valid)

    expect(() => registry.registerExternal(valid)).toThrow(/already registered/)
    expect(() => registry.registerExternal({ ...valid, name: 'no_dot' })).toThrow(/must match/)
    expect(() => registry.registerExternal({ ...valid, name: 'Bad.tool' })).toThrow(/must match/)
    expect(() => registry.registerExternal({ ...valid, name: 'srv.' })).toThrow(/must match/)
  })

  it('handles an empty server list with empty states and no registered tools', async () => {
    const storage = tmpStorage()
    const registry = makeRegistry(storage)

    const host = await connectMcpServers([], registry, makeLogger())
    hosts.push(host)

    expect(host.states()).toEqual([])
    expect(registry.toolNames()).toEqual([])
  })
})
