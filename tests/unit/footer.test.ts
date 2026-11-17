import { describe, expect, it } from 'vitest'
import { loadPack } from '../../src/character/loader.js'
import { isFace } from '../../src/character/schema.js'
import { type CleanOptions, cleanReply, createReplyCleaner, guardFaces } from '../../src/format/clean.js'
import { buildFooter, capitaliseBubble, forReplay } from '../../src/format/footer.js'
import { BUBBLE_BREAK } from '../../src/gateway/response.js'
import type { BuiltPrompt, RunResult, TurnContext } from '../../src/turn/types.js'

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
  it('lists tools once, in call order, in italics, with at most two labels and a count', () => {
    expect(buildFooter([])).toBeUndefined()
    expect(buildFooter(['web_search'])).toBe('_🛠️ searched the web_')
    expect(buildFooter(['web_search', 'web_search', 'read_page', 'note', 'recall'])).toBe(
      '_🛠️ searched the web · read a page +2_'
    )
  })

  it('takes labels from the card, the emoji from the chat before the card, and adds up to three domains', () => {
    const card = { icon: '🧪', labels: { web_search: 'Ran a Web Search' } }
    expect(buildFooter(['web_search'], card)).toBe('_🧪 ran a web search_')
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
    ).toBe('_🔬 ran a web search · used song find_\n_🔗 dosm.gov.my · en.wikipedia.org · reuters.com_')
  })

  it('footer: media_video and media_youtube in one turn show the label once', () => {
    expect(buildFooter(['media_video', 'media_youtube'])).toBe('_🛠️ watched a video_')
    expect(buildFooter(['media_video', 'media_youtube', 'web_search'])).toBe('_🛠️ watched a video · searched the web_')
  })
})

describe('createReplyCleaner intake and tool footers', () => {
  const pack = loadPack('characters/example', 'repository')
  const built: BuiltPrompt = { system: [], messages: [], record: {}, shape: { maxChars: 600 } }
  const emptyRun = { calls: [] } as unknown as RunResult

  const makeContext = (overrides: Partial<TurnContext> = {}): TurnContext => ({
    turnId: 't_1',
    chat: { chatId: 'c_1', waId: 'test-chat', type: 'group', label: '', status: 'active' },
    senderId: 's_1',
    character: pack,
    settings: {},
    kind: 'reply',
    delivery: { kind: 'reply' },
    deadline: Date.now() + 10_000,
    ...overrides
  })

  it('footer: a watched YouTube link with no tool call shows "watched a video" and youtube.com', () => {
    const cleaner = createReplyCleaner(
      { format: { bubbleMaxChars: 4000, maxBubbles: 1, leakCheck: 'off' } },
      () => [],
      () => [],
      () => []
    )
    const result = cleaner.clean({
      text: 'looks cool',
      context: makeContext({
        intakeKinds: ['media_youtube'],
        intakeUrls: ['https://www.youtube.com/watch?v=abc123']
      }),
      built,
      run: emptyRun
    })
    expect(result.content).toBe('Looks cool\n\n_🛠️ watched a video_\n_🔗 youtube.com_')
  })

  it('footer: a video file and a web search show both labels, intake first', () => {
    const cleaner = createReplyCleaner(
      { format: { bubbleMaxChars: 4000, maxBubbles: 1, leakCheck: 'off' } },
      () => ['web_search'],
      () => ['web_search'],
      () => ['https://example.com/1']
    )
    const result = cleaner.clean({
      text: 'here is more info',
      context: makeContext({ intakeKinds: ['media_video'] }),
      built,
      run: emptyRun
    })
    expect(result.content).toBe('Here is more info\n\n_🛠️ watched a video · searched the web_\n_🔗 example.com_')
  })

  it('footer: an unreadable file adds no label', () => {
    const cleaner = createReplyCleaner(
      { format: { bubbleMaxChars: 4000, maxBubbles: 1, leakCheck: 'off' } },
      () => [],
      () => [],
      () => []
    )
    const result = cleaner.clean({
      text: 'could not open that',
      context: makeContext({ intakeKinds: [], intakeUrls: [] }),
      built,
      run: emptyRun
    })
    expect(result.content).toBe('Could not open that')
  })

  it('footer: a pack label overrides an intake default', () => {
    const customPack = {
      ...pack,
      card: {
        ...pack.card,
        toolFooter: { icon: '📺', labels: { media_youtube: 'checked a clip' } }
      }
    }
    const cleaner = createReplyCleaner(
      { format: { bubbleMaxChars: 4000, maxBubbles: 1, leakCheck: 'off' } },
      () => [],
      () => [],
      () => []
    )
    const result = cleaner.clean({
      text: 'nice clip',
      context: makeContext({
        character: customPack,
        intakeKinds: ['media_youtube'],
        intakeUrls: ['https://www.youtube.com/watch?v=abc123']
      }),
      built,
      run: emptyRun
    })
    expect(result.content).toBe('Nice clip\n\n_📺 checked a clip_\n_🔗 youtube.com_')
  })

  it('footer: a direct command still gets no footer; features.toolFooter off hides both lines', () => {
    const cleaner = createReplyCleaner(
      { format: { bubbleMaxChars: 4000, maxBubbles: 1, leakCheck: 'off' } },
      () => ['help', 'web_search'],
      () => ['help'],
      () => ['https://example.com']
    )
    const direct = cleaner.clean({
      text: 'Commands in this chat:',
      context: makeContext({ kind: 'command' }),
      built: { system: [], messages: [], record: { lengthBypass: 'command_list' }, shape: { lengthBypass: true } },
      run: emptyRun
    })
    expect(direct.content).toBe('Commands in this chat:')

    const off = cleaner.clean({
      text: 'found it',
      context: makeContext({
        intakeKinds: ['media_youtube'],
        intakeUrls: ['https://www.youtube.com/watch?v=abc123'],
        settings: { 'features.toolFooter': { value: false, level: 'chat' } }
      }),
      built,
      run: emptyRun
    })
    expect(off.content).toBe('Found it')
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

  it('follows the chat: no footer when switched off, and the chat emoji and the sources when on', () => {
    expect(cleanReply('found it', { ...base, toolsOk: ['web_search'], footerOff: true }).content).toBe('Found it')
    expect(
      cleanReply('found it', {
        ...base,
        toolsOk: ['web_search'],
        footerEmoji: '🔬',
        sources: ['https://www.dosm.gov.my/x']
      }).content
    ).toBe('Found it\n\n_🔬 searched the web_\n_🔗 dosm.gov.my_')
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
    const stored = `Hi\n${BUBBLE_BREAK}\nMore\n\n_🧪 searched the web +1_\n_🔗 dosm.gov.my · reuters.com_\nMEDIA:/data/stickers/a.webp`
    expect(forReplay(stored)).toBe('Hi\nMore')
    expect(forReplay('Text\n\n_🛠️ checked reminders_')).toBe('Text')
    expect(forReplay('Ends in _italic_')).toBe('Ends in _italic_')
    expect(forReplay('Line one\n😊 see you')).toBe('Line one\n😊 see you')
  })

  it('keeps a reply that is only small text', () => {
    expect(forReplay('_🛠️ hi_')).toBe('_🛠️ hi_')
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
