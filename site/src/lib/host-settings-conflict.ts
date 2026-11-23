/* Compare-before-save and masked readback for host settings.
 *
 * The host owner service offers no compare-and-swap for these writes: there is
 * no revision, no `expected` field and no 409. Every `POST` below therefore
 * last-write-wins against any other writer. This module does not change that —
 * it only lets one editor session notice before it overwrites, and prove after
 * that what it sent is what the host now holds.
 *
 * The pattern per save, owned by `docs/trd/dashboard-state.md`:
 *
 * 1. Keep the local draft untouched until the readback passes.
 * 2. `GET /api/settings` fresh, then compare only the affected public keys
 *    against the base snapshot from load or last good save. A difference means
 *    another session wrote first: stale, keep the draft, say which keys moved.
 * 3. `POST` only the affected keys — never unrelated stale fields, never a
 *    read-only key, never a write-only credential alongside its flag.
 * 4. `GET` again and check the affected public keys equal what was sent. A
 *    failed read is offline, not stale: the write may have landed, so the
 *    draft stays and nothing is claimed. Write-only credentials (the home
 *    token) are never read back — only the masked `token_set` flag is.
 *
 * Residual window, stated plainly: the fresh `GET` and the `POST` are not one
 * atomic host transaction. Two writers inside that window still last-write-win.
 * This is detection, not host CAS, and it makes no claim against arbitrary
 * writers beyond naming the keys it compared.
 *
 * Everything here is pure: no fetch, no storage, no logging of values. Error
 * text names keys, never their contents. Malformed payloads throw so callers
 * keep the draft instead of saving blindly. */

export type SettingsLike = Record<string, unknown>

/** Writable host endpoints on the Settings page, by the `POST` path suffix. */
export type HostWriteTarget =
  'search' | 'learning' | 'models' | 'avatar' | 'tts' | 'tts_provider' | 'tts_lang' | 'home' | 'file'

export interface HostWriteSpec {
  /** Public keys compared before save and verified on readback, as dot paths. */
  affected: string[]
  /** Keys the dashboard may show but must never send. */
  readOnly: string[]
  /** Keys sent on write but never read back or stored. */
  writeOnly: string[]
}

/* Affected means public and writable. Option lists (`tts.langs`,
   `tts.providers`), capability flags (`tts.lang_aware`), environment
   overrides (`models.env_chat`, `models.env_agent`), counters
   (`learning.calls_today`), masks (`home.token_set`) and the probe/refresh
   actions are read-only or action-only and stay out of every body. */
export const HOST_WRITE_SPECS: Record<HostWriteTarget, HostWriteSpec> = {
  search: {
    affected: ['search.mode'],
    readOnly: ['search.modes', 'search.exa_key', 'search.exa_off_until', 'search.usage'],
    writeOnly: []
  },
  learning: {
    affected: ['learning.learning'],
    readOnly: ['learning.env_off', 'learning.calls_today', 'learning.chats', 'learning.lessons'],
    writeOnly: []
  },
  models: {
    affected: [
      'models.chat',
      'models.agent',
      'models.effort',
      'models.ollama.enabled',
      'models.ollama.endpoint',
      'models.ollama.fallback'
    ],
    readOnly: ['models.catalogue', 'models.providers', 'models.local_available', 'models.env_chat', 'models.env_agent'],
    writeOnly: []
  },
  avatar: { affected: ['avatar.model', 'avatar.mirror'], readOnly: [], writeOnly: [] },
  tts: {
    affected: ['tts.enabled'],
    readOnly: ['tts.auto_tts', 'tts.speaking', 'tts.silenced', 'tts.unreachable', 'tts.lang_unreachable'],
    writeOnly: []
  },
  tts_provider: {
    affected: ['tts.provider'],
    readOnly: ['tts.providers', 'tts.lang_aware'],
    writeOnly: []
  },
  tts_lang: {
    affected: ['tts.lang'],
    readOnly: ['tts.langs', 'tts.lang_overrides', 'tts.lang_aware'],
    writeOnly: []
  },
  home: {
    affected: ['home.ip'],
    readOnly: ['home.token_set'],
    writeOnly: ['token']
  },
  file: { affected: ['text'], readOnly: ['kind', 'name'], writeOnly: [] }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Throw on anything that is not a settings-shaped object. Names the route, never values. */
export function parseSettingsPayload(value: unknown, route: string): SettingsLike {
  if (!isRecord(value)) throw new Error(`Invalid response from ${route}`)
  return value
}

function getPath(root: SettingsLike, path: string): unknown {
  let node: unknown = root
  for (const part of path.split('.')) {
    if (!isRecord(node)) return undefined
    node = node[part]
  }
  return node
}

function isEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== typeof b) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, i) => isEqual(item, (b as unknown[])[i]))
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    for (const key of keys) if (!isEqual(a[key], (b as SettingsLike)[key])) return false
    return true
  }
  return false
}

