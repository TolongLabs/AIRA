import { createHash } from 'node:crypto'
import type { Dirent } from 'node:fs'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync
} from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { isMap, parse, parseDocument, stringify } from 'yaml'
import type { z } from 'zod'
import { loadPack, PackError } from '../character/loader.js'
import { cardSchema, linesSchema, moodsSchema, PACK_ID, STICKER_FILE } from '../character/schema.js'
import { readWebpInfo, stickerFault } from '../character/webp.js'
import { isoNow } from '../storage/database.js'
import { writeFileAtomic } from '../storage/files.js'
import type { SiteApiDeps } from './routes.js'

// Character studio pack backend (docs/trd/site.md#character-studio-operation-contract).
// Query, create and patch helpers usable from SiteApiDeps. No HTTP, no registry,
// no migrations and no live calls here. Reads derive an opaque revision from the
// authoritative tree. Writes stage outside the scanned characters root, validate
// the full staged tree under the intended id, then publish with one audit row.

export const STUDIO_FILES = ['card.yml', 'moods.yml', 'lines.yml'] as const
type StudioFile = (typeof STUDIO_FILES)[number]

const MAX_YAML_BYTES = 256 * 1024
const MAX_STICKER_BYTES = 500_000
const STAGE_ROOT_NAME = '.studio-stage'
const JOURNAL_SUFFIX = '.journal.json'
const SITE_ACTOR = 'site'
const REVISION_PATTERN = /^[0-9a-f]{64}$/

export type StudioCard = z.infer<typeof cardSchema>
export type StudioMoods = z.infer<typeof moodsSchema>
export type StudioLines = z.infer<typeof linesSchema>

export interface StudioPackRead {
  id: string
  source: 'repository' | 'data'
  writable: boolean
  revision: string
  card: StudioCard
  moods: StudioMoods
  lines: StudioLines
}

export interface StudioPackWriteResult {
  id: string
  revision: string
  changed: boolean
}

export type StudioCreateInput =
  | { id: string; card: unknown; moods: unknown; lines: unknown }
  | { sourceId: string; newId: string }

export interface StudioUpdateInput {
  expectedRevision: string
  card?: unknown
  moods?: unknown
  lines?: unknown
}

export class StudioPackError extends Error {
  override name = 'StudioPackError'
  constructor(
    readonly code:
      | 'invalid_id'
      | 'not_found'
      | 'pack_read_only'
      | 'pack_unparseable'
      | 'conflict'
      | 'stale_revision'
      | 'invalid_body'
      | 'too_large'
      | 'busy',
    message: string,
    readonly status: number
  ) {
    super(message)
  }
}

type StudioDeps = Pick<SiteApiDeps, 'storage' | 'paths' | 'packs'> & { now?: () => Date }
type ReadDeps = Pick<SiteApiDeps, 'paths' | 'packs'>
type RecoverDeps = Pick<SiteApiDeps, 'storage' | 'paths'> & { now?: () => Date }

let publishing = false

function charactersDirOf(paths: StudioDeps['paths']): string {
  return join(paths.root, 'characters')
}

function stageRootOf(paths: StudioDeps['paths'] | RecoverDeps['paths']): string {
  return join(paths.root, STAGE_ROOT_NAME)
}

function journalPathFor(paths: StudioDeps['paths'] | RecoverDeps['paths'], id: string): string {
  return join(stageRootOf(paths), `${id}${JOURNAL_SUFFIX}`)
}

function stagingParentFor(paths: StudioDeps['paths'] | RecoverDeps['paths'], id: string): string {
  return join(stageRootOf(paths), `${id}.staging`)
}

function backupParentFor(paths: StudioDeps['paths'] | RecoverDeps['paths'], id: string): string {
  return join(stageRootOf(paths), `${id}.backup`)
}

function assertPackId(id: string): void {
  if (!PACK_ID.test(id)) throw new StudioPackError('invalid_id', `invalid pack id "${id}"`, 400)
}

function assertRevisionFormat(revision: string): void {
  if (!REVISION_PATTERN.test(revision)) {
    throw new StudioPackError('invalid_body', 'expectedRevision must be a 64 character hex revision', 400)
  }
}

function ensureInside(root: string, target: string): void {
  const resolvedRoot = resolve(root) + sep
  if (!resolve(target).startsWith(resolvedRoot)) {
    throw new StudioPackError('invalid_body', 'path escapes the pack root', 400)
  }
}

