import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { type SearchCase, searchCases } from '../../scripts/search-cases.js'
import { createExaSearchPort } from '../../src/tools/exa.js'
import { createSearchDepth, passageMatches } from '../../src/tools/search-depth.js'
import { createTurnSources } from '../../src/turn/sources.js'

type Recording = SearchCase & { recordedAt: string; payloads: Record<string, unknown> }

describe('recorded Exa search depth', () => {
  it.each(searchCases.map(({ id }) => id))('replays %s offline with source IDs', async (id) => {
    const json = readFileSync(new URL(`../fixtures/search/${id}.json`, import.meta.url), 'utf8')
    const recording = JSON.parse(json) as Recording
    expect(recording.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)

    const queries: string[] = []
    const port = createExaSearchPort({
      apiKey: 'recording-test-key',
      fetch: async (input, init) => {
        expect(input).toBe('https://api.exa.ai/search')
        const { query } = JSON.parse(String(init?.body)) as { query: string }
        expect(recording.payloads).toHaveProperty(query)
        queries.push(query)
        return Response.json(recording.payloads[query])
      }
    })
    const sources = createTurnSources()
    const { brief } = await createSearchDepth({ search: port }).deep(recording, {
      callId: 'search',
      sources,
      now: () => new Date(),
      deadline: Date.now() + 30_000,
      callDeadline: Date.now() + 15_000,
      signal: new AbortController().signal
    })

    expect(queries[0]).toBe(recording.query)
    expect(queries.length).toBeLessThanOrEqual(2)
    expect(brief.stillMissing).toMatch(/^Still missing: ./)
    for (const passage of brief.passages) {
      expect(sources.find({ source: passage.source })?.url).toBe(passage.url)
      expect(recording.fields.some((field) => passageMatches(field, passage.text))).toBe(true)
    }
    if (id === 'cafe-menu') {
      expect(brief.stillMissing).toBe('Still missing: none.')
      expect(brief.passages.map(({ text }) => text).join('\n')).toMatch(/(?:croissant|sandwich)/i)
      expect(brief.passages.map(({ text }) => text).join('\n')).toMatch(/(?:cold brew|iced espresso)/i)
    }
    if (id === 'hardware-price') {
      expect(brief.stillMissing).toBe('Still missing: none.')
      expect(brief.passages[0]?.text).toMatch(/\$15/)
    }
  })
})
