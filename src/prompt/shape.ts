import type { Pack } from '../character/loader.js'
import { detectFormatRequest } from '../format/request.js'
import { pick, seededRandom } from './random.js'

export const LENGTH_CHARS = { short: 280, default: 600, long: 1400 } as const
export const FACE_LIMIT = 2

export interface ReplyShape {
  length: 'short' | 'default' | 'long'
  /** Undefined when a bypass lifted the length. */
  maxChars?: number
  lengthBypass: boolean
  bypassReason?: string
  opener?: string
  ending?: string
  faces: string[]
  seed: number
}

/** The reason the default length is lifted, or undefined. */
export function detectLengthBypass(input: {
  userText: string
  usedResearchTool?: boolean
  commandListsOutput?: boolean
}): string | undefined {
  const format = detectFormatRequest(input.userText)
  if (format !== undefined) return `format:${format}`
  if (input.usedResearchTool) return 'research'
  if (input.commandListsOutput) return 'command_list'
  return undefined
}

export function drawShape(input: {
  pack: Pack
  mood: string
  /** The resolved `replyLength` setting: 'short', 'default' or 'long'. */
  replyLength: 'short' | 'default' | 'long'
  lastOpener?: string
  bypassReason?: string
  seed: number
}): ReplyShape {
  const mood = input.pack.moods.get(input.mood) ?? input.pack.moods.get(input.pack.defaultMood)
  const length = input.replyLength === 'default' ? input.pack.card.defaultReplyLength : input.replyLength
  const lengthBypass = input.bypassReason !== undefined
  const maxChars = lengthBypass ? undefined : LENGTH_CHARS[length]

  const random = seededRandom(input.seed)

  let opener: string | undefined
  if (mood && mood.openers.length > 0) {
    const filtered =
      input.lastOpener !== undefined && mood.openers.length > 1
        ? mood.openers.filter((o) => o !== input.lastOpener)
        : mood.openers
    opener = pick(filtered.length > 0 ? filtered : mood.openers, random)
  }

  const ending = mood ? pick(mood.endings, random) : undefined

  const faces: string[] = []
  if (mood && mood.faces.length > 0) {
    const pool = [...new Set(mood.faces)]
    const count = Math.min(FACE_LIMIT, pool.length)
    for (let i = 0; i < count; i++) {
      const index = Math.floor(random() * pool.length)
      const chosen = pool.splice(index, 1)[0]
      if (chosen !== undefined) faces.push(chosen)
    }
  }

  return {
    length,
    maxChars,
    lengthBypass,
    bypassReason: input.bypassReason,
    opener,
    ending,
    faces,
    seed: input.seed
  }
}

/** Block 6: the shape as short instructions for the model. */
export function shapeText(shape: ReplyShape): string {
  const lines = [
    'Reply shape for this message:',
    shape.maxChars !== undefined
      ? `Keep the reply under ${shape.maxChars} characters.`
      : 'Use the length the answer needs.'
  ]
  if (shape.opener !== undefined) lines.push(`Open in the spirit of: "${shape.opener}"`)
  if (shape.ending !== undefined) lines.push(`Close in the spirit of: "${shape.ending}"`)
  if (shape.faces.length > 0) {
    lines.push(`You may use at most ${shape.faces.length} of these faces: ${shape.faces.join(' ')}`)
  }
  return lines.join('\n')
}