function safeReadFile(dir: string, name: string, maxBytes: number): Buffer {
  if (name.includes('/') || name.includes('\\') || name === '' || name === '.' || name === '..') {
    throw new StudioPackError('invalid_body', `invalid file name "${name}"`, 400)
  }
  const full = join(dir, name)
  ensureInside(dir, full)
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(full)
  } catch {
    throw new StudioPackError('pack_unparseable', `cannot read ${name}`, 409)
  }
  if (stat.isSymbolicLink()) throw new StudioPackError('invalid_body', `${name} must not be a symlink`, 400)
  const real = statSync(full)
  if (!real.isFile()) throw new StudioPackError('pack_unparseable', `cannot read ${name}`, 409)
  if (real.size > maxBytes) throw new StudioPackError('too_large', `${name} is over the size limit`, 413)
  return readFileSync(full)
}

function scanStickersGuard(dir: string): void {
  const stickersDir = join(dir, 'stickers')
  let entries: Dirent<string>[] = []
  try {
    const st = lstatSync(stickersDir)
    if (st.isSymbolicLink()) throw new StudioPackError('invalid_body', 'stickers must not be a symlink', 400)
    if (!st.isDirectory()) throw new StudioPackError('invalid_body', 'stickers must be a directory', 400)
    entries = readdirSync(stickersDir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  for (const entry of entries) {
    if (entry.name.includes('/') || entry.name.includes('\\')) {
      throw new StudioPackError('invalid_body', `invalid sticker name "${entry.name}"`, 400)
    }
    if (!STICKER_FILE.test(entry.name)) {
      throw new StudioPackError('invalid_body', `unknown sticker file "${entry.name}"`, 400)
    }
    const full = join(stickersDir, entry.name)
    ensureInside(dir, full)
    const lst = lstatSync(full)
    if (lst.isSymbolicLink()) throw new StudioPackError('invalid_body', 'sticker must not be a symlink', 400)
    const st = statSync(full)
    if (!st.isFile()) throw new StudioPackError('pack_unparseable', 'cannot read sticker', 409)
    if (st.size > MAX_STICKER_BYTES) throw new StudioPackError('too_large', 'sticker is over the size limit', 413)
    const fault = stickerFault(readWebpInfo(readFileSync(full)))
    if (fault) throw new StudioPackError('invalid_body', `invalid sticker "${entry.name}": ${fault}`, 400)
  }
  const unknown: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'stickers') continue
    if (!(STUDIO_FILES as readonly string[]).includes(entry.name)) unknown.push(entry.name)
  }
  if (unknown.length > 0) {
    throw new StudioPackError('invalid_body', `unknown file "${unknown.sort()[0]}"`, 400)
  }
}

type TreeBytes = Record<StudioFile, Buffer>

function readTreeBytes(dir: string): TreeBytes {
  const dirStat = lstatSync(dir)
  if (dirStat.isSymbolicLink()) throw new StudioPackError('invalid_body', 'pack must not be a symlink', 400)
  if (!dirStat.isDirectory()) throw new StudioPackError('pack_unparseable', 'pack is not a directory', 409)
  scanStickersGuard(dir)
  return {
    'card.yml': safeReadFile(dir, 'card.yml', MAX_YAML_BYTES),
    'moods.yml': safeReadFile(dir, 'moods.yml', MAX_YAML_BYTES),
    'lines.yml': safeReadFile(dir, 'lines.yml', MAX_YAML_BYTES)
  }
}

function revisionOf(id: string, tree: TreeBytes): string {
  const hash = createHash('sha256')
  hash.update(`id:${id}\n`)
  for (const name of STUDIO_FILES) {
    const bytes = tree[name as StudioFile]
    hash.update(`${name}:${bytes.length}\n`)
    hash.update(bytes)
    hash.update('\n')
  }
  return hash.digest('hex')
}

function sanitizedIssues(prefix: string, error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  const first = error.issues.slice(0, 3).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)'
    return `${path}: ${issue.message}`
  })
  return `${prefix}: ${first.join('; ')}`
}

