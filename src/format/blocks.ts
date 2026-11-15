// Parses model reply text into a neutral block and inline structure (docs/trd/prompt-engine.md#cleaning-chain).

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'bold'; children: Inline[] }
  | { type: 'italic'; children: Inline[] }
  | { type: 'strike'; children: Inline[] }
  | { type: 'code'; text: string }
  | { type: 'link'; text: string; url: string }

export type Block =
  | { type: 'paragraph'; inlines: Inline[] }
  | { type: 'heading'; inlines: Inline[] }
  | { type: 'list'; ordered: boolean; items: Inline[][] }
  | { type: 'quote'; inlines: Inline[] }
  | { type: 'code'; text: string }
  | { type: 'table'; header: string[]; rows: string[][] }

const FENCE_RE = /^ {0,3}```/
const FENCE_CLOSE_RE = /^ {0,3}```\s*$/
const HEADING_RE = /^ {0,3}(#{1,6}) (.*)$/
const HR_RE = /^ {0,3}(?:---+|\*\*\*+|___+)\s*$/
const QUOTE_RE = /^ {0,3}> ?(.*)$/
const BULLET_RE = new RegExp(`^ {0,3}[-*+${String.fromCodePoint(0x2022)}] (.*)$`)
const ORDERED_RE = /^ {0,3}\d+[.)] (.*)$/
const NESTED_LIST_RE = new RegExp(`^(?: {2,}|\\t+)(?:[-*+${String.fromCodePoint(0x2022)}]|\\d+[.)]) (.*)$`)
const CONTINUATION_RE = /^(?: {2,}|\t)(.+)$/
const TABLE_SEP_RE = /^[|\-: ]+$/

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'"
}
const ENTITY_RE = /&(?:amp|lt|gt|quot|#39);/g
const ENTITY_SINGLE_RE = /^&(?:amp|lt|gt|quot|#39);/
const WORD_CHAR_RE = /[\p{L}\p{N}_]/u

function decodeEntities(text: string): string {
  return text.replace(ENTITY_RE, (m) => ENTITIES[m] ?? m)
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && WORD_CHAR_RE.test(ch)
}

function pushText(out: Inline[], text: string): void {
  if (text.length === 0) return
  const prev = out[out.length - 1]
  if (prev?.type === 'text') prev.text += text
  else out.push({ type: 'text', text })
}

/** Finds the closing delimiter index, skipping inline code spans, or -1 if none. */
function findClosing(text: string, start: number, marker: string, wordBoundary: boolean): number {
  let i = start
  while (i < text.length) {
    if (text[i] === '`') {
      const closeCode = text.indexOf('`', i + 1)
      if (closeCode !== -1) {
        i = closeCode + 1
        continue
      }
    }
    if (text.startsWith(marker, i)) {
      const prev = text[i - 1]
      const next = text[i + marker.length]
      const validClose = prev !== undefined && !/\s/.test(prev) && (!wordBoundary || !isWordChar(next))
      if (validClose && i > start) return i
    }
    i++
  }
  return -1
}

export function parseInlines(text: string): Inline[] {
  const out: Inline[] = []
  let i = 0

  while (i < text.length) {
    const ch = text[i]!

    // Inline code
    if (ch === '`') {
      const close = text.indexOf('`', i + 1)
      if (close !== -1) {
        out.push({ type: 'code', text: text.slice(i + 1, close) })
        i = close + 1
        continue
      }
    }

    // Image link: ![alt](url)
    if (ch === '!' && text[i + 1] === '[') {
      const closeBracket = text.indexOf(']', i + 2)
      if (closeBracket !== -1 && text[closeBracket + 1] === '(') {
        const closeParen = text.indexOf(')', closeBracket + 2)
        if (closeParen !== -1) {
          const alt = decodeEntities(text.slice(i + 2, closeBracket))
          const url = text.slice(closeBracket + 2, closeParen)
          out.push({ type: 'link', text: alt, url })
          i = closeParen + 1
          continue
        }
      }
    }

    // Link: [text](url)
    if (ch === '[') {
      const closeBracket = text.indexOf(']', i + 1)
      if (closeBracket !== -1 && text[closeBracket + 1] === '(') {
        const closeParen = text.indexOf(')', closeBracket + 2)
        if (closeParen !== -1) {
          const label = decodeEntities(text.slice(i + 1, closeBracket))
          const url = text.slice(closeBracket + 2, closeParen)
          out.push({ type: 'link', text: label, url })
          i = closeParen + 1
          continue
        }
      }
    }

    // HTML tag (keep <https://...> and bare addresses)
    if (ch === '<') {
      const tagMatch = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)(?:\s[^<>]*)?\/?>/.exec(text.slice(i))
      if (tagMatch) {
        if (tagMatch[1]?.toLowerCase() === 'br') pushText(out, '\n')
        i += tagMatch[0].length
        continue
      }
    }

    // Bold: ** or __
    if (text.startsWith('**', i) || text.startsWith('__', i)) {
      const marker = text.slice(i, i + 2)
      const boundary = marker === '__'
      const prev = text[i - 1]
      const next = text[i + 2]
      const canOpen = next !== undefined && !/\s/.test(next) && (!boundary || !isWordChar(prev))
      if (canOpen) {
        const close = findClosing(text, i + 2, marker, boundary)
        if (close !== -1) {
          out.push({ type: 'bold', children: parseInlines(text.slice(i + 2, close)) })
          i = close + 2
          continue
        }
      }
    }

    // Strikethrough: ~~ or ~
    if (ch === '~') {
      const marker = text.startsWith('~~', i) ? '~~' : '~'
      const next = text[i + marker.length]
      if (next !== undefined && !/\s/.test(next)) {
        const close = findClosing(text, i + marker.length, marker, false)
        if (close !== -1) {
          out.push({ type: 'strike', children: parseInlines(text.slice(i + marker.length, close)) })
          i = close + marker.length
          continue
        }
      }
    }

    // Italic: * or _
    if (ch === '*' || ch === '_') {
      const boundary = ch === '_'
      const prev = text[i - 1]
      const next = text[i + 1]
      const canOpen = next !== undefined && !/\s/.test(next) && (!boundary || !isWordChar(prev))
      if (canOpen) {
        const close = findClosing(text, i + 1, ch, boundary)
        if (close !== -1) {
          out.push({ type: 'italic', children: parseInlines(text.slice(i + 1, close)) })
          i = close + 1
          continue
        }
      }
    }

    // HTML entity
    if (ch === '&') {
      const entityMatch = ENTITY_SINGLE_RE.exec(text.slice(i))
      if (entityMatch) {
        pushText(out, ENTITIES[entityMatch[0]] ?? entityMatch[0])
        i += entityMatch[0].length
        continue
      }
    }

    pushText(out, ch)
    i++
  }

  return out
}

function isTableStart(lines: string[], index: number): boolean {
  const header = lines[index]
  const sep = lines[index + 1]
  if (header === undefined || sep === undefined) return false
  if (!header.includes('|')) return false
  const trimmedSep = sep.trim()
  return trimmedSep.includes('-') && trimmedSep.includes('|') && TABLE_SEP_RE.test(trimmedSep)
}

function splitTableRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  return s.split('|').map((cell) => cell.trim())
}

