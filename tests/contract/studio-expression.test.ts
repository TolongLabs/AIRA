import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { readWebpInfo } from '../../src/character/webp.js'
import {
  convertExpression, 
  STUDIO_OUTPUT_LIMIT_BYTES
} from '../../src/media/studio-expression.js'

// Contract tests for the bounded static expression converter (issue #368).
// Every fixture is synthetic and generated in this file: solid-colour PNGs
// built by hand, a JPEG rendered locally by ffmpeg's own test pattern, SVG
// and GIF byte patterns, and slices of those buffers. No real image or pack
// asset enters the tree.

const runTest = promisify(execFile)

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c % 2 === 0 ? c >>> 1 : 0xedb88320 ^ (c >>> 1)
  return c >>> 0
})

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typeBytes = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])))
  return Buffer.concat([length, typeBytes, data, crc])
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function ihdr(width: number, height: number, colorType: 0 | 6): Buffer {
  const data = Buffer.alloc(13)
  data.writeUInt32BE(width, 0)
  data.writeUInt32BE(height, 4)
  data[8] = 8
  data[9] = colorType
  return pngChunk('IHDR', data)
}

/** A solid-colour RGBA PNG generated locally: no real image data. */
function makePng(width: number, height: number, pixel: { r: number; g: number; b: number }): Buffer {
  const stride = width * 4 + 1
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const base = y * stride
    raw[base] = 0
    for (let x = 0; x < width; x++) {
      const at = base + 1 + x * 4
      raw[at] = pixel.r
      raw[at + 1] = pixel.g
      raw[at + 2] = pixel.b
      raw[at + 3] = 255
    }
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    ihdr(width, height, 6),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

/** A solid-grey PNG for the megapixel test: one byte per pixel keeps the raw buffer small. */
function makeGrayPng(width: number, height: number, value: number): Buffer {
  const stride = width + 1
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0
    raw.fill(value, y * stride + 1, (y + 1) * stride)
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    ihdr(width, height, 0),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

/** An animated PNG: the same solid picture with an `acTL` chunk before its image data. */
function makeApng(width: number, height: number): Buffer {
  const png = makePng(width, height, { r: 1, g: 2, b: 3 })
  const ihdrEnd = 8 + 4 + 4 + 13 + 4
  const actl = Buffer.alloc(8)
  actl.writeUInt32BE(2, 0)
  actl.writeUInt32BE(0, 4)
  return Buffer.concat([png.subarray(0, ihdrEnd), pngChunk('acTL', actl), png.subarray(ihdrEnd)])
}

/** A JPEG rendered locally from ffmpeg's synthetic test pattern: no real image data. */
async function makeJpeg(): Promise<Buffer> {
  const { stdout } = await runTest(
    'ffmpeg',
    [
      '-nostdin',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=64x64:rate=1:duration=1',
      '-frames:v',
      '1',
      '-c:v',
      'mjpeg',
      '-q:v',
      '2',
      '-f',
      'image2',
      'pipe:1'
    ],
    { encoding: 'buffer', maxBuffer: 8_000_000 }
  )
  return stdout as Buffer
}

describe('studio-expression', () => {
  it('converts a wide PNG to an exact 512x512 sticker within the byte limit', async () => {
    const result = await convertExpression(makePng(64, 32, { r: 200, g: 40, b: 40 }), 'image/png')
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected the PNG to convert')
    const info = readWebpInfo(result.data)
    expect(info?.width).toBe(512)
    expect(info?.height).toBe(512)
    expect(info?.animated).toBe(false)
    expect(result.data.length).toBeLessThanOrEqual(STUDIO_OUTPUT_LIMIT_BYTES)
    expect(result.data.subarray(0, 4).toString('ascii')).toBe('RIFF')
  })

  it('pads a tall PNG to 512x512', async () => {
    const result = await convertExpression(makePng(32, 64, { r: 40, g: 120, b: 200 }), 'image/png')
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected the PNG to convert')
    const info = readWebpInfo(result.data)
    expect(info?.width).toBe(512)
    expect(info?.height).toBe(512)
    expect(info?.animated).toBe(false)
  })

  it('converts a generated JPEG to a 512x512 sticker', async () => {
    const result = await convertExpression(await makeJpeg(), 'image/jpeg')
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected the JPEG to convert')
    const info = readWebpInfo(result.data)
    expect(info?.width).toBe(512)
    expect(info?.height).toBe(512)
    expect(result.data.length).toBeLessThanOrEqual(STUDIO_OUTPUT_LIMIT_BYTES)
  })

  it('converts a static WebP back to a 512x512 sticker', async () => {
    const first = await convertExpression(makePng(48, 48, { r: 60, g: 180, b: 60 }), 'image/png')
    expect(first.ok).toBe(true)
    if (!first.ok) throw new Error('expected the PNG to convert')
    const result = await convertExpression(first.data, 'image/webp')
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected the WebP to convert')
    const info = readWebpInfo(result.data)
    expect(info?.width).toBe(512)
    expect(info?.height).toBe(512)
    expect(info?.animated).toBe(false)
  })

  it('rejects SVG markup under an image MIME type', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"></svg>', 'utf8')
    expect(await convertExpression(svg, 'image/svg+xml')).toEqual({ ok: false, reason: 'unsupported_type' })
    expect(await convertExpression(svg, 'image/png')).toEqual({ ok: false, reason: 'unsupported_type' })
  })

  it('rejects GIF bytes', async () => {
    const gif = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.alloc(32)])
    expect(await convertExpression(gif, 'image/gif')).toEqual({ ok: false, reason: 'unsupported_type' })
    expect(await convertExpression(gif, 'image/png')).toEqual({ ok: false, reason: 'unsupported_type' })
  })

  it('rejects input over 4 MiB', async () => {
    const big = Buffer.alloc(4 * 1024 * 1024 + 1)
    PNG_SIGNATURE.copy(big, 0)
    expect(await convertExpression(big, 'image/png')).toEqual({ ok: false, reason: 'too_large' })
  })

  it('rejects a side over 4096 pixels', async () => {
    const result = await convertExpression(makePng(4100, 4, { r: 9, g: 9, b: 9 }), 'image/png')
    expect(result).toEqual({ ok: false, reason: 'dimensions_exceeded' })
  })

  it('rejects more than 16 megapixels within the side limit', async () => {
    const result = await convertExpression(makeGrayPng(4096, 3907, 128), 'image/png')
    expect(result).toEqual({ ok: false, reason: 'dimensions_exceeded' })
  })

  it('rejects truncated input the decoder cannot read', async () => {
    const truncated = makePng(16, 16, { r: 9, g: 9, b: 9 }).subarray(0, 40)
    expect(await convertExpression(truncated, 'image/png')).toEqual({ ok: false, reason: 'invalid_image' })
  })

  it('rejects an animated PNG', async () => {
    expect(await convertExpression(makeApng(16, 16), 'image/png')).toEqual({ ok: false, reason: 'animated' })
  })

  it('rejects a MIME type that does not match the bytes', async () => {
    const png = makePng(16, 16, { r: 9, g: 9, b: 9 })
    expect(await convertExpression(png, 'image/jpeg')).toEqual({ ok: false, reason: 'invalid_image' })
  })
})
