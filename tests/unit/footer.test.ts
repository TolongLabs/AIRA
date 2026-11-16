import { describe, expect, it } from 'vitest'
import { type CleanOptions, cleanReply } from '../../src/format/clean.js'
import { buildFooter, capitaliseBubble, forReplay } from '../../src/format/footer.js'
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
  it('lists tools once, in call order, with at most two labels and a count', () => {
    expect(buildFooter([])).toBeUndefined()
    expect(buildFooter(['web_search'])).toBe('_🛠️ searched the web_')
    expect(buildFooter(['web_search', 'web_search', 'read_page', 'note', 'recall'])).toBe(
      '_🛠️ searched the web · read a page +2_'
    )
  })

  it('takes the icon and labels from the card, and a plain label for an unnamed tool', () => {
    const card = { icon: '🧪', labels: { web_search: 'ran an experiment on the web' } }
    expect(buildFooter(['web_search', 'song_find'], card)).toBe('_🧪 ran an experiment on the web · used song find_')
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
    expect(result.content).toBe(`First part of it\n${BUBBLE_BREAK}\nSecond part of it\n\n_🛠️ searched the web_`)
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
  it('removes bubble breaks, media lines and the footer, and keeps the text', () => {
    const stored = `Hi\n${BUBBLE_BREAK}\nMore\n\n_🛠️ searched the web_\nMEDIA:/data/stickers/a.webp`
    expect(forReplay(stored)).toBe('Hi\nMore')
    expect(forReplay('Ends in _italic_')).toBe('Ends in _italic_')
    expect(forReplay('Text\n\n_🧪 ran a test_', '🧪')).toBe('Text')
  })
})