function parseTree(id: string, tree: TreeBytes): { card: StudioCard; moods: StudioMoods; lines: StudioLines } {
  const parsed: Record<string, unknown> = {}
  for (const name of STUDIO_FILES) {
    const text = tree[name as StudioFile].toString('utf8')
    parsed[name] = parseYamlText(text, name)
  }
  const card = cardSchema.safeParse(parsed['card.yml'])
  if (!card.success) throw new StudioPackError('pack_unparseable', sanitizedIssues('card.yml', card.error), 409)
  const moods = moodsSchema.safeParse(parsed['moods.yml'])
  if (!moods.success) throw new StudioPackError('pack_unparseable', sanitizedIssues('moods.yml', moods.error), 409)
  const lines = linesSchema.safeParse(parsed['lines.yml'])
  if (!lines.success) throw new StudioPackError('pack_unparseable', sanitizedIssues('lines.yml', lines.error), 409)
  if (card.data.id !== id) {
    throw new StudioPackError('pack_unparseable', `card.yml: id: must equal folder name "${id}"`, 409)
  }
  return { card: card.data, moods: moods.data, lines: lines.data }
}

function parseYamlText(text: string, name: string): unknown {
  // A broken file keeps its bytes so the owner can repair it.
  try {
    return parse(text)
  } catch (error) {
    const first = (error as Error).message.split('\n')[0] ?? 'invalid YAML'
    throw new StudioPackError('pack_unparseable', `${name}: invalid YAML: ${first}`, 409)
  }
}

function dataDirFor(paths: StudioDeps['paths'] | ReadDeps['paths'] | RecoverDeps['paths'], id: string): string {
  assertPackId(id)
  const dir = join(charactersDirOf(paths as StudioDeps['paths']), id)
  ensureInside(charactersDirOf(paths as StudioDeps['paths']), dir)
  return dir
}

function locatePack(deps: ReadDeps, id: string): { dir: string; source: 'repository' | 'data' } {
  assertPackId(id)
  const dataDir = dataDirFor(deps.paths, id)
  try {
    const st = lstatSync(dataDir)
    if (!st.isSymbolicLink() && st.isDirectory()) return { dir: dataDir, source: 'data' }
    if (st.isSymbolicLink()) throw new StudioPackError('invalid_body', 'pack must not be a symlink', 400)
  } catch (error) {
    if (error instanceof StudioPackError) throw error
  }
  const set = deps.packs()
  const loaded = set.packs.get(id)
  if (loaded) return { dir: loaded.dir, source: loaded.source }
  const fault = set.faults.find((entry) => entry.id === id)
  if (fault) {
    const looksData = resolve(fault.dir) === resolve(dataDir)
    return { dir: fault.dir, source: looksData ? 'data' : 'repository' }
  }
  throw new StudioPackError('not_found', `unknown pack "${id}"`, 404)
}

function acquireWriter(): void {
  if (publishing) throw new StudioPackError('busy', 'another pack publish is in progress', 409)
  publishing = true
}

function releaseWriter(): void {
  publishing = false
}

function auditCount(storage: StudioDeps['storage'], id: string): number {
  return storage.read(
    (db) =>
      db
        .prepare("SELECT COUNT(*) AS n FROM setting_change WHERE target = 'pack' AND scope = ? AND key = 'revision'")
        .get(id) as { n: number }
  ).n
}

function ensureAuditRow(
  storage: StudioDeps['storage'] | RecoverDeps['storage'],
  id: string,
  oldRevision: string,
  newRevision: string,
  now: () => Date
): void {
  storage.tx((db) => {
    const existing = db
      .prepare(
        "SELECT 1 FROM setting_change WHERE target = 'pack' AND scope = ? AND key = 'revision' AND new_value = ?"
      )
      .get(id, newRevision)
    if (existing !== undefined) return
    db.prepare(
      `INSERT INTO setting_change (target, actor, level, scope, key, old_value, new_value, changed_at)
       VALUES ('pack', ?, NULL, ?, 'revision', ?, ?, ?)`
    ).run(SITE_ACTOR, id, oldRevision === '' ? null : oldRevision, newRevision, isoNow(now))
  })
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function applyPatchToDoc(doc: ReturnType<typeof parseDocument>, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw new StudioPackError('invalid_body', 'invalid patch key', 400)
    }
    if (value === undefined) continue
    if (value === null) {
      doc.deleteIn([key])
      continue
    }
    const current = doc.getIn([key], true)
    if (isPlainObject(value) && isMap(current)) {
      applyNested(doc, [key], value)
      continue
    }
    doc.setIn([key], value)
  }
}

