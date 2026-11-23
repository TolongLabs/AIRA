/* Legacy bookmark fragments, resolved by the preview/canonical router.
 *
 * The server only sees the path and query — a fragment never leaves the
 * browser — so only this router can own the mapping from a saved
 * `/app/*.html#…` URL to its canonical route. The server keeps serving the
 * nine legacy documents under `/app/` until cutover, and a legacy pathname
 * is expected to redirect to its canonical path keeping the query (the
 * fragment survives that redirect in the browser). This translator therefore
 * accepts BOTH a legacy pathname and a canonical pathname carrying a legacy
 * fragment, and it always preserves the query string.
 *
 * Actual legacy links traced in code:
 * - dashboard (pages/dashboard.tsx): `/app/library.html#vocab|song|grammar|
 *   note|project|person|topic`, plus bare `/app/graph.html`, `/app/library.html`,
 *   `/app/cron.html`, `/app/markets.html`, `/app/settings.html`.
 * - library (pages/library.tsx): `#/<type>:<slug>` or `#<type>:<slug>` opens an
 *   item, `#<type-plural>` (e.g. `#songs`) lists a category, empty opens the
 *   overview. Decoding is decodeURIComponent with a raw fallback (safeReadHash);
 *   the dashboard keeps `?q=`, `?type=` and `?page=` across item hops.
 * - graph (pages/graph.tsx): backlinks are `/app/library.html#<item-id>`; the
 *   dashboard reads `?focus=<encoded id>` with `?q=` and `?lens=` kept, and
 *   `#graph` with `?lens=` is the legacy equivalent of the graph view.
 * - markets (pages/markets.tsx): `#watchlist|alerts|news` with a `?tab=`
 *   fallback (parseMarketTab reads path, then hash, then `?tab=`).
 * - settings (pages/settings.tsx): `#models|markets|avatar|voice|home|files`
 *   switch tabs; `#chats|bindings|proactive` move to `/app/chats.html` and
 *   `#cron` moves to `/app/cron.html`.
 * - chats: `#chat-<internal-id>` (the PackFooterPanel anchor shape) opens
 *   `/chats/:id/settings` (entry.tsx validates `c_[A-Za-z0-9_-]+`); the
 *   directory return state `?search=&status=&page=` rides along (chatHref).
 * - send (pages/send.tsx): no hash routing — the page IS the target picker —
 *   so a targetless `/app/send.html` resolves to `chats/files` with the query.
 * - notices (pages/notices.tsx): `?q=` filters routes; `#machines` is an
 *   in-page anchor and is kept as-is.
 * - routines (pages/cron.tsx): `?tab=archive`, `?q=`, and detail at
 *   `/automations/routines/:encodedId`; no hash routing.
 *
 * History: applyLegacyBookmark uses history.replaceState, never push or
 * assign, so the legacy URL never becomes a back-button trap.
 * Escapes: decode once with a raw fallback and rebuild with
 * encodeURIComponent, so `%25`, `%3A` and opaque Unicode ids round-trip
 * without double-decoding. Unrecognized fragments pass through untouched. */

export interface LegacyBookmark {
  pathname: string
  search: string
  hash: string
}

export interface CanonicalTarget {
  path: string
  search: string
  hash: string
}

