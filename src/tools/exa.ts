import type { SearchPort } from './ports.js'

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
      } catch {
        const kind = signal.aborted ? 'aborted' : combined.aborted ? 'timeout' : 'network'
        throw new Error(`exa search failed (${kind})`)
      }
      if (!response.ok) {
        throw new Error(`exa search failed (${response.status})`)
      }
      let data: unknown
      try {
        data = await response.json()
      } catch {
        throw new Error('exa search failed (invalid_json)')
      }
      return mapResults(data)
    }
  }
}
