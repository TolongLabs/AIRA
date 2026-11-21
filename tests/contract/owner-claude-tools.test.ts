import { chmodSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadPack } from '../../src/character/loader.js'
import { createLogger } from '../../src/records/logger.js'
import { createRedactor } from '../../src/records/redact.js'
import { ensureChat, setChatStatus } from '../../src/settings/chats.js'
import { resolveSettings } from '../../src/settings/settings.js'
import { openTurn, receiveInbound } from '../../src/storage/turns.js'
import { claudeTools } from '../../src/tools/owner/claude.js'
import { createToolRegistry, type ToolRegistry } from '../../src/tools/registry.js'
import type { ToolDefinition, ToolResult } from '../../src/tools/types.js'
import { createTurnSources } from '../../src/turn/sources.js'
import type { TurnContext } from '../../src/turn/types.js'
import { tmpDir, tmpStorage } from '../support/tmp.js'

const pack = loadPack('characters/example', 'repository')

let seq = 0

function setup(options: { projectsDir?: string; routesFile?: string; now?: () => Date; ownerEnabled?: boolean }) {
  const storage = tmpStorage()
  const registry = createToolRegistry({
    storage,
    config: { tools: { defaultTimeoutMs: 500 } },
    logger: createLogger({ level: 'error', module: 'owner-claude-test', sink: () => {} }),
    redactor: createRedactor(),
    now: options.now
  })
  for (const tool of claudeTools(options)) {
    registry.register(tool as ToolDefinition<unknown>)
  }

  const makeCtx = (waId = '0000000000@s.whatsapp.net'): TurnContext => {
    seq += 1
    const chat = ensureChat(storage, { waId, type: 'dm' })
    setChatStatus(storage, { chatId: chat.chatId, status: 'active', actor: 'test' })
    const senderId = `member-${seq}`
    const mid = `mid-${seq}`
    const turnId = `turn-${seq}`
    receiveInbound(storage, { chatId: chat.chatId, mid, senderId })
    openTurn(storage, { turnId, chatId: chat.chatId, senderId, kind: 'reply', mids: [mid] })
    const settings = resolveSettings(storage, chat)
    if (options.ownerEnabled ?? true) {
      settings['features.owner'] = { value: true, level: 'chat' }
    }
    return {
      turnId,
      chat,
      senderId,
      character: pack,
      settings,
      kind: 'reply',
      delivery: { kind: 'reply' },
      deadline: Date.now() + 10_000,
      sources: createTurnSources()
    }
  }

  return { storage, registry, makeCtx }
}

function writeJsonl(filePath: string, rows: unknown[], mtime: Date) {
  const content = `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`
  writeFileSync(filePath, content, 'utf8')
  utimesSync(filePath, mtime, mtime)
}

describe('claudeTools registration and gating', () => {
  it('registers only the tools whose paths are configured', () => {
    expect(claudeTools({})).toHaveLength(0)
    expect(claudeTools({ projectsDir: '   ', routesFile: '' })).toHaveLength(0)

    const onlySessions = claudeTools({ projectsDir: '/tmp/projects' }).map((t) => t.name)
    expect(onlySessions).toEqual(['claude_sessions'])

    const onlyNotices = claudeTools({ routesFile: '/tmp/routes.json' }).map((t) => t.name)
    expect(onlyNotices).toEqual(['session_notices_status', 'session_notices_set'])

    const both = claudeTools({ projectsDir: '/tmp/projects', routesFile: '/tmp/routes.json' }).map((t) => t.name)
    expect(both).toEqual(['claude_sessions', 'session_notices_status', 'session_notices_set'])
  })

  it('requires features.owner to be offered or run', async () => {
    const projectsDir = tmpDir('cc-projects-')
    const routesFile = join(tmpDir('cc-routes-'), 'routes.json')
    writeFileSync(routesFile, JSON.stringify({ routes: [] }), 'utf8')

    const { registry, makeCtx } = setup({ projectsDir, routesFile, ownerEnabled: false })
    const ctx = makeCtx()
    expect(registry.offered(ctx)).toHaveLength(0)

    const runRes = await runOn(registry, ctx, { callId: 'c1', name: 'claude_sessions', args: {} })
    expect(runRes.result.ok).toBe(false)
    if (!runRes.result.ok) expect(runRes.result.kind).toBe('refused')
  })
})

