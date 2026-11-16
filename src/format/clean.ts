import type { LineKind } from '../character/schema.js'
import type { CleanedReply, ReplyCleaner } from '../turn/types.js'
import { parseBlocks } from './blocks.js'
import { joinContent, splitBubbles } from './bubbles.js'
import { LIST_COMMAND_TOOLS, RESEARCH_MAX_CHARS, RESEARCH_TOOLS, buildFooter, capitaliseParagraphs } from './footer.js'
import { renderWhatsApp } from './render.js'

// Seven-step reply cleaning chain (docs/trd/prompt-engine.md#cleaning-chain).

export interface ReplyShapeLimits {
  maxChars?: number
}

export interface CleanOptions {
  /** Tool names from the registry, for step 1. */
  toolNames: string[]
  /** Speaker names to strip in step 2: the character's display name and id. */
  speakerNames: string[]
  /** True when code detected an explicit format request, or a length bypass applies. Step 4 is skipped. */
  lengthBypass: boolean
  shape: ReplyShapeLimits
  /** The fixed prompt blocks (blocks 1 to 3), for the leak check. */
  fixedBlocks: string[]
  leakCheck: boolean
  /** The pack's fallback line. */
  fallbackLine: string
  bubbleMaxChars: number
  maxBubbles: number
  media?: string[]
  /** Tools that ran with outcome `ok` in this turn, in call order. They decide the bypasses and the footer. */
  toolsOk?: string[]
  /** For a skill-style command: the tool it names. */
  commandTool?: string
  /** The card's footer icon and labels. */
  footer?: { icon?: string; labels?: Record<string, string> }
  /** The chat's footer switch and emoji, and the URLs the turn read or found. */
  footerOff?: boolean
  footerEmoji?: string
  sources?: string[]
}

const ELLIPSIS = String.fromCodePoint(0x2026)
const BULLET_CHARS = `*+${String.fromCodePoint(0x2022)}${String.fromCodePoint(0x2013)}${String.fromCodePoint(0x2014)}`
const LIST_MARKER_LINE_RE = new RegExp(`^(\\s*)[${BULLET_CHARS}] (.*)$`)
const ORDERED_PAREN_RE = /^(\s*\d+)\) (.*)$/
const LONE_LIST_MARKER_RE = new RegExp(`^(\\s*(?:[-${BULLET_CHARS}]|\\d+[.)]))\\s*$`)
const ANY_BULLET_LINE_RE = new RegExp(`^\\s*[-${BULLET_CHARS}] `)
const ANY_ORDERED_LINE_RE = /^\s*\d+[.)] /
const FENCE_START_RE = /^ {0,3}```(.*)$/
const FENCE_END_RE = /^ {0,3}```\s*$/
const SENTENCE_PUNCT_RE = new RegExp(
  `[.!?${ELLIPSIS}${String.fromCodePoint(0x3002)}${String.fromCodePoint(0xff01)}${String.fromCodePoint(0xff1f)}]`
)

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isJsonToolBlock(body: string, toolSet: Set<string>): boolean {
  try {
    const parsed: unknown = JSON.parse(body)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false
    const record = parsed as Record<string, unknown>
    return (
      (typeof record.name === 'string' && toolSet.has(record.name)) ||
      (typeof record.tool === 'string' && toolSet.has(record.tool))
    )
  } catch {
    return false
  }
}

