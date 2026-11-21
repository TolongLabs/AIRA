import { linkUrls } from '../social/urls.js'

// The URLs one turn has seen (docs/trd/tools.md#turn-sources). read_page and read_post open only these, and a page
// or post read ends the turn's state changes. Built fresh at step 2 of each turn, and gone with it.

/** How a URL first reached the turn. Each web search keeps its own call id (`search:<callId>`). */
export type SourceLookup = 'message' | 'quote' | 'intake' | 'canonical' | `search:${string}`

/** The lookup tag for one web_search call. */
export function searchLookup(callId: string): SourceLookup {
  return `search:${callId}`
}

export interface SourceEntry {
  /** `s1`, `s2`, ... in order of arrival. */
  id: string
  /** The address as it first arrived. A read fetches this address. */
  url: string
  /** The lookup that first found it. A later arrival of the same page keeps this one. */
  lookup: SourceLookup
}

/** A source id as the model writes it: `s` and a positive number. */
export const SOURCE_ID = /^s[1-9][0-9]{0,5}$/

function isTrackingParam(key: string): boolean {
  const lower = key.toLowerCase()
  return lower.startsWith('utm_') || lower === 'fbclid' || lower === 'si'
}

/**
 * The key two addresses share when they name one page: an http(s) address with a lower-case host, no fragment and
 * no tracking parameter. Undefined for any other scheme or an address that does not parse.
 */
export function sourceKey(url: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  parsed.hash = ''
  for (const key of [...parsed.searchParams.keys()]) {
    if (isTrackingParam(key)) parsed.searchParams.delete(key)
  }
  return parsed.toString()
}

export interface TurnSources {
  /** Registers one address. Returns its entry, or undefined when it is not an http(s) address. */
  add(url: string, lookup: SourceLookup): SourceEntry | undefined
  /** Registers every link in a text, in order. */
  addText(text: string, lookup: SourceLookup): void
  /** The entry for a URL or a source id, or undefined when the turn has not seen it. */
  find(ref: { url?: string; source?: string }): SourceEntry | undefined
  /** Records that a page or post was read in this turn. State changes are refused from then on. */
  markRead(): void
  readThisTurn(): boolean
  /** Keeps a read call in view until it settles. */
  track(call: Promise<unknown>): void
  /** Resolves once every tracked read has settled, so a state change checks the reads that ran before it. */
  settled(): Promise<void>
}

export function createTurnSources(): TurnSources {
  const byKey = new Map<string, SourceEntry>()
  const byId = new Map<string, SourceEntry>()
  const inFlight = new Set<Promise<void>>()
  let read = false

  const add = (url: string, lookup: SourceLookup): SourceEntry | undefined => {
    const key = sourceKey(url)
    if (key === undefined) return undefined
    const existing = byKey.get(key)
    if (existing !== undefined) return existing
    const entry: SourceEntry = { id: `s${byId.size + 1}`, url, lookup }
    byKey.set(key, entry)
    byId.set(entry.id, entry)
    return entry
  }

  return {
    add,

    addText(text, lookup) {
      for (const url of linkUrls(text)) add(url, lookup)
    },

    find(ref) {
      if (ref.source !== undefined) return byId.get(ref.source)
      if (ref.url === undefined) return undefined
      const key = sourceKey(ref.url)
      return key === undefined ? undefined : byKey.get(key)
    },

    markRead() {
      read = true
    },

    readThisTurn() {
      return read
    },

    track(call) {
      const done: Promise<void> = call.then(
        () => {
          inFlight.delete(done)
        },
        () => {
          inFlight.delete(done)
        }
      )
      inFlight.add(done)
    },

    async settled() {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight])
    }
  }
}