function isBlockStart(lines: string[], index: number): boolean {
  const line = lines[index]!
  return (
    line.trim() === '' ||
    FENCE_RE.test(line) ||
    HEADING_RE.test(line) ||
    HR_RE.test(line) ||
    QUOTE_RE.test(line) ||
    BULLET_RE.test(line) ||
    ORDERED_RE.test(line) ||
    isTableStart(lines, index)
  )
}

export function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]!

    if (line.trim() === '') {
      i++
      continue
    }

    // Fenced code block
    if (FENCE_RE.test(line)) {
      i++
      const codeLines: string[] = []
      while (i < lines.length && !FENCE_CLOSE_RE.test(lines[i]!)) {
        codeLines.push(lines[i]!)
        i++
      }
      if (i < lines.length && FENCE_CLOSE_RE.test(lines[i]!)) i++
      blocks.push({ type: 'code', text: codeLines.join('\n') })
      continue
    }

    // Table
    if (isTableStart(lines, i)) {
      const header = splitTableRow(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim() !== '' && !FENCE_RE.test(lines[i]!)) {
        rows.push(splitTableRow(lines[i]!))
        i++
      }
      blocks.push({ type: 'table', header, rows })
      continue
    }

    // Horizontal rule
    if (HR_RE.test(line)) {
      i++
      continue
    }

    // Heading
    const headingMatch = HEADING_RE.exec(line)
    if (headingMatch) {
      blocks.push({ type: 'heading', inlines: parseInlines(headingMatch[2]!) })
      i++
      continue
    }

    // Quote
    if (QUOTE_RE.test(line)) {
      const quoteLines: string[] = []
      while (i < lines.length) {
        const qm = QUOTE_RE.exec(lines[i]!)
        if (!qm) break
        quoteLines.push(qm[1]!)
        i++
      }
      blocks.push({ type: 'quote', inlines: parseInlines(quoteLines.join('\n')) })
      continue
    }

    // List
    const bulletMatch = BULLET_RE.exec(line)
    const orderedMatch = ORDERED_RE.exec(line)
    if (bulletMatch || orderedMatch) {
      const ordered = Boolean(orderedMatch)
      const rawItems: string[] = [bulletMatch ? bulletMatch[1]! : orderedMatch![1]!]
      i++

      while (i < lines.length) {
        const next = lines[i]!
        if (next.trim() === '' || FENCE_RE.test(next)) break

        const nested = NESTED_LIST_RE.exec(next)
        if (nested) {
          rawItems.push(nested[1]!)
          i++
          continue
        }

        const sameBullet = !ordered && BULLET_RE.exec(next)
        const sameOrdered = ordered && ORDERED_RE.exec(next)
        if (sameBullet) {
          rawItems.push(sameBullet[1]!)
          i++
          continue
        }
        if (sameOrdered) {
          rawItems.push(sameOrdered[1]!)
          i++
          continue
        }

        // Different list kind at top level starts a new list
        if (BULLET_RE.test(next) || ORDERED_RE.test(next)) break

        const cont = CONTINUATION_RE.exec(next)
        if (cont) {
          const lastIdx = rawItems.length - 1
          rawItems[lastIdx] = `${rawItems[lastIdx]!} ${cont[1]!.trim()}`
          i++
          continue
        }

        break
      }

      blocks.push({ type: 'list', ordered, items: rawItems.map((item) => parseInlines(item)) })
      continue
    }

    // Paragraph
    const paraLines: string[] = [line]
    i++
    while (i < lines.length && !isBlockStart(lines, i)) {
      paraLines.push(lines[i]!)
      i++
    }
    blocks.push({ type: 'paragraph', inlines: parseInlines(paraLines.join('\n')) })
  }

  return blocks
}