/** Step 1: Remove narrated tool calls and tool-call syntax. */
export function removeToolNarration(text: string, toolNames: string[]): string {
  let out = text
  let changed = false

  const xmlPattern = /<(?:tool_call|function_calls|tool_code)>[\s\S]*?<\/(?:tool_call|function_calls|tool_code)>/gi
  if (xmlPattern.test(out)) {
    out = out.replace(xmlPattern, '')
    changed = true
  }

  const toolSet = new Set(toolNames.filter((n) => n.length > 0))
  if (toolSet.size > 0) {
    const lines = out.split('\n')
    const keptLines: string[] = []
    const toolPatterns = [...toolSet].map((name) => {
      const esc = escapeRegex(name)
      return new RegExp(
        `^\\s*(?:${esc}\\s*\\(.*\\)|functions\\.${esc}\\s*\\(.*\\)|\\[Calling ${esc}(?:\\s[^\\]]*)?\\]|Calling ${esc}.*|\\*uses ${esc}\\*)\\s*$`,
        'i'
      )
    })

    let i = 0
    while (i < lines.length) {
      const line = lines[i]!
      const fenceMatch = FENCE_START_RE.exec(line)
      if (fenceMatch) {
        const lang = fenceMatch[1]!.trim().toLowerCase()
        const blockLines: string[] = [line]
        i++
        while (i < lines.length && !FENCE_END_RE.test(lines[i]!)) {
          blockLines.push(lines[i]!)
          i++
        }
        if (i < lines.length) {
          blockLines.push(lines[i]!)
          i++
        }
        const isToolLang = lang === 'tool_code' || lang === 'tool_call' || lang === 'json'
        const body = blockLines
          .slice(1, blockLines.length - (FENCE_END_RE.test(blockLines[blockLines.length - 1]!) ? 1 : 0))
          .join('\n')
        if (isToolLang && isJsonToolBlock(body, toolSet)) {
          changed = true
          continue
        }
        keptLines.push(...blockLines)
        continue
      }

      if (toolPatterns.some((re) => re.test(line))) {
        changed = true
        i++
        continue
      }

      keptLines.push(line)
      i++
    }
    out = keptLines.join('\n')
  }

  if (!changed) return text
  return out.replace(/\n{3,}/g, '\n\n').trim()
}

/** Step 2: Remove speaker name tags and leading indentation. */
export function removeSpeakerTags(text: string, speakerNames: string[]): string {
  const names = [...speakerNames, 'Assistant', 'AI'].filter((n) => n.length > 0).map(escapeRegex)
  const tagRe =
    names.length > 0
      ? new RegExp(`^(?:\\*\\*(?:${names.join('|')}):\\*\\*|(?:${names.join('|')}):)[ \\t]*`, 'i')
      : undefined

  const lines = text.split('\n')
  const out: string[] = []
  let inFence = false
  let afterListItem = false

  for (const rawLine of lines) {
    if (inFence) {
      out.push(rawLine)
      if (FENCE_END_RE.test(rawLine)) inFence = false
      continue
    }

    if (FENCE_START_RE.test(rawLine)) {
      inFence = true
      afterListItem = false
      out.push(rawLine)
      continue
    }

    let line = rawLine
    const isIndented = /^[ \t]+/.test(line)
    const isListItem = ANY_BULLET_LINE_RE.test(line) || ANY_ORDERED_LINE_RE.test(line)

    if (tagRe) {
      const stripped = line.replace(/^[ \t]+/, '')
      const withoutTag = stripped.replace(tagRe, '')
      if (withoutTag !== stripped) line = withoutTag
    }

    if (line.trim() === '') {
      afterListItem = false
      out.push('')
      continue
    }

    if (afterListItem && isIndented) {
      out.push(line)
      continue
    }

    line = line.replace(/^[ \t]+/, '')
    afterListItem = isListItem
    out.push(line)
  }

  return out.join('\n')
}

interface FenceSpan {
  start: number
  end: number
}

function findFenceSpans(text: string): FenceSpan[] {
  const spans: FenceSpan[] = []
  const lines = text.split('\n')
  let offset = 0
  let inFence = false
  let fenceStart = 0

  for (const line of lines) {
    const lineEnd = offset + line.length
    if (!inFence && FENCE_START_RE.test(line)) {
      inFence = true
      fenceStart = offset
    } else if (inFence && FENCE_END_RE.test(line)) {
      spans.push({ start: fenceStart, end: lineEnd })
      inFence = false
    }
    offset = lineEnd + 1
  }

  if (inFence) spans.push({ start: fenceStart, end: text.length })
  return spans
}

