import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type Pack, PackError, loadPack } from '../../src/character/loader.js'
import { readWebpInfo, stickerFault } from '../../src/character/webp.js'
import { pickSticker, withStickers } from '../../src/prompt/stickers.js'
import type { CleanedReply, ReplyCleaner, TurnContext } from '../../src/turn/types.js'
import { tmpDir, tmpStorage } from '../support/tmp.js'

function makeVp8x(width: number, height: number, options: { animated?: boolean; bytes?: number } = {}): Buffer {
  const buf = Buffer.alloc(options.bytes ?? 30)
  buf.write('RIFF', 0, 'ascii')
  buf.write('WEBP', 8, 'ascii')
  buf.write('VP8X', 12, 'ascii')
  if (options.animated) buf.writeUInt8(2, 20)
  buf.writeUIntLE(width - 1, 24, 3)
  buf.writeUIntLE(height - 1, 27, 3)
  return buf
}

function makeVp8(width: number, height: number, bytes = 30): Buffer {
  const buf = Buffer.alloc(bytes)
  buf.write('RIFF', 0, 'ascii')
  buf.write('WEBP', 8, 'ascii')
  buf.write('VP8 ', 12, 'ascii')
  buf.writeUInt8(0x9d, 23)
  buf.writeUInt8(0x01, 24)
  buf.writeUInt8(0x2a, 25)
  buf.writeUInt16LE(width & 0x3fff, 26)
  buf.writeUInt16LE(height & 0x3fff, 28)
  return buf
}

function makeVp8l(width: number, height: number, bytes = 25): Buffer {
  const buf = Buffer.alloc(bytes)
  buf.write('RIFF', 0, 'ascii')
  buf.write('WEBP', 8, 'ascii')
  buf.write('VP8L', 12, 'ascii')
  buf.writeUInt8(0x2f, 20)
  const packed = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14)
  buf.writeUInt32LE(packed >>> 0, 21)
  return buf
}

function copyExamplePackWithSticker(stickerBytes: Buffer, stickerFile = 'wave.webp'): string {
  const dir = join(tmpDir(), 'example')
  cpSync('characters/example', dir, { recursive: true })
  mkdirSync(join(dir, 'stickers'))
  writeFileSync(join(dir, 'stickers', stickerFile), stickerBytes)
  const moodsPath = join(dir, 'moods.yml')
  writeFileSync(
    moodsPath,
    readFileSync(moodsPath, 'utf8').replace('    stickers: []', `    stickers:\n      - ${stickerFile}`)
  )
  return dir
}

describe('readWebpInfo', () => {
  it('reads dimensions from VP8X, VP8, and VP8L headers', () => {
    expect(readWebpInfo(makeVp8x(512, 512))).toEqual({ width: 512, height: 512, animated: false, bytes: 30 })
    expect(readWebpInfo(makeVp8(512, 256))).toEqual({ width: 512, height: 256, animated: false, bytes: 30 })
    expect(readWebpInfo(makeVp8l(320, 512))).toEqual({ width: 320, height: 512, animated: false, bytes: 25 })
  })

  it('detects animated VP8X images', () => {
    expect(readWebpInfo(makeVp8x(512, 512, { animated: true, bytes: 128 }))).toEqual({
      width: 512,
      height: 512,
      animated: true,
      bytes: 128
    })
  })

  it('returns undefined for truncated or non-WebP data', () => {
    expect(readWebpInfo(makeVp8x(512, 512).subarray(0, 29))).toBeUndefined()
    expect(readWebpInfo(makeVp8l(512, 512).subarray(0, 24))).toBeUndefined()
    expect(readWebpInfo(Buffer.from('not a webp image at all'))).toBeUndefined()
  })
})

describe('stickerFault', () => {
  it('accepts a 512 by 512 still sticker within 100,000 bytes', () => {
    expect(stickerFault(readWebpInfo(makeVp8x(512, 512, { bytes: 100_000 })))).toBeUndefined()
  })

  it('rejects undefined info, wrong dimensions, and oversized still stickers', () => {
    expect(stickerFault(undefined)).toBe('not a WebP image')
    expect(stickerFault(readWebpInfo(makeVp8(256, 512)))).toBe('is 256 by 512 pixels, not 512 by 512')
    expect(stickerFault(readWebpInfo(makeVp8x(512, 512, { bytes: 100_001 })))).toBe(
      'is 100001 bytes, over the limit of 100000'
    )
  })

  it('allows animated stickers up to 500,000 bytes and rejects larger ones', () => {
    expect(stickerFault(readWebpInfo(makeVp8x(512, 512, { animated: true, bytes: 500_000 })))).toBeUndefined()
    expect(stickerFault(readWebpInfo(makeVp8x(512, 512, { animated: true, bytes: 500_001 })))).toBe(
      'is 500001 bytes, over the limit of 500000'
    )
  })
})

