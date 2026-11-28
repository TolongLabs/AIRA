import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config } from '../config/schema.js'
import { createReplyCleaner } from '../format/clean.js'
import { createPromptBuilder } from '../prompt/builder.js'
import { ensureChat } from '../settings/chats.js'
import { openDatabase } from '../storage/database.js'
import { applyMigrations } from '../storage/migrate.js'
import { createTurnSources } from '../turn/sources.js'
import type { RunResult, TurnContext, TurnRunner, WindowMessage } from '../turn/types.js'
import type { Pack } from './loader.js'

export interface PackPreview {
  mood: string
  shape: unknown
  reply: string
  live: boolean
}

function scriptedReply(pack: Pack): RunResult {
  return {
    text: `${pack.card.displayName}: **hello from the preview.**`,
    model: 'scripted',
    role: 'main',
    transport: 'scripted',
    usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
    costUsd: 0,
    calls: [],
    receipts: []
  }
}

/** A one-message harness turn, with no real chat, memory, offered tools or delivery transport. */
export async function previewPack(options: {
  pack: Pack
  config: Config
  harnessRules: string
  message: string
  live?: boolean
  runner?: TurnRunner
}): Promise<PackPreview> {
  const { pack, config, harnessRules, message, runner } = options
  const live = options.live === true
  if (live && !runner) throw new Error('live preview unavailable')
  const dir = mkdtempSync(join(tmpdir(), 'aira-pack-preview-'))
  try {
    const storage = openDatabase(join(dir, 'preview.db'))
    try {
      applyMigrations(storage)
      const chat = ensureChat(storage, { waId: 'synthetic-preview', type: 'dm' })
      const deadline = Date.now() + config.llm.turnDeadlineMs
      const context: TurnContext = {
        turnId: randomUUID(),
        chat,
        senderId: 'synthetic-preview',
        character: pack,
        settings: {},
        kind: 'reply',
        delivery: { kind: 'reply' },
        deadline,
        sources: createTurnSources()
      }
      const user: WindowMessage = { role: 'user', content: message, at: new Date().toISOString() }
      // Leave the judge and recall unconfigured: neither can access real state or make model calls.
      const builder = createPromptBuilder({ storage, config, harnessRules, newSeed: () => 1 })
      const built = await builder.build({ context, window: [user], pending: [user] })
      const run = live
        ? await runner!.run({
            system: built.system,
            messages: built.messages,
            tools: [],
            maxToolCalls: 0,
            context,
            signal: AbortSignal.timeout(Math.max(1, deadline - Date.now()))
          })
        : scriptedReply(pack)
      const cleaned = createReplyCleaner(config).clean({ text: run.text, context, built, run })
      if (!cleaned.content) throw new Error('preview cleaning failed')
      return { mood: built.record.mood ?? pack.defaultMood, shape: built.shape, reply: cleaned.content, live }
    } finally {
      storage.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