/** Step 4: Enforce the reply shape's length. */
export function enforceLength(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text

  const spans = findFenceSpans(text)
  let ceiling = maxChars
  for (const span of spans) {
    if (span.start < ceiling && ceiling < span.end) {
      ceiling = span.start
      break
    }
  }

  const inCode = (idx: number) => spans.some((s) => idx >= s.start && idx < s.end)

  // Find last sentence end within ceiling
  let lastSentenceEnd = -1
  for (let i = 0; i < ceiling; i++) {
    if (inCode(i)) continue
    if (SENTENCE_PUNCT_RE.test(text[i]!)) {
      const next = text[i + 1]
      if (next === undefined || /\s/.test(next) || i + 1 === ceiling) {
        lastSentenceEnd = i + 1
      }
    }
  }

  if (lastSentenceEnd > 0) {
    const candidate = text.slice(0, lastSentenceEnd).trimEnd()
    if (candidate.length > 0) return candidate
  }

  // No sentence end fits: cut after last word that fits, with ellipsis appended
  const limitForWords = Math.max(0, ceiling - 1)
  const slice = text.slice(0, limitForWords)
  let lastSpace = -1
  for (let i = slice.length - 1; i >= 0; i--) {
    if (/\s/.test(slice[i]!)) {
      lastSpace = i
      break
    }
  }
  // Also check if a word ends right at limitForWords
  if (limitForWords < text.length && /\s/.test(text[limitForWords]!)) {
    const candidate = slice.trimEnd()
    if (candidate.length > 0) return candidate + ELLIPSIS
  }

  if (lastSpace > 0) {
    const candidate = slice.slice(0, lastSpace).trimEnd()
    if (candidate.length > 0) return candidate + ELLIPSIS
  }

  return slice.trimEnd() + ELLIPSIS
}

function listKind(line: string): 'bullet' | 'ordered' | undefined {
  if (ANY_BULLET_LINE_RE.test(line)) return 'bullet'
  if (ANY_ORDERED_LINE_RE.test(line)) return 'ordered'
  return undefined
}

/** Step 5: Repair list formatting outside fenced code blocks. */
export function repairLists(text: string): string {
  const lines = text.split('\n')
  const normalized: string[] = []
  let inFence = false

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!
    if (inFence) {
      normalized.push(line)
      if (FENCE_END_RE.test(line)) inFence = false
      continue
    }
    if (FENCE_START_RE.test(line)) {
      inFence = true
      normalized.push(line)
      continue
    }

    line = line.replace(LIST_MARKER_LINE_RE, '$1- $2')
    line = line.replace(ORDERED_PAREN_RE, '$1. $2')

    const lone = LONE_LIST_MARKER_RE.exec(line)
    if (lone && i + 1 < lines.length) {
      const next = lines[i + 1]!
      if (next.trim() !== '' && !FENCE_START_RE.test(next) && listKind(next) === undefined) {
        let marker = lone[1]!.replace(new RegExp(`[${BULLET_CHARS}]$`), '-')
        marker = marker.replace(/\)$/, '.')
        normalized.push(`${marker} ${next.trim()}`)
        i++
        continue
      }
    }

    normalized.push(line)
  }

  // Remove blank lines between two items of the same list
  const result: string[] = []
  inFence = false
  for (let i = 0; i < normalized.length; i++) {
    const line = normalized[i]!
    if (inFence) {
      result.push(line)
      if (FENCE_END_RE.test(line)) inFence = false
      continue
    }
    if (FENCE_START_RE.test(line)) {
      inFence = true
      result.push(line)
      continue
    }

    if (line.trim() === '') {
      let prevIdx = result.length - 1
      while (prevIdx >= 0 && result[prevIdx]!.trim() === '') prevIdx--
      let nextIdx = i + 1
      while (nextIdx < normalized.length && normalized[nextIdx]!.trim() === '') nextIdx++

      const prevKind = prevIdx >= 0 ? listKind(result[prevIdx]!) : undefined
      const nextKind = nextIdx < normalized.length ? listKind(normalized[nextIdx]!) : undefined
      if (prevKind !== undefined && prevKind === nextKind) continue
    }

    result.push(line)
  }

  return result.join('\n')
}

