import { describe, expect, it } from 'vitest'
import { BUBBLE_BREAK } from '../gateway.js'
import { ChatLog, classifyMedia, quoteText, shapeReply, textFields } from './model.js'

const STICKER = '/host/aira-data/characters/second/stickers/calm.webp'

describe('shapeReply: what the gateway sends for the core’s reply', () => {
  it('splits at the break lines into bubbles, in order, and drops empty ones', () => {
    const shape = shapeReply(`one${'\n'}${BUBBLE_BREAK}\ntwo\n\n${BUBBLE_BREAK}\n${BUBBLE_BREAK}\nthree`)
    expect(shape).toEqual({ kind: 'messages', bubbles: ['one', 'two', 'three'], media: [] })
  })

  it('sends a sticker after every text bubble, as its own message', () => {
    const shape = shapeReply(`first\n${BUBBLE_BREAK}\nsecond\nMEDIA:${STICKER}`)
    if (shape.kind !== 'messages') throw new Error('expected messages')
    expect(shape.bubbles).toEqual(['first', 'second'])
    expect(shape.media).toEqual([{ kind: 'sticker', name: 'calm.webp', pack: 'second', file: 'calm.webp' }])
  })

  it('applies the gateway’s Markdown conversion to each bubble, so the preview shows what WhatsApp gets', () => {
    const shape = shapeReply(
      `**bold** *it* ~~x~~ [t](https://a.test)\n${BUBBLE_BREAK}\n# Head\n\`\`\`\n**kept**\n\`\`\``
    )
    if (shape.kind !== 'messages') throw new Error('expected messages')
    expect(shape.bubbles).toEqual(['*bold* _it_ ~x~ t (https://a.test)', '*Head*\n```\n**kept**\n```'])
  })

  it('sends nothing for NO_REPLY, and nothing for an empty reply', () => {
    expect(shapeReply('NO_REPLY')).toEqual({ kind: 'none', reason: 'no_reply' })
    expect(shapeReply('  NO_REPLY\n')).toEqual({ kind: 'none', reason: 'no_reply' })
    expect(shapeReply('')).toEqual({ kind: 'none', reason: 'empty' })
    expect(shapeReply(`${BUBBLE_BREAK}\n\n`)).toEqual({ kind: 'none', reason: 'empty' })
  })

  it('sends a reply that is only a file', () => {
    expect(shapeReply(`MEDIA:${STICKER}`)).toMatchObject({ kind: 'messages', bubbles: [] })
  })
})

describe('classifyMedia', () => {
  it('takes a .webp under a pack’s stickers folder for a sticker, on the gateway’s own rule', () => {
    expect(classifyMedia(STICKER)).toEqual({ kind: 'sticker', name: 'calm.webp', pack: 'second', file: 'calm.webp' })
    expect(classifyMedia('/x/characters/a/stickers/B.WEBP')).toMatchObject({ kind: 'sticker', pack: 'a' })
  })

  it('takes any other image for a photo, and any other file for a file', () => {
    expect(classifyMedia('/host/aira-data/pictures/a.webp')).toEqual({ kind: 'photo', name: 'a.webp' })
    expect(classifyMedia('/host/aira-data/notes/report.pdf')).toEqual({ kind: 'file', name: 'report.pdf' })
  })

  it('names the stored path of a picture a tool made, and nothing for a path outside files/', () => {
    const hash = 'a'.repeat(64)
    expect(classifyMedia(`/host/aira-data/files/ab/${hash}.png`)).toEqual({
      kind: 'photo',
      name: `${hash}.png`,
      stored: `ab/${hash}.png`
    })
    expect(classifyMedia(`/etc/${hash}.png`)).not.toHaveProperty('stored')
  })

  it('does not take a path that climbs out of a stickers folder for a sticker', () => {
    expect(classifyMedia('/x/characters/a/stickers/../../../etc/passwd.webp')).toMatchObject({ kind: 'photo' })
  })
})

describe('ChatLog', () => {
  it('numbers messages in send order and returns what changed since a revision', () => {
    const log = new ChatLog('t')
    const a = log.add({ kind: 'member', sender: 'A', ...textFields('one') })
    const b = log.add({ kind: 'aira', ...textFields('two') })
    expect([a.seq, b.seq, a.id, b.id]).toEqual([1, 2, 't-1', 't-2'])
    expect(log.since(0).map((m) => m.seq)).toEqual([1, 2])
    expect(log.since(1).map((m) => m.seq)).toEqual([2])

    const seen = log.rev
    log.update(a, { reaction: '👍' })
    expect(log.since(seen).map((m) => [m.seq, m.reaction])).toEqual([[1, '👍']])
    expect(log.find('t-2')).toBe(b)
  })
})

describe('quoteText', () => {
  it('quotes the text, or what kind of thing the message is', () => {
    const log = new ChatLog('q')
    expect(quoteText(log.add({ kind: 'aira', ...textFields('  hello\nthere ') }))).toBe('hello there')
    expect(quoteText(log.add({ kind: 'aira', html: '', text: '', sticker: { url: '/s', name: 'a.webp' } }))).toBe(
      'Sticker'
    )
    expect(quoteText(log.add({ kind: 'aira', html: '', text: '', attachment: { name: 'a.pdf', kind: 'file' } }))).toBe(
      'a.pdf'
    )
  })
})
