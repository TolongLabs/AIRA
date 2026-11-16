import { describe, expect, it } from 'vitest'
import { escapeHtml, previewText, renderInline, renderMarkup } from './markup.js'

// WhatsApp's published markup, and the cases it leaves alone (docs/trd/harness.md#chat-preview).

describe('renderInline: what WhatsApp marks up', () => {
  it('draws *bold*, _italic_ and ~strikethrough~', () => {
    expect(renderInline('a *bold* word')).toBe('a <b>bold</b> word')
    expect(renderInline('an _italic_ word')).toBe('an <i>italic</i> word')
    expect(renderInline('a ~struck~ word')).toBe('a <s>struck</s> word')
  })

  it('draws `inline code` and leaves markup inside it alone', () => {
    expect(renderInline('run `ls *.ts` now')).toBe('run <code>ls *.ts</code> now')
  })

  it('nests one mark in another', () => {
    expect(renderInline('*bold _and italic_*')).toBe('<b>bold <i>and italic</i></b>')
  })

  it('marks at the start of the text, after punctuation, and before punctuation', () => {
    expect(renderInline('*one*, (_two_) and "~three~".')).toBe('<b>one</b>, (<i>two</i>) and &quot;<s>three</s>&quot;.')
  })

  it('links a bare address and leaves the punctuation after it out of the link', () => {
    expect(renderInline('see https://example.com/a_b, ok')).toBe(
      'see <a href="https://example.com/a_b" target="_blank" rel="noopener noreferrer">https://example.com/a_b</a>, ok'
    )
  })
})

describe('renderInline: what WhatsApp leaves as raw characters', () => {
  it('shows **double asterisks** raw', () => {
    expect(renderInline('a **double** word')).toBe('a **double** word')
    expect(renderInline('***three***')).toBe('***three***')
  })

  it('shows ~~double tildes~~ raw', () => {
    expect(renderInline('~~gone~~')).toBe('~~gone~~')
  })

  it('shows a Markdown link as its characters, with the bare address still a link', () => {
    const html = renderInline('[text](https://example.com)')
    expect(html.startsWith('[text](<a ')).toBe(true)
    expect(html.endsWith('>https://example.com</a>)')).toBe(true)
  })

  it('does not mark a word-internal underscore, or a star with a space inside', () => {
    expect(renderInline('use snake_case_names here')).toBe('use snake_case_names here')
    expect(renderInline('2 * 3 * 4')).toBe('2 * 3 * 4')
    expect(renderInline('a * b* and *c *')).toBe('a * b* and *c *')
  })

  it('does not mark an empty pair, or one that never closes', () => {
    expect(renderInline('**')).toBe('**')
    expect(renderInline('an *open mark')).toBe('an *open mark')
  })

  it('does not close a mark that a word runs on from', () => {
    expect(renderInline('*bold*s')).toBe('*bold*s')
  })
})

describe('renderMarkup: blocks', () => {
  it('draws - and * lists as bullets, and 1. lists as numbers', () => {
    expect(renderMarkup('- one\n* two')).toBe('<ul><li>one</li><li>two</li></ul>')
    expect(renderMarkup('1. first\n2. second')).toBe('<ol><li value="1">first</li><li value="2">second</li></ol>')
  })

  it('draws a > line as a block quote, and several as one', () => {
    expect(renderMarkup('> a\n> b')).toBe('<blockquote>a\nb</blockquote>')
  })

  it('marks up inside a list item and a quote', () => {
    expect(renderMarkup('- a *b*')).toBe('<ul><li>a <b>b</b></li></ul>')
    expect(renderMarkup('> _q_')).toBe('<blockquote><i>q</i></blockquote>')
  })

  it('draws a triple-backtick block as monospace and marks up nothing inside it', () => {
    expect(renderMarkup('```\n*not bold* <b>\n```')).toBe('<pre>*not bold* &lt;b&gt;</pre>')
    expect(renderMarkup('before\n```code```\nafter')).toBe(
      '<div class="t">before</div><pre>code</pre><div class="t">after</div>'
    )
  })

  it('keeps line breaks and blank lines of plain text', () => {
    expect(renderMarkup('a\n\nb')).toBe('<div class="t">a\n\nb</div>')
  })

  it('shows a heading, a table and a number without a space as raw characters', () => {
    expect(renderMarkup('# Title')).toBe('<div class="t"># Title</div>')
    expect(renderMarkup('| a | b |\n| - | - |')).toBe('<div class="t">| a | b |\n| - | - |</div>')
    expect(renderMarkup('-no space\n1.no space\n>no space')).toBe(
      '<div class="t">-no space\n1.no space\n&gt;no space</div>'
    )
  })

  it('shows an unclosed monospace fence as raw characters', () => {
    expect(renderMarkup('```open')).toBe('<div class="t">```open</div>')
  })

  it('keeps a mark from running across lines', () => {
    expect(renderMarkup('*a\nb*')).toBe('<div class="t">*a\nb*</div>')
  })
})

describe('escaping', () => {
  it('writes nothing a person or a model typed as live HTML', () => {
    expect(renderMarkup('<img src=x onerror=alert(1)> & "q"')).toBe(
      '<div class="t">&lt;img src=x onerror=alert(1)&gt; &amp; &quot;q&quot;</div>'
    )
    expect(renderMarkup('*<script>*')).toBe('<div class="t"><b>&lt;script&gt;</b></div>')
    expect(renderMarkup('`<b>`')).toBe('<div class="t"><code>&lt;b&gt;</code></div>')
  })

  it('links only http and https, and escapes the address', () => {
    expect(renderMarkup('javascript:alert(1) data:text/html,x')).not.toContain('<a ')
    expect(renderMarkup('http://a.test/?q="x"&y=1')).toContain('href="http://a.test/?q=&quot;x&quot;&amp;y=1"')
  })

  it('escapes the five characters', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;')
  })
})

describe('previewText', () => {
  it('flattens to one line and cuts at the limit', () => {
    expect(previewText('a\n  b')).toBe('a b')
    expect(previewText('x'.repeat(200), 10)).toBe(`${'x'.repeat(9)}…`)
  })
})
