import { describe, expect, it } from 'vitest'
import { loadPack } from '../../src/character/loader.js'
import { createLogger } from '../../src/records/logger.js'
import { createRedactor } from '../../src/records/redact.js'
import { ensureChat, setChatStatus } from '../../src/settings/chats.js'
import { resolveSettings, setSetting } from '../../src/settings/settings.js'
import { createCommandRouter } from '../../src/tools/commands.js'
import { registerCoreTools } from '../../src/tools/core/index.js'
import { createToolRegistry } from '../../src/tools/registry.js'
import type { TurnContext } from '../../src/turn/types.js'
import { tmpDir, tmpStorage } from '../support/tmp.js'

const pack = loadPack('characters/example', 'repository')

function setup(maxPerMessage?: number) {
  const storage = tmpStorage()
  const registry = createToolRegistry({
    storage,
    config: { tools: { defaultTimeoutMs: 500 } },
    logger: createLogger({ level: 'error', module: 'commands-anywhere-test', sink: () => {} }),
    redactor: createRedactor()
  })
  registerCoreTools(registry, { filesDir: tmpDir('aira-files-') })
  const chat = ensureChat(storage, { waId: '0000000000@lid', type: 'group' })
  setChatStatus(storage, { chatId: chat.chatId, status: 'active', actor: 'test' })
  if (maxPerMessage !== undefined) {
    setSetting(storage, {
      level: 'chat',
      scope: chat.chatId,
      key: 'commands.maxPerMessage',
      value: maxPerMessage,
      actor: 'test'
    })
  }
  const context: TurnContext = {
    turnId: 'turn-1',
    chat,
    senderId: '1234567890@s.whatsapp.net',
    character: pack,
    settings: resolveSettings(storage, chat),
    kind: 'reply',
    delivery: { kind: 'reply' },
    deadline: Date.now() + 30_000
  }
  return { router: createCommandRouter(registry), context }
}

describe('commands anywhere matching', () => {
  it('matches a command at the start, in the middle, and after a line break', () => {
    const { router, context } = setup(3)
    expect(router.match('/remind me at 6', context).map((m) => m.name)).toEqual(['remind'])
    expect(router.match('hey can you /remind me at 6?', context).map((m) => m.name)).toEqual(['remind'])
    expect(router.match('hey\n/remind me at 6', context).map((m) => m.name)).toEqual(['remind'])
  })

  it('never treats a link, a path, or and/or as a command', () => {
    const { router, context } = setup(3)
    expect(router.match('see https://example.com/remind for details', context)).toEqual([])
    expect(router.match('open /remind/later or /usr/bin/help', context)).toEqual([])
    expect(router.match('do it today and/or tomorrow', context)).toEqual([])
    expect(router.match('check /help.txt', context)).toEqual([])
  })

  it('respects commands.maxPerMessage at 1 (default) and at 3', () => {
    const def = setup()
    expect(def.router.match('/remind me and /remember this', def.context).map((m) => m.name)).toEqual(['remind'])

    const three = setup(3)
    expect(three.router.match('/remind a /remember b /search c /recall d', three.context).map((m) => m.name)).toEqual([
      'remind',
      'remember',
      'search'
    ])
  })

  it('ignores unknown command names and keeps later valid ones', () => {
    const { router, context } = setup(2)
    expect(router.match('/unknown please', context)).toEqual([])
    expect(router.match('/unknown please /remind me at 6', context).map((m) => m.name)).toEqual(['remind'])
  })
})
