// The tool footer, the capital-letter step and the delivery marks a replay removes (docs/trd/prompt-engine.md).

import { BUBBLE_BREAK } from '../gateway/response.js'
import { LENGTH_CHARS } from '../prompt/shape.js'

/** Tools whose successful call makes the turn a research answer (docs/trd/prompt-engine.md#reply-shape). */
export const RESEARCH_TOOLS: ReadonlySet<string> = new Set(['web_search', 'read_page', 'read_post'])

/** Skill-style commands whose answer is a list, so the length limit is lifted. */
export const LIST_COMMAND_TOOLS: ReadonlySet<string> = new Set(['recall', 'history_search', 'reminder_list'])

/** The length limit a research answer is lifted to. */
export const RESEARCH_MAX_CHARS = LENGTH_CHARS.long

export const DEFAULT_FOOTER_ICON = '🛠️'
const MAX_LABELS = 2

/** Plain labels for the footer. They hold no persona text; a card may replace any of them. */
export const DEFAULT_TOOL_LABELS: Readonly<Record<string, string>> = {
  media_video: 'watched a video',
  media_youtube: 'watched a video',
  media_image: 'looked at an image',
  media_audio: 'listened to audio',
  media_document: 'read a document',
  media_post: 'read a post',
  recall: 'checked memory',
  note: 'saved a note',
  forget: 'forgot a note',
  history_search: 'searched the chat',
  lingo_note: 'saved a word',
  web_search: 'searched the web',
  read_page: 'read a page',
  read_post: 'read a post',
  send_photo: 'sent a photo',
  reminder_set: 'set a reminder',
  reminder_list: 'checked reminders',
  reminder_cancel: 'cancelled a reminder',
  set_mute: 'changed mute',
  make_report: 'wrote a report',
  research_start: 'started research',
  report_pdf: 'made a PDF',
  help: 'listed commands',
  list: 'listed tools',
  song_get: 'opened a song',
  song_save: 'saved a song',
  lyrics_search: 'searched lyrics',
  lyrics_fetch: 'fetched lyrics',
  vocab_lookup: 'looked up a word',
  gloss_set: 'saved a meaning',
  library_search: 'searched the library',
  library_open: 'opened the library',
  library_write: 'updated the library',
  library_gaps: 'checked the library'
}

export function plainLabel(tool: string): string {
  return DEFAULT_TOOL_LABELS[tool] ?? `used ${tool.replace(/_/g, ' ')}`
}

/** The site a URL is on, without `www.`, or undefined for anything that is not an http(s) URL. */
export function domainOf(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
    return parsed.hostname.replace(/^www\./, '')
  } catch {
    return undefined
  }
}

const MAX_SOURCES = 3
export const SOURCES_MARK = '🔗'

/**
 * The footer for the tools that ran with outcome `ok`, or undefined when none did: a line of labels in small text
 * and, when the turn read or found pages, a line of up to three source domains in normal text, so they stay
 * tappable.
 */
export function buildFooter(
  toolsOk: readonly string[],
  card?: { icon?: string; labels?: Record<string, string> },
  options: { emoji?: string; sources?: readonly string[] } = {}
): string | undefined {
  const tools = [...new Set(toolsOk)]
  if (tools.length === 0) return undefined
  const labels = [...new Set(tools.map((tool) => (card?.labels?.[tool] ?? plainLabel(tool)).toLowerCase()))]
  const visible = labels.slice(0, MAX_LABELS).join(' · ')
  const hidden = labels.length - MAX_LABELS
  const emoji = options.emoji ?? card?.icon ?? DEFAULT_FOOTER_ICON
  const lines = [`_${emoji} ${visible}${hidden > 0 ? ` +${hidden}` : ''}_`]
  const domains = [...new Set((options.sources ?? []).map(domainOf).filter((d): d is string => d !== undefined))]
  if (domains.length > 0) lines.push(`_${SOURCES_MARK} ${domains.slice(0, MAX_SOURCES).join(' · ')}_`)
  return lines.join('\n')
}

/** True for a footer line: italic, opening with one emoji. Plain italic text is never taken for one. */
function isFooterLine(line: string): boolean {
  return /^_\p{Extended_Pictographic}\uFE0F? [^_\n]+_$/u.test(line.trim())
}

const SKIP_START = /^(?:```|`|https?:\/\/|www\.|\/[a-z]|@)/i
/** A list is left as written, so its items keep one style. */
const LIST_START = /^\s*(?:[-*•]|\d+[.)])\s/
const LEADING = /^[\s*_~>"'“‘([\-•·]*(?:\p{Extended_Pictographic}️?\s*)*[\s*_~>"'“‘([\-•·]*/u

/** Capitalises the first letter of a bubble, unless it starts with code, a link, a command or a mention. */
export function capitaliseBubble(bubble: string): string {
  if (SKIP_START.test(bubble.trimStart()) || LIST_START.test(bubble)) return bubble
  const lead = bubble.match(LEADING)?.[0] ?? ''
  const rest = bubble.slice(lead.length)
  if (SKIP_START.test(rest)) return bubble
  const word = rest.match(/^\S+/)?.[0] ?? ''
  if (word === '' || /\p{Lu}/u.test(word)) return bubble
  const first = rest[0]!
  if (!/\p{Ll}/u.test(first)) return bubble
  return lead + first.toUpperCase() + rest.slice(1)
}

/** Capitalises the first letter of every paragraph: text after a blank line or a bubble break line. */
export function capitaliseParagraphs(text: string): string {
  const parts = text.split(new RegExp(`(\\n(?:[ \\t]*\\n|[ \\t]*${BUBBLE_BREAK}[ \\t]*\\n)+)`))
  return parts.map((part, i) => (i % 2 === 1 ? part : capitaliseBubble(part))).join('')
}

/**
 * The label a code-written reply carries on replay, so the model does not take it for its own words and disown it.
 * The cleaning chain removes it if the model ever copies it.
 */
export const CODE_REPLY_NOTE =
  '[Code wrote this reply from stored data for a command. It is accurate; you did not write it.]'
export const CODE_REPLY_NOTE_LINE = /^\[Code wrote this reply[^\]\n]*\]\s*$\n?/gm

/**
 * The text of a stored reply as the model should see it on replay: no bubble breaks, no `MEDIA:` lines and no
 * footer lines.
 */
export function forReplay(content: string): string {
  const lines = content.split('\n').filter((line) => line.trim() !== BUBBLE_BREAK && !line.startsWith('MEDIA:'))
  const trimEnd = () => {
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop()
  }
  trimEnd()
  if (lines[lines.length - 1]?.startsWith(`_${SOURCES_MARK} `)) lines.pop()
  trimEnd()
  if (lines.length > 1 && isFooterLine(lines[lines.length - 1]!)) lines.pop()
  trimEnd()
  return lines.join('\n')
}
