export type MediaKind = 'image' | 'audio' | 'video' | 'document'

export interface MediaFile {
  data: Buffer
  /** A MIME type such as image/jpeg. */
  contentType: string
  /** Seconds, when the sender's app reported it. */
  durationSeconds?: number
}

export interface MediaLimits {
  maxBytes: number
  maxVideoSeconds: number
  maxAudioSeconds: number
}

export const DEFAULT_MEDIA_LIMITS: Omit<MediaLimits, 'maxVideoSeconds'> = {
  maxBytes: 20_000_000,
  maxAudioSeconds: 600
}

const MIME_KINDS: Record<string, MediaKind> = {
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/webp': 'image',
  'image/gif': 'image',
  'image/heic': 'image',
  'audio/ogg': 'audio',
  'audio/mpeg': 'audio',
  'audio/mp4': 'audio',
  'audio/aac': 'audio',
  'audio/wav': 'audio',
  'audio/x-wav': 'audio',
  'audio/opus': 'audio',
  'video/mp4': 'video',
  'video/quicktime': 'video',
  'video/webm': 'video',
  'video/3gpp': 'video',
  'application/pdf': 'document'
}

export function mediaKindOf(contentType: string): MediaKind | undefined {
  const mime = (contentType.split(';', 1)[0] ?? '').trim().toLowerCase()
  return MIME_KINDS[mime]
}

/** The reason a file is not read, or undefined when it may be read. */
export function mediaFault(file: MediaFile, limits: MediaLimits): string | undefined {
  const kind = mediaKindOf(file.contentType)
  if (kind === undefined) return 'unsupported type'
  if (file.data.byteLength === 0) return 'empty file'
  if (file.data.byteLength > limits.maxBytes) return 'too large'
  if (file.durationSeconds !== undefined) {
    if (kind === 'video' && file.durationSeconds > limits.maxVideoSeconds) return 'too long'
    if (kind === 'audio' && file.durationSeconds > limits.maxAudioSeconds) return 'too long'
  }
  return undefined
}