function applyNested(doc: ReturnType<typeof parseDocument>, path: string[], patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw new StudioPackError('invalid_body', 'invalid patch key', 400)
    }
    if (value === undefined) continue
    const next = [...path, key]
    if (value === null) {
      doc.deleteIn(next)
      continue
    }
    const current = doc.getIn(next, true)
    if (isPlainObject(value) && isMap(current)) {
      applyNested(doc, next, value)
      continue
    }
    doc.setIn(next, value)
  }
}

function cleanStageDir(path: string): void {
  rmSync(path, { recursive: true, force: true })
}

function copyStickersForPublish(fromDir: string, stagingDir: string): void {
  const from = join(fromDir, 'stickers')
  try {
    const st = lstatSync(from)
    if (st.isSymbolicLink()) throw new StudioPackError('invalid_body', 'stickers must not be a symlink', 400)
    if (!st.isDirectory()) throw new StudioPackError('invalid_body', 'stickers must be a directory', 400)
  } catch (error) {
    if (error instanceof StudioPackError) throw error
    return
  }
  const entries = readdirSync(from, { withFileTypes: true })
  if (entries.length === 0) return
  mkdirSync(join(stagingDir, 'stickers'), { recursive: true })
  for (const entry of entries) {
    if (!entry.isFile()) throw new StudioPackError('invalid_body', `unknown sticker "${entry.name}"`, 400)
    if (!STICKER_FILE.test(entry.name)) {
      throw new StudioPackError('invalid_body', `unknown sticker file "${entry.name}"`, 400)
    }
    const src = join(from, entry.name)
    ensureInside(fromDir, src)
    const lst = lstatSync(src)
    if (lst.isSymbolicLink()) throw new StudioPackError('invalid_body', 'sticker must not be a symlink', 400)
    const st = statSync(src)
    if (st.size > MAX_STICKER_BYTES) throw new StudioPackError('too_large', 'sticker is over the size limit', 413)
    const bytes = readFileSync(src)
    const fault = stickerFault(readWebpInfo(bytes))
    if (fault) throw new StudioPackError('invalid_body', `invalid sticker "${entry.name}": ${fault}`, 400)
    const dest = join(stagingDir, 'stickers', entry.name)
    ensureInside(stagingDir, dest)
    mkdirSync(join(stagingDir, 'stickers'), { recursive: true })
    writeFileAtomic(dest, bytes)
  }
}

function validateStagedTree(stagingDir: string, id: string): void {
  try {
    loadPack(stagingDir, 'data')
  } catch (error) {
    if (error instanceof PackError) {
      const first = error.message.split('\n')[0] ?? 'invalid pack'
      throw new StudioPackError('pack_unparseable', first, 409)
    }
    throw error
  }
  const tree = readTreeBytes(stagingDir)
  parseTree(id, tree)
}

function swapStagedFiles(stagingDir: string, targetDir: string): void {
  mkdirSync(targetDir, { recursive: true })
  for (const name of STUDIO_FILES) {
    renameSync(join(stagingDir, name), join(targetDir, name))
  }
  const stagedStickers = join(stagingDir, 'stickers')
  if (existsSync(stagedStickers)) {
    rmSync(join(targetDir, 'stickers'), { recursive: true, force: true })
    renameSync(stagedStickers, join(targetDir, 'stickers'))
  }
}

