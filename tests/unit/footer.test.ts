import { describe, expect, it } from 'vitest'
import { isFace } from '../../src/character/schema.js'
import { type CleanOptions, cleanReply, guardFaces } from '../../src/format/clean.js'
import { buildFooter, capitaliseBubble, forReplay, superscript } from '../../src/format/footer.js'
import { BUBBLE_BREAK } from '../../src/gateway/response.js'

const base: CleanOptions = {
  toolNames: [],
  speakerNames: ['Bot'],
  lengthBypass: false,
  shape: { maxChars: 600 },
  fixedBlocks: [],
  leakCheck: false,
  fallbackLine: 'Fallback.',
  bubbleMaxChars: 4000,
  maxBubbles: 3
}

describe('buildFooter', () => {
  it('lists tools once, in call order, in small text, with at most two labels and a count', () => {
    expect(buildFooter([])).toBeUndefined()
    expect(buildFooter(['web_search'])).toBe('🛠️ ˢᵉᵃʳᶜʰᵉᵈ ᵗʰᵉ ʷᵉᵇ')
    expect(buildFooter(['web_search', 'web_search', 'read_page', 'note', 'recall'])).toBe(
      '🛠️ ˢᵉᵃʳᶜʰᵉᵈ ᵗʰᵉ ʷᵉᵇ · ʳᵉᵃᵈ ᵃ ᵖᵃᵍᵉ ⁺²'
    )
  })

  it('takes labels from the card, the emoji from the chat before the card, and adds up to three domains', () => {
    const card = { icon: '🧪', labels: { web_search: 'Ran a Web Search' } }
    expect(buildFooter(['web_search'], card)).toBe('🧪 ʳᵃⁿ ᵃ ʷᵉᵇ ˢᵉᵃʳᶜʰ')
    expect(
      buildFooter(['web_search', 'song_find'], card, {
        emoji: '🔬',
        sources: [
          'https://www.dosm.gov.my/a/b?x=1',
          'https://dosm.gov.my/other',
          'https://en.wikipedia.org/wiki/Malaysia_(country)',
          'mailto:someone',
          'https://reuters.com/x',
          'https://fourth.example/y'
        ]
      })
    ).toBe('🔬 ʳᵃⁿ ᵃ ʷᵉᵇ ˢᵉᵃʳᶜʰ · ᵘˢᵉᵈ ˢᵒⁿᵍ ᶠⁱⁿᵈ\n🔗 dosm.gov.my · en.wikipedia.org · reuters.com')
  })

  it('keeps q, which has no small form', () => {
    expect(superscript('quick 42')).toBe('qᵘⁱᶜᵏ ⁴²')
  })
})

describe('capitaliseBubble', () => {
  it('capitalises the first letter past markup, quotes and emoji', () => {
    expect(capitaliseBubble('hello there')).toBe('Hello there')
    expect(capitaliseBubble('**ok** fine')).toBe('**Ok** fine')
    expect(capitaliseBubble('> quoted line')).toBe('> Quoted line')
    expect(capitaliseBubble('😊 sure thing')).toBe('😊 Sure thing')
    expect(capitaliseBubble('"yes," she said')).toBe('"Yes," she said')
  })

  it('leaves code, links, commands, mentions and words that hold a capital', () => {
    for (const text of ['`npm i`', '```\ncode\n```', 'https://x.test', '/help me', '@member hi', 'iPhone is here'])
      expect(capitaliseBubble(text)).toBe(text)
    expect(capitaliseBubble('42 is the answer')).toBe('42 is the answer')
  })
})

