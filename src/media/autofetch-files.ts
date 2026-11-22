import { randomUUID } from 'node:crypto'
import { closeSync, lstatSync, mkdirSync, openSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// The files one autofetch delivery hands to the gateway by host path (docs/trd/system.md#autofetch). Each file gets a
// new random name, so identical bytes in two deliveries never share a file. Only names of this shape are ever removed,
// and nothing that is not a plain file is followed or removed.

const EXTENSIONS: readonly string[] = ['.jpg', '.png', '.webp', '.gif', '.mp4']
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const SHA256 = '[0-9a-f]{64}'
const FILE = `(?:${UUID}|${SHA256})\\.(?:jpg|png|webp|gif|mp4)`
/** A delivery's file, a file of the previous hash-named cache, or a temporary file that cache left behind. */
const OWNED = new RegExp(`^(?:${FILE}|\\.${FILE}\\.[0-9a-f]{12}\\.tmp)$`)

export interface DeliveryFiles {
  /** Leftover files removed when the folder was opened. */
  purged: number
  /** Writes `data` under a new random name and returns the name. Leaves nothing behind when it throws. */
  write(data: Buffer, ext: string): string
  /** Removes the named files and returns how many could not be removed. */
  remove(names: readonly string[]): number
}

function ensureFolder(dir: string): void {
  mkdirSync(dir, { recursive: true })
  if (!lstatSync(dir).isDirectory()) throw new Error('the autofetch folder must be a plain directory')
}

/**
 * Opens the autofetch folder at start-up. A folder that exists must be a real directory, and every owned file left in
 * it is removed. A folder that does not exist yet is created on the first write.
 */
export function openDeliveryFiles(dir: string): DeliveryFiles {
  let purged = 0
  if (lstatSync(dir, { throwIfNoEntry: false })) {
    ensureFolder(dir)
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !OWNED.test(entry.name)) continue
      rmSync(join(dir, entry.name), { force: true })
      purged++
    }
  }
  return {
    purged,
    write(data, ext) {
      if (!EXTENSIONS.includes(ext)) throw new Error('unsupported autofetch file type')
      ensureFolder(dir)
      const name = `${randomUUID()}${ext}`
      const path = join(dir, name)
      // 'wx' never opens an existing name, so a planted symlink is refused rather than followed.
      const fd = openSync(path, 'wx', 0o644)
      let complete = false
      try {
        writeFileSync(fd, data)
        complete = true
      } finally {
        closeSync(fd)
        if (!complete) rmSync(path, { force: true })
      }
      return name
    },
    remove(names) {
      let failed = 0
      for (const name of names) {
        try {
          rmSync(join(dir, name), { force: true })
        } catch {
          failed++
        }
      }
      return failed
    }
  }
}
