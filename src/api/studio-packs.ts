import { createHash, randomBytes } from 'node:crypto'
import type { Dirent } from 'node:fs'
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync
} from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { isMap, parse, parseDocument, stringify } from 'yaml'
import type { z } from 'zod'
import { checkLoadedPack } from '../character/check.js'
import { MAX_PACK_DOCUMENT_BYTES } from '../character/draft.js'
import { loadPack, PackError } from '../character/loader.js'
import {
  cardSchema,
  footerEmojiSchema,
  footerLabelSchema,
  linesSchema,
  moodsSchema,
  PACK_ID,
  STICKER_FILE
} from '../character/schema.js'
import { readWebpInfo, stickerFault } from '../character/webp.js'
import { DEFAULT_TOOL_LABELS } from '../format/footer.js'
import { isoNow } from '../storage/database.js'
import { syncDir, writeFileAtomic } from '../storage/files.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { SiteApiDeps } from './routes.js'
import { type StudioExpressionStore, StudioExpressionStoreError } from './studio-expression-routes.js'

// Character studio pack backend (docs/trd/site.md#character-studio-operation-contract).
// Query, create and patch helpers usable from SiteApiDeps. No HTTP, no registry,
// no migrations and no live calls here. Reads derive an opaque revision from the
// authoritative tree. Writes stage a complete tree outside the scanned characters
// root, validate the full staged tree under the intended id, then publish with
// one directory rename (new) or rename-to-backup then staged rename (existing)
// under a durable journal, and reconcile safely before reads and writes.

export const STUDIO_FILES = ['card.yml', 'moods.yml', 'lines.yml'] as const
type StudioFile = (typeof STUDIO_FILES)[number]

const MAX_YAML_BYTES = MAX_PACK_DOCUMENT_BYTES
const DOCUMENT_BACKUP = /^(?:card|moods|lines)\.yml\.bak-[0-9]{8}$/u
const MAX_DOCUMENT_BACKUPS = 64
const MAX_STICKER_BYTES = 500_000
const STAGE_ROOT_NAME = '.studio-stage'
const JOURNAL_SUFFIX = '.journal.json'
const SITE_ACTOR = 'site'
const REVISION_PATTERN = /^[0-9a-f]{64}$/
const OPID_PATTERN = /^[0-9a-f]{32}$/
const JOURNAL_VERSION = 2
const PHASES = ['staged', 'backed-up', 'swapped', 'audited'] as const
type JournalPhase = (typeof PHASES)[number]

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
  { id: string; card: unknown; moods: unknown; lines: unknown } | { sourceId: string; newId: string }

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
      | 'revision_required'
      | 'invalid_body'
      | 'invalid_footer'
      | 'unknown_footer_kind'
      | 'too_large'
      | 'busy',
    message: string,
    readonly status: number
  ) {
    super(message)
  }
}

type StudioDeps = Pick<SiteApiDeps, 'storage' | 'paths' | 'packs'> & {
  now?: () => Date
  packValidation?: { ceiling: number; harnessRules: string }
}
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
  if (typeof id !== 'string' || !PACK_ID.test(id))
    throw new StudioPackError('invalid_id', `invalid pack id "${id}"`, 400)
}

function assertRevisionFormat(revision: string): void {
  if (!REVISION_PATTERN.test(revision)) {
    throw new StudioPackError('invalid_body', 'expectedRevision must be a 64 character hex revision', 400)
  }
}

function assertOpIdFormat(opId: string): void {
  if (!OPID_PATTERN.test(opId)) throw new StudioPackError('pack_unparseable', 'invalid operation identifier', 409)
}

function assertPhaseFormat(phase: unknown): asserts phase is JournalPhase {
  if (typeof phase !== 'string' || !(PHASES as readonly string[]).includes(phase)) {
    throw new StudioPackError('pack_unparseable', 'invalid journal phase', 409)
  }
}

function ensureInside(root: string, target: string): void {
  const resolvedRoot = resolve(root) + sep
  if (!resolve(target).startsWith(resolvedRoot)) {
    throw new StudioPackError('invalid_body', 'path escapes the pack root', 400)
  }
}

function assertNotSymlink(path: string, label: string): void {
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(path)
  } catch {
    return
  }
  if (stat.isSymbolicLink()) throw new StudioPackError('invalid_body', `${label} must not be a symlink`, 400)
}

function assertPathSafe(root: string, target: string, label: string): void {
  ensureInside(root, target)
  const resolvedRoot = resolve(root)
  let current = resolve(target)
  while (current !== resolvedRoot && current.startsWith(resolvedRoot + sep)) {
    let stat: ReturnType<typeof lstatSync>
    try {
      stat = lstatSync(current)
    } catch {
      const parent = resolve(join(current, '..'))
      if (parent === current) break
      current = parent
      continue
    }
    if (stat.isSymbolicLink()) throw new StudioPackError('invalid_body', `${label} must not be a symlink`, 400)
    const parent = resolve(join(current, '..'))
    if (parent === current) break
    current = parent
  }
  try {
    const rootStat = lstatSync(resolvedRoot)
    if (rootStat.isSymbolicLink()) throw new StudioPackError('invalid_body', 'data root must not be a symlink', 400)
  } catch (error) {
    if (error instanceof StudioPackError) throw error
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

function validatePackLayout(dir: string, repository: boolean): string[] {
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
  const backups: string[] = []
  const unknown: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'stickers' || (repository && entry.name === 'README.md' && entry.isFile())) continue
    if (!repository && entry.isFile() && DOCUMENT_BACKUP.test(entry.name)) backups.push(entry.name)
    else if (!(STUDIO_FILES as readonly string[]).includes(entry.name)) unknown.push(entry.name)
  }
  if (unknown.length > 0) {
    throw new StudioPackError('invalid_body', `unknown file "${unknown.sort()[0]}"`, 400)
  }
  if (backups.length > MAX_DOCUMENT_BACKUPS) throw new StudioPackError('too_large', 'too many document backups', 413)
  return backups.sort()
}

