// Copy of the gateway's Markdown-to-WhatsApp conversion, for tests only.

const BUBBLE_BREAK = String.fromCodePoint(0x2063)
const BOLD_OPEN = String.fromCodePoint(0xe010)
const BOLD_CLOSE = String.fromCodePoint(0xe011)
const CODE_OPEN = String.fromCodePoint(0xe020)
const CODE_CLOSE = String.fromCodePoint(0xe021)

/** What the gateway does to every outgoing message, after the core. A copy, for tests only. */
export function gatewayMarkdown(text: string): string {
  const saved: string[] = []
  const stash = (value: string): string => {
    const idx = saved.length
    saved.push(value)
    return `${CODE_OPEN}${idx}${CODE_CLOSE}`
  }

  // Protect fenced code blocks and inline code spans
  let out = text.replace(/```[\s\S]*?```/g, (m) => stash(m))
  out = out.replace(/`[^`\n]+`/g, (m) => stash(m))

  // Bold placeholder, then italic, then restore bold as single *
  out = out.replace(/\*\*([^\n]+?)\*\*/g, `${BOLD_OPEN}$1${BOLD_CLOSE}`)
  out = out.replace(/\*([^*\n]+?)\*/g, '_$1_')
  out = out.replaceAll(BOLD_OPEN, '*').replaceAll(BOLD_CLOSE, '*')

  // Strikethrough, headings, links
  out = out.replace(/~~([^~\n]+?)~~/g, '~$1~')
  out = out.replace(/^#{1,6} (.+)$/gm, '*$1*')
  out = out.replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, '$1 ($2)')

  // Restore code spans and code blocks
  out = out.replace(new RegExp(`${CODE_OPEN}(\\d+)${CODE_CLOSE}`, 'g'), (_, idx: string) => saved[Number(idx)] ?? '')

  return out.replaceAll(BUBBLE_BREAK, '')
}
