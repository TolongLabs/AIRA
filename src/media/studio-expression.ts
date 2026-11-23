import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { readWebpInfo } from '../character/webp.js'

// Bounded static expression converter for the character studio (issue #368).
// Takes one uploaded image and returns a validated WhatsApp static sticker:
// exactly 512 by 512 pixels, at most 100 * 1024 bytes. That byte limit is the
// one WhatsApp's official StickerPackValidator applies to static stickers.
// This module never publishes to packs: the orchestrator owns concurrency,
// capacity and where the result is stored.
//
// Only JPEG, PNG and static WebP are accepted, by MIME type and by file
// signature, with the actual decoder (ffprobe/ffmpeg) as the final word.
// SVG and other markup, GIF and other active or animated data, multi-frame
// images, input over 4 MiB, pixel dimensions over 4096 on a side or over
// 16 megapixels, and malformed or truncated data are all refused with a typed
// reason. Decoding runs only through the fixed ffmpeg/ffprobe binaries below,
// with a fixed argument list, a timeout, output caps and a temporary working
// directory: no network, no format probing beyond still images, and only the
// first frame is ever decoded. The picture is scaled proportionally to fit
// inside 512 by 512, padded transparent to exactly that size, stripped of
// metadata, and verified as one static WebP frame within the byte limit.

/** Largest accepted input: 4 MiB. Anything bigger is refused before decoding. */
export const STUDIO_MAX_INPUT_BYTES = 4 * 1024 * 1024
/** Largest accepted side: 4096 pixels. Anything bigger is refused before decoding. */
export const STUDIO_MAX_DIMENSION = 4096
/** Largest accepted area: 16 megapixels. Anything bigger is refused before decoding. */
export const STUDIO_MAX_PIXELS = 16_000_000
/** Sticker edge: WhatsApp requires exactly 512 by 512 pixels. */
export const STUDIO_OUTPUT_SIZE = 512
/** Sticker byte limit: WhatsApp's StickerPackValidator allows 100 * 1024 bytes for static stickers. */
export const STUDIO_OUTPUT_LIMIT_BYTES = 100 * 1024

/** Why an expression image was not converted. */
export type StudioExpressionReason =
  | 'unsupported_type'
  | 'too_large'
  | 'dimensions_exceeded'
  | 'invalid_image'
  | 'animated'
  | 'busy'
  | 'aborted'
  | 'timeout'
  | 'output_too_large'
  | 'conversion_failed'

export interface StudioExpressionOk {
  ok: true
  /** Validated static WebP: 512 by 512 pixels, within the byte limit. */
  data: Buffer
}

export interface StudioExpressionFail {
  ok: false
  reason: StudioExpressionReason
}

export type StudioExpressionResult = StudioExpressionOk | StudioExpressionFail

const CONVERT_TIMEOUT_MS = 10_000
/** Decoder processes running at once. Over this cap the call is refused with `busy`. */
const MAX_CONCURRENT_DECODERS = 2
/** Scale proportionally inside 512 by 512, then pad transparent to exactly that size. */
const SCALE_PAD_FILTER =
  'scale=512:512:force_original_aspect_ratio=decrease:flags=lanczos,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000'

let runningDecoders = 0
const run = promisify(execFile)

type DecodedKind = 'jpeg' | 'png' | 'webp'

const MIME_KINDS: Record<string, DecodedKind> = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp'
}

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff])
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function normalizeMime(mime: string): string {
  const raw = mime.split(';', 1)[0] ?? ''
  const value = raw.trim().toLowerCase()
  return value === 'image/jpg' ? 'image/jpeg' : value
}

function kindOf(bytes: Buffer): DecodedKind | undefined {
  if (bytes.length >= 3 && bytes.subarray(0, 3).equals(JPEG_MAGIC)) return 'jpeg'
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_MAGIC)) return 'png'
  if (
    bytes.length >= 12 &&
    bytes.toString('latin1', 0, 4) === 'RIFF' &&
    bytes.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'webp'
  }
  return undefined
}

/** Markup or text smuggled under an image MIME type is never decoded. */
function isSvgOrMarkup(bytes: Buffer): boolean {
  const head = bytes.subarray(0, 1024).toString('latin1').trimStart().toLowerCase()
  if (head.startsWith('<svg') || head.startsWith('<html') || head.startsWith('<!doctype html')) return true
  return head.startsWith('<?xml') && head.includes('<svg')
}