type TreeBytes = Record<StudioFile, Buffer> & { backups: { name: string; bytes: Buffer }[] }

interface StickerEntry {
  name: string
  bytes: Buffer
}

function readTreeBytes(dir: string, repository = false): TreeBytes {
  const dirStat = lstatSync(dir)
  if (dirStat.isSymbolicLink()) throw new StudioPackError('invalid_body', 'pack must not be a symlink', 400)
  if (!dirStat.isDirectory()) throw new StudioPackError('pack_unparseable', 'pack is not a directory', 409)
  const names = validatePackLayout(dir, repository)
  const tree = readDocumentBytes(dir)
  tree.backups = names.map((name) => ({ name, bytes: safeReadFile(dir, name, MAX_YAML_BYTES) }))
  return tree
}

function readDocumentBytes(dir: string): TreeBytes {
  return {
    backups: [],
    'card.yml': safeReadFile(dir, 'card.yml', MAX_YAML_BYTES),
    'moods.yml': safeReadFile(dir, 'moods.yml', MAX_YAML_BYTES),
    'lines.yml': safeReadFile(dir, 'lines.yml', MAX_YAML_BYTES)
  }
}

function readStickerEntries(dir: string): StickerEntry[] {
  const stickersDir = join(dir, 'stickers')
  let entries: Dirent<string>[] = []
  try {
    const st = lstatSync(stickersDir)
    if (st.isSymbolicLink()) throw new StudioPackError('invalid_body', 'stickers must not be a symlink', 400)
    if (!st.isDirectory()) throw new StudioPackError('invalid_body', 'stickers must be a directory', 400)
    entries = readdirSync(stickersDir, { withFileTypes: true })
  } catch (error) {
    if (error instanceof StudioPackError) throw error
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return []
  }
  const out: StickerEntry[] = []
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
    const bytes = readFileSync(full)
    const fault = stickerFault(readWebpInfo(bytes))
    if (fault) throw new StudioPackError('invalid_body', `invalid sticker "${entry.name}": ${fault}`, 400)
    out.push({ name: entry.name, bytes })
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return out
}