describe('loadPack sticker validation', () => {
  it('loads a pack when its named sticker is a valid 512 by 512 WebP', () => {
    const dir = copyExamplePackWithSticker(makeVp8x(512, 512))
    const pack = loadPack(dir, 'data')
    expect(pack.moods.get('neutral')?.stickers).toEqual(['wave.webp'])
  })

  it('rejects a wrong-size or non-WebP sticker and names the mood and file', () => {
    const wrongSizeDir = copyExamplePackWithSticker(makeVp8(200, 200), 'small.webp')
    expect(() => loadPack(wrongSizeDir, 'data')).toThrow(PackError)
    try {
      loadPack(wrongSizeDir, 'data')
    } catch (error) {
      expect((error as Error).message).toContain('moods.yml: moods.neutral.stickers: sticker "small.webp"')
    }

    const badBytesDir = copyExamplePackWithSticker(Buffer.from('not-webp'), 'broken.webp')
    expect(() => loadPack(badBytesDir, 'data')).toThrow(PackError)
    try {
      loadPack(badBytesDir, 'data')
    } catch (error) {
      expect((error as Error).message).toContain('moods.yml: moods.neutral.stickers: sticker "broken.webp"')
    }
  })
})

describe('pickSticker', () => {
  it('returns undefined when the mood has no stickers and repeats when there is only one', () => {
    expect(pickSticker({ stickers: [], random: () => 0 })).toBeUndefined()
    expect(pickSticker({ stickers: ['only.webp'], last: 'only.webp', random: () => 0.5 })).toBe('only.webp')
  })

  it('never picks the last sticker when another sticker exists', () => {
    const stickers = ['one.webp', 'two.webp']
    for (let i = 0; i < 50; i++) {
      const r = i / 50
      expect(pickSticker({ stickers, last: 'one.webp', random: () => r })).toBe('two.webp')
      expect(pickSticker({ stickers, last: 'two.webp', random: () => r })).toBe('one.webp')
    }
  })
})

