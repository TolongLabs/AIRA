import { realpathSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'

// The sticker route's file lookup. It serves a `.webp` from a pack's `stickers/` folder under the data folder or the
// repository, and nothing else: the pack and the file are names, never paths.

const PACK_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.webp$/i

export interface StickerRoots {
  /** The data folder: packs live in `<dataDir>/characters/<id>/stickers/`. */
  dataDir: string
  /** The repository: packs live in `<repositoryDir>/characters/<id>/stickers/`. */
  repositoryDir: string
}

/** The absolute path of a sticker, or undefined when the names are not plain names or the file is not there. */
export function findSticker(roots: StickerRoots, pack: string, file: string): string | undefined {
  if (!PACK_NAME.test(pack) || !FILE_NAME.test(file) || file.includes('..')) return undefined
  for (const base of [roots.dataDir, roots.repositoryDir]) {
    try {
      const folder = realpathSync(join(base, 'characters', pack, 'stickers'))
      const path = realpathSync(join(folder, file))
      // A link inside the folder that points outside it is not served.
      if (path.startsWith(folder + sep) && statSync(path).isFile()) return path
    } catch {
      // Not in this root: try the next.
    }
  }
  return undefined
}

export function stickerUrl(pack: string, file: string): string {
  return `/sticker/${encodeURIComponent(pack)}/${encodeURIComponent(file)}`
}

/** The content-addressed name the storage layer gives a file a tool made: two hex digits, a slash, 64 hex digits. */
const PHOTO_PATH = /^[0-9a-f]{2}\/[0-9a-f]{64}\.(?:png|jpe?g|gif|webp)$/

/** A picture a tool made, in the data folder's `files/` folder. Same rule: a plain name, a file inside the folder. */
export function findPhoto(dataDir: string, relative: string): string | undefined {
  if (!PHOTO_PATH.test(relative)) return undefined
  try {
    const folder = realpathSync(join(dataDir, 'files'))
    const path = realpathSync(join(folder, relative))
    if (path.startsWith(folder + sep) && statSync(path).isFile()) return path
  } catch {
    // Not there.
  }
  return undefined
}

export function photoUrl(relative: string): string {
  return `/photo/${relative}`
}
