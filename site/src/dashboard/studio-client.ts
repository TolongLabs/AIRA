import { authHeaders, requestToken } from '@/lib/api'
import { dashboardHref } from './navigation'

/* Character Studio: the protected pack writer. Reads and writes go through the
 * core's protected prefix (/owner-api/core/…), never the tokenless /api/.
 * The orchestrator owns routing — these are the paths this UI links to. */

/** Required dashboard route paths (report): the orchestrator must mount views here. */
export const studioPaths = {
  /** Catalogue (this ships in ./characters). */
  catalogue: 'characters',
  /** Blank-pack creation (StudioEditor mode='create'). */
  create: 'characters/new',
  /** Copy-or-upload import (StudioEditor mode='import'). */
  import: 'characters/import',
  /** Per-persona editor (StudioEditor mode='edit'). Static routes win over this pattern. */
  edit: (id: string) => 'characters/' + encodeURIComponent(id) + '/edit',
  /** Per-persona tool wording (legacy footer route, per DESIGN.md). */
  footer: (id: string) => 'characters/' + encodeURIComponent(id) + '/footer',
  /** Same-origin simulator tab (StudioSimulator). */
  simulator: 'characters/simulator'
} as const

export function studioHref(path: string): string {
  return dashboardHref(path)
}

/* ── typed documents (mirror src/character/schema.ts; the server re-validates) ── */

export type ReplyLength = 'short' | 'default' | 'long'

export interface StudioCard {
  id: string
  displayName: string
  aliases?: string[]
  languages: string[]
  coreIdentity: string
  speechRules: string[]
  privateInstructions?: string
  expressionDescriptions?: Record<string, string>
  defaultReplyLength: ReplyLength
  capitaliseBubbles?: boolean
  toolFooter?: { icon?: string; labels?: Record<string, string> }
}

export interface StudioMoodEntry {
  patterns: string[]
  tone: string
  openers: string[]
  endings: string[]
  faces: string[]
  faceGroups?: string[]
  beats?: Record<string, number>
  stickers: string[]
}

export interface StudioMoodsDoc {
  default: string
  faceGroups?: Record<string, string[]>
  beats?: { name: string; line: string }[]
  moods: Record<string, StudioMoodEntry>
}

/** Fixed lines, keyed by line kind. */
export type StudioLinesDoc = Record<string, string>

export interface StudioDraft {
  card: StudioCard
  moods: StudioMoodsDoc
  lines: StudioLinesDoc
}

export interface StudioDoc extends StudioDraft {
  id: string
  source: 'repository' | 'data'
  writable: boolean
  revision: string
}

/** A JSON merge-patch fragment: partial objects, `null` deletes a key, arrays replace wholesale. */
export type MergePatch<T> = T extends readonly unknown[]
  ? T | null
  : T extends Record<string, unknown>
    ? { [K in keyof T]?: MergePatch<T[K]> | null } | null
    : T | null

/** The studio save patch: only the leaves that changed, against pristine. */
export interface StudioPatch {
  card?: MergePatch<StudioCard>
  moods?: MergePatch<StudioMoodsDoc>
  lines?: Record<string, string | null>
}

export class StudioError extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(code)
  }
}

async function studioFetch<T>(method: string, path: string, body?: unknown): Promise<T> {
  const url = '/owner-api/core/' + path.replace(/^\/+/, '')
  const send = () =>
    fetch(url, {
      method,
      headers: authHeaders({ accept: 'application/json', 'content-type': 'application/json' }),
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store'
    })
  let res = await send()
  if (res.status === 401) {
    await requestToken()
    res = await send()
  }
  const parsed = (await res.json().catch(() => ({}))) as { error?: string; revision?: string }
  if (!res.ok) throw new StudioError(res.status, typeof parsed.error === 'string' ? parsed.error : `http_${res.status}`)
  return parsed as T
}

/** GET /owner-api/core/characters/:id/studio — id, source, writability, revision, documents. */
export function getStudio(id: string, view?: 'documents'): Promise<StudioDoc> {
  return studioFetch<StudioDoc>('GET', `characters/${encodeURIComponent(id)}/studio` + (view ? '?view=documents' : ''))
}

