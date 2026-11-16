import type { Pack } from '../character/loader.js'
import { detectFormatRequest } from '../format/request.js'
import { pick, seededRandom } from './random.js'

export const LENGTH_CHARS = { short: 280, default: 600, long: 1400 } as const
/** How many faces a reply is offered, drawn fresh each time from the mood's pool. */
export const FACE_LIMIT = 4

export interface ReplyShape {
  length: 'short' | 'default' | 'long'
  /** Undefined when a bypass lifted the length. */
  maxChars?: number
  lengthBypass: boolean
  bypassReason?: string
  opener?: string
  ending?: string
  faces: string[]
  /** The lines of the beats drawn for this reply. */
  beats: string[]
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

/** How often a reply is given an opener, and an ending, to write in the spirit of. */
export const OPENER_RATE = 1 / 3
export const ENDING_RATE = 1 / 4

function pickFresh(options: string[], last: string | undefined, random: () => number): string | undefined {
  const fresh = options.filter((option) => option !== last)
  return fresh.length > 0 ? pick(fresh, random) : undefined
}

export function drawShape(input: {
  pack: Pack
  mood: string
  /** The resolved `replyLength` setting: 'short', 'default' or 'long'. */
  replyLength: 'short' | 'default' | 'long'
  lastOpener?: string
  lastEnding?: string
  bypassReason?: string
  seed: number
}): ReplyShape {
  const mood = input.pack.moods.get(input.mood) ?? input.pack.moods.get(input.pack.defaultMood)
  const length = input.replyLength === 'default' ? input.pack.card.defaultReplyLength : input.replyLength
  const lengthBypass = input.bypassReason !== undefined
  const maxChars = lengthBypass ? undefined : LENGTH_CHARS[length]

  const random = seededRandom(input.seed)

  // An opener or ending is drawn only for some replies, and never the one the chat saw last: a fixed phrase in
  // every reply reads as a tic.
  const opener = mood && random() < OPENER_RATE ? pickFresh(mood.openers, input.lastOpener, random) : undefined
  const ending = mood && random() < ENDING_RATE ? pickFresh(mood.endings, input.lastEnding, random) : undefined

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

  // Each beat the mood allows is rolled once, at its odds. Left to the prompt, beats were rare.
  const beats = (mood?.beats ?? []).filter((beat) => random() < beat.odds).map((beat) => beat.line)

  return {
    length,
    maxChars,
    lengthBypass,
    bypassReason: input.bypassReason,
    opener,
    ending,
    faces,
    beats,
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
    lines.push(
      `Faces that fit: ${shape.faces.join(' ')}. Use one, or two when flustered or excited; a sincere moment may need none. Use no other face.`
    )
  }
  for (const beat of shape.beats) lines.push(beat)
  return lines.join('\n')
}
