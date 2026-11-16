import type { Config } from '../config/schema.js'
import { buildSystemBlocks, estimateTokens, loadHarnessRules } from '../prompt/builder.js'
import { FACE_LIMIT, LENGTH_CHARS } from '../prompt/shape.js'
import { type Mood, type Pack, loadPacks } from './loader.js'

export interface PackCheck {
  id: string
  ok: boolean
  faults: string[]
  promptTokens?: number
  ceiling: number
  moods: number
  stickers: number
}

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
    lines.push(
      `Faces that fit: ${longestFaces.join(' ')}. Use one, or two when flustered or excited; a sincere moment may need none. Use no other face.`
    )
  }
  // The worst case draws every beat.
  for (const beat of mood.beats) lines.push(beat.line)
  return lines.join('\n')
}

function maxPromptTokens(pack: Pack, harnessRules: string): number {
  const recalled = Array.from({ length: 5 }, (_, i) => `item-${i}-${'x'.repeat(193)}`)
  const context = [
    'Chat type: group',
    'Time: 2026-01-02T03:04:05.000Z (Friday)',
    '<memory untrusted="true">',
    ...recalled.map((item) => `- ${item}`),
    '</memory>'
  ].join('\n')

  let maxTokens = 0
  for (const mood of pack.moods.values()) {
    const blocks = buildSystemBlocks({
      pack,
      harnessRules,
      context,
      tone: mood.tone,
      shape: longestShapeText(mood)
    })
    const tokens = estimateTokens(blocks.map((b) => b.text).join('\n\n'))
    if (tokens > maxTokens) maxTokens = tokens
  }
  return maxTokens
}

export function checkPack(options: {
  id: string
  repositoryDir: string
  dataDir?: string
  config: Config
  harnessRulesPath?: string
}): PackCheck {
  const ceiling = options.config.prompt.maxSystemTokens
  const loaded = loadPacks({ repositoryDir: options.repositoryDir, dataDir: options.dataDir })
  const matchingFaults = loaded.faults.filter((f) => f.id === options.id).map((f) => f.message)
  if (matchingFaults.length > 0) {
    return { id: options.id, ok: false, faults: matchingFaults, ceiling, moods: 0, stickers: 0 }
  }

  const pack = loaded.packs.get(options.id)
  if (!pack) {
    return { id: options.id, ok: false, faults: [`unknown pack "${options.id}"`], ceiling, moods: 0, stickers: 0 }
  }

  const stickerSet = new Set<string>()
  for (const mood of pack.moods.values()) {
    for (const sticker of mood.stickers) stickerSet.add(sticker)
  }

  const harnessRules = loadHarnessRules(options.harnessRulesPath)
  const promptTokens = maxPromptTokens(pack, harnessRules)
  const faults: string[] = []
  if (promptTokens > ceiling) {
    faults.push('prompt over the ceiling')
  }

  return {
    id: options.id,
    ok: faults.length === 0,
    faults,
    promptTokens,
    ceiling,
    moods: pack.moods.size,
    stickers: stickerSet.size
  }
}

export function formatPackCheck(check: PackCheck): string {
  const status = check.ok ? 'ok' : 'fail'
  const tokens = check.promptTokens !== undefined ? `${check.promptTokens}/${check.ceiling}` : `-/${check.ceiling}`
  const lines = [`pack ${check.id}: ${status} (moods=${check.moods} stickers=${check.stickers} tokens=${tokens})`]
  for (const fault of check.faults) {
    lines.push(`  ${fault}`)
  }
  return lines.join('\n')
}
