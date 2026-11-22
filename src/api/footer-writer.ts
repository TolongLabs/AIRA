import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { isMap, parseDocument } from 'yaml'
import { z } from 'zod'
import { loadPack } from '../character/loader.js'
import { cardSchema, footerLabelSchema, PACK_ID } from '../character/schema.js'
import { isoNow } from '../storage/database.js'
import { footerKindsFor, type RouteResult, type SiteApiDeps } from './routes.js'

const SITE_ACTOR = 'site'

const footerBody = z.strictObject({
  icon: z.union([z.string(), z.null()]).optional(),
  labels: z.record(z.string(), z.union([z.string(), z.null()])).optional()
})

type FooterPatch = z.infer<typeof footerBody>
type CardData = z.infer<typeof cardSchema>
type ParsedYamlDoc = ReturnType<typeof parseDocument>

interface FooterChange {
  key: string
  oldValue: string | null
  newValue: string | null
}

type PackLocation = { ok: true; dir: string; wasFaulted: boolean } | { ok: false; result: RouteResult }
type ReadCardResult =
  { ok: true; oldBytes: Buffer; doc: ParsedYamlDoc; card: CardData } | { ok: false; result: RouteResult }
type PatchResult = { ok: true; card: CardData } | { ok: false; result: RouteResult }

/** Edits a data pack's `toolFooter` in `card.yml` atomically with its `setting_change` audit rows. */
export class CharacterFooterWriter {
  constructor(private readonly deps: SiteApiDeps) {}

  write(id: string, body: unknown): RouteResult {
    const parsed = footerBody.safeParse(body)
    if (!parsed.success) return { status: 400, body: { error: 'invalid_body' } }

    const resolved = this.resolveDataPackDir(id)
    if (!resolved.ok) return resolved.result
    const { dir, wasFaulted } = resolved

    const cardPath = join(dir, 'card.yml')
    const current = this.readCurrentCard(cardPath)
    if (!current.ok) return current.result

    const patched = this.applyPatch(current.doc, parsed.data)
    if (!patched.ok) return patched.result

    const changes = this.computeChanges(current.card.toolFooter, patched.card.toolFooter)
    if (changes.length === 0) {
      return { status: 200, body: { id, toolFooter: current.card.toolFooter ?? {}, changed: false } }
    }

    const tmpPath = join(dir, 'card.yml.tmp')
    const rowIds = this.commitChanges(id, cardPath, tmpPath, current.doc.toString(), current.oldBytes, changes)

    try {
      loadPack(dir, 'data')
    } catch {
      this.rollbackAfterReloadFailure(cardPath, tmpPath, current.oldBytes, rowIds)
      return {
        status: wasFaulted ? 409 : 400,
        body: { error: wasFaulted ? 'pack_unparseable' : 'invalid_footer' }
      }
    }

    return { status: 200, body: { id, toolFooter: patched.card.toolFooter ?? {}, changed: true } }
  }

  private resolveDataPackDir(id: string): PackLocation {
    if (!PACK_ID.test(id)) return { ok: false, result: { status: 404, body: { error: 'not_found' } } }
    const set = this.deps.packs()
    const loaded = set.packs.get(id)
    if (loaded) {
      if (loaded.source !== 'data') return { ok: false, result: { status: 409, body: { error: 'pack_read_only' } } }
      return { ok: true, dir: loaded.dir, wasFaulted: false }
    }
    const fault = set.faults.find((entry) => entry.id === id)
    if (!fault) return { ok: false, result: { status: 404, body: { error: 'not_found' } } }
    if (resolve(fault.dir) !== resolve(join(this.deps.paths.root, 'characters', id))) {
      return { ok: false, result: { status: 409, body: { error: 'pack_read_only' } } }
    }
    return { ok: true, dir: fault.dir, wasFaulted: true }
  }

  private readCurrentCard(cardPath: string): ReadCardResult {
    let oldBytes: Buffer
    try {
      oldBytes = readFileSync(cardPath)
    } catch {
      return { ok: false, result: { status: 409, body: { error: 'pack_unparseable' } } }
    }

    let doc: ParsedYamlDoc
    let currentRaw: unknown
    try {
      doc = parseDocument(oldBytes.toString('utf8'))
      if (doc.errors.length > 0) return { ok: false, result: { status: 409, body: { error: 'pack_unparseable' } } }
      currentRaw = doc.toJS()
    } catch {
      return { ok: false, result: { status: 409, body: { error: 'pack_unparseable' } } }
    }

    const currentParsed = cardSchema.safeParse(currentRaw)
    if (!currentParsed.success) return { ok: false, result: { status: 409, body: { error: 'pack_unparseable' } } }
    return { ok: true, oldBytes, doc, card: currentParsed.data }
  }

