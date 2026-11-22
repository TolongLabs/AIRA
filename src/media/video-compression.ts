import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

export const COMPRESSION_MAX_INPUT_BYTES = 48_000_000
export const COMPRESSION_MAX_SECONDS = 300
const COMPRESSION_TIMEOUT_MS = 12_000

export type CompressVideo = (
  data: Buffer,
  maxBytes: number,
  maxSeconds: number,
  signal: AbortSignal
) => Promise<Buffer | undefined>

const run = promisify(execFile)

export function isMp4(data: Buffer): boolean {
  return data.length >= 16 && data.toString('latin1', 4, 8) === 'ftyp'
}

async function probe(path: string, signal: AbortSignal) {
  const { stdout } = await run(
    'ffprobe',
    [
      '-v',
      'error',
      '-protocol_whitelist',
      'file',
      '-f',
      'mov',
      '-show_entries',
      'format=duration:stream=codec_type,width,height:stream_disposition=attached_pic',
      '-of',
      'json',
      path
    ],
    { signal, killSignal: 'SIGKILL', maxBuffer: 64_000 }
  )
  const info = JSON.parse(stdout) as {
    format?: { duration?: string }
    streams?: {
      codec_type: string
      width?: number
      height?: number
      disposition?: { attached_pic?: number }
    }[]
  }
  const video = info.streams?.find((stream) => stream.codec_type === 'video' && !stream.disposition?.attached_pic)
  return {
    duration: Number(info.format?.duration),
    pixels: (video?.width ?? 0) * (video?.height ?? 0),
    audio: info.streams?.some((stream) => stream.codec_type === 'audio') ?? false
  }
}

/** Seconds the MP4 plays, or undefined when ffprobe cannot establish a finite positive length. */
export type ProbeVideoDuration = (data: Buffer, signal: AbortSignal) => Promise<number | undefined>

/** Duration probes running at once. A probe over this cap is refused, so its video is skipped as unknown duration. */
const PROBE_CONCURRENCY = 2
let runningProbes = 0

/**
 * Probes an MP4 held in memory for its duration only, through a temporary file removed before the call returns.
 * Refused without running ffprobe: an aborted caller, a non-MP4, an input over the compressor's cap, or a probe over
 * the concurrency cap. The probe shares the compressor's local deadline.
 */
export const probeVideoDuration: ProbeVideoDuration = async (data, callerSignal) => {
  if (
    callerSignal.aborted ||
    runningProbes >= PROBE_CONCURRENCY ||
    data.length > COMPRESSION_MAX_INPUT_BYTES ||
    !isMp4(data)
  )
    return undefined
  runningProbes++
  let root: string | undefined
  try {
    const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(COMPRESSION_TIMEOUT_MS)])
    root = await mkdtemp(join(tmpdir(), 'aira-probe-'))
    const input = join(root, 'input.mp4')
    await writeFile(input, data, { signal })
    const { duration, pixels } = await probe(input, signal)
    return pixels > 0 && Number.isFinite(duration) && duration > 0 ? duration : undefined
  } catch {
    return undefined
  } finally {
    runningProbes--
    if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** One bounded, local transcode at a time across intake and group autofetch. */
export function createVideoCompressor(): CompressVideo {
  let busy = false
  return async (data, maxBytes, maxSeconds, callerSignal) => {
    if (busy || callerSignal.aborted || data.length > COMPRESSION_MAX_INPUT_BYTES || !isMp4(data)) return
    busy = true
    let root: string | undefined
    try {
      const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(COMPRESSION_TIMEOUT_MS)])
      root = await mkdtemp(join(tmpdir(), 'aira-video-'))
      const input = join(root, 'input.mp4')
      const output = join(root, 'output.mp4')
      await writeFile(input, data, { signal })
      const source = await probe(input, signal)
      const limit = Math.min(maxSeconds, COMPRESSION_MAX_SECONDS)
      if (!(source.duration > 0 && source.duration <= limit && source.pixels > 0 && source.pixels <= 8_294_400)) return

      const audioRate = source.audio ? 96_000 : 0
      const videoRate = Math.floor((maxBytes * 8 * 0.9) / source.duration) - audioRate
      if (videoRate < 80_000) return
      await run(
        'ffmpeg',
        [
          '-nostdin',
          '-v',
          'error',
          '-xerror',
          '-protocol_whitelist',
          'file',
          '-f',
          'mov',
          '-threads',
          '4',
          '-i',
          input,
          '-map',
          '0:V:0',
          '-map',
          '0:a:0?',
          '-map_metadata',
          '-1',
          '-map_chapters',
          '-1',
          '-filter_threads',
          '2',
          '-vf',
          "scale=w='min(960,iw)':h='min(540,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2:flags=fast_bilinear,fps='if(gt(source_fps,0),min(source_fps,24),24)'",
          '-c:v',
          'libx264',
          '-preset',
          'ultrafast',
          '-pix_fmt',
          'yuv420p',
          '-threads',
          '3',
          '-b:v',
          String(videoRate),
          '-maxrate',
          String(videoRate),
          '-bufsize',
          String(videoRate),
          '-c:a',
          'aac',
          '-b:a',
          '96k',
          '-movflags',
          '+faststart',
          '-t',
          String(limit + 0.1),
          '-fs',
          String(maxBytes + 1),
          output
        ],
        { signal, killSignal: 'SIGKILL', maxBuffer: 64_000 }
      )
      if ((await stat(output)).size > maxBytes) return
      const result = await probe(output, signal)
      if (!result.pixels || result.audio !== source.audio || !(Math.abs(result.duration - source.duration) <= 0.25))
        return
      const bytes = await readFile(output, { signal })
      if (!signal.aborted && isMp4(bytes)) return bytes
    } catch {
      return undefined
    } finally {
      if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined)
      busy = false
    }
  }
}
