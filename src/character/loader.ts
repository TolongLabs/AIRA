import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { parse } from 'yaml'
import type { z } from 'zod'
import { cardSchema, type LineKind, linesSchema, moodsSchema, PACK_ID } from './schema.js'
import { readWebpInfo, stickerFault } from './webp.js'

export class PackError extends Error {
  override name = 'PackError'
  readonly kind = 'config_invalid'
}

export interface Mood {
  key: string
  /** The mood's patterns, compiled with the flags 'iu'. */
  patterns: RegExp[]
  tone: string
  openers: string[]
  endings: string[]
  /** The mood's own faces and those of its face groups, without repeats. */
  faces: string[]
  /** The beats this mood allows, with their odds per reply. */
  beats: { name: string; line: string; odds: number }[]
  stickers: string[]
}

export interface Pack {
  id: string
  /** The folder the pack was read from. */
  dir: string
  source: 'repository' | 'data'
  card: {
    id: string
    displayName: string
    aliases?: string[]
    languages: string[]
    coreIdentity: string
    speechRules: string[]
    defaultReplyLength: 'short' | 'default' | 'long'
    toolFooter?: { icon?: string; labels?: Record<string, string> }
  }
  defaultMood: string
  moods: Map<string, Mood>
  lines: Record<LineKind, string> &
    Partial<Record<'researchStarted' | 'researchTopic' | 'researchBusy' | 'researchFailed' | 'offerPdf', string>>
}

function readAndValidate<T>(dir: string, file: string, schema: z.ZodType<T>, faults: string[]): T | undefined {
  let source: string
  try {
    source = readFileSync(join(dir, file), 'utf8')
  } catch (cause) {
    faults.push(`${file}: cannot read file: ${(cause as Error).message}`)
    return undefined
  }
  let raw: unknown
  try {
    raw = parse(source)
  } catch (cause) {
    // The parser's message quotes the file around the fault. Keep its first line only: the rest is pack text.
    faults.push(`${file}: invalid YAML: ${(cause as Error).message.split('\n')[0]}`)
    return undefined
  }
  const result = schema.safeParse(raw)
  if (!result.success) {
    for (const issue of result.error.issues) {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)'
      faults.push(`${file}: ${path}: ${issue.message}`)
    }
    return undefined
  }
  return result.data
}

/** Reads and validates one pack folder. Throws one PackError that lists every fault found. */
export function loadPack(dir: string, source: 'repository' | 'data'): Pack {
  const id = basename(dir)
  const faults: string[] = []

  const card = readAndValidate(dir, 'card.yml', cardSchema, faults)
  const moodsRaw = readAndValidate(dir, 'moods.yml', moodsSchema, faults)
  const lines = readAndValidate(dir, 'lines.yml', linesSchema, faults)

  if (card && card.id !== id) {
    faults.push(`card.yml: id: must equal folder name "${id}"`)
  }

  const moods = new Map<string, Mood>()
  if (moodsRaw) {
    if (!Object.hasOwn(moodsRaw.moods, moodsRaw.default)) {
      faults.push(`moods.yml: default: unknown mood "${moodsRaw.default}"`)
    }
    for (const [key, entry] of Object.entries(moodsRaw.moods)) {
      const patterns: RegExp[] = []
      for (const [index, pattern] of entry.patterns.entries()) {
        try {
          patterns.push(new RegExp(pattern, 'iu'))
        } catch (cause) {
          faults.push(`moods.yml: moods.${key}.patterns.${index}: ${(cause as Error).message}`)
        }
      }
      for (const file of entry.stickers) {
        const stickerPath = join(dir, 'stickers', file)
        if (!existsSync(stickerPath) || !statSync(stickerPath).isFile()) {
          faults.push(`moods.yml: moods.${key}.stickers: missing sticker file "${file}"`)
        } else {
          const fault = stickerFault(readWebpInfo(readFileSync(stickerPath)))
          if (fault) {
            faults.push(`moods.yml: moods.${key}.stickers: sticker "${file}" ${fault}`)
          }
        }
      }
      const groupFaces = (entry.faceGroups ?? []).flatMap((group) => {
        const faces = moodsRaw.faceGroups?.[group]
        if (!faces) faults.push(`moods.yml: moods.${key}.faceGroups: unknown face group "${group}"`)
        return faces ?? []
      })
      const beats = Object.entries(entry.beats ?? {}).flatMap(([name, odds]) => {
        const beat = moodsRaw.beats?.find((b) => b.name === name)
        if (!beat) faults.push(`moods.yml: moods.${key}.beats: unknown beat "${name}"`)
        return beat ? [{ name, line: beat.line, odds }] : []
      })
      moods.set(key, {
        key,
        patterns,
        tone: entry.tone,
        openers: entry.openers,
        endings: entry.endings,
        faces: [...new Set([...entry.faces, ...groupFaces])],
        beats,
        stickers: entry.stickers
      })
    }
  }

  if (faults.length > 0 || !card || !moodsRaw || !lines) {
    throw new PackError(`character pack ${id} is invalid:\n${faults.map((f) => `  ${f}`).join('\n')}`)
  }

  return {
    id,
    dir,
    source,
    card,
    defaultMood: moodsRaw.default,
    moods,
    lines
  }
}

export interface PackFault {
  id: string
  dir: string
  message: string
}
export interface PackSet {
  packs: Map<string, Pack>
  faults: PackFault[]
}

/**
 * Loads every pack folder under the two roots. A pack on the data volume wins over one in the repository with the
 * same id. A pack that fails validation is not loaded and is reported as a fault; the other packs still load.
 */
export function loadPacks(roots: { repositoryDir?: string; dataDir?: string }): PackSet {
  const candidates = new Map<string, { dir: string; source: 'repository' | 'data' }>()

  const scan = (rootDir: string | undefined, source: 'repository' | 'data') => {
    if (!rootDir || !existsSync(rootDir) || !statSync(rootDir).isDirectory()) return
    for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (candidates.has(entry.name)) continue
      candidates.set(entry.name, { dir: join(rootDir, entry.name), source })
    }
  }

  scan(roots.dataDir, 'data')
  scan(roots.repositoryDir, 'repository')

  const packs = new Map<string, Pack>()
  const faults: PackFault[] = []

  for (const [id, { dir, source }] of candidates) {
    if (!PACK_ID.test(id)) {
      faults.push({
        id,
        dir,
        message: `character pack ${id} is invalid:\n  id: directory name does not match PACK_ID`
      })
      continue
    }
    try {
      packs.set(id, loadPack(dir, source))
    } catch (cause) {
      faults.push({
        id,
        dir,
        message: cause instanceof Error ? cause.message : String(cause)
      })
    }
  }

  faults.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return { packs, faults }
}
