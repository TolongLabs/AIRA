import { BUBBLE_BREAK } from '../gateway/response.js'

// Bubble splitter and content joiner (docs/trd/prompt-engine.md#bubbles).

/** The gateway's own chunk limit. No bubble may reach it. */
export const GATEWAY_CHUNK_LIMIT = 4096

type UnitKind = 'code' | 'list-item' | 'paragraph'

interface Unit {
  kind: UnitKind
  text: string
}

const LIST_ITEM_RE = /^(?:- |\d+\. )/
const SENTENCE_RE = new RegExp(
  `[\\s\\S]*?[.!?${String.fromCodePoint(0x2026)}${String.fromCodePoint(0x3002)}${String.fromCodePoint(0xff01)}${String.fromCodePoint(0xff1f)}](?=\\s|$)`,
  'g'
)

function extractUnits(text: string): Unit[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const units: Unit[] = []
  let para: string[] = []
  let i = 0

  const flushPara = () => {
    if (para.length > 0) {
      const joined = para.join('\n').trim()
      if (joined.length > 0) units.push({ kind: 'paragraph', text: joined })
      para = []
    }
  }

  while (i < lines.length) {
    const line = lines[i]!
    if (line.startsWith('```')) {
      flushPara()
      const codeLines = [line]
      i++
      while (i < lines.length && !lines[i]!.startsWith('```')) {
        codeLines.push(lines[i]!)
        i++
      }
      if (i < lines.length) {
        codeLines.push(lines[i]!)
        i++
      }
      units.push({ kind: 'code', text: codeLines.join('\n') })
      continue
    }

    if (line.trim() === '') {
      flushPara()
      i++
      continue
    }

    if (LIST_ITEM_RE.test(line)) {
      flushPara()
      units.push({ kind: 'list-item', text: line.trimEnd() })
      i++
      continue
    }

    para.push(line)
    i++
  }

  flushPara()
  return units
}

function splitLongWord(word: string, limit: number): string[] {
  const parts: string[] = []
  for (let i = 0; i < word.length; i += limit) {
    parts.push(word.slice(i, i + limit))
  }
  return parts
}

function splitAtSpaces(text: string, limit: number): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0)
  const chunks: string[] = []
  let current = ''

  for (const word of words) {
    if (word.length > limit) {
      if (current.length > 0) {
        chunks.push(current)
        current = ''
      }
      const parts = splitLongWord(word, limit)
      for (let idx = 0; idx < parts.length - 1; idx++) chunks.push(parts[idx]!)
      current = parts[parts.length - 1] ?? ''
      continue
    }

    if (current.length === 0) current = word
    else if (current.length + 1 + word.length <= limit) current += ` ${word}`
    else {
      chunks.push(current)
      current = word
    }
  }

  if (current.length > 0) chunks.push(current)
  return chunks
}

function splitSentences(paragraph: string): string[] {
  SENTENCE_RE.lastIndex = 0
  const out: string[] = []
  let lastIndex = 0
  let match = SENTENCE_RE.exec(paragraph)

  while (match !== null) {
    const s = match[0].trim()
    if (s.length > 0) out.push(s)
    lastIndex = SENTENCE_RE.lastIndex
    match = SENTENCE_RE.exec(paragraph)
  }

  if (lastIndex < paragraph.length) {
    const rest = paragraph.slice(lastIndex).trim()
    if (rest.length > 0) out.push(rest)
  }
  return out
}

function splitParagraph(paragraph: string, limit: number): string[] {
  if (paragraph.length <= limit) return [paragraph]
  const sentences = splitSentences(paragraph)
  const chunks: string[] = []
  let current = ''

  for (const sentence of sentences) {
    if (sentence.length > limit) {
      if (current.length > 0) {
        chunks.push(current)
        current = ''
      }
      chunks.push(...splitAtSpaces(sentence, limit))
      continue
    }

    if (current.length === 0) current = sentence
    else if (current.length + 1 + sentence.length <= limit) current += ` ${sentence}`
    else {
      chunks.push(current)
      current = sentence
    }
  }

  if (current.length > 0) chunks.push(current)
  return chunks
}