function extractWords(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
}

const FULL_WIDTH: Readonly<Record<string, string>> = { '*': '＊', _: '＿', '~': '～', '`': '｀' }

/**
 * Step 6: inside a kaomoji, markdown characters become their full-width forms, so neither WhatsApp nor the
 * gateway's Markdown conversion reads them as formatting. WhatsApp has no escape character. Code is left alone.
 */
export function guardFaces(text: string): string {
  const guard = (prose: string) =>
    prose
      .replace(/\([^()\n]{1,20}\)/g, (face) =>
        /[A-Za-z0-9]{2}/.test(face.slice(1, -1)) ? face : face.replace(/[*_~`]/g, (ch) => FULL_WIDTH[ch]!)
      )
      // The shrug's arms sit outside its brackets.
      .replace(/¯\\_\(/g, '¯\\＿(')
      .replace(/\)_\/¯/g, ')＿/¯')
  // A face's backtick becomes ｀ first, so it cannot pair with a real code span; then code is set aside.
  const faceTicks = (prose: string) =>
    prose.replace(/\(([^()\n`]{0,12})`([^()\n`]{0,12})\)/g, (face, before: string, after: string) =>
      /[A-Za-z0-9]{2}/.test(before + after) ? face : `(${before}｀${after})`
    )
  const outside = (value: string, pattern: RegExp, transform: (prose: string) => string) =>
    value
      .split(pattern)
      .map((part, i) => (i % 2 === 1 ? part : transform(part)))
      .join('')
  return outside(text, /(```[\s\S]*?```)/, (prose) => outside(faceTicks(prose), /(`[^`\n]+`)/, guard))
}

/** Step 7: Check for leaked prompt text against the fixed blocks (12+ consecutive words). */
export function leaksPrompt(text: string, fixedBlocks: string[]): boolean {
  const replyWords = extractWords(text)
  if (replyWords.length < 12) return false

  const runs = new Set<string>()
  for (let i = 0; i <= replyWords.length - 12; i++) {
    runs.add(replyWords.slice(i, i + 12).join(' '))
  }

  for (const block of fixedBlocks) {
    const blockWords = extractWords(block)
    if (blockWords.length < 12) continue
    for (let i = 0; i <= blockWords.length - 12; i++) {
      if (runs.has(blockWords.slice(i, i + 12).join(' '))) return true
    }
  }

  return false
}

/** Runs all seven steps of the cleaning chain, then splits into bubbles. */
export function cleanReply(text: string, options: CleanOptions): CleanedReply {
  const steps: string[] = []
  try {
    let current = text

    const afterTool = removeToolNarration(current, options.toolNames)
    if (afterTool !== current) {
      steps.push('tool_narration')
      current = afterTool
    }

    const afterSpeaker = removeSpeakerTags(current, options.speakerNames)
    if (afterSpeaker !== current) {
      steps.push('speaker_tags')
      current = afterSpeaker
    }

    const toolsOk = options.toolsOk ?? []
    const listCommand = options.commandTool !== undefined && LIST_COMMAND_TOOLS.has(options.commandTool)
    let maxChars = options.shape.maxChars
    if (listCommand) {
      maxChars = undefined
      steps.push('bypass_command_list')
    } else if (maxChars !== undefined && toolsOk.some((tool) => RESEARCH_TOOLS.has(tool))) {
      if (maxChars < RESEARCH_MAX_CHARS) steps.push('bypass_research')
      maxChars = Math.max(maxChars, RESEARCH_MAX_CHARS)
    }
    if (!options.lengthBypass && maxChars !== undefined) {
      const afterLength = enforceLength(current, maxChars)
      if (afterLength !== current) {
        steps.push('length')
        current = afterLength
      }
    }

    const afterLists = repairLists(current)
    if (afterLists !== current) {
      steps.push('lists')
      current = afterLists
    }

    const afterFaces = guardFaces(current)
    if (afterFaces !== current) {
      steps.push('faces')
      current = afterFaces
    }

    let replacedBy: LineKind | undefined
    if (options.leakCheck && leaksPrompt(current, options.fixedBlocks)) {
      current = options.fallbackLine
      replacedBy = 'fallback'
      steps.push('leak')
    }

    const afterRender = renderWhatsApp(parseBlocks(current))
    if (afterRender !== current) {
      steps.push('render')
      current = afterRender
    }

    if (current.trim().length === 0) {
      return {
        content: '',
        bubbleCount: 0,
        steps,
        ...(replacedBy ? { replacedBy } : {}),
        ...(options.media ? { attachments: options.media } : {})
      }
    }

    const { bubbles, trimmed } = splitBubbles(current, {
      maxChars: options.bubbleMaxChars,
      maxBubbles: options.maxBubbles
    })
    if (trimmed) steps.push('bubbles_trimmed')

    const capitalised = bubbles.map(capitaliseParagraphs)
    if (capitalised.some((bubble, i) => bubble !== bubbles[i])) steps.push('capitals')
    const footer =
      replacedBy || options.footerOff
        ? undefined
        : buildFooter(toolsOk, options.footer, {
            ...(options.footerEmoji ? { emoji: options.footerEmoji } : {}),
            ...(options.sources ? { sources: options.sources } : {})
          })
    if (footer !== undefined && capitalised.length > 0) {
      capitalised[capitalised.length - 1] = `${capitalised[capitalised.length - 1]}\n\n${footer}`
      steps.push('footer')
    }

    return {
      content: joinContent(capitalised, options.media),
      bubbleCount: capitalised.length,
      steps,
      ...(replacedBy ? { replacedBy } : {}),
      ...(options.media ? { attachments: options.media } : {})
    }
  } catch {
    return { content: '', bubbleCount: 0, steps }
  }
}

/** The pipeline seam. `toolNames` comes from the registry when it exists. */
export function createReplyCleaner(
  config: { format: { bubbleMaxChars: number; maxBubbles: number; leakCheck: 'on' | 'off' } },
  toolNames?: () => string[],
  /** The tools that ran with outcome `ok` in a turn, in call order. */
  toolsOk?: (turnId: string) => string[],
  /** The URLs a turn read or found, for the sources line. */
  sources?: (turnId: string) => string[]
): ReplyCleaner {
  return {
    clean({ text, context, built, run }) {
      const shapeObj =
        typeof built.shape === 'object' && built.shape !== null ? (built.shape as Record<string, unknown>) : undefined
      const maxChars = typeof shapeObj?.maxChars === 'number' ? shapeObj.maxChars : undefined
      const lengthBypass = typeof shapeObj?.lengthBypass === 'boolean' ? shapeObj.lengthBypass : false
      const fixedBlocks = built.system
        .filter((block) => block.name === 'core' || block.name === 'speech' || block.name === 'harness')
        .map((block) => block.text)

      return cleanReply(text, {
        toolNames: toolNames ? toolNames() : [],
        speakerNames: [context.character.card.displayName, context.character.card.id],
        lengthBypass,
        shape: { maxChars },
        fixedBlocks,
        leakCheck: config.format.leakCheck === 'on',
        fallbackLine: context.character.lines.fallback,
        bubbleMaxChars: config.format.bubbleMaxChars,
        maxBubbles: config.format.maxBubbles,
        // A direct command runs no model and gets no footer.
        toolsOk: toolsOk && run.calls.length > 0 ? toolsOk(context.turnId) : [],
        ...(context.commandTool === undefined ? {} : { commandTool: context.commandTool }),
        ...(context.character.card.toolFooter ? { footer: context.character.card.toolFooter } : {}),
        footerOff: context.settings?.['features.toolFooter']?.value === false,
        ...(typeof context.settings?.['footerEmoji']?.value === 'string'
          ? { footerEmoji: context.settings['footerEmoji'].value }
          : {}),
        sources: sources ? sources(context.turnId) : []
      })
    }
  }
}