/** PUT /owner-api/core/characters/:id/studio — a merge patch of the changed leaves, with `null` tombstones. */
export function putStudio(id: string, expectedRevision: string, patch: StudioPatch): Promise<{ revision: string }> {
  return studioFetch('PUT', `characters/${encodeURIComponent(id)}/studio`, { expectedRevision, patch })
}

/** POST /owner-api/core/characters — { id, card, moods, lines } or { id, sourceId }. */
export function postStudio(
  body:
    { id: string; card: StudioCard; moods: StudioMoodsDoc; lines: StudioLinesDoc } | { id: string; sourceId: string }
): Promise<{ id: string }> {
  return studioFetch('POST', 'characters', body)
}

/* ── validation (client-side mirror of the start-up validator; the server decides) ── */

export const PACK_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/
export const MOOD_KEY = /^[a-z][a-z0-9_]{0,31}$/
const STICKER_FILE = /^[a-z0-9][a-z0-9_-]*\.webp$/
const FOOTER_KEY = /^[a-z][a-z0-9_]{0,63}$/
const FOOTER_FORBIDDEN = /[_*~`<>\r\n\p{Cc}]/u
export const PROMPT_CEILING = 8000
export const REPLY_LENGTHS: Record<ReplyLength, number> = { short: 280, default: 600, long: 1400 }

export const LINE_KINDS = [
  'error',
  'limit',
  'refusal',
  'busy',
  'slow',
  'unreadableMedia',
  'fallback',
  'unavailable'
] as const

export const OPTIONAL_LINES = [
  'feedback',
  'researchStarted',
  'researchTopic',
  'researchBusy',
  'researchFailed',
  'offerPdf'
] as const

function isEmoji(value: string): boolean {
  return /\p{Extended_Pictographic}/u.test(value) && !/[\p{L}\p{N}\s]/u.test(value) && !FOOTER_FORBIDDEN.test(value)
}

function isFace(value: string): boolean {
  const match = /^([^()]{0,4})\(([^()\n]{1,20})\)([^()]{0,4})$/u.exec(value)
  return match !== null && !/[A-Za-z0-9]{2}/.test(match[2] ?? '')
}

const isLangTag = (value: string) => /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(value)

export function validateId(id: string): string[] {
  if (!PACK_ID.test(id)) return ['Id must be 1–64 chars: lowercase letters, digits, - or _, starting alphanumerically.']
  return []
}

export function validateCard(card: StudioCard): string[] {
  const faults: string[] = []
  faults.push(...validateId(card.id).map((f) => `card.id: ${f}`))
  if (!card.displayName.trim()) faults.push('card.displayName: give the character a display name.')
  for (const alias of card.aliases ?? [])
    if (alias.length < 2 || alias.length > 40) faults.push(`card.aliases: each alias is 2–40 characters ("${alias}").`)
  if (!card.languages.length) faults.push('card.languages: list at least one language tag (e.g. en).')
  for (const lang of card.languages)
    if (!isLangTag(lang)) faults.push(`card.languages: "${lang}" is not a language tag.`)
  if (!card.coreIdentity.trim()) faults.push('card.coreIdentity: describe who the character is.')
  const rules = card.speechRules.filter((r) => r.trim())
  if (!rules.length) faults.push('card.speechRules: add at least one speech rule.')
  if (!['short', 'default', 'long'].includes(card.defaultReplyLength))
    faults.push('card.defaultReplyLength: pick short, default or long.')
  const icon = card.toolFooter?.icon
  if (icon !== undefined && !isEmoji(icon)) faults.push('card.toolFooter.icon: use one emoji.')
  for (const [kind, label] of Object.entries(card.toolFooter?.labels ?? {})) {
    if (!FOOTER_KEY.test(kind)) faults.push(`card.toolFooter.labels: "${kind}" is not a valid footer kind.`)
    if (label.trim().length < 1 || label.trim().length > 40 || FOOTER_FORBIDDEN.test(label))
      faults.push(`card.toolFooter.labels.${kind}: 1–40 characters, no _ * ~ \` < > or line breaks.`)
  }
  return faults
}