function splitAtLines(text: string, limit: number): string[] {
  const lines = text.split('\n')
  const chunks: string[] = []
  let current = ''

  for (const line of lines) {
    if (line.length > limit) {
      if (current.length > 0) {
        chunks.push(current)
        current = ''
      }
      chunks.push(...splitLongWord(line, limit))
      continue
    }
    if (current.length === 0) current = line
    else if (current.length + 1 + line.length <= limit) current += `\n${line}`
    else {
      chunks.push(current)
      current = line
    }
  }

  if (current.length > 0) chunks.push(current)
  return chunks
}

function packUnits(units: Unit[], limit: number): string[] {
  const pieces: Unit[] = []
  for (const unit of units) {
    if (unit.kind === 'code' || unit.kind === 'list-item') {
      if (unit.text.length < GATEWAY_CHUNK_LIMIT) pieces.push(unit)
      else {
        for (const chunk of splitAtLines(unit.text, GATEWAY_CHUNK_LIMIT - 1)) {
          pieces.push({ kind: unit.kind, text: chunk })
        }
      }
    } else {
      for (const chunk of splitParagraph(unit.text, limit)) {
        pieces.push({ kind: 'paragraph', text: chunk })
      }
    }
  }

  const bubbles: string[] = []
  let current = ''
  let lastKind: UnitKind | undefined

  for (const piece of pieces) {
    const trimmedPiece = piece.text.trim()
    if (trimmedPiece.length === 0) continue

    if (current.length === 0) {
      current = trimmedPiece
      lastKind = piece.kind
      continue
    }

    const sep = lastKind === 'list-item' && piece.kind === 'list-item' ? '\n' : '\n\n'
    if (current.length + sep.length + trimmedPiece.length <= limit) {
      current += sep + trimmedPiece
      lastKind = piece.kind
    } else {
      bubbles.push(current.trim())
      current = trimmedPiece
      lastKind = piece.kind
    }
  }

  if (current.trim().length > 0) bubbles.push(current.trim())
  return bubbles
}

export function splitBubbles(
  text: string,
  limits: { maxChars: number; maxBubbles: number }
): { bubbles: string[]; trimmed: boolean } {
  const trimmedText = text.trim()
  if (trimmedText.length === 0) return { bubbles: [], trimmed: false }

  const maxLimit = GATEWAY_CHUNK_LIMIT - 1
  const initialLimit = Math.max(1, Math.min(limits.maxChars, maxLimit))
  const maxBubbles = Math.max(1, limits.maxBubbles)

  if (trimmedText.length <= initialLimit) return { bubbles: [trimmedText], trimmed: false }

  const units = extractUnits(trimmedText)
  let limit = initialLimit
  let bubbles = packUnits(units, limit)

  if (bubbles.length <= maxBubbles) return { bubbles, trimmed: false }

  if (limit < maxLimit) {
    let nextLimit = Math.min(maxLimit, Math.ceil((trimmedText.length / maxBubbles) * 1.1))
    if (nextLimit <= limit) nextLimit = Math.min(maxLimit, Math.max(limit + 1, Math.ceil(limit * 1.1)))

    while (true) {
      limit = nextLimit
      bubbles = packUnits(units, limit)
      if (bubbles.length <= maxBubbles) return { bubbles, trimmed: false }
      if (limit >= maxLimit) break
      nextLimit = Math.min(maxLimit, Math.max(limit + 1, Math.ceil(limit * 1.1)))
    }
  }

  return { bubbles: bubbles.slice(0, maxBubbles), trimmed: true }
}

/** Joins bubbles with a line that holds only the bubble break, and appends one `MEDIA:<path>` line per attachment. */
export function joinContent(bubbles: string[], media?: string[]): string {
  const mediaLines = (media ?? []).map((path) => `MEDIA:${path}`)
  if (bubbles.length === 0) return mediaLines.join('\n')
  const body = bubbles.join(`\n${BUBBLE_BREAK}\n`)
  if (mediaLines.length === 0) return body
  return `${body}\n${mediaLines.join('\n')}`
}
