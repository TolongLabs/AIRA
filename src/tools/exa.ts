import type { PagePort, SearchPort } from './ports.js'

const EXA_SEARCH_URL = 'https://api.exa.ai/search'
const DEFAULT_TIMEOUT_MS = 10_000
const NUM_RESULTS = 5
const MAX_SNIPPET_CHARS = 300

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function cutSnippet(text: string): string {
  return text.length > MAX_SNIPPET_CHARS ? `${text.slice(0, MAX_SNIPPET_CHARS - 1)}…` : text
}

function firstSnippet(highlights: unknown): string {
  if (!Array.isArray(highlights)) return ''
  for (const item of highlights) {
    if (typeof item !== 'string') continue
    const collapsed = collapseWhitespace(item)
    if (collapsed.length > 0) return cutSnippet(collapsed)
  }
  return ''
}

function mapResults(raw: unknown): { title: string; url: string; snippet: string }[] {
  if (!raw || typeof raw !== 'object') {
    throw new Error('exa search failed (malformed)')
  }
  const results = (raw as { results?: unknown }).results
  if (!Array.isArray(results)) {
    throw new Error('exa search failed (malformed)')
  }
  const mapped: { title: string; url: string; snippet: string }[] = []
  for (const entry of results) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as { title?: unknown; url?: unknown; highlights?: unknown }
    if (typeof record.url !== 'string') continue
    const title = typeof record.title === 'string' ? record.title : ''
    mapped.push({ title, url: record.url, snippet: firstSnippet(record.highlights) })
  }
  return mapped
}

export function createExaSearchPort(options: { apiKey: string; fetch?: typeof fetch; timeoutMs?: number }): SearchPort {
  const fetchFn = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return {
    async search(query, signal) {
      if (signal.aborted) {
        throw new Error('exa search failed (aborted)')
      }
      const combined = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
      let response: Response
      try {
        response = await fetchFn(EXA_SEARCH_URL, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': options.apiKey
          },
          body: JSON.stringify({
            query,
            type: 'auto',
            numResults: NUM_RESULTS,
            contents: { highlights: true }
          }),
          signal: combined
        })
      } catch (cause) {
        const kind = signal.aborted ? 'aborted' : combined.aborted ? 'timeout' : 'network'
        throw new Error(`exa search failed (${kind})`, { cause })
      }
      if (!response.ok) {
        throw new Error(`exa search failed (${response.status})`)
      }
      let data: unknown
      try {
        data = await response.json()
      } catch (cause) {
        throw new Error('exa search failed (invalid_json)', { cause })
      }
      return mapResults(data)
    }
  }
}

const EXA_CONTENTS_URL = 'https://api.exa.ai/contents'
const DEFAULT_PAGE_MAX_CHARS = 12_000

/**
 * Reads a page through Exa's contents endpoint, with a live crawl when Exa has no copy, so a page that refuses plain
 * fetches still reads (docs/trd/tools.md). Any Exa failure, or an empty text, falls back to the plain reader.
 * Downloads always use the plain reader, which checks every address.
 */
export function createExaPagePort(options: {
  apiKey: string
  fallback: PagePort
  fetch?: typeof fetch
  timeoutMs?: number
  maxChars?: number
}): PagePort {
  const fetchFn = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxChars = options.maxChars ?? DEFAULT_PAGE_MAX_CHARS

  async function viaExa(url: string, signal: AbortSignal): Promise<{ title: string; text: string } | undefined> {
    const combined = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    try {
      const response = await fetchFn(EXA_CONTENTS_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': options.apiKey },
        body: JSON.stringify({ urls: [url], text: { maxCharacters: maxChars }, livecrawl: 'fallback' }),
        signal: combined
      })
      if (!response.ok) return undefined
      const data = (await response.json()) as { results?: { title?: unknown; text?: unknown }[] }
      const first = Array.isArray(data.results) ? data.results[0] : undefined
      const text = typeof first?.text === 'string' ? first.text.trim() : ''
      if (text.length === 0) return undefined
      return { title: typeof first?.title === 'string' ? first.title : '', text: text.slice(0, maxChars) }
    } catch {
      return undefined
    }
  }

  return {
    async read(url, signal) {
      return (await viaExa(url, signal)) ?? options.fallback.read(url, signal)
    },
    download(url, signal, maxBytes) {
      return options.fallback.download(url, signal, maxBytes)
    }
  }
}