  private applyPatch(doc: ParsedYamlDoc, patch: FooterPatch): PatchResult {
    if (patch.labels) {
      const knownKinds = new Set(footerKindsFor(this.deps.registry).map((entry) => entry.kind))
      for (const kind of Object.keys(patch.labels)) {
        if (!knownKinds.has(kind)) return { ok: false, result: { status: 400, body: { error: 'unknown_footer_kind' } } }
      }
    }

    if (patch.icon === null) {
      doc.deleteIn(['toolFooter', 'icon'])
    } else if (patch.icon !== undefined) {
      doc.setIn(['toolFooter', 'icon'], patch.icon)
    }

    if (patch.labels) {
      for (const [kind, value] of Object.entries(patch.labels)) {
        if (value === null) {
          doc.deleteIn(['toolFooter', 'labels', kind])
        } else {
          const checked = footerLabelSchema.safeParse(value)
          if (!checked.success) return { ok: false, result: { status: 400, body: { error: 'invalid_footer' } } }
          doc.setIn(['toolFooter', 'labels', kind], checked.data)
        }
      }
    }

    const labelsNode = doc.getIn(['toolFooter', 'labels'], true)
    if (isMap(labelsNode) && labelsNode.items.length === 0) doc.deleteIn(['toolFooter', 'labels'])
    const footerNode = doc.getIn(['toolFooter'], true)
    if (isMap(footerNode) && footerNode.items.length === 0) doc.deleteIn(['toolFooter'])

    const nextParsed = cardSchema.safeParse(doc.toJS())
    if (!nextParsed.success) return { ok: false, result: { status: 400, body: { error: 'invalid_footer' } } }
    return { ok: true, card: nextParsed.data }
  }

  private computeChanges(before: CardData['toolFooter'], after: CardData['toolFooter']): FooterChange[] {
    const changes: FooterChange[] = []
    if (before?.icon !== after?.icon) {
      changes.push({
        key: 'toolFooter.icon',
        oldValue: before?.icon === undefined ? null : JSON.stringify(before.icon),
        newValue: after?.icon === undefined ? null : JSON.stringify(after.icon)
      })
    }
    const oldLabels = before?.labels ?? {}
    const newLabels = after?.labels ?? {}
    const keys = new Set([...Object.keys(oldLabels), ...Object.keys(newLabels)])
    for (const kind of [...keys].sort()) {
      const prev = Object.hasOwn(oldLabels, kind) ? oldLabels[kind] : undefined
      const next = Object.hasOwn(newLabels, kind) ? newLabels[kind] : undefined
      if (prev !== next) {
        changes.push({
          key: `toolFooter.labels.${kind}`,
          oldValue: prev === undefined ? null : JSON.stringify(prev),
          newValue: next === undefined ? null : JSON.stringify(next)
        })
      }
    }
    return changes
  }

  private commitChanges(
    id: string,
    cardPath: string,
    tmpPath: string,
    nextText: string,
    oldBytes: Buffer,
    changes: readonly FooterChange[]
  ): number[] {
    const at = isoNow(this.deps.now)
    return this.deps.storage.tx((db) => {
      const rowIds: number[] = []
      this.writeCardAtomic(cardPath, tmpPath, nextText)
      try {
        const insert = db.prepare(
          `INSERT INTO setting_change (target, actor, level, scope, key, old_value, new_value, changed_at)
           VALUES ('pack', ?, NULL, ?, ?, ?, ?, ?)`
        )
        for (const change of changes) {
          const info = insert.run(SITE_ACTOR, id, change.key, change.oldValue, change.newValue, at)
          rowIds.push(Number(info.lastInsertRowid))
        }
        return rowIds
      } catch (error) {
        // File replacement is outside SQLite's rollback scope, so restore oldBytes before rethrowing.
        this.writeCardAtomic(cardPath, tmpPath, oldBytes)
        throw error
      }
    })
  }

  private rollbackAfterReloadFailure(
    cardPath: string,
    tmpPath: string,
    oldBytes: Buffer,
    rowIds: readonly number[]
  ): void {
    this.writeCardAtomic(cardPath, tmpPath, oldBytes)
    this.deps.storage.tx((db) => {
      const remove = db.prepare('DELETE FROM setting_change WHERE id = ?')
      for (const rowId of rowIds) remove.run(rowId)
    })
  }

  private writeCardAtomic(cardPath: string, tmpPath: string, content: string | Buffer): void {
    try {
      if (typeof content === 'string') {
        writeFileSync(tmpPath, content, 'utf8')
      } else {
        writeFileSync(tmpPath, content)
      }
      renameSync(tmpPath, cardPath)
    } catch (error) {
      try {
        unlinkSync(tmpPath)
      } catch {
        // ignore cleanup failure
      }
      throw error
    }
  }
}