export function validateMoods(moods: StudioMoodsDoc): string[] {
  const faults: string[] = []
  const keys = Object.keys(moods.moods)
  if (!keys.length) {
    faults.push('moods: define at least one mood.')
    return faults
  }
  if (!Object.hasOwn(moods.moods, moods.default))
    faults.push(`moods.default: "${moods.default || '(empty)'}" is not a defined mood.`)
  const beatNames = new Set((moods.beats ?? []).map((b) => b.name))
  for (const beat of moods.beats ?? []) {
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(beat.name)) faults.push(`moods.beats: "${beat.name}" is not a valid beat name.`)
    if (!beat.line.trim() || beat.line.length > 300)
      faults.push(`moods.beats.${beat.name}: one line, 1–300 characters.`)
  }
  for (const [key, entry] of Object.entries(moods.moods)) {
    const at = `moods.${key}`
    if (!MOOD_KEY.test(key)) faults.push(`${at}: mood keys are lowercase letters, digits or _, starting with a letter.`)
    for (const [i, pattern] of entry.patterns.entries()) {
      if (!pattern.length || pattern.length > 200) {
        faults.push(`${at}.patterns.${i}: 1–200 characters.`)
        continue
      }
      try {
        new RegExp(pattern, 'iu')
      } catch {
        faults.push(`${at}.patterns.${i}: does not compile as a regular expression.`)
      }
    }
    if (!entry.tone.trim()) faults.push(`${at}.tone: describe the tone.`)
    if (entry.openers.some((line) => !line.trim())) faults.push(`${at}.openers: remove blank openers.`)
    if (entry.endings.some((line) => !line.trim())) faults.push(`${at}.endings: remove blank endings.`)
    for (const face of entry.faces)
      if (!isFace(face)) faults.push(`${at}.faces: "${face}" is not one kaomoji in round brackets.`)
    for (const group of entry.faceGroups ?? []) {
      const pool = moods.faceGroups?.[group]
      if (!pool) faults.push(`${at}.faceGroups: unknown face group "${group}".`)
      for (const face of pool ?? [])
        if (!isFace(face)) faults.push(`moods.faceGroups.${group}: "${face}" is not one kaomoji in round brackets.`)
    }
    for (const [name, odds] of Object.entries(entry.beats ?? {})) {
      if (!beatNames.has(name)) faults.push(`${at}.beats: unknown beat "${name}".`)
      if (!(odds >= 0 && odds <= 1)) faults.push(`${at}.beats.${name}: odds are 0–1.`)
    }
    for (const file of entry.stickers) {
      if (file && !STICKER_FILE.test(file))
        faults.push(`${at}.stickers: "${file}" must be a lowercase .webp filename. The server checks it exists.`)
    }
  }
  return faults
}

export function validateLines(lines: StudioLinesDoc): string[] {
  const faults: string[] = []
  for (const kind of LINE_KINDS) {
    const value = lines[kind] ?? ''
    if (!value) faults.push(`lines.${kind}: this fixed line is required.`)
    else if (value.length > 300) faults.push(`lines.${kind}: keep it under 300 characters.`)
    else if (/[\r\n]/.test(value)) faults.push(`lines.${kind}: one line, no line breaks.`)
  }
  for (const kind of OPTIONAL_LINES) {
    const value = lines[kind]
    if (value === undefined || value === '') continue
    if (value.length > 300) faults.push(`lines.${kind}: keep it under 300 characters.`)
    else if (/[\r\n]/.test(value)) faults.push(`lines.${kind}: one line, no line breaks.`)
  }
  return faults
}

export function validateDraft(id: string, draft: StudioDraft): string[] {
  return [
    ...validateId(id).map((f) => `id: ${f}`),
    ...validateCard({ ...draft.card, id }),
    ...validateMoods(draft.moods),
    ...validateLines(draft.lines)
  ]
}

/* ── patch encoding: a typed merge patch against pristine ──
 *
 * Only the leaves that changed travel. Plain objects merge key by key, `null`
 * removes a key (a deleted mood, face group, label or optional line), and
 * arrays and scalars replace wholesale. The server lays the patch onto the
 * stored pack, so a save never replays a field the draft did not touch. */

const isPatchObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

