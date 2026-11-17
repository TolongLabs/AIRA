// WhatsApp's published text markup, drawn as HTML (docs/trd/harness.md#chat-preview).
//
// Supported, as WhatsApp documents it: *bold*, _italic_, ~strikethrough~, ```monospace```, `inline code`, `- ` and
// `* ` bulleted lists, `1. ` numbered lists and `> ` block quotes. Everything else is drawn as the raw characters, so
// a formatting fault (a `**double**`, a `# heading`, a `[text](url)`, a table) is visible in the preview.
//
// The output is HTML built from escaped text only. Nothing the model or a member wrote reaches the page unescaped.

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char)
}

type Marker = '*' | '_' | '~' | '`'
const TAGS: Record<Marker, string> = { '*': 'b', _: 'i', '~': 's', '`': 'code' }
const MARKERS = new Set<string>(['*', '_', '~', '`'])
const URL_AT = /^https?:\/\/[^\s<>]+/i

const isWordChar = (char: string | undefined): boolean => char !== undefined && /[\p{L}\p{N}]/u.test(char)
const isSpace = (char: string | undefined): boolean => char === undefined || /\s/u.test(char)

/** Where a link ends: the address without the punctuation that follows it in a sentence. */
function linkLength(text: string): number {
  const match = URL_AT.exec(text)
  if (!match) return 0
  let url = match[0]
  while (/[.,;:!?'"*_~]$/.test(url) || (url.endsWith(')') && !url.includes('('))) url = url.slice(0, -1)
  return url.length > url.indexOf('://') + 3 ? url.length : 0
}

/** The index of the marker that closes the one at `open`, or -1. WhatsApp's rules, one line at a time. */
function closingIndex(text: string, open: number, marker: Marker): number {
  for (let j = open + 2; j < text.length; j++) {
    const char = text[j]
    if (char === '\n') return -1
    if (char !== marker) continue
    if (isSpace(text[j - 1]) || text[j - 1] === marker) continue
    if (text[j + 1] === marker || isWordChar(text[j + 1])) continue
    return j
  }
  return -1
}

/** One line of text with its inline markup, as HTML. */
export function renderInline(text: string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    const char = text[i] as string

    if (char === 'h' || char === 'H') {
      const length = isWordChar(text[i - 1]) ? 0 : linkLength(text.slice(i))
      if (length > 0) {
        const url = text.slice(i, i + length)
        out += `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`
        i += length
        continue
      }
    }

    if (MARKERS.has(char)) {
      const marker = char as Marker
      const canOpen =
        !isWordChar(text[i - 1]) && text[i - 1] !== marker && !isSpace(text[i + 1]) && text[i + 1] !== marker
      const close = canOpen ? closingIndex(text, i, marker) : -1
      if (close !== -1) {
        const inner = text.slice(i + 1, close)
        const tag = TAGS[marker]
        out += `<${tag}>${marker === '`' ? escapeHtml(inner) : renderInline(inner)}</${tag}>`
        i = close + 1
        continue
      }
    }

    out += escapeHtml(char)
    i += 1
  }
  return out
}

const BULLET = /^[*-] (.*)$/
const NUMBERED = /^(\d{1,9})\. (.*)$/
const QUOTE = /^> (.*)$/

type Block =
  | { type: 'text'; lines: string[] }
  | { type: 'bullets'; items: string[] }
  | { type: 'numbers'; items: { number: string; text: string }[] }
  | { type: 'quote'; lines: string[] }
  | { type: 'mono'; text: string }

/** Cuts the text into monospace blocks (which hold no markup) and the lines around them. */
function splitMono(text: string): ({ mono: string } | { plain: string })[] {
  const parts: ({ mono: string } | { plain: string })[] = []
  let rest = text
  while (rest.length > 0) {
    const open = rest.indexOf('```')
    const close = open === -1 ? -1 : rest.indexOf('```', open + 3)
    if (open === -1 || close === -1) {
      parts.push({ plain: rest })
      break
    }
    // The line break before a block and the one after it belong to the block, not to the text around it.
    if (open > 0) parts.push({ plain: rest.slice(0, open).replace(/\n$/, '') })
    parts.push({ mono: rest.slice(open + 3, close) })
    rest = rest.slice(close + 3).replace(/^\n/, '')
  }
  return parts.filter((part) => !('plain' in part) || part.plain !== '')
}

function blocksOf(text: string): Block[] {
  const blocks: Block[] = []
  for (const part of splitMono(text)) {
    if ('mono' in part) {
      blocks.push({ type: 'mono', text: part.mono.replace(/^\r?\n/, '').replace(/\r?\n$/, '') })
      continue
    }
    for (const line of part.plain.split('\n')) {
      const last = blocks[blocks.length - 1]
      const bullet = BULLET.exec(line)
      const numbered = NUMBERED.exec(line)
      const quote = QUOTE.exec(line)
      if (bullet) {
        if (last?.type === 'bullets') last.items.push(bullet[1] as string)
        else blocks.push({ type: 'bullets', items: [bullet[1] as string] })
      } else if (numbered) {
        const item = { number: numbered[1] as string, text: numbered[2] as string }
        if (last?.type === 'numbers') last.items.push(item)
        else blocks.push({ type: 'numbers', items: [item] })
      } else if (quote) {
        if (last?.type === 'quote') last.lines.push(quote[1] as string)
        else blocks.push({ type: 'quote', lines: [quote[1] as string] })
      } else if (last?.type === 'text') {
        last.lines.push(line)
      } else {
        blocks.push({ type: 'text', lines: [line] })
      }
    }
  }
  return blocks
}

/** A message's text as the HTML of a WhatsApp bubble. The caller sets `white-space: pre-wrap` on `.t`. */
export function renderMarkup(text: string): string {
  const blocks = blocksOf(text.replace(/\r\n/g, '\n'))
  return (
    blocks
      // biome-ignore lint/suspicious/useIterableCallbackReturn: kept as written in the Biome 2 bump; behaviour unchanged
      .map((block) => {
        switch (block.type) {
          case 'text':
            return `<div class="t">${block.lines.map(renderInline).join('\n')}</div>`
          case 'quote':
            return `<blockquote>${block.lines.map(renderInline).join('\n')}</blockquote>`
          case 'bullets':
            return `<ul>${block.items.map((item) => `<li>${renderInline(item)}</li>`).join('')}</ul>`
          case 'numbers':
            return `<ol>${block.items.map((item) => `<li value="${item.number}">${renderInline(item.text)}</li>`).join('')}</ol>`
          case 'mono':
            return `<pre>${escapeHtml(block.text)}</pre>`
        }
      })
      .join('')
  )
}

/** The text of a message as one short plain line, for a quote or a reply preview. */
export function previewText(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}