function decodeOnce(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

const CHAT_ID = /^c_[A-Za-z0-9_-]+$/
const MARKET_TABS = new Set(['watchlist', 'alerts', 'news'])
const SETTINGS_TABS = new Set(['models', 'markets', 'avatar', 'voice', 'home', 'files'])
const SETTINGS_TO_CHATS = new Set(['chats', 'bindings', 'proactive'])
const LIBRARY_SINGULARS = [
  'song',
  'vocab',
  'grammar',
  'artist',
  'note',
  'topic',
  'source',
  'reminder',
  'transcript',
  'person',
  'project',
  'place'
]

/** Singular library type for a fragment, accepting plurals (`#songs`) and the
 *  irregular `#people`/`#words` dashboard spellings. Null when unknown. */
function canonicalLibraryType(fragment: string): string | null {
  const t = fragment.trim().toLowerCase()
  if (LIBRARY_SINGULARS.includes(t)) return t
  if (t === 'people') return 'person'
  if (t === 'words') return 'vocab'
  if (t.endsWith('s')) {
    const singular = t.slice(0, -1)
    if (LIBRARY_SINGULARS.includes(singular)) return singular
  }
  return null
}

/** Merge a patch into a query string, keeping every other param untouched.
 *  Returns the original string when nothing changes, so percent escapes in
 *  unrelated params are never renormalized. A null value deletes the key. */
function mergeSearch(search: string, patch: Record<string, string | null>): string {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  let changed = false
  for (const [key, value] of Object.entries(patch)) {
    const current = params.get(key)
    if (value === null) {
      if (current !== null) {
        params.delete(key)
        changed = true
      }
    } else if (current !== value) {
      params.set(key, value)
      changed = true
    }
  }
  if (!changed) return search
  const serial = params.toString()
  return serial ? `?${serial}` : ''
}

function queryParam(search: string, key: string): string | null {
  try {
    return new URLSearchParams(search.startsWith('?') ? search.slice(1) : search).get(key)
  } catch {
    return null
  }
}

function pageKey(logical: string): string | null {
  switch (logical) {
    case '/':
    case '/app':
    case '/app/':
    case '/app/index.html':
    case '/overview':
      return 'index'
    case '/app/library.html':
    case '/library':
      return 'library'
    case '/app/graph.html':
    case '/library/graph':
      return 'graph'
    case '/app/markets.html':
    case '/markets':
      return 'markets'
    case '/app/chats.html':
    case '/chats':
      return 'chats'
    case '/app/settings.html':
    case '/system/settings':
      return 'settings'
    case '/app/send.html':
    case '/chats/files':
      return 'send'
    case '/app/cron.html':
    case '/automations/routines':
      return 'routines'
    case '/app/notices.html':
    case '/automations/notices':
      return 'notices'
    default:
      break
  }
  // Already on a canonical markets tab: only a tab fragment upgrades in place.
  if (logical.startsWith('/markets/')) return 'markets-tab'
  return null
}

/** Pure mapping from a legacy (or canonical-with-legacy-fragment) URL to its
 *  canonical target under `mount` (`''` or `'/app/preview'`). Null means the
 *  URL needs no translation and must be left untouched. */
export function translateLegacyBookmark(source: LegacyBookmark, mount: string): CanonicalTarget | null {
  const { pathname, search, hash } = source
  const logical = mount !== '' && pathname.startsWith(mount + '/') ? pathname.slice(mount.length) : pathname
  const key = pageKey(pathname === mount ? '/' : logical)
  if (!key) return null
  const made = (route: string, nextSearch: string, nextHash: string): CanonicalTarget => ({
    path: `${mount}/${route}`,
    search: nextSearch,
    hash: nextHash
  })
  const raw = hash.replace(/^#\/+/, '').replace(/^#/, '')
  const decoded = raw === '' ? '' : decodeOnce(raw)

  switch (key) {
    case 'library': {
      if (raw === '') return made('library', search, '')
      if (decoded.includes(':')) return made(`library/item/${encodeURIComponent(decoded)}`, search, '')
      const type = canonicalLibraryType(decoded)
      // A new type is a new list, so it starts on page 1; an item hop keeps
      // the page so the return link can restore the origin search.
      if (type) return made('library', mergeSearch(search, { type, page: null }), '')
      return made('library', search, hash)
    }
    case 'graph': {
      if (decoded.includes(':')) return made('library/graph', mergeSearch(search, { focus: decoded }), '')
      const cut = decoded.indexOf('?')
      const base = (cut === -1 ? decoded : decoded.slice(0, cut)).replace(/\/+$/, '')
      if (base === '' || base === 'graph') {
        let nextSearch = search
        if (cut !== -1) {
          let fragParams: URLSearchParams | null = null
          try {
            fragParams = new URLSearchParams(decoded.slice(cut + 1))
          } catch {
            fragParams = null
          }
          if (fragParams) {
            const patch: Record<string, string | null> = {}
            for (const name of ['lens', 'focus', 'q']) {
              const value = fragParams.get(name)
              if (value !== null) patch[name] = value
            }
            if (Object.keys(patch).length) nextSearch = mergeSearch(search, patch)
          }
        }
        return made('library/graph', nextSearch, '')
      }
      return made('library/graph', search, hash)
    }
    case 'markets':
    case 'markets-tab': {
      const first = decoded.split(/[?/]/)[0] ?? ''
      if (MARKET_TABS.has(first)) return made(`markets/${first}`, search, '')
      if (key === 'markets-tab') return null
      if (raw === '') {
        const tab = queryParam(search, 'tab')
        if (tab && MARKET_TABS.has(tab)) return made(`markets/${tab}`, search, '')
        return made('markets', search, '')
      }
      const tab = queryParam(search, 'tab')
      return made(tab && MARKET_TABS.has(tab) ? `markets/${tab}` : 'markets', search, hash)
    }
    case 'chats': {
      const match = /^chat-(.+)$/.exec(decoded)
      if (match) {
        const rest = match[1] ?? ''
        const slash = rest.indexOf('/')
        const idPart = slash === -1 ? rest : rest.slice(0, slash)
        const tail = slash === -1 ? 'settings' : rest.slice(slash + 1)
        if ((tail === 'settings' || tail === 'send') && CHAT_ID.test(idPart))
          return made(`chats/${encodeURIComponent(idPart)}/${tail}`, search, '')
        return null
      }
      if (raw === '') return made('chats', search, '')
      return made('chats', search, hash)
    }
    case 'settings': {
      const name = decoded.toLowerCase()
      if (SETTINGS_TABS.has(name)) return made('system/settings', search, `#${name}`)
      if (SETTINGS_TO_CHATS.has(name)) return made('chats', search, '')
      if (name === 'cron') return made('automations/routines', search, '')
      if (raw === '') return made('system/settings', search, '')
      return made('system/settings', search, hash)
    }
    case 'send':
      // No hash routing on the file-send page; it carries its own target
      // picker, so every legacy send bookmark resolves there with the query.
      return made('chats/files', search, '')
    case 'routines':
      return made('automations/routines', search, hash)
    case 'notices':
      // `#machines` is an in-page anchor; keep it so the machines table link
      // still lands after the redirect.
      return made('automations/notices', search, hash)
    default:
      return made('overview', search, hash)
  }
}