describe('cleanReply footer, capitals and bypasses', () => {
  it('capitalises every bubble and puts the footer in the last one', () => {
    const result = cleanReply('first part of it\n\nsecond part of it', {
      ...base,
      bubbleMaxChars: 20,
      toolsOk: ['web_search']
    })
    expect(result.content).toBe(`First part of it\n${BUBBLE_BREAK}\nSecond part of it\n\n🛠️ ˢᵉᵃʳᶜʰᵉᵈ ᵗʰᵉ ʷᵉᵇ`)
    expect(result.bubbleCount).toBe(2)
    expect(result.steps).toEqual(expect.arrayContaining(['capitals', 'footer']))
  })

  it('adds no footer when no tool ran with outcome ok, or when a line replaced the reply', () => {
    expect(cleanReply('plain reply', base).content).toBe('Plain reply')
    const leaked = cleanReply('one two three four five six seven eight nine ten eleven twelve', {
      ...base,
      leakCheck: true,
      fixedBlocks: ['one two three four five six seven eight nine ten eleven twelve'],
      toolsOk: ['web_search']
    })
    expect(leaked.content).toBe('Fallback.')
  })

  it('follows the chat: no footer when switched off, and the chat emoji and the sources when on', () => {
    expect(cleanReply('found it', { ...base, toolsOk: ['web_search'], footerOff: true }).content).toBe('Found it')
    expect(
      cleanReply('found it', {
        ...base,
        toolsOk: ['web_search'],
        footerEmoji: '🔬',
        sources: ['https://www.dosm.gov.my/x']
      }).content
    ).toBe('Found it\n\n🔬 ˢᵉᵃʳᶜʰᵉᵈ ᵗʰᵉ ʷᵉᵇ\n🔗 dosm.gov.my')
  })

  it('lifts a research answer to 1,400 characters, not to no limit', () => {
    const long = 'word '.repeat(500).trim()
    const plain = cleanReply(long, base)
    const research = cleanReply(long, { ...base, toolsOk: ['web_search'] })
    expect(plain.content.length).toBeLessThanOrEqual(600)
    expect(research.content.length).toBeGreaterThan(600)
    expect(research.content.split('\n\n')[0]!.length).toBeLessThanOrEqual(1400)
    expect(research.steps).toContain('bypass_research')
  })

  it('lifts the limit for a command whose answer is a list', () => {
    const long = 'word '.repeat(500).trim()
    const result = cleanReply(long, { ...base, commandTool: 'reminder_list' })
    expect(result.content.length).toBeGreaterThan(1400)
    expect(result.steps).toContain('bypass_command_list')
  })
})

describe('capitals inside one bubble', () => {
  it('capitalises each paragraph', () => {
    expect(cleanReply(`one\n\ntwo\n${BUBBLE_BREAK}\nthree`, base).content).toBe(`One\n\nTwo\n${BUBBLE_BREAK}\nThree`)
  })
})

describe('forReplay', () => {
  it('removes bubble breaks, media lines and both footer lines, and keeps the text', () => {
    const stored = `Hi\n${BUBBLE_BREAK}\nMore\n\n🧪 ˢᵉᵃʳᶜʰᵉᵈ ᵗʰᵉ ʷᵉᵇ ⁺¹\n🔗 dosm.gov.my · reuters.com\nMEDIA:/data/stickers/a.webp`
    expect(forReplay(stored)).toBe('Hi\nMore')
    expect(forReplay('Text\n\n🛠️ ᶜʰᵉᶜᵏᵉᵈ ʳᵉᵐⁱⁿᵈᵉʳˢ')).toBe('Text')
    expect(forReplay('Ends in _italic_')).toBe('Ends in _italic_')
    expect(forReplay('Line one\n😊 see you')).toBe('Line one\n😊 see you')
  })

  it('keeps a reply that is only small text', () => {
    expect(forReplay('🛠️ ʰⁱ')).toBe('🛠️ ʰⁱ')
  })
})

describe('guardFaces', () => {
  it('turns markdown characters inside faces into full-width forms, and leaves code and words alone', () => {
    expect(guardFaces('Yay (*^▽^*) and (>_<) ~')).toBe('Yay (＊^▽^＊) and (>＿<) ~')
    expect(guardFaces('Hm (´・ω・`) see `npm i` now')).toBe('Hm (´・ω・｀) see `npm i` now')
    expect(guardFaces('```\n(>_<)\n```')).toBe('```\n(>_<)\n```')
    expect(guardFaces('call (my_func) here')).toBe('call (my_func) here')
    expect(guardFaces('¯\\_(ツ)_/¯ ok')).toBe('¯\\＿(ツ)＿/¯ ok')
  })
})

describe('isFace', () => {
  it('accepts kaomoji and refuses bracketed words', () => {
    for (const face of ['(≧▽≦)', '(ﾉ◕ヮ◕)ﾉ', 'σ(≧ε≦σ)', '( ˘▽˘)っ', 'ᕦ(ò_óˇ)ᕤ', '(O_O)'])
      expect(isFace(face)).toBe(true)
    for (const word of ['(hello)', 'smile', '(a)(b)', `(${'・'.repeat(21)})`]) expect(isFace(word)).toBe(false)
  })
})
