import { describe, expect, it, vi } from 'vitest'
import { loadPack } from '../../src/character/loader.js'
import { previewPack } from '../../src/character/preview.js'
import { loadConfig } from '../../src/config/loader.js'
import { type RunResult, type TurnRunner } from '../../src/turn/types.js'

const config = loadConfig('config.yml')
const harnessRules = 'Keep the conversation natural.'
const pack = loadPack('characters/example', 'repository')
const result = (text: string): RunResult => ({
  text,
  role: 'main',
  model: 'fictional-model',
  transport: 'api',
  usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
  costUsd: 0,
  calls: [
    { role: 'main', model: 'fictional-model', transport: 'api', attempt: 1, startedAt: new Date(), durationMs: 1 }
  ],
  receipts: []
})

describe('pack preview', () => {
  it('uses the actual mood, shape and cleaner without calling a live runner by default', async () => {
    const runner = { run: vi.fn<TurnRunner['run']>() }
    const preview = await previewPack({ pack, config, harnessRules, message: 'hello', runner })
    expect(pack.moods.has(preview.mood)).toBe(true)
    expect(preview.shape).toEqual(expect.objectContaining({ maxChars: expect.any(Number) }))
    expect(preview.reply).toBeTruthy()
    expect(preview.live).toBe(false)
    expect(runner.run).not.toHaveBeenCalled()
  })

  it('uses the live runner only by opt-in with a synthetic turn and no tools, then cleans the reply', async () => {
    const runner = { run: vi.fn<TurnRunner['run']>().mockResolvedValue(result('Example: **hello there.**')) }
    const preview = await previewPack({ pack, config, harnessRules, message: 'hello there', live: true, runner })
    expect(runner.run).toHaveBeenCalledTimes(1)
    const input = runner.run.mock.calls[0]![0]
    expect(input.tools).toEqual([])
    expect(input.maxToolCalls).toBe(0)
    expect(input.messages).toEqual([{ role: 'user', content: 'hello there' }])
    expect(input.context.character).toBe(pack)
    expect(input.system.some((block) => block.name === 'harness')).toBe(true)
    expect(preview.reply).not.toContain('Example:')
    expect(preview.reply).toBe('**Hello there.**')
    expect(preview.live).toBe(true)
  })

  it('fails closed if live preview is not configured', async () => {
    await expect(previewPack({ pack, config, harnessRules, message: 'hello', live: true })).rejects.toThrow(
      'live preview unavailable'
    )
  })

  it('uses the harness role-recovery path rather than exposing a rejected first reply', async () => {
    const runner = {
      run: vi
        .fn<TurnRunner['run']>()
        .mockResolvedValueOnce(result('The API returned HTTP 429.'))
        .mockResolvedValueOnce(result('Let us try again later.'))
    }
    const preview = await previewPack({ pack, config, harnessRules, message: 'hello', live: true, runner })
    expect(runner.run).toHaveBeenCalledTimes(2)
    expect(preview.reply).toBe('Let us try again later.')
    expect(runner.run.mock.calls.every(([input]) => input.tools.length === 0 && input.maxToolCalls === 0)).toBe(true)
  })

  it('applies the harness leak guard to a live preview', async () => {
    const privateRules = 'one two three four five six seven eight nine ten eleven twelve'
    const runner = { run: vi.fn<TurnRunner['run']>().mockResolvedValue(result(privateRules)) }
    const preview = await previewPack({
      pack,
      config,
      harnessRules: privateRules,
      message: 'hello',
      live: true,
      runner
    })
    expect(preview.reply).toBe(pack.lines.fallback)
  })
})
