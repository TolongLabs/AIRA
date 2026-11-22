import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { posix } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { Attachment } from '../gateway/request.js'
import { type MediaFile, type MediaKind, mediaKindOf } from './limits.js'

// Finds the file a gateway note names, and reads it (docs/trd/models.md#media-watching).
// A note is text, and a member's message could imitate one, so the core opens a path only when it lies under one of
// the gateway's media folders, which the container mounts read-only.

/** One gateway media folder: the path the gateway writes in its notes, and where this process mounts it. */
export interface GatewayDir {
  host: string
  container: string
}

/** Why loading a file failed. */
export type LoadFault = 'refused' | 'missing' | 'unsupported type' | 'too large' | 'unreadable'

/** Why a file or link was not read. `off` and the limit faults come from the intake code. */
export type MediaUnreadable = LoadFault | 'off' | 'empty file' | 'too long' | 'unavailable' | 'link'

const EXTENSION_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.3gp': 'video/3gpp',
  '.pdf': 'application/pdf'
}

/** The MIME type from the file's extension, or undefined. An `.mp4` the gateway filed as audio is audio. */
export function contentTypeOf(path: string, attachmentKind?: Attachment['kind']): string | undefined {
  const type = EXTENSION_TYPES[posix.extname(path).toLowerCase()]
  if (type === 'video/mp4' && (attachmentKind === 'audio' || attachmentKind === 'voice')) return 'audio/mp4'
  return type
}

export type MappedPath = { ok: true; containerPath: string; dir: GatewayDir } | { ok: false }

function trimmed(path: string): string {
  const normal = posix.normalize(path)
  return normal.length > 1 ? normal.replace(/\/+$/, '') : normal
}

/**
 * Maps a host path to the path under the paired container folder. Pure: it resolves `..` in the text and nothing
 * else. A path that is not absolute, holds a NUL, or lies outside every `host` folder is refused.
 */
export function mapGatewayPath(hostPath: string, dirs: readonly GatewayDir[]): MappedPath {
  if (!posix.isAbsolute(hostPath) || hostPath.includes('\0')) return { ok: false }
  const path = trimmed(hostPath)
  // The longest folder wins, so a folder nested in another keeps its own mount.
  const ordered = [...dirs].sort((a, b) => trimmed(b.host).length - trimmed(a.host).length)
  for (const dir of ordered) {
    const root = trimmed(dir.host)
    if (path === root || !path.startsWith(`${root}/`)) continue
    return { ok: true, containerPath: posix.join(trimmed(dir.container), path.slice(root.length)), dir }
  }
  return { ok: false }
}

export type LoadedFile = { ok: true; file: MediaFile; kind: MediaKind } | { ok: false; reason: LoadFault }

/**
 * Reads the file an attachment names. Never throws. The path is mapped, then resolved through every symlink in the
 * container, and must still lie under the paired folder. The type comes from the extension and the size is checked
 * before the file is read into memory.
 */
export async function loadGatewayFile(
  attachment: Attachment,
  dirs: readonly GatewayDir[],
  maxBytes: number,
  timeoutMs?: number
): Promise<LoadedFile> {
  if (timeoutMs === undefined) return readGatewayFile(attachment, dirs, maxBytes)
  const timedOut = { ok: false, reason: 'unreadable' } as const
  if (timeoutMs <= 0) return timedOut
  const controller = new AbortController()
  try {
    return await Promise.race([
      readGatewayFile(attachment, dirs, maxBytes, controller.signal),
      delay(timeoutMs, timedOut, { signal: controller.signal })
    ])
  } finally {
    controller.abort()
  }
}

async function readGatewayFile(
  attachment: Attachment,
  dirs: readonly GatewayDir[],
  maxBytes: number,
  signal?: AbortSignal
): Promise<LoadedFile> {
  const mapped = mapGatewayPath(attachment.path, dirs)
  if (!mapped.ok) return { ok: false, reason: 'refused' }
  const contentType = contentTypeOf(mapped.containerPath, attachment.kind)
  const kind = contentType === undefined ? undefined : mediaKindOf(contentType)
  if (contentType === undefined || kind === undefined) return { ok: false, reason: 'unsupported type' }

  let real: string
  let root: string
  try {
    ;[real, root] = await Promise.all([realpath(mapped.containerPath), realpath(trimmed(mapped.dir.container))])
  } catch (error) {
    return { ok: false, reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable' }
  }
  if (!real.startsWith(root === '/' ? '/' : `${root}/`)) return { ok: false, reason: 'refused' }

  try {
    signal?.throwIfAborted()
    const handle = await open(real, constants.O_RDONLY | constants.O_NONBLOCK)
    try {
      signal?.throwIfAborted()
      const info = await handle.stat()
      if (!info.isFile()) return { ok: false, reason: 'refused' }
      if (info.size > maxBytes) return { ok: false, reason: 'too large' }
      return { ok: true, kind, file: { data: await handle.readFile({ signal }), contentType } }
    } finally {
      await handle.close()
    }
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
}
