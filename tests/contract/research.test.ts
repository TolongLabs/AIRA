import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { ModelClient } from '../../src/models/types.js'
import { runResearch, validateFindings } from '../../src/research/job.js'
import { offerAnswer } from '../../src/research/offer.js'

const at = '2026-11-17T00:00:00.000Z'
const source = { n: 1, title: 'A source', url: 'https://example.com/', domain: 'example.com', accessedAt: at }
const doc = {
  title: 'A report',
  question: 'A question?',
  summary: 'A summary',
  keyFindings: [1, 2, 3].map((n) => ({ text: `Finding ${n}`, sources: [1] })),
  sections: [1, 2].map((n) => ({ heading: `Section ${n}`, body: 'Body', sources: [1] })),
  limitations: [],
  sources: [source]
}

describe('research boundaries', () => {
  it('matches the whole offer answer, with punctuation or a closing emoji', () => {
    for (const answer of ['yes', 'YA!', '好👍', 'okay 😊', '/pdf']) expect(offerAnswer(answer)).toBe('accepted')
    for (const answer of ['yes please explain', 'yesterday', 'not yes', '/pdf more'])
      expect(offerAnswer(answer)).toBeUndefined()
    for (const answer of ['no', '不用', 'nah']) expect(offerAnswer(answer)).toBe('declined')
  })

  it('drops unread sources and the claims left citing nothing; fills source metadata in code', () => {
    const result = validateFindings(
      {
        ...doc,
        sources: [
          { ...source, domain: 'forged', accessedAt: 'forged' },
          { ...source, n: 2, url: 'https://unread.example/' }
        ],
        keyFindings: [...doc.keyFindings, { text: 'Unsupported', sources: [2] }]
      },
      [{ ...source, text: 'Read text' }]
    )
    expect(result.sources).toEqual([source])
    expect(result.keyFindings).toHaveLength(3)
  })

  it('limits search and page budgets, ranks by query count, and clips untrusted pages', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({ text: JSON.stringify({ queries: ['one', 'two', 'three'] }) })
      .mockResolvedValueOnce({ text: JSON.stringify(doc) })
    const search = vi.fn().mockResolvedValue([
      { title: 'Blocked', url: 'http://127.0.0.1/', snippet: '' },
      { title: 'A source', url: 'https://example.com/', snippet: '' },
      { title: 'Duplicate', url: 'https://example.com/#x', snippet: '' }
    ])
    const read = vi.fn().mockResolvedValue({ title: 'A source', text: 'x'.repeat(5000) })
    const result = await runResearch({
      topic: 'A question?',
      client: { call } as ModelClient,
      model: 'fake',
      search: { search },
      page: { read, download: vi.fn() },
      limits: { maxSearches: 2, maxPages: 1, deadlineMs: 120000 },
      now: () => new Date(at)
    })
    expect(result.sources).toHaveLength(1)
    expect(search).toHaveBeenCalledTimes(2)
    expect(read).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledTimes(2)
    expect(call.mock.calls[1]?.[0].messages[0].content).toContain('untrusted="true"')
    expect(call.mock.calls[1]?.[0].messages[0].content).not.toContain('x'.repeat(4001))
  })
  it('stops at the spend cap without another model call, and keeps read evidence', async () => {
    let canSpend = true
    const call = vi.fn().mockResolvedValue({ text: JSON.stringify({ queries: ['one', 'two', 'three'] }) })
    const result = await runResearch({
      topic: 'A question?',
      client: { call } as ModelClient,
      model: 'fake',
      search: { search: async () => [{ title: 'A source', url: source.url, snippet: '' }] },
      page: {
        read: async () => {
          canSpend = false
          return { title: 'A source', text: 'The page text.' }
        },
        download: vi.fn()
      },
      limits: { maxSearches: 1, maxPages: 2, deadlineMs: 120000 },
      spendAllows: () => canSpend,
      now: () => new Date(at)
    })
    expect(call).toHaveBeenCalledTimes(1)
    expect(result.sources).toHaveLength(1)
    expect(result.limitations.join(' ')).toContain('spend limit')
  })

  it('fails without any call when the spend cap is already reached', async () => {
    const call = vi.fn()
    await expect(
      runResearch({
        topic: 'A question?',
        client: { call } as ModelClient,
        model: 'fake',
        search: { search: vi.fn() },
        page: { read: vi.fn(), download: vi.fn() },
        limits: { maxSearches: 6, maxPages: 8, deadlineMs: 120000 },
        spendAllows: () => false
      })
    ).rejects.toThrow('budget')
    expect(call).not.toHaveBeenCalled()
  })

  it('cuts off a port that ignores its abort signal at the wall deadline', async () => {
    const call = vi.fn().mockResolvedValue({ text: JSON.stringify({ queries: ['one', 'two', 'three'] }) })
    const search = vi.fn(() => new Promise<never>(() => {}))
    await expect(
      runResearch({
        topic: 'A question?',
        client: { call } as ModelClient,
        model: 'fake',
        search: { search },
        page: { read: vi.fn(), download: vi.fn() },
        limits: { maxSearches: 6, maxPages: 8, deadlineMs: 20 }
      })
    ).rejects.toThrow('no_sources')
    expect(search).toHaveBeenCalledTimes(1)
  })

  it('repairs invalid findings only once and never makes a fourth model call', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({ text: JSON.stringify({ queries: ['one', 'two', 'three'] }) })
      .mockResolvedValue({ text: '{}' })
    await expect(
      runResearch({
        topic: 'A question?',
        client: { call } as ModelClient,
        model: 'fake',
        search: { search: async () => [{ title: 'Source', url: source.url, snippet: '' }] },
        page: { read: async () => ({ title: 'Source', text: 'A page.' }), download: vi.fn() },
        limits: { maxSearches: 1, maxPages: 1, deadlineMs: 120000 }
      })
    ).rejects.toThrow('invalid_findings')
    expect(call).toHaveBeenCalledTimes(3)
  })

  it('ranks a URL by distinct queries rather than duplicate hits within one query', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({ text: JSON.stringify({ queries: ['one', 'two', 'three'] }) })
      .mockResolvedValueOnce({ text: JSON.stringify(doc) })
    const search = vi
      .fn()
      .mockResolvedValueOnce([
        ...[1, 2, 3].map(() => ({ title: 'Other', url: 'https://other.example/', snippet: '' })),
        { title: 'Source', url: source.url, snippet: '' }
      ])
      .mockResolvedValueOnce([{ title: 'Source', url: source.url, snippet: '' }])
    const read = vi.fn().mockResolvedValue({ title: 'Source', text: 'A page.' })
    await runResearch({
      topic: 'A question?',
      client: { call } as ModelClient,
      model: 'fake',
      search: { search },
      page: { read, download: vi.fn() },
      limits: { maxSearches: 2, maxPages: 1, deadlineMs: 120000 }
    })
    expect(read.mock.calls[0]?.[0]).toBe(source.url)
  })

  it('trims 8 queries to 6 and proceeds with the job', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({ text: JSON.stringify({ queries: ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8'] }) })
      .mockResolvedValueOnce({ text: JSON.stringify(doc) })
    const search = vi.fn().mockResolvedValue([{ title: 'A source', url: source.url, snippet: '' }])
    const read = vi.fn().mockResolvedValue({ title: 'A source', text: 'Read text.' })
    const result = await runResearch({
      topic: 'A question?',
      client: { call } as ModelClient,
      model: 'fake',
      search: { search },
      page: { read, download: vi.fn() },
      limits: { maxSearches: 6, maxPages: 1, deadlineMs: 120000 },
      now: () => new Date(at)
    })
    expect(search).toHaveBeenCalledTimes(6)
    expect(search.mock.calls.map((c) => c[0])).toEqual(['q1', 'q2', 'q3', 'q4', 'q5', 'q6'])
    expect(result.sources).toEqual([source])
  })

  it('trims over-long findings arrays to their maximums and still enforces zod limits', async () => {
    const read = Array.from({ length: 14 }, (_, index) => ({
      n: index + 1,
      title: `Source ${index + 1}`,
      url: `https://example.com/${index + 1}`,
      domain: 'example.com',
      accessedAt: at,
      text: `Text ${index + 1}`
    }))
    const overlong = {
      title: 'A report',
      question: 'A question?',
      summary: 'A summary',
      keyFindings: Array.from({ length: 9 }, (_, i) => ({ text: `Finding ${i + 1}`, sources: [1] })),
      sections: Array.from({ length: 8 }, (_, i) => ({ heading: `Section ${i + 1}`, body: 'Body', sources: [1] })),
      limitations: Array.from({ length: 6 }, (_, i) => `Limitation ${i + 1}`),
      sources: read.slice(0, 14).map((s, i) => ({ n: i < 12 ? s.n : 12, title: s.title, url: s.url }))
    }
    const result = validateFindings(overlong, read)
    expect(result.keyFindings).toHaveLength(7)
    expect(result.sections).toHaveLength(6)
    expect(result.limitations).toHaveLength(4)
    expect(result.sources).toHaveLength(12)

    expect(() => validateFindings({ ...doc, title: 'abc' }, [{ ...source, text: 'Read text' }])).toThrow(z.ZodError)
    expect(() =>
      validateFindings(
        { ...doc, keyFindings: [{ text: 'x'.repeat(301), sources: [1] }, ...doc.keyFindings.slice(1)] },
        [{ ...source, text: 'Read text' }]
      )
    ).toThrow(z.ZodError)

    await expect(
      runResearch({
        topic: 'A question?',
        client: {
          call: vi.fn().mockResolvedValueOnce({ text: JSON.stringify({ queries: ['only-one'] }) })
        } as ModelClient,
        model: 'fake',
        search: { search: vi.fn() },
        page: { read: vi.fn(), download: vi.fn() },
        limits: { maxSearches: 6, maxPages: 8, deadlineMs: 120000 }
      })
    ).rejects.toThrow(z.ZodError)
  })
})