function revisionOf(id: string, tree: TreeBytes, stickers: StickerEntry[]): string {
  const hash = createHash('sha256')
  hash.update(`id:${id}\n`)
  for (const name of STUDIO_FILES) {
    const bytes = tree[name as StudioFile]
    hash.update(`${name}:${bytes.length}\n`)
    hash.update(bytes)
    hash.update('\n')
  }
  for (const backup of tree.backups) {
    hash.update(`backup/${backup.name}:${backup.bytes.length}\n`)
    hash.update(backup.bytes)
    hash.update('\n')
  }
  for (const sticker of stickers) {
    hash.update(`stickers/${sticker.name}:${sticker.bytes.length}\n`)
    hash.update(sticker.bytes)
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
  assertPathSafe(deps.paths.root, dataDir, 'pack')
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

function auditKeyFor(opId: string): string {
  assertOpIdFormat(opId)
  return `revision:${opId}`
}

function ensureAuditRow(
  storage: StudioDeps['storage'] | RecoverDeps['storage'],
  id: string,
  opId: string,
  oldRevision: string,
  newRevision: string,
  now: () => Date
): void {
  const key = auditKeyFor(opId)
  storage.tx((db) => {
    const existing = db
      .prepare("SELECT 1 FROM setting_change WHERE target = 'pack' AND scope = ? AND key = ?")
      .get(id, key)
    if (existing !== undefined) return
    db.prepare(
      `INSERT INTO setting_change (target, actor, level, scope, key, old_value, new_value, changed_at)
       VALUES ('pack', ?, NULL, ?, ?, ?, ?, ?)`
    ).run(SITE_ACTOR, id, key, oldRevision === '' ? null : oldRevision, newRevision, isoNow(now))
  })
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Resolve the requested change by value so a YAML anchor shared by another
// field cannot silently change that field too.
function patchedValues(original: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const result = { ...original }
  for (const [key, value] of Object.entries(patch)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw new StudioPackError('invalid_body', 'invalid patch key', 400)
    }
    if (value === null) delete result[key]
    else if (isPlainObject(value)) result[key] = patchedValues(isPlainObject(original[key]) ? original[key] : {}, value)
    else if (value !== undefined) result[key] = value
  }
  return result
}

function applyPatchToDoc(doc: ReturnType<typeof parseDocument>, patch: Record<string, unknown>): boolean {
  const original = doc.toJS() as Record<string, unknown>
  const intended = patchedValues(original, patch)
  if (isDeepStrictEqual(original, intended)) return false
  applyNested(doc, [], patch)
  let actual: unknown
  try {
    actual = doc.toJS()
  } catch {
    throw new StudioPackError('conflict', 'Edit the linked YAML values together in the source file.', 409)
  }
  if (!isDeepStrictEqual(actual, intended)) {
    throw new StudioPackError('conflict', 'Edit the linked YAML values together in the source file.', 409)
  }
  return true
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

function stageStickers(entries: StickerEntry[], stagingDir: string): void {
  if (!entries.length) return
  const dir = join(stagingDir, 'stickers')
  ensureDirectory(dir)
  for (const entry of entries) writeFileAtomic(join(dir, entry.name), entry.bytes)
}

function validateStagedTree(stagingDir: string, id: string, validation?: StudioDeps['packValidation']): void {
  const tree = readTreeBytes(stagingDir)
  parseTree(id, tree)
  try {
    const pack = loadPack(stagingDir, 'data')
    if (validation && !checkLoadedPack(pack, validation.ceiling, validation.harnessRules).ok)
      throw new StudioPackError('invalid_body', 'prompt over the ceiling', 400)
  } catch (error) {
    if (error instanceof PackError) {
      const first = error.message.split('\n')[0] ?? 'invalid pack'
      throw new StudioPackError('pack_unparseable', first, 409)
    }
    throw error
  }
}

function assertSameFs(a: string, b: string): void {
  const aStat = statSync(a)
  const bStat = statSync(b)
  if (aStat.dev !== bStat.dev) {
    throw new StudioPackError('pack_unparseable', 'staging and characters must share one filesystem', 409)
  }
}

interface StudioJournal {
  version: number
  id: string
  opId: string
  oldRevision: string
  newRevision: string
  phase: JournalPhase
  at: string
}

function writeJournalAtomic(paths: StudioDeps['paths'] | RecoverDeps['paths'], journal: StudioJournal): void {
  assertPackId(journal.id)
  assertOpIdFormat(journal.opId)
  if (journal.oldRevision !== '') assertRevisionFormat(journal.oldRevision)
  assertRevisionFormat(journal.newRevision)
  assertPhaseFormat(journal.phase)
  const root = paths.root
  const stageRoot = stageRootOf(paths)
  const journalPath = journalPathFor(paths, journal.id)
  assertPathSafe(root, stageRoot, 'stage root')
  assertPathSafe(root, journalPath, 'journal')
  assertNotSymlink(journalPath, 'journal')
  ensureDirectory(stageRoot)
  assertNotSymlink(stageRoot, 'stage root')
  writeFileAtomic(journalPath, JSON.stringify(journal))
}

function readJournalValidated(paths: StudioDeps['paths'] | RecoverDeps['paths'], id: string): StudioJournal {
  assertPackId(id)
  const root = paths.root
  const journalPath = journalPathFor(paths, id)
  assertPathSafe(root, stageRootOf(paths), 'stage root')
  assertPathSafe(root, journalPath, 'journal')
  let raw: string
  try {
    const lst = lstatSync(journalPath)
    if (lst.isSymbolicLink()) throw new StudioPackError('invalid_body', 'journal must not be a symlink', 400)
    if (!lst.isFile() || lst.size > 8192) throw new StudioPackError('pack_unparseable', 'Invalid journal', 409)
    raw = readFileSync(journalPath, 'utf8')
  } catch (error) {
    if (error instanceof StudioPackError) throw error
    throw new StudioPackError('pack_unparseable', 'cannot read journal', 409)
  }
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch {
    throw new StudioPackError('pack_unparseable', 'invalid journal', 409)
  }
  // Paths never come from the journal: only the id (from the filename) is trusted.
  // Unknown fields are ignored so a newer writer stays readable.
  if (!isPlainObject(parsed) || parsed['version'] !== JOURNAL_VERSION)
    throw new StudioPackError('pack_unparseable', 'invalid journal', 409)
  if (parsed['id'] !== id) throw new StudioPackError('pack_unparseable', 'invalid journal', 409)
  if (typeof parsed['opId'] !== 'string') throw new StudioPackError('pack_unparseable', 'invalid journal', 409)
  if (typeof parsed['oldRevision'] !== 'string' || typeof parsed['newRevision'] !== 'string') {
    throw new StudioPackError('pack_unparseable', 'invalid journal', 409)
  }
  if (typeof parsed['phase'] !== 'string' || typeof parsed['at'] !== 'string') {
    throw new StudioPackError('pack_unparseable', 'invalid journal', 409)
  }
  assertOpIdFormat(parsed['opId'] as string)
  if ((parsed['oldRevision'] as string) !== '') assertRevisionFormat(parsed['oldRevision'] as string)
  assertRevisionFormat(parsed['newRevision'] as string)
  assertPhaseFormat(parsed['phase'])
  return {
    version: JOURNAL_VERSION,
    id,
    opId: parsed['opId'] as string,
    oldRevision: parsed['oldRevision'] as string,
    newRevision: parsed['newRevision'] as string,
    phase: parsed['phase'] as JournalPhase,
    at: parsed['at'] as string
  }
}

function tryReadRevision(dir: string, id: string): string | undefined {
  try {
    const lst = lstatSync(dir)
    if (lst.isSymbolicLink()) return undefined
    if (!lst.isDirectory()) return undefined
    const tree = readTreeBytes(dir)
    const stickers = readStickerEntries(dir)
    const revision = revisionOf(id, tree, stickers)
    parseTree(id, tree)
    return revision
  } catch {
    return undefined
  }
}

function stagingDirFor(paths: StudioDeps['paths'] | RecoverDeps['paths'], id: string): string {
  return join(stagingParentFor(paths, id), id)
}

function backupDirFor(paths: StudioDeps['paths'] | RecoverDeps['paths'], id: string): string {
  return join(backupParentFor(paths, id), id)
}

function reconcileOnePack(deps: RecoverDeps, id: string): boolean {
  assertPackId(id)
  const root = deps.paths.root
  const journalPath = journalPathFor(deps.paths, id)
  if (!existsSync(journalPath)) return false
  const journal = readJournalValidated(deps.paths, id)
  const targetDir = dataDirFor(deps.paths, id)
  const stagingDir = stagingDirFor(deps.paths, id)
  const backupDir = backupDirFor(deps.paths, id)
  const stagingParent = stagingParentFor(deps.paths, id)
  const backupParent = backupParentFor(deps.paths, id)
  assertPathSafe(root, charactersDirOf(deps.paths), 'characters root')
  assertPathSafe(root, stageRootOf(deps.paths), 'stage root')
  assertPathSafe(root, stagingParent, 'staging parent')
  assertPathSafe(root, backupParent, 'backup parent')
  assertPathSafe(root, targetDir, 'pack')
  assertPathSafe(root, stagingDir, 'staging')
  assertPathSafe(root, backupDir, 'backup')
  assertPathSafe(root, journalPath, 'journal')
  const targetExists = existsSync(targetDir)
  const currentRevision = targetExists ? tryReadRevision(targetDir, id) : undefined
  const stagingComplete =
    existsSync(join(stagingDir, 'card.yml')) &&
    existsSync(join(stagingDir, 'moods.yml')) &&
    existsSync(join(stagingDir, 'lines.yml'))
  let stagingRevision: string | undefined
  if (stagingComplete) {
    try {
      validateStagedTree(stagingDir, id)
      stagingRevision = revisionOf(id, readTreeBytes(stagingDir), readStickerEntries(stagingDir))
    } catch {
      stagingRevision = undefined
    }
  }
  const backupExists = existsSync(backupDir)
  let backupRevision: string | undefined
  if (backupExists) backupRevision = tryReadRevision(backupDir, id)
  if (backupExists && backupRevision !== journal.oldRevision)
    throw new StudioPackError('conflict', 'Backup changed during publication', 409)
  if (currentRevision === journal.newRevision) {
    ensureAuditRow(deps.storage, id, journal.opId, journal.oldRevision, journal.newRevision, () => new Date(journal.at))
    cleanStageDir(stagingParent)
    retireBackup(backupDir, id, journal.oldRevision, journal.opId)
    removeJournal(journalPath)
    return true
  }
  const isCreate = journal.oldRevision === ''
  const targetMatchesOld = isCreate ? !targetExists : currentRevision === journal.oldRevision
  if (targetMatchesOld) {
    if (stagingRevision !== journal.newRevision) {
      throw new StudioPackError('pack_unparseable', 'interrupted publish has no valid staged tree', 409)
    }
    if (isCreate) {
      if (targetExists) throw new StudioPackError('conflict', 'pack changed during publish', 409)
      ensureDirectory(charactersDirOf(deps.paths))
      assertSameFs(stagingDir, charactersDirOf(deps.paths))
      renamePack(stagingDir, targetDir)
      writeJournalAtomic(deps.paths, { ...journal, phase: 'swapped' })
      ensureAuditRow(
        deps.storage,
        id,
        journal.opId,
        journal.oldRevision,
        journal.newRevision,
        () => new Date(journal.at)
      )
      writeJournalAtomic(deps.paths, { ...journal, phase: 'audited' })
      cleanStageDir(stagingParent)
      retireBackup(backupDir, id, journal.oldRevision, journal.opId)
      removeJournal(journalPath)
      return true
    }
    if (!existsSync(backupDir)) {
      ensureDirectory(backupParent)
      assertSameFs(targetDir, backupParent)
      assertNotSymlink(targetDir, 'pack')
      assertNotSymlink(backupDir, 'backup')
      moveVerifiedBackup(targetDir, backupDir, id, journal.oldRevision)
      writeJournalAtomic(deps.paths, { ...journal, phase: 'backed-up' })
    }
    assertSameFs(stagingDir, charactersDirOf(deps.paths))
    assertNotSymlink(stagingDir, 'staging')
    assertNotSymlink(targetDir, 'pack')
    renamePack(stagingDir, targetDir)
    writeJournalAtomic(deps.paths, { ...journal, phase: 'swapped' })
    ensureAuditRow(deps.storage, id, journal.opId, journal.oldRevision, journal.newRevision, () => new Date(journal.at))
    writeJournalAtomic(deps.paths, { ...journal, phase: 'audited' })
    cleanStageDir(stagingParent)
    retireBackup(backupDir, id, journal.oldRevision, journal.opId)
    removeJournal(journalPath)
    return true
  }
  if (!targetExists && backupRevision === journal.oldRevision && stagingRevision === journal.newRevision) {
    ensureDirectory(charactersDirOf(deps.paths))
    assertSameFs(stagingDir, charactersDirOf(deps.paths))
    assertNotSymlink(stagingDir, 'staging')
    assertNotSymlink(targetDir, 'pack')
    renamePack(stagingDir, targetDir)
    writeJournalAtomic(deps.paths, { ...journal, phase: 'swapped' })
    ensureAuditRow(deps.storage, id, journal.opId, journal.oldRevision, journal.newRevision, () => new Date(journal.at))
    writeJournalAtomic(deps.paths, { ...journal, phase: 'audited' })
    cleanStageDir(stagingParent)
    retireBackup(backupDir, id, journal.oldRevision, journal.opId)
    removeJournal(journalPath)
    return true
  }
  if (
    !targetExists &&
    backupExists &&
    backupRevision === journal.oldRevision &&
    stagingRevision !== journal.newRevision
  ) {
    renamePack(backupDir, targetDir)
    cleanStageDir(stagingParent)
    cleanStageDir(backupParent)
    removeJournal(journalPath)
    return true
  }
  // The target moved somewhere neither the journal's old nor new revision predicts:
  // an external edit landed mid-publish. Never restore the prior version over it.
  // Keep the journal, the backup and the staging tree for the operator and refuse.
  throw new StudioPackError('conflict', 'pack changed during publish', 409)
}

function maybeReconcile(deps: RecoverDeps, id: string): void {
  if (publishing) return
  const journalPath = journalPathFor(deps.paths, id)
  if (!existsSync(journalPath)) return
  reconcileOnePack(deps, id)
}

/** Reads the authoritative tree and derives its opaque revision. Throws when the pack is missing or invalid. */
export function getStudioPack(deps: ReadDeps, id: string): StudioPackRead {
  assertPackId(id)
  const recoverDeps = deps as unknown as RecoverDeps
  if ('storage' in deps) maybeReconcile(recoverDeps as RecoverDeps, id)
  const located = locatePack(deps, id)
  const tree = readTreeBytes(located.dir, located.source === 'repository')
  const stickers = readStickerEntries(located.dir)
  const docs = parseTree(id, tree)
  try {
    loadPack(located.dir, located.source)
  } catch {
    throw new StudioPackError('pack_unparseable', 'Invalid character pack', 409)
  }
  return {
    id,
    source: located.source,
    writable: located.source === 'data',
    revision: revisionOf(id, tree, stickers),
    card: docs.card,
    moods: docs.moods,
    lines: docs.lines
  }
}

/** File browsing can show validated documents from a loaded pack that Studio cannot safely replace. */
export function getProfileDocuments(deps: ReadDeps, id: string): StudioPackRead {
  try {
    return getStudioPack(deps, id)
  } catch (error) {
    if (
      !(error instanceof StudioPackError) ||
      !['invalid_body', 'too_large'].includes(error.code) ||
      deps.packs().packs.get(id)?.source !== 'data'
    )
      throw error
    const located = locatePack(deps, id)
    assertPathSafe(deps.paths.root, located.dir, 'pack')
    const tree = readDocumentBytes(located.dir)
    return { id, source: located.source, writable: false, revision: revisionOf(id, tree, []), ...parseTree(id, tree) }
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
  maybeReconcile(deps, id)
  const stagingParent = stagingParentFor(deps.paths, id)
  const stagingDir = join(stagingParent, id)
  const backupParent = backupParentFor(deps.paths, id)
  const journalPath = journalPathFor(deps.paths, id)
  assertPathSafe(deps.paths.root, stageRootOf(deps.paths), 'stage root')
  assertPathSafe(deps.paths.root, stagingParent, 'staging parent')
  assertPathSafe(deps.paths.root, backupParent, 'backup parent')
  assertPathSafe(deps.paths.root, stagingDir, 'staging')
  assertPathSafe(deps.paths.root, journalPath, 'journal')
  let journalWritten = false
  acquireWriter()
  try {
    rejectExistingId(deps, id)
    ensureDirectory(stagingParent)
    cleanStageDir(stagingDir)
    ensureDirectory(stagingDir)
    if (isCopy) {
      assertPackId(input.sourceId)
      const source = locatePack(deps, input.sourceId)
      const sourceTree = readTreeBytes(source.dir, source.source === 'repository')
      // A copy validates the source before it moves any bytes. The source is never modified.
      parseTree(input.sourceId, sourceTree)
      stageStickers(readStickerEntries(source.dir), stagingDir)
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
    validateStagedTree(stagingDir, id, deps.packValidation)
    const staged = readTreeBytes(stagingDir)
    const stagedStickers = readStickerEntries(stagingDir)
    const newRevision = revisionOf(id, staged, stagedStickers)
    const opId = randomBytes(16).toString('hex')
    const at = now().toISOString()
    writeJournalAtomic(deps.paths, {
      version: JOURNAL_VERSION,
      id,
      opId,
      oldRevision: '',
      newRevision,
      phase: 'staged',
      at
    })
    journalWritten = true
    const targetDir = dataDirFor(deps.paths, id)
    assertPathSafe(deps.paths.root, targetDir, 'pack')
    if (existsSync(targetDir)) throw new StudioPackError('conflict', `pack "${id}" already exists`, 409)
    ensureDirectory(charactersDirOf(deps.paths))
    assertSameFs(stagingDir, charactersDirOf(deps.paths))
    assertNotSymlink(stagingDir, 'staging')
    assertNotSymlink(targetDir, 'pack')
    renamePack(stagingDir, targetDir)
    writeJournalAtomic(deps.paths, {
      version: JOURNAL_VERSION,
      id,
      opId,
      oldRevision: '',
      newRevision,
      phase: 'swapped',
      at
    })
    ensureAuditRow(deps.storage, id, opId, '', newRevision, () => new Date(at))
    writeJournalAtomic(deps.paths, {
      version: JOURNAL_VERSION,
      id,
      opId,
      oldRevision: '',
      newRevision,
      phase: 'audited',
      at
    })
    cleanStageDir(stagingParent)
    cleanStageDir(backupParent)
    removeJournal(journalPath)
    return { id, revision: newRevision, changed: true }
  } catch (error) {
    if (!journalWritten) {
      cleanStageDir(stagingParent)
      rmSync(journalPath, { force: true })
    }
    throw error
  } finally {
    releaseWriter()
  }
}

function retireBackup(backupDir: string, id: string, revision: string, opId: string) {
  const parent = dirname(backupDir)
  if (existsSync(backupDir)) {
    if (tryReadRevision(backupDir, id) !== revision)
      throw new StudioPackError('conflict', 'Backup changed during publication', 409)
    renamePack(backupDir, join(parent, 'retired-' + opId))
  }
  cleanStageDir(parent)
}

function removeJournal(path: string) {
  rmSync(path)
  syncDir(dirname(path))
}

function moveVerifiedBackup(target: string, backup: string, id: string, expected: string) {
  renamePack(target, backup)
  if (tryReadRevision(backup, id) !== expected) {
    if (!existsSync(target)) renamePack(backup, target)
    throw new StudioPackError('conflict', 'Source changed during publication', 409)
  }
}

function ensureDirectory(dir: string): void {
  if (existsSync(dir)) return
  ensureDirectory(dirname(dir))
  mkdirSync(dir, { mode: 0o700 })
  syncDir(dirname(dir))
}

function renamePack(from: string, to: string) {
  renameSync(from, to)
  syncDir(dirname(to))
  if (dirname(from) !== dirname(to)) syncDir(dirname(from))
}

function toStableYaml(value: unknown): string {
  return stringify(value)
}

/** Patches one data pack. Preserves comments, keeps unchanged bytes and writes one audit row on change. */
export function updateStudioPack(
  deps: StudioDeps,
  id: string,
  input: StudioUpdateInput,
  expression?: { file: string; data: Buffer }
): StudioPackWriteResult {
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
  maybeReconcile(deps, id)
  const located = locatePack({ paths: deps.paths, packs: deps.packs }, id)
  if (located.source !== 'data') throw new StudioPackError('pack_read_only', 'repository packs are read-only', 409)
  const stagingParent = stagingParentFor(deps.paths, id)
  const stagingDir = join(stagingParent, id)
  const backupParent = backupParentFor(deps.paths, id)
  const backupDir = join(backupParent, id)
  const journalPath = journalPathFor(deps.paths, id)
  assertPathSafe(deps.paths.root, stageRootOf(deps.paths), 'stage root')
  assertPathSafe(deps.paths.root, stagingParent, 'staging parent')
  assertPathSafe(deps.paths.root, backupParent, 'backup parent')
  assertPathSafe(deps.paths.root, stagingDir, 'staging')
  assertPathSafe(deps.paths.root, backupDir, 'backup')
  assertPathSafe(deps.paths.root, journalPath, 'journal')
  let journalWritten = false
  acquireWriter()
  try {
    const targetDir = dataDirFor(deps.paths, id)
    assertPathSafe(deps.paths.root, targetDir, 'pack')
    const current = readTreeBytes(targetDir)
    const currentStickers = readStickerEntries(targetDir)
    const oldRevision = revisionOf(id, current, currentStickers)
    if (input.expectedRevision !== oldRevision) {
      throw new StudioPackError('stale_revision', 'the pack changed since it was read', 409)
    }
    if (expression) {
      if (currentStickers.length >= 50) throw new StudioPackError('conflict', 'Gallery full', 409)
      if (currentStickers.some((sticker) => sticker.name === expression.file))
        throw new StudioPackError('conflict', 'Name already used', 409)
    }
    const hasPatch =
      (input.card !== undefined && Object.keys(input.card as Record<string, unknown>).length > 0) ||
      (input.moods !== undefined && Object.keys(input.moods as Record<string, unknown>).length > 0) ||
      (input.lines !== undefined && Object.keys(input.lines as Record<string, unknown>).length > 0)
    if (!hasPatch && !expression) return { id, revision: oldRevision, changed: false }
    const cardDoc = parseYamlDocument(current['card.yml'])
    const moodsDoc = parseYamlDocument(current['moods.yml'])
    const linesDoc = parseYamlDocument(current['lines.yml'])
    const cardChanged = input.card !== undefined && applyPatchToDoc(cardDoc, input.card as Record<string, unknown>)
    const moodsChanged = input.moods !== undefined && applyPatchToDoc(moodsDoc, input.moods as Record<string, unknown>)
    const linesChanged = input.lines !== undefined && applyPatchToDoc(linesDoc, input.lines as Record<string, unknown>)
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
      'card.yml': cardChanged ? cardDoc.toString() : current['card.yml'].toString('utf8'),
      'moods.yml': moodsChanged ? moodsDoc.toString() : current['moods.yml'].toString('utf8'),
      'lines.yml': linesChanged ? linesDoc.toString() : current['lines.yml'].toString('utf8')
    }
    const currentTexts: Record<StudioFile, string> = {
      'card.yml': current['card.yml'].toString('utf8'),
      'moods.yml': current['moods.yml'].toString('utf8'),
      'lines.yml': current['lines.yml'].toString('utf8')
    }
    if (
      !expression &&
      nextTexts['card.yml'] === currentTexts['card.yml'] &&
      nextTexts['moods.yml'] === currentTexts['moods.yml'] &&
      nextTexts['lines.yml'] === currentTexts['lines.yml']
    ) {
      return { id, revision: oldRevision, changed: false }
    }
    ensureDirectory(stagingParent)
    cleanStageDir(stagingDir)
    ensureDirectory(stagingDir)
    // Unchanged files keep their exact bytes; changed files keep their comments through Document editing.
    for (const name of STUDIO_FILES) {
      const text = nextTexts[name] === currentTexts[name] ? current[name as StudioFile] : Buffer.from(nextTexts[name])
      writeFileAtomic(join(stagingDir, name), text)
    }
    // Same-filesystem links retain owner, permissions and bytes. Studio never writes these files.
    for (const backup of current.backups) linkSync(join(targetDir, backup.name), join(stagingDir, backup.name))
    stageStickers(currentStickers, stagingDir)
    if (expression) {
      ensureDirectory(join(stagingDir, 'stickers'))
      writeFileAtomic(join(stagingDir, 'stickers', expression.file), expression.data)
    }
    validateStagedTree(stagingDir, id, deps.packValidation)
    const staged = readTreeBytes(stagingDir)
    const stagedStickers = readStickerEntries(stagingDir)
    const newRevision = revisionOf(id, staged, stagedStickers)
    if (newRevision === oldRevision) {
      cleanStageDir(stagingParent)
      return { id, revision: oldRevision, changed: false }
    }
    // Re-read before publish so an external edit is a stale revision, not a silent overwrite.
    const reread = readTreeBytes(targetDir)
    const rereadStickers = readStickerEntries(targetDir)
    if (revisionOf(id, reread, rereadStickers) !== input.expectedRevision) {
      cleanStageDir(stagingParent)
      throw new StudioPackError('stale_revision', 'the pack changed since it was read', 409)
    }
    const opId = randomBytes(16).toString('hex')
    const at = now().toISOString()
    writeJournalAtomic(deps.paths, {
      version: JOURNAL_VERSION,
      id,
      opId,
      oldRevision,
      newRevision,
      phase: 'staged',
      at
    })
    journalWritten = true
    if (existsSync(backupDir)) throw new StudioPackError('conflict', 'Unexpected backup', 409)
    ensureDirectory(backupParent)
    assertSameFs(targetDir, backupParent)
    assertNotSymlink(targetDir, 'pack')
    assertNotSymlink(backupDir, 'backup')
    moveVerifiedBackup(targetDir, backupDir, id, oldRevision)
    writeJournalAtomic(deps.paths, {
      version: JOURNAL_VERSION,
      id,
      opId,
      oldRevision,
      newRevision,
      phase: 'backed-up',
      at
    })
    assertSameFs(stagingDir, charactersDirOf(deps.paths))
    assertNotSymlink(stagingDir, 'staging')
    assertNotSymlink(targetDir, 'pack')
    renamePack(stagingDir, targetDir)
    writeJournalAtomic(deps.paths, {
      version: JOURNAL_VERSION,
      id,
      opId,
      oldRevision,
      newRevision,
      phase: 'swapped',
      at
    })
    ensureAuditRow(deps.storage, id, opId, oldRevision, newRevision, () => new Date(at))
    writeJournalAtomic(deps.paths, {
      version: JOURNAL_VERSION,
      id,
      opId,
      oldRevision,
      newRevision,
      phase: 'audited',
      at
    })
    cleanStageDir(stagingParent)
    retireBackup(backupDir, id, oldRevision, opId)
    removeJournal(journalPath)
    return { id, revision: newRevision, changed: true }
  } catch (error) {
    if (!journalWritten) cleanStageDir(stagingParent)
    if (error instanceof StudioPackError && error.code === 'stale_revision' && !journalWritten) {
      cleanStageDir(stagingParent)
    }
    throw error
  } finally {
    releaseWriter()
  }
}

export type StudioFooterDeps = Pick<SiteApiDeps, 'storage' | 'paths' | 'packs' | 'registry'> & {
  now?: () => Date
}

export interface StudioFooterUpdateInput {
  expectedRevision: string
  icon?: string | null
  labels?: Record<string, string | null>
}

export interface StudioFooterWriteResult {
  id: string
  revision: string
  toolFooter: { icon?: string; labels?: Record<string, string> }
  changed: boolean
}

export interface StudioFooterRead {
  id: string
  revision: string
  toolFooter: { icon?: string; labels?: Record<string, string> }
  writable: boolean
  source: 'repository' | 'data'
}

function knownFooterKinds(registry: ToolRegistry): Set<string> {
  const kinds = new Set<string>(Object.keys(DEFAULT_TOOL_LABELS))
  for (const tool of registry.all()) kinds.add(tool.name)
  return kinds
}

function toolFooterOf(card: StudioCard): { icon?: string; labels?: Record<string, string> } {
  return card.toolFooter ?? {}
}

/** Reads one pack's footer with its opaque revision for the owner preview flow. */
export function getStudioFooter(deps: ReadDeps, id: string): StudioFooterRead {
  const pack = getStudioPack(deps, id)
  return {
    id: pack.id,
    revision: pack.revision,
    toolFooter: toolFooterOf(pack.card),
    writable: pack.writable,
    source: pack.source
  }
}

/**
 * Edits a data pack's `toolFooter` through the existing atomic pack writer.
 * Validation mirrors `CharacterFooterWriter`: unknown kinds are 400
 * `unknown_footer_kind`, bad icon or label values are 400 `invalid_footer`,
 * a missing revision is 428 `revision_required`, and a stale revision is 409
 * `stale_revision` with no write. A patch that changes nothing returns
 * `changed: false` with the current revision and writes no audit row.
 * A change publishes once with a single redacted `setting_change` row.
 */
export function updateStudioFooter(
  deps: StudioFooterDeps,
  id: string,
  input: StudioFooterUpdateInput
): StudioFooterWriteResult {
  assertPackId(id)
  if (!isPlainObject(input)) throw new StudioPackError('invalid_body', 'invalid footer body', 400)
  const expectedRevision = (input as { expectedRevision?: unknown }).expectedRevision
  if (expectedRevision === undefined || expectedRevision === null || expectedRevision === '') {
    throw new StudioPackError('revision_required', 'expectedRevision is required', 428)
  }
  if (typeof expectedRevision !== 'string') {
    throw new StudioPackError('invalid_body', 'expectedRevision must be a revision string', 400)
  }
  assertRevisionFormat(expectedRevision)
  const rawIcon = (input as { icon?: unknown }).icon
  const rawLabels = (input as { labels?: unknown }).labels
  if (rawIcon !== undefined && rawIcon !== null && typeof rawIcon !== 'string') {
    throw new StudioPackError('invalid_body', 'icon must be a string or null', 400)
  }
  if (rawLabels !== undefined) {
    if (!isPlainObject(rawLabels)) throw new StudioPackError('invalid_body', 'labels must be an object', 400)
    for (const [kind, value] of Object.entries(rawLabels as Record<string, unknown>)) {
      if (value !== null && typeof value !== 'string') {
        throw new StudioPackError('invalid_body', `label "${kind}" must be a string or null`, 400)
      }
    }
  }
  const icon = rawIcon as string | null | undefined
  const labels = rawLabels as Record<string, string | null> | undefined

  const knownKinds = knownFooterKinds(deps.registry)
  if (labels) {
    for (const kind of Object.keys(labels)) {
      if (!knownKinds.has(kind)) throw new StudioPackError('unknown_footer_kind', `unknown footer kind "${kind}"`, 400)
    }
    for (const [kind, value] of Object.entries(labels)) {
      if (value === null) continue
      if (!footerLabelSchema.safeParse(value).success) {
        throw new StudioPackError('invalid_footer', `invalid label for "${kind}"`, 400)
      }
    }
  }
  if (typeof icon === 'string' && !footerEmojiSchema.safeParse(icon).success) {
    throw new StudioPackError('invalid_footer', 'invalid footer icon', 400)
  }

  const current = getStudioFooter(deps, id)
  if (!current.writable) throw new StudioPackError('pack_read_only', 'repository packs are read-only', 409)
  if (current.revision !== expectedRevision) {
    throw new StudioPackError('stale_revision', 'the pack changed since it was read', 409)
  }

  const beforeIcon = current.toolFooter.icon
  const beforeLabels = current.toolFooter.labels ?? {}
  let iconChanged = false
  if (icon !== undefined) {
    const nextIcon = icon === null ? undefined : icon
    iconChanged = nextIcon !== beforeIcon
  }
  const labelPatch: Record<string, string | null> = {}
  let labelsChanged = false
  if (labels) {
    for (const [kind, value] of Object.entries(labels)) {
      const had = Object.hasOwn(beforeLabels, kind)
      const prev = had ? beforeLabels[kind] : undefined
      if (value === null) {
        if (had) {
          labelPatch[kind] = null
          labelsChanged = true
        }
        continue
      }
      if (prev !== value) {
        labelPatch[kind] = value
        labelsChanged = true
      }
    }
  }
  if (!iconChanged && !labelsChanged) {
    return { id, revision: current.revision, toolFooter: current.toolFooter, changed: false }
  }

  const toolFooterPatch: { icon?: string | null; labels?: Record<string, string | null> } = {}
  if (iconChanged) toolFooterPatch.icon = icon as string | null
  if (labelsChanged) toolFooterPatch.labels = labelPatch

  let published: StudioPackWriteResult
  try {
    published = updateStudioPack(deps, id, { expectedRevision, card: { toolFooter: toolFooterPatch } })
  } catch (error) {
    if (error instanceof StudioPackError && error.code === 'invalid_body') {
      throw new StudioPackError('invalid_footer', 'invalid footer value', 400)
    }
    throw error
  }
  const reread = getStudioFooter(deps, id)
  if (reread.revision !== published.revision) {
    throw new StudioPackError('pack_unparseable', 'footer readback mismatch', 409)
  }
  return { id, revision: published.revision, toolFooter: reread.toolFooter, changed: published.changed }
}

/** A pending tree stays unavailable to turns until a complete publish or explicit reconciliation. */
export function pendingStudioPacks(paths: RecoverDeps['paths']): Set<string> {
  const root = stageRootOf(paths)
  assertPathSafe(paths.root, root, 'stage root')
  if (!existsSync(root)) return new Set()
  return new Set(
    readdirSync(root)
      .filter((name) => name.endsWith(JOURNAL_SUFFIX))
      .map((name) => name.slice(0, -JOURNAL_SUFFIX.length))
  )
}

/** Replays an interrupted publish after restart. Never trusts paths from the journal. */
export function recoverStudioPacks(deps: RecoverDeps, onConflict?: (id: string) => void): { recovered: string[] } {
  if (publishing) throw new StudioPackError('busy', 'another pack publish is in progress', 409)
  const stageRoot = stageRootOf(deps.paths)
  if (!existsSync(stageRoot)) return { recovered: [] }
  assertPathSafe(deps.paths.root, stageRoot, 'stage root')
  assertNotSymlink(stageRoot, 'stage root')
  const recovered: string[] = []
  const entries = readdirSync(stageRoot, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  )
  for (const entry of entries) {
    if (!entry.name.endsWith(JOURNAL_SUFFIX)) continue
    const rawId = entry.name.slice(0, -JOURNAL_SUFFIX.length)
    if (!PACK_ID.test(rawId)) {
      if (onConflict) continue
      throw new StudioPackError('pack_unparseable', 'Invalid journal filename', 409)
    }
    try {
      if (!entry.isFile()) throw new StudioPackError('pack_unparseable', 'Invalid journal type', 409)
      if (reconcileOnePack(deps, rawId)) recovered.push(rawId)
    } catch (error) {
      if (!onConflict) throw error
      onConflict(rawId)
    }
  }
  return { recovered }
}

// YAML helpers localised here so Document editing preserves comments and unknown fields.
function parseYamlDocument(bytes: Buffer): ReturnType<typeof parseDocument> {
  const doc = parseDocument(bytes.toString('utf8'))
  if (doc.errors.length > 0) throw new StudioPackError('pack_unparseable', 'pack does not parse', 409)
  return doc
}

export function studioExpressionStore(deps: StudioDeps): StudioExpressionStore {
  function checked<T>(fn: () => T): T {
    try {
      return fn()
    } catch (error) {
      if (error instanceof StudioPackError) {
        if (
          error.code === 'invalid_footer' ||
          error.code === 'unknown_footer_kind' ||
          error.code === 'revision_required'
        ) {
          throw new StudioExpressionStoreError('invalid_body', error.status)
        }
        throw new StudioExpressionStoreError(error.code, error.status)
      }
      throw error
    }
  }
  function snapshot(id: string) {
    const pack = getStudioPack(deps, id)
    const { dir } = locatePack(deps, id)
    return { pack, stickers: readStickerEntries(dir) }
  }
  return {
    list: (id) =>
      checked(() => {
        const { pack, stickers } = snapshot(id)
        return {
          revision: pack.revision,
          expressions: stickers.map(({ name }) => ({
            name: name.slice(0, -5),
            description: pack.card.expressionDescriptions?.[name] ?? ''
          }))
        }
      }),
    read: (id, name) =>
      checked(() => {
        const entry = snapshot(id).stickers.find((sticker) => sticker.name === name + '.webp')
        if (!entry) throw new StudioPackError('not_found', 'Expression missing', 404)
        return entry.bytes
      }),
    publish: (id, expectedRevision, name, description, data) =>
      checked(() => {
        if (!PACK_ID.test(name) || data.length > 102400 || description.length > 300)
          throw new StudioPackError('invalid_body', 'Invalid expression', 400)
        const file = name + '.webp'
        return updateStudioPack(
          deps,
          id,
          { expectedRevision, card: { expressionDescriptions: { [file]: description } } },
          { file, data }
        )
      })
  }
}
