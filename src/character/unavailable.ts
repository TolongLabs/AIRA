import { join, posix } from 'node:path'
import { writeFileAtomic } from '../storage/files.js'
import { type Pack, PackError } from './loader.js'
import { PACK_ID, STICKER_FILE } from './schema.js'

/** Writes a pack's unavailable line where the gateway's failure helper reads it. Returns the file's path. */
export function writeUnavailableLine(dataDir: string, pack: Pack): string {
  const filePath = join(dataDir, 'gateway', 'unavailable.txt')
  writeFileAtomic(filePath, `${pack.lines.unavailable}\n`)
  return filePath
}

/** The path the gateway uses for a pack's sticker: it reads the data volume at its path on the host. */
export function stickerHostPath(hostDataDir: string, packId: string, file: string): string {
  if (!PACK_ID.test(packId)) {
    throw new PackError(`invalid pack id "${packId}"`)
  }
  if (!STICKER_FILE.test(file)) {
    throw new PackError(`invalid sticker file name "${file}"`)
  }
  return posix.join(hostDataDir, 'characters', packId, 'stickers', file)
}
