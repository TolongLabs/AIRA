import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { readWebpInfo, stickerFault } from '../../src/character/webp.js'

// Real encoded files, not hand-built headers (#12): a lossy 512 by 512 sticker passes, a 300 by 300 one is refused.
const fixture = (name: string) => readFileSync(new URL(`../fixtures/stickers/${name}`, import.meta.url))

describe('WebP sticker fixtures', () => {
  it('reads a real 512 by 512 sticker and accepts it', () => {
    const info = readWebpInfo(fixture('smile-512.webp'))
    expect(info).toMatchObject({ width: 512, height: 512 })
    expect(stickerFault(info)).toBeUndefined()
  })

  it('refuses a real sticker that is not 512 by 512', () => {
    const info = readWebpInfo(fixture('smile-300.webp'))
    expect(info).toMatchObject({ width: 300, height: 300 })
    expect(stickerFault(info)).toBeDefined()
  })
})
