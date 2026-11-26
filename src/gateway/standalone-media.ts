import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { PortableAttachment } from './request.js'

// The direct-media wire boundary (docs/trd/media-pipelines.md#standalone-direct-media).
export const MAX_MEDIA_BYTES = 5 * 1024 * 1024
const MAX_BASE64 = 4 * Math.ceil(MAX_MEDIA_BYTES / 3)
export const MAX_MEDIA_BODY = MAX_BASE64 + 256 * 1024

export const directMediaSchema = z.strictObject({
  kind: z.enum(['image', 'audio', 'voice', 'video', 'document']),
  mime: z.enum(['image/png', 'image/jpeg', 'audio/ogg', 'audio/mpeg', 'video/mp4', 'application/pdf']),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  base64: z.string().min(1).max(MAX_BASE64)
})
type DirectMedia = z.infer<typeof directMediaSchema>

const prefix = (bytes: Buffer, signature: Buffer): boolean => bytes.subarray(0, signature.length).equals(signature)

function matchesMedia({ kind, mime }: DirectMedia, bytes: Buffer): boolean {
  switch (mime) {
    case 'image/png':
      return kind === 'image' && prefix(bytes, Buffer.from('89504e470d0a1a0a', 'hex'))
    case 'image/jpeg':
      return kind === 'image' && prefix(bytes, Buffer.from('ffd8ff', 'hex'))
    case 'audio/ogg':
      return (kind === 'voice' || kind === 'audio') && prefix(bytes, Buffer.from('OggS'))
    case 'audio/mpeg':
      return (
        (kind === 'voice' || kind === 'audio') &&
        (prefix(bytes, Buffer.from('ID3')) || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0))
      )
    case 'video/mp4':
      return kind === 'video' && bytes.length >= 12 && bytes.subarray(4, 8).equals(Buffer.from('ftyp'))
    case 'application/pdf':
      return kind === 'document' && prefix(bytes, Buffer.from('%PDF-'))
  }
}

export function decodeDirectMedia(media: DirectMedia): PortableAttachment | null {
  const data = Buffer.from(media.base64, 'base64')
  if (
    data.length === 0 ||
    data.length > MAX_MEDIA_BYTES ||
    data.toString('base64') !== media.base64 ||
    createHash('sha256').update(data).digest('hex') !== media.sha256 ||
    !matchesMedia(media, data)
  )
    return null
  return { kind: media.kind, file: { data, contentType: media.mime } }
}