function isGif(bytes: Buffer): boolean {
  if (bytes.length < 6) return false
  const magic = bytes.toString('latin1', 0, 6)
  return magic === 'GIF87a' || magic === 'GIF89a'
}

/** An APNG carries an `acTL` chunk before its first `IDAT` chunk. */
function isAnimatedPng(bytes: Buffer): boolean {
  let offset = 8
  for (let chunks = 0; chunks < 64 && offset + 8 <= bytes.length; chunks++) {
    const length = bytes.readUInt32BE(offset)
    if (!Number.isSafeInteger(length) || length > bytes.length) return false
    const type = bytes.toString('latin1', offset + 4, offset + 8)
    if (type === 'acTL') return true
    if (type === 'IDAT' || type === 'IEND') return false
    offset += 12 + length
  }
  return false
}

function readPngDimensions(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.length < 24) return undefined
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width === 0 || height === 0) {
    return undefined
  }
  return { width, height }
}

/** Reads the frame size from JPEG headers. Undefined when no SOF marker is found, as in truncated data. */
function readJpegDimensions(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined
  let offset = 2
  for (let markers = 0; markers < 64 && offset + 4 <= bytes.length; markers++) {
    if (bytes[offset] !== 0xff) return undefined
    const marker = bytes[offset + 1]
    if (marker === undefined) return undefined
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2
      continue
    }
    const length = bytes.readUInt16BE(offset + 2)
    if (length < 2 || offset + 2 + length > bytes.length) return undefined
    if (marker >= 0xc0 && marker <= 0xc3) {
      if (length < 7) return undefined
      const height = bytes.readUInt16BE(offset + 5)
      const width = bytes.readUInt16BE(offset + 7)
      if (width === 0 || height === 0) return undefined
      return { width, height }
    }
    if (marker === 0xda || marker === 0xd9) return undefined
    offset += 2 + length
  }
  return undefined
}

function exceedsPixelLimits(width: number, height: number): boolean {
  return (
    width > STUDIO_MAX_DIMENSION || height > STUDIO_MAX_DIMENSION || width * height > STUDIO_MAX_PIXELS
  )
}

function probeDimensions(value: unknown): { width: number; height: number; frames: number } | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const streams = (value as { streams?: unknown }).streams
  if (!Array.isArray(streams) || streams.length === 0) return undefined
  const first = streams[0]
  if (typeof first !== 'object' || first === null) return undefined
  const stream = first as { width?: unknown; height?: unknown; nb_frames?: unknown }
  if (typeof stream.width !== 'number' || typeof stream.height !== 'number') return undefined
  if (!Number.isFinite(stream.width) || !Number.isFinite(stream.height)) return undefined
  const frames = stream.nb_frames === undefined ? 1 : Number(stream.nb_frames)
  return {
    width: Math.floor(stream.width),
    height: Math.floor(stream.height),
    frames: Number.isFinite(frames) ? frames : 1
  }
}

/**
 * Converts one image to a validated static sticker WebP. Never throws: every
 * refusal, including an aborted caller and a busy decoder pool, is a typed
 * `fail` result. The caller owns retries, capacity and publishing to packs.
 */
