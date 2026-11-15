import { type Block, type Inline, parseInlines } from './blocks.js'

// WhatsApp renderer (docs/trd/prompt-engine.md#whatsapp-renderer).
// Emits the Markdown subset that survives the gateway's Markdown-to-WhatsApp conversion.

const ASTERISK_OP = String.fromCodePoint(0x2217)
const FULLWIDTH_HASH = String.fromCodePoint(0xff03)
const FULLWIDTH_LBRACKET = String.fromCodePoint(0xff3b)

interface RenderState {
  bold: boolean
  italic: boolean
}

function escapePlainText(text: string): string {
  const noStar = text.replaceAll('*', ASTERISK_OP)
  return noStar
    .split('\n')
    .map((line) => line.replace(/\[(?=[^\n]*\]\()/g, FULLWIDTH_LBRACKET))
    .join('\n')
}

function renderInlineList(inlines: Inline[], state: RenderState): string {
  let out = ''
  for (const node of inlines) {
    switch (node.type) {
      case 'text':
        out += escapePlainText(node.text)
        break
      case 'bold': {
        const inner = renderInlineList(node.children, { ...state, bold: true })
        out += state.bold ? inner : `**${inner}**`
        break
      }
      case 'italic': {
        const inner = renderInlineList(node.children, { ...state, italic: true })
        out += state.italic ? inner : `_${inner}_`
        break
      }
      case 'strike': {
        const inner = renderInlineList(node.children, state)
        out += `~${inner}~`
        break
      }
      case 'code':
        out += `\`${node.text}\``
        break
      case 'link': {
        const label = escapePlainText(node.text.trim())
        if (label.length === 0 || label === node.url) out += node.url
        else out += `${label} ${node.url}`
        break
      }
    }
  }
  return out
}

export function renderInlines(inlines: Inline[]): string {
  return renderInlineList(inlines, { bold: false, italic: false })
}

function cleanNonCodeBlock(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function renderTable(header: string[], rows: string[][]): string {
  if (rows.length === 0) return ''
  if (header.length <= 1) {
    return rows.map((row) => `- ${renderInlines(parseInlines(row[0] ?? ''))}`).join('\n')
  }
  return rows
    .map((row) => {
      const pairs = header.map((col, idx) => {
        const key = renderInlines(parseInlines(col))
        const val = renderInlines(parseInlines(row[idx] ?? ''))
        return `${key}: ${val}`
      })
      return `- ${pairs.join(', ')}`
    })
    .join('\n')
}

/** Renders blocks in the form that survives the gateway's Markdown conversion. Blocks are separated by a blank line. */
export function renderWhatsApp(blocks: Block[]): string {
  const rendered: string[] = []

  for (const block of blocks) {
    switch (block.type) {
      case 'code':
        rendered.push(`\`\`\`\n${block.text}\n\`\`\``)
        break
      case 'paragraph': {
        const text = renderInlines(block.inlines).replace(/^# /gm, `${FULLWIDTH_HASH} `)
        const cleaned = cleanNonCodeBlock(text)
        if (cleaned.length > 0) rendered.push(cleaned)
        break
      }
      case 'heading': {
        const inner = renderInlineList(block.inlines, { bold: true, italic: false }).replace(/\n+/g, ' ').trim()
        const cleaned = cleanNonCodeBlock(inner)
        if (cleaned.length > 0) rendered.push(`**${cleaned}**`)
        break
      }
      case 'list': {
        const lines = block.items.map((item, idx) => {
          const text = renderInlines(item).replace(/\n+/g, ' ').trim()
          return block.ordered ? `${idx + 1}. ${text}` : `- ${text}`
        })
        const cleaned = cleanNonCodeBlock(lines.join('\n'))
        if (cleaned.length > 0) rendered.push(cleaned)
        break
      }
      case 'quote': {
        const lines = renderInlines(block.inlines)
          .split('\n')
          .map((line) => `> ${line}`.replace(/[ \t]+$/g, ''))
        const cleaned = lines
          .join('\n')
          .replace(/\n{3,}/g, '\n\n')
          .trim()
        if (cleaned.length > 0) rendered.push(cleaned)
        break
      }
      case 'table': {
        const cleaned = cleanNonCodeBlock(renderTable(block.header, block.rows))
        if (cleaned.length > 0) rendered.push(cleaned)
        break
      }
    }
  }

  return rendered.join('\n\n')
}
