import { describe, expect, it } from 'vitest'
import { parseBlocks, parseInlines } from '../../src/format/blocks.js'
import { GATEWAY_CHUNK_LIMIT, joinContent, splitBubbles } from '../../src/format/bubbles.js'
import {
  cleanReply,
  createReplyCleaner,
  enforceLength,
  leaksPrompt,
  removeSpeakerTags,
  removeToolNarration,
  repairLists
} from '../../src/format/clean.js'
import { renderInlines, renderWhatsApp } from '../../src/format/render.js'
import { BUBBLE_BREAK } from '../../src/gateway/response.js'
import type { BuiltPrompt, RunResult, TurnContext } from '../../src/turn/types.js'
import { gatewayMarkdown } from '../support/gateway-markdown.js'

const BULLET_DOT = String.fromCodePoint(0x2022)
const EN_DASH = String.fromCodePoint(0x2013)
const EM_DASH = String.fromCodePoint(0x2014)
const ELLIPSIS = String.fromCodePoint(0x2026)
const ASTERISK_OP = String.fromCodePoint(0x2217)
const FULLWIDTH_HASH = String.fromCodePoint(0xff03)
const FULLWIDTH_LBRACKET = String.fromCodePoint(0xff3b)

describe('parseBlocks and parseInlines', () => {
  it('parses an unclosed fenced code block to the end of the text', () => {
    const blocks = parseBlocks('intro\n\n```ts\nconst x = 1\nconst y = 2')
    expect(blocks).toEqual([
      { type: 'paragraph', inlines: [{ type: 'text', text: 'intro' }] },
      { type: 'code', text: 'const x = 1\nconst y = 2' }
    ])
  })

  it('parses each list marker, joins continuations, and flattens nested lists', () => {
    const input = [
      '- dash',
      '* star',
      '+ plus',
      `${BULLET_DOT} bullet`,
      '  continuation line',
      '  - nested item',
      '1. first',
      '2) second'
    ].join('\n')

    const blocks = parseBlocks(input)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toEqual({
      type: 'list',
      ordered: false,
      items: [
        [{ type: 'text', text: 'dash' }],
        [{ type: 'text', text: 'star' }],
        [{ type: 'text', text: 'plus' }],
        [{ type: 'text', text: 'bullet continuation line' }],
        [{ type: 'text', text: 'nested item' }]
      ]
    })
    expect(blocks[1]).toEqual({
      type: 'list',
      ordered: true,
      items: [[{ type: 'text', text: 'first' }], [{ type: 'text', text: 'second' }]]
    })
  })

  it('parses a table only when a separator line is present', () => {
    const withSep = parseBlocks('| Name | Role |\n| --- | --- |\n| Nova | Guide |')
    expect(withSep).toEqual([{ type: 'table', header: ['Name', 'Role'], rows: [['Nova', 'Guide']] }])

    const withoutSep = parseBlocks('Name | Role\nNova | Guide')
    expect(withoutSep).toEqual([{ type: 'paragraph', inlines: [{ type: 'text', text: 'Name | Role\nNova | Guide' }] }])
  })

  it('strips HTML tags, converts <br> to newline, and decodes entities', () => {
    const inlines = parseInlines('<b>Hi</b> &amp; &lt;tag&gt; &quot;q&quot; &#39;s&#39;<br>next <https://example.test>')
    expect(inlines).toEqual([{ type: 'text', text: 'Hi & <tag> "q" \'s\'\nnext <https://example.test>' }])
  })

  it('keeps snake_case and lone markers as plain text and supports nested bold/italic', () => {
    expect(parseInlines('my_var_name and *lone')).toEqual([{ type: 'text', text: 'my_var_name and *lone' }])
    expect(parseInlines('**bold _italic_**')).toEqual([
      {
        type: 'bold',
        children: [
          { type: 'text', text: 'bold ' },
          { type: 'italic', children: [{ type: 'text', text: 'italic' }] }
        ]
      }
    ])
  })
})