describe('claude_sessions', () => {
  it('reads running and finished sessions, filters by active_only and project, and notes remote requests', async () => {
    const now = new Date('2026-11-17T10:00:00.000Z')
    const projectsDir = tmpDir('cc-projects-')
    const activeSlug = join(projectsDir, '-workspace-alpha-app')
    const idleSlug = join(projectsDir, '-workspace-beta-tool')
    mkdirSync(activeSlug, { recursive: true })
    mkdirSync(idleSlug, { recursive: true })

    writeJsonl(
      join(activeSlug, '00000001-0000-0000-0000-000000000001.jsonl'),
      [
        {
          type: 'user',
          timestamp: '2026-11-17T09:50:00.000Z',
          cwd: '/workspace/alpha-app',
          gitBranch: 'feat/status-port',
          sessionId: '00000001-0000-0000-0000-000000000001',
          entrypoint: 'cli',
          message: { role: 'user', content: 'Add the owner tools' }
        },
        {
          type: 'ai-title',
          aiTitle: 'Port owner tools'
        },
        {
          type: 'assistant',
          timestamp: '2026-11-17T09:55:00.000Z',
          message: {
            role: 'assistant',
            model: 'claude-sonnet-test',
            content: [
              { type: 'tool_use', name: 'Edit', input: { file_path: '/workspace/alpha-app/src/index.ts' } },
              { type: 'text', text: 'Updated src/index.ts and running checks.' }
            ]
          }
        }
      ],
      new Date('2026-11-17T09:55:00.000Z')
    )

    writeJsonl(
      join(idleSlug, '00000002-0000-0000-0000-000000000002.jsonl'),
      [
        {
          type: 'assistant',
          timestamp: '2026-11-17T07:30:00.000Z',
          cwd: '/workspace/beta-tool',
          gitBranch: 'main',
          message: {
            role: 'assistant',
            model: 'claude-sonnet-test',
            content: [{ type: 'text', text: 'Finished beta refactor.' }]
          }
        }
      ],
      new Date('2026-11-17T07:30:00.000Z')
    )

    const { registry, makeCtx } = setup({ projectsDir, now: () => now })
    const ctx = makeCtx()

    // Default active_only=true returns only the running session
    const activeRun = await runOn(registry, ctx, { callId: 'c-active', name: 'claude_sessions', args: {} })
    expect(activeRun.result.ok).toBe(true)
    if (activeRun.result.ok) {
      const data = activeRun.result.data as { sessions: number; text: string }
      expect(data.sessions).toBe(1)
      expect(data.text).toContain('🟢 ACTIVE  alpha-app')
      expect(data.text).toContain('branch feat/status-port')
      expect(data.text).toContain('last activity 5m ago')
      expect(data.text).toContain('edited 1: src/index.ts')
      expect(data.text).not.toContain('beta-tool')
    }

    // active_only=false returns both running and finished sessions
    const allRun = await runOn(registry, ctx, {
      callId: 'c-all',
      name: 'claude_sessions',
      args: { active_only: false }
    })
    expect(allRun.result.ok).toBe(true)
    if (allRun.result.ok) {
      const data = allRun.result.data as { sessions: number; text: string }
      expect(data.sessions).toBe(2)
      expect(data.text).toContain('🟢 ACTIVE  alpha-app')
      expect(data.text).toContain('⚪ idle  beta-tool')
      expect(data.text).toContain('last activity 2h 30m ago')
    }

    // project filter
    const filteredRun = await runOn(registry, ctx, {
      callId: 'c-proj',
      name: 'claude_sessions',
      args: { project: 'beta', active_only: false }
    })
    expect(filteredRun.result.ok).toBe(true)
    if (filteredRun.result.ok) {
      const data = filteredRun.result.data as { sessions: number; text: string }
      expect(data.sessions).toBe(1)
      expect(data.text).toContain('beta-tool')
    }

    // remote machine request is answered honestly as local-only
    const remoteRun = await runOn(registry, ctx, {
      callId: 'c-remote',
      name: 'claude_sessions',
      args: { machine: 'remote-box-9' }
    })
    expect(remoteRun.result.ok).toBe(true)
    if (remoteRun.result.ok) {
      const data = remoteRun.result.data as { sessions: number; remoteUnsupported: boolean; text: string }
      expect(data.sessions).toBe(0)
      expect(data.remoteUnsupported).toBe(true)
      expect(data.text).toContain('this host')
      expect(data.text).toContain('remote-box-9')
    }
  })
})