export async function convertExpression(
  bytes: Buffer,
  mime: string,
  callerSignal?: AbortSignal
): Promise<StudioExpressionResult> {
  if (callerSignal?.aborted) return { ok: false, reason: 'aborted' }

  const expected = MIME_KINDS[normalizeMime(mime)]
  if (expected === undefined) return { ok: false, reason: 'unsupported_type' }

  if (bytes.length === 0) return { ok: false, reason: 'invalid_image' }
  if (bytes.length > STUDIO_MAX_INPUT_BYTES) return { ok: false, reason: 'too_large' }

  if (isSvgOrMarkup(bytes) || isGif(bytes)) return { ok: false, reason: 'unsupported_type' }

  const kind = kindOf(bytes)
  if (kind === undefined || kind !== expected) return { ok: false, reason: 'invalid_image' }

  if (kind === 'webp') {
    const info = readWebpInfo(bytes)
    if (info === undefined) return { ok: false, reason: 'invalid_image' }
    if (info.animated) return { ok: false, reason: 'animated' }
    if (exceedsPixelLimits(info.width, info.height)) return { ok: false, reason: 'dimensions_exceeded' }
  } else if (kind === 'png') {
    if (isAnimatedPng(bytes)) return { ok: false, reason: 'animated' }
    const size = readPngDimensions(bytes)
    if (size !== undefined && exceedsPixelLimits(size.width, size.height)) {
      return { ok: false, reason: 'dimensions_exceeded' }
    }
  } else {
    const size = readJpegDimensions(bytes)
    if (size !== undefined && exceedsPixelLimits(size.width, size.height)) {
      return { ok: false, reason: 'dimensions_exceeded' }
    }
  }

  if (runningDecoders >= MAX_CONCURRENT_DECODERS) return { ok: false, reason: 'busy' }
  runningDecoders++
  try {
    const signal =
      callerSignal === undefined
        ? AbortSignal.timeout(CONVERT_TIMEOUT_MS)
        : AbortSignal.any([callerSignal, AbortSignal.timeout(CONVERT_TIMEOUT_MS)])
    const interrupted = (): StudioExpressionReason | undefined => {
      if (callerSignal?.aborted) return 'aborted'
      if (signal.aborted) return 'timeout'
      return undefined
    }

    const root = await mkdtemp(join(tmpdir(), 'aira-expression-')).catch(() => undefined)
    if (root === undefined) return { ok: false, reason: interrupted() ?? 'conversion_failed' }
    try {
      const input = join(root, 'input')
      const output = join(root, 'output.webp')
      try {
        await writeFile(input, bytes, { signal })
      } catch {
        return { ok: false, reason: interrupted() ?? 'conversion_failed' }
      }

      let probeOut: string
      try {
        const probe = await run(
          'ffprobe',
          [
            '-v',
            'error',
            '-protocol_whitelist',
            'file',
            '-select_streams',
            'v:0',
            '-show_entries',
            'stream=width,height,nb_frames',
            '-of',
            'json',
            input
          ],
          { signal, killSignal: 'SIGKILL', maxBuffer: 64_000 }
        )
        probeOut = probe.stdout
      } catch {
        return { ok: false, reason: interrupted() ?? 'invalid_image' }
      }

      let dimensions: { width: number; height: number; frames: number } | undefined
      try {
        dimensions = probeDimensions(JSON.parse(probeOut) as unknown)
      } catch {
        return { ok: false, reason: 'invalid_image' }
      }
      if (dimensions === undefined || dimensions.width <= 0 || dimensions.height <= 0) {
        return { ok: false, reason: 'invalid_image' }
      }
      if (dimensions.frames > 1) return { ok: false, reason: 'animated' }
      if (exceedsPixelLimits(dimensions.width, dimensions.height)) {
        return { ok: false, reason: 'dimensions_exceeded' }
      }

      try {
        await run(
          'ffmpeg',
          [
            '-nostdin',
            '-v',
            'error',
            '-xerror',
            '-protocol_whitelist',
            'file',
            '-i',
            input,
            '-frames:v',
            '1',
            '-vf',
            SCALE_PAD_FILTER,
            '-map_metadata',
            '-1',
            '-map_chapters',
            '-1',
            '-c:v',
            'libwebp',
            '-quality',
            '80',
            '-fs',
            String(STUDIO_OUTPUT_LIMIT_BYTES + 1),
            output
          ],
          { signal, killSignal: 'SIGKILL', maxBuffer: 64_000 }
        )
      } catch {
        return { ok: false, reason: interrupted() ?? 'conversion_failed' }
      }

      let result: Buffer
      try {
        result = await readFile(output, { signal })
      } catch {
        return { ok: false, reason: interrupted() ?? 'conversion_failed' }
      }
      if (result.length > STUDIO_OUTPUT_LIMIT_BYTES) return { ok: false, reason: 'output_too_large' }
      const info = readWebpInfo(result)
      if (
        info === undefined ||
        info.width !== STUDIO_OUTPUT_SIZE ||
        info.height !== STUDIO_OUTPUT_SIZE ||
        info.animated
      ) {
        return { ok: false, reason: 'conversion_failed' }
      }
      return { ok: true, data: result }
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => undefined)
    }
  } finally {
    runningDecoders--
  }
}