/** Paths whose value moved between base and fresh. Compare-only, nothing sent. */
export function affectedChanged(base: SettingsLike, fresh: SettingsLike, paths: string[]): string[] {
  return paths.filter((path) => !isEqual(getPath(base, path), getPath(fresh, path)))
}

/** True when every intended value already equals the base — send no `POST`. */
export function isNoop(base: SettingsLike, intended: Record<string, unknown>): boolean {
  return Object.entries(intended).every(([path, value]) => isEqual(getPath(base, path), value))
}

export type BeforeSave =
  { kind: 'noop' } | { kind: 'ok' } | { kind: 'stale'; changed: string[] } | { kind: 'unsupported'; missing: string[] }

/** Step 2 of the pattern: no-op short-circuits, otherwise a moved key is stale. */
export function checkBeforeSave(
  base: SettingsLike,
  fresh: SettingsLike,
  intended: Record<string, unknown>,
  paths: string[],
  hasWriteOnlyChange = false
): BeforeSave {
  const missing = paths.filter((path) => getPath(fresh, path) === undefined)
  if (missing.length) return { kind: 'unsupported', missing }
  if (!hasWriteOnlyChange && isNoop(fresh, intended)) return { kind: 'noop' }
  const changed = affectedChanged(base, fresh, paths)
  return changed.length ? { kind: 'stale', changed } : { kind: 'ok' }
}

export interface ReadbackVerdict {
  mismatched: string[]
  /** Paths the host did not return at all — unsupported there, not a value miss. */
  unsupported: string[]
}

/** Step 4 of the pattern: every affected public key must read back as sent. */
export function checkReadback(readback: SettingsLike, intended: Record<string, unknown>): ReadbackVerdict {
  const mismatched: string[] = []
  const unsupported: string[] = []
  for (const [path, value] of Object.entries(intended)) {
    const seen = getPath(readback, path)
    if (seen === undefined) unsupported.push(path)
    else if (!isEqual(seen, value)) mismatched.push(path)
  }
  return { mismatched, unsupported }
}

/** Body keys that are not affected-public — read-only, a write-only flag, or unknown. Write-only keys stay sendable. */
export function unsupportedBodyKeys(target: HostWriteTarget, body: Record<string, unknown>): string[] {
  const spec = HOST_WRITE_SPECS[target]
  const topAllowed = new Set([...spec.affected.map((path) => path.split('.')[1] ?? path), ...spec.writeOnly])
  return Object.keys(body).filter((key) => !topAllowed.has(key))
}

/** A file save receipt only counts when kind, name and byte length all match. */
export function fileReceiptValid(
  receipt: unknown,
  target: { kind: string; name: string },
  byteLength: number
): boolean {
  if (!isRecord(receipt)) return false
  return receipt.kind === target.kind && receipt.name === target.name && receipt.bytes === byteLength
}
