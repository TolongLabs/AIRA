export interface WebpInfo {
  width: number
  height: number
  animated: boolean
  bytes: number
}

const STILL_LIMIT_BYTES = 100_000
const ANIMATED_LIMIT_BYTES = 500_000
const STICKER_SIZE = 512

/** Reads the canvas size from a WebP file's header. Undefined when the bytes are not a WebP image. */
export function readWebpInfo(data: Buffer): WebpInfo | undefined {
  if (data.length < 20) return undefined
  if (data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WEBP') {
    return undefined
  }

  const chunk = data.toString('ascii', 12, 16)
  if (chunk === 'VP8X') {
    if (data.length < 30) return undefined
    const animated = (data.readUInt8(20) & 2) !== 0
    const width = data.readUIntLE(24, 3) + 1
    const height = data.readUIntLE(27, 3) + 1
    return { width, height, animated, bytes: data.length }
  }

  if (chunk === 'VP8 ') {
    if (data.length < 30) return undefined
    if (data.readUInt8(23) !== 0x9d || data.readUInt8(24) !== 0x01 || data.readUInt8(25) !== 0x2a) {
      return undefined
    }
    const width = data.readUInt16LE(26) & 0x3fff
    const height = data.readUInt16LE(28) & 0x3fff
    return { width, height, animated: false, bytes: data.length }
  }

  if (chunk === 'VP8L') {
    if (data.length < 25) return undefined
    if (data.readUInt8(20) !== 0x2f) return undefined
    const bits = data.readUInt32LE(21)
    const width = (bits & 0x3fff) + 1
    const height = ((bits >>> 14) & 0x3fff) + 1
    return { width, height, animated: false, bytes: data.length }
  }

  return undefined
}

/** WhatsApp's sticker limits: 512 by 512 pixels; at most 100,000 bytes still, 500,000 bytes animated. */
export function stickerFault(info: WebpInfo | undefined): string | undefined {
  if (!info) return 'not a WebP image'
  if (info.width !== STICKER_SIZE || info.height !== STICKER_SIZE) {
    return `is ${info.width} by ${info.height} pixels, not ${STICKER_SIZE} by ${STICKER_SIZE}`
  }
  const limit = info.animated ? ANIMATED_LIMIT_BYTES : STILL_LIMIT_BYTES
  if (info.bytes > limit) {
    return `is ${info.bytes} bytes, over the limit of ${limit}`
  }
  return undefined
}