function diffValue(oldValue: unknown, newValue: unknown): { patch: unknown; changed: boolean } {
  if (same(oldValue, newValue)) return { patch: undefined, changed: false }
  if (isPatchObject(oldValue) && isPatchObject(newValue)) {
    const patch: Record<string, unknown> = {}
    let changed = false
    for (const key of Object.keys(oldValue)) {
      if (!Object.hasOwn(newValue, key)) {
        patch[key] = null
        changed = true
        continue
      }
      const leaf = diffValue(oldValue[key], newValue[key])
      if (leaf.changed) {
        patch[key] = leaf.patch
        changed = true
      }
    }
    for (const key of Object.keys(newValue)) {
      if (!Object.hasOwn(oldValue, key)) {
        patch[key] = newValue[key]
        changed = true
      }
    }
    return { patch, changed }
  }
  return { patch: newValue, changed: true }
}

export function diffDocs(
  pristine: StudioDraft,
  draft: StudioDraft
): { patch: StudioPatch; changed: (keyof StudioDraft)[] } {
  const patch: StudioPatch = {}
  const changed: (keyof StudioDraft)[] = []
  const card = diffValue(pristine.card, draft.card)
  if (card.changed) {
    patch.card = card.patch as MergePatch<StudioCard>
    changed.push('card')
  }
  const moods = diffValue(pristine.moods, draft.moods)
  if (moods.changed) {
    patch.moods = moods.patch as MergePatch<StudioMoodsDoc>
    changed.push('moods')
  }
  const lines = diffValue(pristine.lines, draft.lines)
  if (lines.changed) {
    patch.lines = lines.patch as Record<string, string | null>
    changed.push('lines')
  }
  return { patch, changed }
}

function applyMerge(base: unknown, patch: unknown): unknown {
  if (patch === null || patch === undefined) return undefined
  if (isPatchObject(patch)) {
    const next: Record<string, unknown> = isPatchObject(base) ? { ...base } : {}
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === undefined) delete next[key]
      else next[key] = applyMerge(next[key], value)
    }
    return next
  }
  return patch
}

/** Lay a merge patch onto a draft. `null` removes the key; arrays replace. Returns a fresh object. */
export function applyStudioPatch(base: StudioDraft, patch: StudioPatch): StudioDraft {
  const clone = JSON.parse(JSON.stringify(base)) as StudioDraft
  if (patch.card) clone.card = applyMerge(clone.card, patch.card) as StudioCard
  if (patch.moods) clone.moods = applyMerge(clone.moods, patch.moods) as StudioMoodsDoc
  if (patch.lines) clone.lines = applyMerge(clone.lines, patch.lines) as StudioLinesDoc
  return clone
}

/** One changed leaf, addressed by a dotted path such as `moods.moods.calm.tone`. */
export interface LeafChange {
  path: string
  before: unknown
  after: unknown
}

/** Every leaf that differs between two drafts. Arrays count as one leaf; a removed key has `after: undefined`. */
export function listLeafChanges(base: StudioDraft, next: StudioDraft): LeafChange[] {
  const out: LeafChange[] = []
  const walk = (oldValue: unknown, newValue: unknown, path: string): void => {
    if (same(oldValue, newValue)) return
    if (isPatchObject(oldValue) && isPatchObject(newValue)) {
      for (const key of new Set([...Object.keys(oldValue), ...Object.keys(newValue)])) {
        const child = path ? path + '.' + key : key
        const value = Object.hasOwn(newValue, key) ? newValue[key] : undefined
        walk(oldValue[key], value, child)
      }
      return
    }
    out.push({ path, before: oldValue, after: newValue })
  }
  walk(base, next, '')
  return out
}

export interface ConflictSets {
  /** Leaves the draft changed against pristine. */
  local: LeafChange[]
  /** Leaves the latest revision changed against pristine. */
  remote: LeafChange[]
  /** Paths changed on both sides. These need an explicit decision. */
  overlapping: string[]
  /** Local leaves no remote change touched. Safe to rebase automatically. */
  localOnly: LeafChange[]
  remoteOnly: LeafChange[]
}

/** Split the draft's intended changes from the latest revision's, by leaf path. */
export function compareDrafts(pristine: StudioDraft, draft: StudioDraft, latest: StudioDraft): ConflictSets {
  const local = listLeafChanges(pristine, draft)
  const remote = listLeafChanges(pristine, latest)
  const remotePaths = new Set(remote.map((leaf) => leaf.path))
  const localPaths = new Set(local.map((leaf) => leaf.path))
  return {
    local,
    remote,
    overlapping: local.map((leaf) => leaf.path).filter((path) => remotePaths.has(path)),
    localOnly: local.filter((leaf) => !remotePaths.has(leaf.path)),
    remoteOnly: remote.filter((leaf) => !localPaths.has(leaf.path))
  }
}