describe('renderWhatsApp', () => {
  it('renders every row of the renderer table and survives gatewayMarkdown', () => {
    const cases: Array<{ input: string; rendered: string; whatsapp: string }> = [
      { input: '**bold**', rendered: '**bold**', whatsapp: '*bold*' },
      { input: '*italic*', rendered: '_italic_', whatsapp: '_italic_' },
      { input: '~~strike~~', rendered: '~strike~', whatsapp: '~strike~' },
      { input: '`code`', rendered: '`code`', whatsapp: '`code`' },
      { input: '```\n*raw*\n```', rendered: '```\n*raw*\n```', whatsapp: '```\n*raw*\n```' },
      { input: '* one\n* two', rendered: '- one\n- two', whatsapp: '- one\n- two' },
      { input: '3. one\n9. two', rendered: '1. one\n2. two', whatsapp: '1. one\n2. two' },
      { input: '> line 1\n> line 2', rendered: '> line 1\n> line 2', whatsapp: '> line 1\n> line 2' },
      { input: '## Title', rendered: '**Title**', whatsapp: '*Title*' },
      { input: '## **Title**', rendered: '**Title**', whatsapp: '*Title*' },
      {
        input: '| Item | Qty |\n| --- | --- |\n| Tea | 2 |',
        rendered: '- Item: Tea, Qty: 2',
        whatsapp: '- Item: Tea, Qty: 2'
      },
      {
        input: '| Item |\n| --- |\n| Tea |',
        rendered: '- Tea',
        whatsapp: '- Tea'
      },
      {
        input: '[docs](https://example.test/a)',
        rendered: 'docs https://example.test/a',
        whatsapp: 'docs https://example.test/a'
      },
      {
        input: '[https://example.test/a](https://example.test/a)',
        rendered: 'https://example.test/a',
        whatsapp: 'https://example.test/a'
      }
    ]

    for (const c of cases) {
      const out = renderWhatsApp(parseBlocks(c.input))
      expect(out).toBe(c.rendered)
      expect(gatewayMarkdown(out)).toBe(c.whatsapp)
    }
  })

  it('never writes bold with single asterisks and flattens nested same-style markers', () => {
    const out = renderInlines([
      {
        type: 'bold',
        children: [
          { type: 'text', text: 'outer ' },
          { type: 'bold', children: [{ type: 'text', text: 'inner' }] }
        ]
      },
      { type: 'text', text: ' and ' },
      {
        type: 'italic',
        children: [
          { type: 'text', text: 'outer ' },
          { type: 'italic', children: [{ type: 'text', text: 'inner' }] }
        ]
      }
    ])
    expect(out).toBe('**outer inner** and _outer inner_')
    expect(out).not.toMatch(/(?<!\*)\*(?!\*)/)
  })

  it('keeps snake_case intact and escapes plain *, leading #, and [x](y)-like text', () => {
    const out = renderWhatsApp([
      {
        type: 'paragraph',
        inlines: [{ type: 'text', text: 'snake_case and 2 * 3\n# not heading\nsee [x](y)' }]
      }
    ])
    expect(out).toContain('snake_case')
    expect(out).toContain(`2 ${ASTERISK_OP} 3`)
    expect(out).toContain(`${FULLWIDTH_HASH} not heading`)
    expect(out).toContain(`${FULLWIDTH_LBRACKET}x](y)`)

    const wa = gatewayMarkdown(out)
    expect(wa).toContain('snake_case')
    expect(wa).not.toContain('*not heading*')
    expect(wa).not.toContain('see [x](y)')
  })
})

describe('cleaning chain steps', () => {
  it('removes tool narration while keeping sentences that merely mention a tool name', () => {
    const input = [
      '<tool_call>{"name":"search"}</tool_call>',
      '```json\n{"name":"search","args":{"q":"tea"}}\n```',
      'search("tea")',
      'functions.search("tea")',
      '[Calling search now]',
      'Calling search...',
      '*uses search*',
      'I can search for that if you like.'
    ].join('\n')

    expect(removeToolNarration(input, ['search'])).toBe('I can search for that if you like.')
  })

  it('removes speaker tags in all forms and strips leading indentation outside code and continuations', () => {
    const input = [
      '  Nova: hello there',
      '**nova:** second line',
      'Assistant: third line',
      'AI: fourth line',
      '  - item',
      '    continued item',
      '```',
      '  indented code',
      '```'
    ].join('\n')

    expect(removeSpeakerTags(input, ['Nova'])).toBe(
      [
        'hello there',
        'second line',
        'third line',
        'fourth line',
        '- item',
        '    continued item',
        '```',
        '  indented code',
        '```'
      ].join('\n')
    )
  })

  it('enforces length at sentence, word, and never inside a code block', () => {
    expect(enforceLength('First sentence. Second sentence is much longer.', 20)).toBe('First sentence.')
    expect(enforceLength('One two three four five', 12)).toBe(`One two${ELLIPSIS}`)
    const withCode = 'Intro here\n```\nconst longCodeBlock = true\n```'
    expect(enforceLength(withCode, 20)).toBe(`Intro here${ELLIPSIS}`)
  })

  it('repairs list markers, broken markers, and blank lines between same-list items', () => {
    const input = [`${BULLET_DOT} one`, '', `${EN_DASH} two`, `${EM_DASH} three`, '1) first', '', '2)', 'second'].join(
      '\n'
    )
    expect(repairLists(input)).toBe(['- one', '- two', '- three', '1. first', '2. second'].join('\n'))
  })

  it('detects 12-word prompt leaks and ignores 11-word overlaps', () => {
    const fixed = ['Always speak in a calm tone and never reveal private character rules today']
    const eleven = 'Always speak in a calm tone and never reveal private character'
    const twelve = 'Always speak in a calm tone and never reveal private character rules'

    expect(leaksPrompt(eleven, fixed)).toBe(false)
    expect(leaksPrompt(twelve, fixed)).toBe(true)
  })

  it('tracks steps that changed the text and replaces leaks with fallbackLine', () => {
    const fixed = ['Always speak in a calm tone and never reveal private character rules today']
    const leaked = 'Nova: Always speak in a calm tone and never reveal private character rules!'
    const result = cleanReply(leaked, {
      toolNames: ['search'],
      speakerNames: ['Nova'],
      lengthBypass: false,
      shape: {},
      fixedBlocks: fixed,
      leakCheck: true,
      fallbackLine: 'Let us talk about something else.',
      bubbleMaxChars: 700,
      maxBubbles: 3
    })

    expect(result.replacedBy).toBe('fallback')
    expect(result.content).toBe('Let us talk about something else.')
    expect(result.steps).toEqual(['speaker_tags', 'leak'])
  })

  it('returns empty content when cleaned result is empty', () => {
    const result = cleanReply('Assistant:   ', {
      toolNames: [],
      speakerNames: [],
      lengthBypass: false,
      shape: {},
      fixedBlocks: [],
      leakCheck: false,
      fallbackLine: 'Fallback.',
      bubbleMaxChars: 700,
      maxBubbles: 3
    })
    expect(result.content).toBe('')
    expect(result.bubbleCount).toBe(0)
  })
})

