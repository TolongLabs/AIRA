import { describe, expect, it } from 'vitest'
import { GATEWAY_CHUNK_LIMIT } from '../../src/format/bubbles.js'
import { cleanReply } from '../../src/format/clean.js'
import { BUBBLE_BREAK } from '../../src/gateway/response.js'
import { gatewayMarkdown } from '../support/gateway-markdown.js'

const SMILE = String.fromCodePoint(0x1f60a)
const TEA = String.fromCodePoint(0x1f375)
const BULLET = String.fromCodePoint(0x2022)
const EN_DASH = String.fromCodePoint(0x2013)
const JP_LINE = '\u4eca\u65e5\u306f\u3044\u3044\u5929\u6c17\u3067\u3059\u306d\u3002**bold** \u3068 `code`'

const CORPUS: string[] = [
  'Just a plain reply with nothing special.',
  'Here is **bold** and __double underscore__ and *italic* and _under_ plus ~~old~~ and ~single~.',
  'Snake case like user_profile_id and max_retry_count stays intact.',
  '# Heading one\n\nParagraph below.',
  '### **Already bold heading**\n\nMore text.',
  '###### Small heading\n\nBody text.',
  '| Item | Price |\n| --- | --- |\n| Coffee | 4 |\n| Tea | 3 |',
  '| Column |\n| :--- |\n| Alpha |\n| Beta |',
  '- top one\n  - nested one\n  - nested two\n- top two',
  '* star item\n+ plus item\n' + BULLET + ' dot item\n' + EN_DASH + ' dash item',
  '1) first step\n2) second step\n3) third step',
  '1.\nbroken marker\n\n2.\nnext item',
  '> Quoted line one\n> Quoted line two',
  'Check [the guide](https://example.test/guide) and ![badge](https://example.test/img.png).',
  'Same URL [https://example.test/same](https://example.test/same) and bare <https://example.test/bare>.',
  '<b>Bold HTML</b><br><p>Second &amp; 1 &lt; 3 &gt; 0 &quot;ok&quot; &#39;fine&#39;</p>',
  'Saya suka minum teh tarik pada waktu petang sambil membaca buku.',
  JP_LINE,
  `Happy to help ${SMILE} have some tea ${TEA}!`,
  '```ts\nconst a = "**not bold**"\nconst b = "__not__ ~~no~~"\n# not heading\n| a | b |\n| --- | --- |\n```',
  'Inline `**code**` and `[link](https://example.test)` stay literal.',
  'Nova: <tool_call>{"name":"search","q":"x"}</tool_call>Here is the answer.',
  '**nova:** **uses**? No, *uses search*\nCalling search...\nThe search tool is helpful.',
  'Assistant:   Indented line\n  AI: Another line',
  '```json\n{"name":"search","arguments":{"q":"test"}}\n```\nDone checking.',
  'Unclosed fence:\n```js\nconst x = 1 * 2',
  'Plain 2 * 3 = 6 and\n# hash at start of line\nand [link](https://example.test).',
  '---',
  '***\n\nText after rule\n\n___',
  'Nested **bold with _italic_ inside** and _italic with **bold** inside_.',
  `${'This is a long sentence for the corpus gate. '.repeat(60)}`,
  `${'UnbrokenWordWithoutSpaces'.repeat(200)}`
]

function stripCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]+`/g, '')
}

describe('format corpus gate', () => {
  it('has at least 30 replies in the corpus', () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(30)
  })

  it('no corpus reply steps out of its role', () => {
    const toolNames = ['search', 'read_post', 'read_page', 'web_search', 'reminder_set', 'note', 'help', 'list']
    const flagged = CORPUS.flatMap((raw) => {
      const { fourthWall } = cleanReply(raw, {
        toolNames,
        speakerNames: ['Nova'],
        lengthBypass: true,
        shape: {},
        fixedBlocks: [],
        leakCheck: false,
        fallbackLine: 'Fallback line.',
        bubbleMaxChars: 700,
        maxBubbles: 3
      })
      return fourthWall === undefined ? [] : [{ raw, fourthWall }]
    })
    expect(flagged).toEqual([])
  })

  it.each(CORPUS.map((text, index) => [index, text]))(
    'produces valid WhatsApp markup and bubbles for corpus item #%i',
    (_index, raw) => {
      const cleaned = cleanReply(raw, {
        toolNames: ['search'],
        speakerNames: ['Nova'],
        lengthBypass: true,
        shape: {},
        fixedBlocks: [],
        leakCheck: false,
        fallbackLine: 'Fallback line.',
        bubbleMaxChars: 700,
        maxBubbles: 3
      })

      if (cleaned.content.length > 0) {
        const bubbles = cleaned.content.split(`\n${BUBBLE_BREAK}\n`)
        for (const bubble of bubbles) {
          expect(bubble.trim().length).toBeGreaterThan(0)
          expect(bubble.length).toBeLessThan(GATEWAY_CHUNK_LIMIT)
        }
      }

      const whatsapp = gatewayMarkdown(cleaned.content)
      const outsideCode = stripCode(whatsapp)

      expect(outsideCode).not.toContain('**')
      expect(outsideCode).not.toContain('__')
      expect(outsideCode).not.toContain('~~')
      expect(outsideCode).not.toMatch(/^#{1,6} /m)
      expect(outsideCode).not.toContain('](')
      expect(outsideCode).not.toMatch(/<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^<>]*)?\/?>/)
      expect(outsideCode).not.toMatch(/^[|\-: ]+$/m)
      expect(outsideCode).not.toMatch(/^[|-]+$/m)
    }
  )
})
