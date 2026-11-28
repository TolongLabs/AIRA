import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config } from '../config/schema.js'
import { createReplyCleaner } from '../format/clean.js'
import { createPromptBuilder } from '../prompt/builder.js'
import { createLogger } from '../records/logger.js'
import { createRedactor } from '../records/redact.js'
import { ensureChat, setChatStatus } from '../settings/chats.js'
import { setSetting } from '../settings/settings.js'
import { openDatabase } from '../storage/database.js'
import { applyMigrations } from '../storage/migrate.js'
import { createTurnService } from '../turn/pipeline.js'
import type { BuiltPrompt, RunResult, TurnRunner } from '../turn/types.js'
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

/** A real harness turn in a disposable store, without real chat history, tools or delivery. */
export async function previewPack(options: {
  pack: Pack
  config: Config
  harnessRules: string
  message: string
  live?: boolean
  runner?: TurnRunner
  toolNames?: () => string[]
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
      setChatStatus(storage, { chatId: chat.chatId, status: 'active', actor: 'preview' })
      setSetting(storage, { level: 'chat', scope: chat.chatId, key: 'character', value: pack.id, actor: 'preview' })
      // The selected pack is the only one available. No model-based judge or memory recall,
      // no tools, research, media, delivery hooks or real diagnostic sink are connected.
      const builder = createPromptBuilder({ storage, config, harnessRules, newSeed: () => 1 })
      let built: BuiltPrompt | undefined
      const turns = createTurnService({
        storage,
        config: { turn: { batchMs: 0 }, llm: config.llm, records: config.records, tools: { maxCallsPerTurn: 0 } },
        logger: createLogger({ level: 'error', module: 'pack-preview', sink: () => {} }),
        redactor: createRedactor(),
        packs: () => ({ packs: new Map([[pack.id, pack]]), faults: [] }),
        prompt: {
          async build(input) {
            built = await builder.build(input)
            return built
          }
        },
        runner: {
          run: (input) =>
            live && runner ? runner.run({ ...input, tools: [], maxToolCalls: 0 }) : Promise.resolve(scriptedReply(pack))
        },
        cleaner: createReplyCleaner(config, options.toolNames),
        alerter: { raise: () => false }
      })
      try {
        const reply = await turns.handle({
          type: 'turn',
          marker: {
            platform: 'preview',
            kind: 'dm',
            chat: 'synthetic-preview',
            sender: 'synthetic-preview-member',
            mid: 'synthetic-preview-message'
          },
          text: message,
          earlier: '',
          attachments: [],
          stream: false,
          includeUsage: false
        })
        if (!built || !reply.content) throw new Error('preview turn did not produce a reply')
        return { mood: built.record.mood ?? pack.defaultMood, shape: built.shape, reply: reply.content, live }
      } finally {
        await turns.drain(config.shutdown.graceMs)
      }
    } finally {
      storage.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