describe('session_notices', () => {
  it('reports status, toggles on/off, preserves other chats and unknown keys', async () => {
    const dir = tmpDir('cc-notices-')
    const routesFile = join(dir, 'session_notice_routes.json')
    const initialRoutes = {
      schema_version: 2,
      extra_top_key: 'keep-top',
      routes: [
        {
          machine: 'box-alpha',
          target: '0000000000@s.whatsapp.net',
          enabled: true,
          mode: 'full',
          when: 'session_end',
          quote_prompt: false,
          custom_meta: { owner: 'test' }
        },
        {
          machine: 'box-beta',
          target: '0000000000@s.whatsapp.net',
          enabled: true,
          mode: 'summary',
          when: 'every_turn'
        },
        {
          machine: 'box-alpha',
          target: '00000000000@s.whatsapp.net',
          enabled: true,
          mode: 'summary',
          note: 'other-chat'
        }
      ]
    }
    writeFileSync(routesFile, JSON.stringify(initialRoutes, null, 2), 'utf8')

    const { storage, registry, makeCtx } = setup({ routesFile })
    const ctx = makeCtx('0000000000@s.whatsapp.net')

    // status
    const statusRun = await runOn(registry, ctx, {
      callId: 'n-status',
      name: 'session_notices_status',
      args: {}
    })
    expect(statusRun.result.ok).toBe(true)
    if (statusRun.result.ok) {
      const data = statusRun.result.data as { changed: boolean; notices: { machine: string; on: boolean }[] }
      expect(data.changed).toBe(false)
      expect(data.notices).toEqual([
        { machine: 'box-alpha', on: true },
        { machine: 'box-beta', on: true }
      ])
      expect(statusRun.result.receipt).toBeUndefined()
    }

    // off for one machine with natural-language article ("the box-alpha")
    const offRun = await runOn(registry, ctx, {
      callId: 'n-off',
      name: 'session_notices_set',
      args: { enabled: false, machine: 'the box-alpha' }
    })
    expect(offRun.result.ok).toBe(true)
    if (offRun.result.ok) {
      const data = offRun.result.data as { changed: boolean; now: string; machines_changed: string[] }
      expect(data.changed).toBe(true)
      expect(data.now).toBe('off')
      expect(data.machines_changed).toEqual(['box-alpha'])
      expect(offRun.result.receipt?.kind).toBe('session_notices.off')
    }

    const afterOff = JSON.parse(readFileSync(routesFile, 'utf8'))
    expect(afterOff.schema_version).toBe(2)
    expect(afterOff.extra_top_key).toBe('keep-top')
    expect(afterOff.routes[0].enabled).toBe(false)
    expect(afterOff.routes[0].mode).toBe('full')
    expect(afterOff.routes[0].when).toBe('session_end')
    expect(afterOff.routes[0].custom_meta).toEqual({ owner: 'test' })
    expect(afterOff.routes[1].enabled).toBe(true)
    expect(afterOff.routes[2].enabled).toBe(true)
    expect(afterOff.routes[2].note).toBe('other-chat')

    // on for all machines ("all machines")
    const onRun = await runOn(registry, ctx, {
      callId: 'n-on',
      name: 'session_notices_set',
      args: { enabled: true, machine: 'all machines' }
    })
    expect(onRun.result.ok).toBe(true)
    if (onRun.result.ok) {
      const data = onRun.result.data as {
        changed: boolean
        now: string
        machines_changed: string[]
        machines_already_set: string[]
      }
      expect(data.changed).toBe(true)
      expect(data.now).toBe('on')
      expect(data.machines_changed).toEqual(['box-alpha'])
      expect(data.machines_already_set).toEqual(['box-beta'])
      expect(onRun.result.receipt?.kind).toBe('session_notices.on')
    }

    const receipts = storage.read((db) =>
      db.prepare('SELECT kind, target FROM receipt WHERE chat_id = ?').all(ctx.chat.chatId)
    ) as { kind: string; target: string }[]
    expect(receipts.map((r) => r.kind)).toEqual(['session_notices.off', 'session_notices.on'])
  })

  it('leaves no receipt when the routes file write fails', async () => {
    const dir = tmpDir('cc-fail-')
    const routesFile = join(dir, 'session_notice_routes.json')
    writeFileSync(
      routesFile,
      JSON.stringify({
        routes: [{ machine: 'box-alpha', target: '0000000000@s.whatsapp.net', enabled: true }]
      }),
      'utf8'
    )

    const { storage, registry, makeCtx } = setup({ routesFile })
    const ctx = makeCtx('0000000000@s.whatsapp.net')

    chmodSync(dir, 0o555)
    try {
      const failRun = await runOn(registry, ctx, {
        callId: 'n-fail',
        name: 'session_notices_set',
        args: { enabled: false }
      })
      expect(failRun.result.ok).toBe(false)
      if (!failRun.result.ok) {
        expect(failRun.result.kind).toBe('error')
      }
    } finally {
      chmodSync(dir, 0o755)
    }

    const receiptCount = storage.read((db) =>
      db.prepare('SELECT COUNT(*) as n FROM receipt WHERE chat_id = ?').get(ctx.chat.chatId)
    ) as { n: number }
    expect(receiptCount.n).toBe(0)
  })
})

/** Runs one tool call through the registry, in the shape these tests read. */
async function runOn(
  registry: ToolRegistry,
  context: TurnContext,
  call: { callId: string; name: string; args: unknown }
): Promise<{ result: ToolResult }> {
  return { result: await registry.call(call.name, call.args, context, { callId: call.callId, source: 'model' }) }
}
