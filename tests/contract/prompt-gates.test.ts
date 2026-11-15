import { describe, expect, it } from 'vitest'
import { type Mood, loadPack, loadPacks } from '../../src/character/loader.js'
import { loadConfig } from '../../src/config/loader.js'
import { buildSystemBlocks, createPromptBuilder, estimateTokens, loadHarnessRules } from '../../src/prompt/builder.js'
import { FACE_LIMIT, LENGTH_CHARS } from '../../src/prompt/shape.js'
import type { TurnInput } from '../../src/turn/types.js'
import { tmpStorage } from '../support/tmp.js'

function longestOf(items: readonly string[]): string | undefined {
  let best: string | undefined
  for (const item of items) {
    if (best === undefined || item.length > best.length) best = item
  }
  return best
}

function longestShapeText(mood: Mood): string {
  const lines = ['Reply shape for this message:', `Keep the reply under ${LENGTH_CHARS.long} characters.`]
  const opener = longestOf(mood.openers)
  if (opener !== undefined) lines.push(`Open in the spirit of: "${opener}"`)
  const ending = longestOf(mood.endings)
  if (ending !== undefined) lines.push(`Close in the spirit of: "${ending}"`)
  if (mood.faces.length > 0) {
    const longestFaces = [...mood.faces].sort((a, b) => b.length - a.length).slice(0, FACE_LIMIT)
    lines.push(`You may use at most ${longestFaces.length} of these faces: ${longestFaces.join(' ')}`)
  }
  return lines.join('\n')
}

describe('prompt gates', () => {
  it('Prompt Size: every repository pack and mood stays within prompt.maxSystemTokens', () => {
    const config = loadConfig('config.yml')
    const harnessRules = loadHarnessRules()
    const { packs, faults } = loadPacks({ repositoryDir: 'characters' })
    expect(faults).toEqual([])
    expect(packs.size).toBeGreaterThan(0)

    const recalled = Array.from({ length: 5 }, (_, i) => `item-${i}-${'x'.repeat(193)}`)
    const context = [
      'Chat type: group',
      'Time: 2026-01-02T03:04:05.000Z (Friday)',
      '<memory untrusted="true">',
      ...recalled.map((item) => `- ${item}`),
      '</memory>'
    ].join('\n')

    for (const pack of packs.values()) {
      for (const mood of pack.moods.values()) {
        const blocks = buildSystemBlocks({
          pack,
          harnessRules,
          context,
          tone: mood.tone,
          shape: longestShapeText(mood)
        })
        const tokens = estimateTokens(blocks.map((b) => b.text).join('\n\n'))
        expect(tokens, `${pack.id}/${mood.key}`).toBeLessThanOrEqual(config.prompt.maxSystemTokens)
      }
    }
  })

  it('Prompt Golden: matches the golden snapshot for a fixed example turn', async () => {
    const storage = tmpStorage()
    const pack = loadPack('characters/example', 'repository')
    const builder = createPromptBuilder({
      storage,
      config: {
        prompt: { maxSystemTokens: 8000 },
        judge: { mood: 'off', moodMinProbability: 0.3, timeoutMs: 1000 }
      },
      harnessRules: loadHarnessRules(),
      newSeed: () => 7,
      now: () => new Date('2026-01-02T03:04:05.000Z')
    })

    const message = {
      role: 'user' as const,
      senderId: 's_test_member',
      content: 'what time is dinner?',
      at: '2026-01-02T03:04:05.000Z'
    }
    const input: TurnInput = {
      context: {
        turnId: 't_golden',
        chat: {
          chatId: 'c_golden',
          waId: 'test-chat-golden',
          type: 'group',
          label: '',
          status: 'active'
        },
        senderId: 's_test_member',
        character: pack,
        settings: {},
        kind: 'reply',
        delivery: { kind: 'reply' },
        deadline: Date.UTC(2026, 0, 2, 3, 5, 0)
      },
      window: [message],
      pending: [message]
    }

    const built = await builder.build(input)
    const text = built.system.map((block) => `--- ${block.name} ---\n${block.text}`).join('\n')
    await expect(text).toMatchFileSnapshot('golden/prompt-example.txt')
  })
})