/** Build a draft from the latest revision plus exactly the given leaves. Untouched fields stay as latest. */
export function rebaseLeaves(latest: StudioDraft, leaves: LeafChange[]): StudioDraft {
  const patch: Record<string, unknown> = {}
  for (const leaf of leaves) {
    const segments = leaf.path.split('.')
    let node = patch
    for (const segment of segments.slice(0, -1)) {
      if (!isPatchObject(node[segment])) node[segment] = {}
      node = node[segment] as Record<string, unknown>
    }
    node[segments[segments.length - 1]!] = leaf.after === undefined ? null : leaf.after
  }
  return applyStudioPatch(latest, patch as StudioPatch)
}

/* ── synthetic prompt preview (no model call; randomness draws at runtime) ── */

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3)
}

export function buildPromptPreview(draft: StudioDraft, moodKey: string): { text: string; tokens: number } {
  const mood = draft.moods.moods[moodKey] ?? draft.moods.moods[draft.moods.default]
  const lines = [
    '[Block 1 · Core]',
    `${draft.card.displayName}: ${draft.card.coreIdentity}`,
    '',
    '[Block 2 · Speech]',
    ...draft.card.speechRules.filter((r) => r.trim()),
    ...(draft.card.privateInstructions ? ['', '[Private instructions]', draft.card.privateInstructions] : []),
    '',
    '[Block 5 · Tone]',
    mood?.tone.trim() ? mood.tone : '(no tone for this mood yet)',
    '',
    '[Block 6 · Reply shape]',
    `Length: ${draft.card.defaultReplyLength} (≤ ${REPLY_LENGTHS[draft.card.defaultReplyLength]} chars)`,
    `Faces: offers 4 from a pool of ${(mood?.faces.length ?? 0) + (mood?.faceGroups?.length ?? 0)} named`,
    `Beats: ${Object.keys(mood?.beats ?? {}).length} armed`
  ]
  const text = lines.join('\n')
  return { text, tokens: estimateTokens(text) }
}

/* ── simulator handoff: same-origin tab, explicit opener handshake ──
 *
 * The draft never touches the URL, storage or the network. The editor opens the
 * simulator route and waits for its ready ping; only then does it post the
 * draft to event.source at this origin. A tab opened directly shows its empty
 * state instead. */

export const SIMULATOR_READY = 'aira-studio-simulator-ready'
export const SIMULATOR_DRAFT = 'aira-studio-draft'

export function openStudioSimulator(draft: StudioDraft & { moodKey?: string }, onError: (message: string) => void) {
  const url = new URL(studioHref(studioPaths.simulator), location.origin)
  const tab = window.open(url, '_blank')
  if (!tab) {
    onError('The simulator tab was blocked. Allow pop-ups for this page and try again.')
    return
  }
  const onMessage = (event: MessageEvent) => {
    if (event.origin !== location.origin) return
    if (event.source !== tab) return
    const data = event.data as { type?: string } | null
    if (data?.type !== SIMULATOR_READY) return
    window.removeEventListener('message', onMessage)
    window.clearTimeout(timer)
    tab.postMessage({ type: SIMULATOR_DRAFT, draft }, location.origin)
  }
  const timer = window.setTimeout(() => {
    window.removeEventListener('message', onMessage)
    onError('The simulator tab did not answer. Close it and try again.')
  }, 15000)
  window.addEventListener('message', onMessage)
}

/* ── blank scaffold for create mode: empty fields, never a persona ── */

export function blankDraft(): StudioDraft {
  return {
    card: {
      id: '',
      displayName: '',
      aliases: [],
      languages: ['en'],
      coreIdentity: '',
      speechRules: [''],
      defaultReplyLength: 'default',
      toolFooter: undefined
    },
    moods: {
      default: 'calm',
      moods: {
        calm: { patterns: [], tone: '', openers: [], endings: [], faces: [], stickers: [] }
      }
    },
    lines: Object.fromEntries([...LINE_KINDS.map((k) => [k, '']), ['feedback', '']]) as StudioLinesDoc
  }
}