describe('withStickers', () => {
  function makePack(overrides: Partial<Pack> = {}, stickers = ['a.webp', 'b.webp']): Pack {
    const base = loadPack('characters/example', 'repository')
    const moods = new Map(base.moods)
    const neutral = moods.get('neutral')
    if (neutral) {
      moods.set('neutral', { ...neutral, stickers })
    }
    return { ...base, source: 'data', moods, ...overrides }
  }

  function makeInput(options: { pack?: Pack; chatId?: string; mood?: string; expressions?: boolean }) {
    const pack = options.pack ?? makePack()
    const settings: TurnContext['settings'] =
      options.expressions === undefined ? {} : { expressions: { value: options.expressions, level: 'chat' } }
    return {
      text: 'raw',
      context: {
        turnId: 't_1',
        chat: {
          chatId: options.chatId ?? 'c_1',
          waId: 'fake-chat-1',
          type: 'dm' as const,
          label: '',
          status: 'active' as const
        },
        senderId: 's_1',
        character: pack,
        settings,
        kind: 'reply' as const,
        delivery: { kind: 'reply' as const },
        deadline: Date.now() + 10_000
      },
      built: {
        system: [],
        messages: [],
        record: {
          mood: options.mood ?? 'neutral',
          moodSource: 'default' as const,
          shapeSeed: 1
        }
      },
      run: {
        text: 'raw',
        usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
        costUsd: 0,
        model: 'm',
        role: 'r',
        transport: 't',
        calls: [],
        receipts: []
      }
    }
  }

  function fakeCleaner(reply: CleanedReply): ReplyCleaner {
    return { clean: () => reply }
  }

  it('appends the sticker MEDIA line last, sets stickerId and attachments, and avoids repeating in one chat', () => {
    const storage = tmpStorage()
    const cleaner = withStickers(
      fakeCleaner({
        content: 'hello\nMEDIA:/srv/data/other.png',
        bubbleCount: 1,
        steps: [],
        attachments: ['/srv/data/other.png']
      }),
      { storage, hostDataDir: '/srv/data', random: () => 0 }
    )

    const first = cleaner.clean(makeInput({}))
    const expectedFirstPath = '/srv/data/characters/example/stickers/a.webp'
    expect(first.content).toBe(`hello\nMEDIA:/srv/data/other.png\nMEDIA:${expectedFirstPath}`)
    expect(first.content.split('\n').at(-1)).toBe(`MEDIA:${expectedFirstPath}`)
    expect(first.stickerId).toBe('a.webp')
    expect(first.attachments).toEqual(['/srv/data/other.png', expectedFirstPath])

    const second = cleaner.clean(makeInput({}))
    const expectedSecondPath = '/srv/data/characters/example/stickers/b.webp'
    expect(second.stickerId).toBe('b.webp')
    expect(second.content.split('\n').at(-1)).toBe(`MEDIA:${expectedSecondPath}`)
  })

  it('skips stickers when expressions are off, reply was replaced, pack is from repository, mood has none, or content is empty', () => {
    const storage = tmpStorage()
    const normalReply: CleanedReply = { content: 'hello', bubbleCount: 1, steps: [] }

    const off = withStickers(fakeCleaner(normalReply), { storage, hostDataDir: '/srv/data', random: () => 0 }).clean(
      makeInput({ expressions: false })
    )
    expect(off).toEqual(normalReply)

    const replacedReply: CleanedReply = {
      content: 'fallback line',
      bubbleCount: 1,
      steps: ['leak'],
      replacedBy: 'fallback'
    }
    const replaced = withStickers(fakeCleaner(replacedReply), {
      storage,
      hostDataDir: '/srv/data',
      random: () => 0
    }).clean(makeInput({}))
    expect(replaced).toEqual(replacedReply)

    const repo = withStickers(fakeCleaner(normalReply), { storage, hostDataDir: '/srv/data', random: () => 0 }).clean(
      makeInput({ pack: makePack({ source: 'repository' }) })
    )
    expect(repo).toEqual(normalReply)

    const noStickers = withStickers(fakeCleaner(normalReply), {
      storage,
      hostDataDir: '/srv/data',
      random: () => 0
    }).clean(makeInput({ pack: makePack({}, []) }))
    expect(noStickers).toEqual(normalReply)

    const emptyReply: CleanedReply = { content: '', bubbleCount: 0, steps: [] }
    const empty = withStickers(fakeCleaner(emptyReply), { storage, hostDataDir: '/srv/data', random: () => 0 }).clean(
      makeInput({})
    )
    expect(empty).toEqual(emptyReply)
  })

  it('isolates lastSticker state per chat and per character', () => {
    const storage = tmpStorage()
    const cleaner = withStickers(fakeCleaner({ content: 'hello', bubbleCount: 1, steps: [] }), {
      storage,
      hostDataDir: '/srv/data',
      random: () => 0
    })

    const chatOne = cleaner.clean(makeInput({ chatId: 'c_one' }))
    expect(chatOne.stickerId).toBe('a.webp')

    const chatTwo = cleaner.clean(makeInput({ chatId: 'c_two' }))
    expect(chatTwo.stickerId).toBe('a.webp')

    const otherChar = cleaner.clean(makeInput({ chatId: 'c_one', pack: makePack({ id: 'other' }) }))
    expect(otherChar.stickerId).toBe('a.webp')
  })
})

describe('loadPack face groups and beats', () => {
  const withMoods = (edit: (moods: string) => string): string => {
    const dir = join(tmpDir(), 'example')
    cpSync('characters/example', dir, { recursive: true })
    const moodsPath = join(dir, 'moods.yml')
    writeFileSync(moodsPath, edit(readFileSync(moodsPath, 'utf8')))
    return dir
  }
  const header = 'faceGroups:\n  happy: ["(≧▽≦)", "(＾▽＾)"]\nbeats:\n  - name: drama\n    line: "- Overreact once."\n'

  it('adds a mood face groups to its faces, without repeats, and attaches its beats with their odds', () => {
    const dir = withMoods(
      (moods) =>
        header +
        moods.replace('    stickers: []', '    faceGroups: [happy]\n    beats: { drama: 0.25 }\n    stickers: []')
    )
    const mood = loadPack(dir, 'data').moods.get('neutral')!
    expect(mood.faces).toEqual(expect.arrayContaining(['(≧▽≦)', '(＾▽＾)']))
    expect(new Set(mood.faces).size).toBe(mood.faces.length)
    expect(mood.beats).toEqual([{ name: 'drama', line: '- Overreact once.', odds: 0.25 }])
  })

  it('refuses an unknown face group, an unknown beat and a bracketed word as a face', () => {
    const dir = withMoods(
      (moods) =>
        header + moods.replace('    stickers: []', '    faceGroups: [sad]\n    beats: { flirt: 0.5 }\n    stickers: []')
    )
    expect(() => loadPack(dir, 'data')).toThrow(/unknown face group "sad"[\s\S]*unknown beat "flirt"/)
    const bad = withMoods((moods) => moods.replace(/faces: \[[^\]]*\]/, 'faces: ["(hello)"]'))
    expect(() => loadPack(bad, 'data')).toThrow(PackError)
  })
})