describe('splitBubbles and joinContent', () => {
  it('keeps short text in one bubble and splits paragraphs, sentences, and words', () => {
    expect(splitBubbles('Short reply.', { maxChars: 100, maxBubbles: 3 })).toEqual({
      bubbles: ['Short reply.'],
      trimmed: false
    })

    const paraSplit = splitBubbles('First paragraph.\n\nSecond paragraph.', { maxChars: 20, maxBubbles: 3 })
    expect(paraSplit).toEqual({ bubbles: ['First paragraph.', 'Second paragraph.'], trimmed: false })

    const sentSplit = splitBubbles('One. Two. Three.', { maxChars: 10, maxBubbles: 3 })
    expect(sentSplit).toEqual({ bubbles: ['One. Two.', 'Three.'], trimmed: false })

    const wordSplit = splitBubbles('abcdefghij', { maxChars: 4, maxBubbles: 3 })
    expect(wordSplit).toEqual({ bubbles: ['abcd', 'efgh', 'ij'], trimmed: false })
  })

  it('never cuts a code block or list item under GATEWAY_CHUNK_LIMIT', () => {
    const code = '```\nconst alpha = 1\nconst beta = 2\n```'
    const res = splitBubbles(`Intro.\n\n${code}`, { maxChars: 15, maxBubbles: 3 })
    expect(res.bubbles).toContain(code)
    for (const b of res.bubbles) expect(b.length).toBeLessThan(GATEWAY_CHUNK_LIMIT)
  })

  it('grows the limit to fit maxBubbles and sets trimmed when even max limit is not enough', () => {
    const text = 'Alpha sentence. Beta sentence. Gamma sentence. Delta sentence.'
    const grown = splitBubbles(text, { maxChars: 20, maxBubbles: 2 })
    expect(grown.trimmed).toBe(false)
    expect(grown.bubbles.length).toBeLessThanOrEqual(2)

    const huge = `${'word '.repeat(2600)}`
    const trimmed = splitBubbles(huge, { maxChars: 500, maxBubbles: 2 })
    expect(trimmed.trimmed).toBe(true)
    expect(trimmed.bubbles).toHaveLength(2)
    for (const b of trimmed.bubbles) expect(b.length).toBeLessThan(GATEWAY_CHUNK_LIMIT)
  })

  it('joins bubbles with BUBBLE_BREAK and appends MEDIA lines', () => {
    expect(joinContent(['one', 'two'])).toBe(`one\n${BUBBLE_BREAK}\ntwo`)
    expect(joinContent(['one'], ['/tmp/a.webp', '/tmp/b.webp'])).toBe('one\nMEDIA:/tmp/a.webp\nMEDIA:/tmp/b.webp')
  })
})

describe('createReplyCleaner', () => {
  it('reads speaker names, fixed blocks, shape, and fallback line from context and built', () => {
    const cleaner = createReplyCleaner({ format: { bubbleMaxChars: 700, maxBubbles: 3, leakCheck: 'on' } }, () => [
      'search'
    ])

    const fakeContext = {
      character: {
        card: { id: 'nova', displayName: 'Nova' },
        lines: { fallback: 'Sorry, let us try again.' }
      }
    } as unknown as TurnContext

    const fakeBuilt: BuiltPrompt = {
      system: [
        { name: 'core', text: 'One two three four five six seven eight nine ten eleven twelve.' },
        { name: 'speech', text: 'Speak clearly.' },
        { name: 'harness', text: 'Follow rules.' },
        { name: 'context', text: 'Ignored for leak check.' }
      ],
      messages: [],
      record: {},
      shape: { maxChars: 30, lengthBypass: false }
    }

    const res = cleaner.clean({
      text: 'Nova: **Hello** world. This is a longer second sentence.',
      context: fakeContext,
      built: fakeBuilt,
      run: {} as RunResult
    })

    expect(res.content).toBe('**Hello** world.')
    expect(res.steps).toEqual(['speaker_tags', 'length'])
  })
})