function backupTree(targetDir: string, backupDir: string): void {
  mkdirSync(backupDir, { recursive: true })
  for (const name of STUDIO_FILES) {
    const src = join(targetDir, name)
    if (!existsSync(src)) continue
    writeFileAtomic(join(backupDir, name), readFileSync(src))
  }
  const stickers = join(targetDir, 'stickers')
  if (existsSync(stickers)) {
    mkdirSync(join(backupDir, 'stickers'), { recursive: true })
    for (const entry of readdirSync(stickers, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      writeFileAtomic(join(backupDir, 'stickers', entry.name), readFileSync(join(stickers, entry.name)))
    }
  }
}

function restoreBackup(backupDir: string, targetDir: string): void {
  if (!existsSync(backupDir)) return
  mkdirSync(targetDir, { recursive: true })
  for (const name of STUDIO_FILES) {
    const src = join(backupDir, name)
    if (!existsSync(src)) continue
    writeFileAtomic(join(targetDir, name), readFileSync(src))
  }
}

/** Reads the authoritative tree and derives its opaque revision. Throws when the pack is missing or invalid. */
export function getStudioPack(deps: ReadDeps, id: string): StudioPackRead {
  const located = locatePack(deps, id)
  const tree = readTreeBytes(located.dir)
  const docs = parseTree(id, tree)
  return {
    id,
    source: located.source,
    writable: located.source === 'data',
    revision: revisionOf(id, tree),
    card: docs.card,
    moods: docs.moods,
    lines: docs.lines
  }
}

function rejectExistingId(deps: StudioDeps, id: string): void {
  assertPackId(id)
  if (existsSync(dataDirFor(deps.paths, id))) {
    throw new StudioPackError('conflict', `pack "${id}" already exists`, 409)
  }
  const set = deps.packs()
  if (set.packs.has(id) || set.faults.some((entry) => entry.id === id)) {
    throw new StudioPackError('conflict', `pack "${id}" already exists`, 409)
  }
}

function validateFullDocuments(input: { card: unknown; moods: unknown; lines: unknown }, id: string): void {
  const card = cardSchema.safeParse(input.card)
  if (!card.success) throw new StudioPackError('invalid_body', sanitizedIssues('card', card.error), 400)
  if (card.data.id !== id) throw new StudioPackError('invalid_body', 'card id must equal the pack id', 400)
  const moods = moodsSchema.safeParse(input.moods)
  if (!moods.success) throw new StudioPackError('invalid_body', sanitizedIssues('moods', moods.error), 400)
  const lines = linesSchema.safeParse(input.lines)
  if (!lines.success) throw new StudioPackError('invalid_body', sanitizedIssues('lines', lines.error), 400)
}

/** Creates a data pack from typed documents, or copies a pack under a new id. One audit row per publish. */
export function createStudioPack(deps: StudioDeps, input: StudioCreateInput): StudioPackWriteResult {
  const now = deps.now ?? (() => new Date())
  const isCopy = 'sourceId' in input
  const id = isCopy ? input.newId : input.id
  assertPackId(id)
  acquireWriter()
  const stagingParent = stagingParentFor(deps.paths, id)
  const stagingDir = join(stagingParent, id)
  const backupParent = backupParentFor(deps.paths, id)
  const journalPath = journalPathFor(deps.paths, id)
  try {
    rejectExistingId(deps, id)
    mkdirSync(stagingParent, { recursive: true })
    cleanStageDir(stagingDir)
    mkdirSync(stagingDir, { recursive: true })
    if (isCopy) {
      assertPackId(input.sourceId)
      const source = locatePack(deps, input.sourceId)
      const sourceTree = readTreeBytes(source.dir)
      // A copy validates the source before it moves any bytes.
      parseTree(input.sourceId, sourceTree)
      copyStickersForPublish(source.dir, stagingDir)
      const cardDoc = parseYamlDocument(sourceTree['card.yml'])
      cardDoc.setIn(['id'], id)
      writeFileAtomic(join(stagingDir, 'card.yml'), cardDoc.toString())
      writeFileAtomic(join(stagingDir, 'moods.yml'), sourceTree['moods.yml'])
      writeFileAtomic(join(stagingDir, 'lines.yml'), sourceTree['lines.yml'])
    } else {
      validateFullDocuments(input, id)
      writeFileAtomic(join(stagingDir, 'card.yml'), toStableYaml(input.card))
      writeFileAtomic(join(stagingDir, 'moods.yml'), toStableYaml(input.moods))
      writeFileAtomic(join(stagingDir, 'lines.yml'), toStableYaml(input.lines))
    }
    validateStagedTree(stagingDir, id)
    const staged = readTreeBytes(stagingDir)
    const newRevision = revisionOf(id, staged)
    writeFileAtomic(journalPath, JSON.stringify({ id, oldRevision: '', newRevision, at: now().toISOString() }))
    const targetDir = dataDirFor(deps.paths, id)
    try {
      swapStagedFiles(stagingDir, targetDir)
      ensureAuditRow(deps.storage, id, '', newRevision, now)
    } catch (error) {
      try {
        rmSync(targetDir, { recursive: true, force: true })
      } catch {
        // Recovery replays the journal; never mask the original failure.
      }
      throw error
    }
    cleanStageDir(stagingParent)
    cleanStageDir(backupParent)
    rmSync(journalPath, { force: true })
    return { id, revision: newRevision, changed: true }
  } catch (error) {
    cleanStageDir(stagingParent)
    if (error instanceof StudioPackError && error.code !== 'stale_revision') {
      // A failed create leaves no journal: there is no prior version to recover.
      rmSync(journalPath, { force: true })
    }
    throw error
  } finally {
    releaseWriter()
  }
}

function toStableYaml(value: unknown): string {
  return stringify(value)
}

/** Patches one data pack. Preserves comments, keeps unchanged bytes and writes one audit row on change. */
export function updateStudioPack(deps: StudioDeps, id: string, input: StudioUpdateInput): StudioPackWriteResult {
  const now = deps.now ?? (() => new Date())
  assertPackId(id)
  if (!isPlainObject(input)) throw new StudioPackError('invalid_body', 'invalid patch body', 400)
  assertRevisionFormat(input.expectedRevision)
  for (const [key, value] of Object.entries(input)) {
    if (key === 'expectedRevision') continue
    if (key !== 'card' && key !== 'moods' && key !== 'lines') {
      throw new StudioPackError('invalid_body', `unknown document "${key}"`, 400)
    }
    if (value !== undefined && !isPlainObject(value)) {
      throw new StudioPackError('invalid_body', `${key} patch must be an object`, 400)
    }
  }
  const located = locatePack({ paths: deps.paths, packs: deps.packs }, id)
  if (located.source !== 'data') throw new StudioPackError('pack_read_only', 'repository packs are read-only', 409)
  acquireWriter()
  const stagingParent = stagingParentFor(deps.paths, id)
  const stagingDir = join(stagingParent, id)
  const backupParent = backupParentFor(deps.paths, id)
  const backupDir = join(backupParent, id)
  const journalPath = journalPathFor(deps.paths, id)
  try {
    const targetDir = dataDirFor(deps.paths, id)
    const current = readTreeBytes(targetDir)
    const oldRevision = revisionOf(id, current)
    if (input.expectedRevision !== oldRevision) {
      throw new StudioPackError('stale_revision', 'the pack changed since it was read', 409)
    }
    const hasPatch =
      (input.card !== undefined && Object.keys(input.card as Record<string, unknown>).length > 0) ||
      (input.moods !== undefined && Object.keys(input.moods as Record<string, unknown>).length > 0) ||
      (input.lines !== undefined && Object.keys(input.lines as Record<string, unknown>).length > 0)
    if (!hasPatch) return { id, revision: oldRevision, changed: false }
    const cardDoc = parseYamlDocument(current['card.yml'])
    const moodsDoc = parseYamlDocument(current['moods.yml'])
    const linesDoc = parseYamlDocument(current['lines.yml'])
    if (input.card !== undefined) applyPatchToDoc(cardDoc, input.card as Record<string, unknown>)
    if (input.moods !== undefined) applyPatchToDoc(moodsDoc, input.moods as Record<string, unknown>)
    if (input.lines !== undefined) applyPatchToDoc(linesDoc, input.lines as Record<string, unknown>)
    const merged = {
      card: cardDoc.toJS(),
      moods: moodsDoc.toJS(),
      lines: linesDoc.toJS()
    }
    const cardChecked = cardSchema.safeParse(merged.card)
    if (!cardChecked.success) {
      throw new StudioPackError('invalid_body', sanitizedIssues('card', cardChecked.error), 400)
    }
    if (cardChecked.data.id !== id) throw new StudioPackError('invalid_body', 'card id must equal the pack id', 400)
    const moodsChecked = moodsSchema.safeParse(merged.moods)
    if (!moodsChecked.success) {
      throw new StudioPackError('invalid_body', sanitizedIssues('moods', moodsChecked.error), 400)
    }
    const linesChecked = linesSchema.safeParse(merged.lines)
    if (!linesChecked.success) {
      throw new StudioPackError('invalid_body', sanitizedIssues('lines', linesChecked.error), 400)
    }
    const nextTexts: Record<StudioFile, string> = {
      'card.yml': cardDoc.toString(),
      'moods.yml': moodsDoc.toString(),
      'lines.yml': linesDoc.toString()
    }
    const currentTexts: Record<StudioFile, string> = {
      'card.yml': current['card.yml'].toString('utf8'),
      'moods.yml': current['moods.yml'].toString('utf8'),
      'lines.yml': current['lines.yml'].toString('utf8')
    }
    if (
      nextTexts['card.yml'] === currentTexts['card.yml'] &&
      nextTexts['moods.yml'] === currentTexts['moods.yml'] &&
      nextTexts['lines.yml'] === currentTexts['lines.yml']
    ) {
      return { id, revision: oldRevision, changed: false }
    }
    mkdirSync(stagingParent, { recursive: true })
    cleanStageDir(stagingDir)
    mkdirSync(stagingDir, { recursive: true })
    // Unchanged files keep their exact bytes; changed files keep their comments through Document editing.
    for (const name of STUDIO_FILES) {
      const text = nextTexts[name] === currentTexts[name] ? current[name as StudioFile] : Buffer.from(nextTexts[name])
      writeFileAtomic(join(stagingDir, name), text)
    }
    copyStickersForPublish(targetDir, stagingDir)
    validateStagedTree(stagingDir, id)
    const staged = readTreeBytes(stagingDir)
    const newRevision = revisionOf(id, staged)
    if (newRevision === oldRevision) {
      cleanStageDir(stagingParent)
      return { id, revision: oldRevision, changed: false }
    }
    // Re-read before publish so an external edit is a stale revision, not a silent overwrite.
    const reread = readTreeBytes(targetDir)
    if (revisionOf(id, reread) !== input.expectedRevision) {
      cleanStageDir(stagingParent)
      throw new StudioPackError('stale_revision', 'the pack changed since it was read', 409)
    }
    writeFileAtomic(
      journalPath,
      JSON.stringify({ id, oldRevision, newRevision, at: now().toISOString() })
    )
    cleanStageDir(backupParent)
    backupTree(targetDir, backupDir)
    const beforeAudit = auditCount(deps.storage, id)
    try {
      swapStagedFiles(stagingDir, targetDir)
      ensureAuditRow(deps.storage, id, oldRevision, newRevision, now)
    } catch (error) {
      let restored = false
      try {
        restoreBackup(backupDir, targetDir)
        restored = true
      } catch {
        // The journal keeps the prior version recoverable; never mask the original failure.
      }
      if (restored) {
        cleanStageDir(stagingParent)
        cleanStageDir(backupParent)
        rmSync(journalPath, { force: true })
      }
      throw error
    }
    const afterAudit = auditCount(deps.storage, id)
    if (afterAudit !== beforeAudit + 1) {
      try {
        restoreBackup(backupDir, targetDir)
        deps.storage.tx((db) => {
          db.prepare(
            "DELETE FROM setting_change WHERE target = 'pack' AND scope = ? AND key = 'revision' AND new_value = ?"
          ).run(id, newRevision)
        })
      } catch {
        // Recovery replays the journal when the audit and the files disagree.
      }
      throw new StudioPackError('pack_unparseable', 'pack audit failed', 409)
    }
    cleanStageDir(stagingParent)
    cleanStageDir(backupParent)
    rmSync(journalPath, { force: true })
    return { id, revision: newRevision, changed: true }
  } catch (error) {
    if (error instanceof StudioPackError && error.code === 'stale_revision') {
      cleanStageDir(stagingParent)
    }
    throw error
  } finally {
    releaseWriter()
  }
}

/** Replays an interrupted publish after restart. Never trusts paths from the journal. */
export function recoverStudioPacks(deps: RecoverDeps): { recovered: string[] } {
  const now = deps.now ?? (() => new Date())
  const stageRoot = stageRootOf(deps.paths)
  if (!existsSync(stageRoot)) return { recovered: [] }
  const recovered: string[] = []
  for (const entry of readdirSync(stageRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(JOURNAL_SUFFIX)) continue
    const rawId = entry.name.slice(0, -JOURNAL_SUFFIX.length)
    if (!PACK_ID.test(rawId)) {
      rmSync(join(stageRoot, entry.name), { force: true })
      continue
    }
    let journal: { id?: unknown; oldRevision?: unknown; newRevision?: unknown }
    try {
      journal = JSON.parse(readFileSync(join(stageRoot, entry.name), 'utf8')) as {
        id?: unknown
        oldRevision?: unknown
        newRevision?: unknown
      }
    } catch {
      rmSync(join(stageRoot, entry.name), { force: true })
      continue
    }
    if (journal.id !== rawId || typeof journal.oldRevision !== 'string' || typeof journal.newRevision !== 'string') {
      rmSync(join(stageRoot, entry.name), { force: true })
      continue
    }
    if (
      (journal.oldRevision !== '' && !REVISION_PATTERN.test(journal.oldRevision)) ||
      !REVISION_PATTERN.test(journal.newRevision)
    ) {
      rmSync(join(stageRoot, entry.name), { force: true })
      continue
    }
    const id = rawId
    // Paths come from the id alone; anything else in the journal is ignored.
    const targetDir = dataDirFor(deps.paths, id)
    const stagingDir = join(stagingParentFor(deps.paths, id), id)
    const backupDir = join(backupParentFor(deps.paths, id), id)
    const journalPath = join(stageRoot, entry.name)
    const targetExists = existsSync(targetDir)
    let currentRevision: string | undefined
    if (targetExists) {
      try {
        currentRevision = revisionOf(id, readTreeBytes(targetDir))
      } catch {
        currentRevision = undefined
      }
    }
    if (currentRevision === journal.newRevision) {
      ensureAuditRow(deps.storage, id, journal.oldRevision, journal.newRevision, now)
      cleanStageDir(stagingParentFor(deps.paths, id))
      cleanStageDir(backupParentFor(deps.paths, id))
      rmSync(journalPath, { force: true })
      recovered.push(id)
      continue
    }
    const stagingExists =
      existsSync(join(stagingDir, 'card.yml')) &&
      existsSync(join(stagingDir, 'moods.yml')) &&
      existsSync(join(stagingDir, 'lines.yml'))
    if (!targetExists && stagingExists) {
      try {
        validateStagedTree(stagingDir, id)
        swapStagedFiles(stagingDir, targetDir)
        ensureAuditRow(deps.storage, id, journal.oldRevision, journal.newRevision, now)
      } catch {
        rmSync(targetDir, { recursive: true, force: true })
        rmSync(journalPath, { force: true })
        cleanStageDir(stagingParentFor(deps.paths, id))
        continue
      }
      cleanStageDir(stagingParentFor(deps.paths, id))
      cleanStageDir(backupParentFor(deps.paths, id))
      rmSync(journalPath, { force: true })
      recovered.push(id)
      continue
    }
    if (currentRevision === journal.oldRevision && stagingExists) {
      try {
        validateStagedTree(stagingDir, id)
        cleanStageDir(backupParentFor(deps.paths, id))
        backupTree(targetDir, backupDir)
        swapStagedFiles(stagingDir, targetDir)
        ensureAuditRow(deps.storage, id, journal.oldRevision, journal.newRevision, now)
      } catch {
        try {
          restoreBackup(backupDir, targetDir)
        } catch {
          // Leave the journal so the next start-up retries the repair.
          continue
        }
        continue
      }
      cleanStageDir(stagingParentFor(deps.paths, id))
      cleanStageDir(backupParentFor(deps.paths, id))
      rmSync(journalPath, { force: true })
      recovered.push(id)
      continue
    }
    if (currentRevision === undefined && existsSync(backupDir)) {
      // An interrupted swap left a partial tree: restore the prior version, then replay the staged one.
      try {
        restoreBackup(backupDir, targetDir)
        if (stagingExists) {
          validateStagedTree(stagingDir, id)
          swapStagedFiles(stagingDir, targetDir)
          ensureAuditRow(deps.storage, id, journal.oldRevision, journal.newRevision, now)
        }
      } catch {
        continue
      }
      cleanStageDir(stagingParentFor(deps.paths, id))
      cleanStageDir(backupParentFor(deps.paths, id))
      rmSync(journalPath, { force: true })
      recovered.push(id)
      continue
    }
    if (currentRevision === journal.oldRevision) {
      cleanStageDir(stagingParentFor(deps.paths, id))
      cleanStageDir(backupParentFor(deps.paths, id))
      rmSync(journalPath, { force: true })
      recovered.push(id)
      continue
    }
    // A partial swap that matches neither revision rolls back to the backup with no new audit.
    if (existsSync(backupDir)) {
      try {
        restoreBackup(backupDir, targetDir)
      } catch {
        continue
      }
    }
    cleanStageDir(stagingParentFor(deps.paths, id))
    cleanStageDir(backupParentFor(deps.paths, id))
    rmSync(journalPath, { force: true })
    recovered.push(id)
  }
  return { recovered }
}

// YAML helpers localised here so Document editing preserves comments and unknown fields.
function parseYamlDocument(bytes: Buffer): ReturnType<typeof parseDocument> {
  const doc = parseDocument(bytes.toString('utf8'))
  if (doc.errors.length > 0) throw new StudioPackError('pack_unparseable', 'pack does not parse', 409)
  return doc
}
