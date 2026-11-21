import { afterEach, describe, expect, it, vi } from 'vitest'
import { createExaSearchPort } from '../../src/tools/exa.js'
import { msg, queueModel, startApp } from '../support/app.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createExaSearchPort', () => {
  it('sends the expected POST request with headers and body', async () => {
    const seen: { url: string; method: string; headers: Headers; body: unknown }[] = []
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({
        url: String(url),
        method: init?.method ?? 'GET',
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body))
      })
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }) as typeof fetch

    const port = createExaSearchPort({ apiKey: 'exa-secret-key', fetch: fakeFetch })
    const results = await port.search('typescript 5', new AbortController().signal)

    expect(results).toEqual([])
    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toBe('https://api.exa.ai/search')
    expect(seen[0]?.method).toBe('POST')
    expect(seen[0]?.headers.get('content-type')).toBe('application/json')
    expect(seen[0]?.headers.get('x-api-key')).toBe('exa-secret-key')
    expect(seen[0]?.body).toEqual({
      query: 'typescript 5',
      type: 'auto',
      numResults: 5,
      contents: { highlights: true }
    })
  })

  it('maps results, defaults title, collapses whitespace, cuts at 300 chars, and skips missing url', async () => {
    const longHighlight = `  ${'word '.repeat(80)}  `
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({
          results: [
            { title: null, url: 'https://example.test/1', highlights: ['', '   \n\t ', '  first\n\t highlight  '] },
            { title: 'Long', url: 'https://example.test/2', highlights: [longHighlight] },
            { title: 'No URL', highlights: ['ignored'] },
            { title: 'Bad URL', url: 123, highlights: ['ignored'] }
          ]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )) as typeof fetch

    const port = createExaSearchPort({ apiKey: 'k', fetch: fakeFetch })
    const results = await port.search('q', new AbortController().signal)

    expect(results).toHaveLength(2)
    expect(results[0]).toEqual({
      title: '',
      url: 'https://example.test/1',
      snippet: 'first highlight'
    })
    expect(results[1]?.title).toBe('Long')
    expect(results[1]?.url).toBe('https://example.test/2')
    expect(results[1]?.snippet.length).toBe(300)
    expect(results[1]?.snippet.endsWith('…')).toBe(true)
  })

  it('throws on non-2xx and invalid JSON without leaking key or response body', async () => {
    const apiKey = 'exa-super-secret-key'
    const secretBody = 'sensitive-upstream-body-text'

    const nonOkPort = createExaSearchPort({
      apiKey,
      fetch: (async () => new Response(secretBody, { status: 401 })) as typeof fetch
    })
    await expect(nonOkPort.search('q', new AbortController().signal)).rejects.toSatisfy((err: Error) => {
      expect(err.message).toBe('exa search failed (401)')
      expect(err.message).not.toContain(apiKey)
      expect(err.message).not.toContain(secretBody)
      return true
    })

    const netErr = new Error('socket hang up')
    const netPort = createExaSearchPort({
      apiKey,
      fetch: (async () => {
        throw netErr
      }) as typeof fetch
    })
    await expect(netPort.search('q', new AbortController().signal)).rejects.toSatisfy((err: Error) => {
      expect(err.message).toBe('exa search failed (network)')
      expect(err.cause).toBe(netErr)
      return true
    })

    const badJsonPort = createExaSearchPort({
      apiKey,
      fetch: (async () => new Response(`{bad json ${secretBody}`, { status: 200 })) as typeof fetch
    })
    await expect(badJsonPort.search('q', new AbortController().signal)).rejects.toSatisfy((err: Error) => {
      expect(err.message).toContain('exa search failed')
      expect(err.message).not.toContain(apiKey)
      expect(err.message).not.toContain(secretBody)
      expect(err.cause).toBeInstanceOf(Error)
      return true
    })
  })

  it('rejects without calling fetch on an already-aborted signal, and aborts a hanging fetch on timeout', async () => {
    let calls = 0
    const countingFetch = (async () => {
      calls += 1
      return new Response(JSON.stringify({ results: [] }), { status: 200 })
    }) as typeof fetch

    const controller = new AbortController()
    controller.abort()
    const port = createExaSearchPort({ apiKey: 'k', fetch: countingFetch })
    await expect(port.search('q', controller.signal)).rejects.toThrow('exa search failed (aborted)')
    expect(calls).toBe(0)

    const hangingFetch = ((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })) as typeof fetch
    const timeoutPort = createExaSearchPort({ apiKey: 'k', fetch: hangingFetch, timeoutMs: 20 })
    await expect(timeoutPort.search('q', new AbortController().signal)).rejects.toThrow('exa search failed (timeout)')
  })

  it('wires web_search through createExaSearchPort when search.provider is exa and EXA_API_KEY is set', async () => {
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) === 'https://api.exa.ai/search') {
        return new Response(
          JSON.stringify({
            results: [{ title: 'Exa Result', url: 'https://example.test/exa', highlights: ['Found via Exa.'] }]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }
      return realFetch(url, init)
    }) as typeof fetch)

    const model = queueModel([
      { toolCalls: [{ id: 'call-1', name: 'web_search', args: { query: 'exa test' } }] },
      { text: 'Here is what I found.' }
    ])
    const { gateway } = await startApp(model, {
      config: (config) => {
        config.search.provider = 'exa'
      },
      env: { EXA_API_KEY: 'exa-test-key' }
    })

    const delivery = await gateway.send(msg('m-1', 'search for exa test'))
    expect(delivery.content).toBe('Here is what I found.\n\n_🛠️ searched the web_\n_🔗 example.test_')
    const toolMessage = model.requests[1]?.messages.at(-1)
    expect(toolMessage).toMatchObject({ role: 'tool', name: 'web_search' })
    expect(JSON.parse(String(toolMessage?.content))).toEqual({
      results: [{ title: 'Exa Result', url: 'https://example.test/exa', snippet: 'Found via Exa.', source: 's1' }]
    })
  })

  it('exa image search returns main images first, then image links, https only, deduplicated', async () => {
    const seen: { url: string; method: string; headers: Headers; body: unknown }[] = []
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({
        url: String(url),
        method: init?.method ?? 'GET',
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body))
      })
      return new Response(
        JSON.stringify({
          results: [
            {
              image: 'https://a.test/main-1.jpg',
              extras: {
                imageLinks: ['http://insecure.test/skip.jpg', 'https://a.test/main-1.jpg', 'https://a.test/link-1.png']
              }
            },
            {
              image: 'http://insecure.test/main-2.jpg',
              extras: {
                imageLinks: ['data:image/png;base64,AAA', 'https://b.test/link-2.webp', '/relative.jpg']
              }
            },
            {
              image: 'https://c.test/main-3.png',
              extras: {
                imageLinks: ['https://a.test/link-1.png', 'https://c.test/link-3.gif']
              }
            }
          ]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }) as typeof fetch

    const port = createExaSearchPort({ apiKey: 'exa-secret-key', fetch: fakeFetch })
    const candidates = await port.images?.('sunset beach', new AbortController().signal)

    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toBe('https://api.exa.ai/search')
    expect(seen[0]?.method).toBe('POST')
    expect(seen[0]?.headers.get('content-type')).toBe('application/json')
    expect(seen[0]?.headers.get('x-api-key')).toBe('exa-secret-key')
    expect(seen[0]?.body).toEqual({
      query: 'sunset beach',
      type: 'auto',
      numResults: 5,
      contents: { extras: { imageLinks: 3 } }
    })
    expect(candidates).toEqual([
      { url: 'https://a.test/main-1.jpg' },
      { url: 'https://c.test/main-3.png' },
      { url: 'https://a.test/link-1.png' },
      { url: 'https://b.test/link-2.webp' },
      { url: 'https://c.test/link-3.gif' }
    ])
  })

  it('caps image search candidates at 10', async () => {
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({
          results: Array.from({ length: 5 }, (_, i) => ({
            image: `https://example.test/main-${i}.jpg`,
            extras: {
              imageLinks: [
                `https://example.test/link-${i}-1.jpg`,
                `https://example.test/link-${i}-2.jpg`,
                `https://example.test/link-${i}-3.jpg`
              ]
            }
          }))
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )) as typeof fetch

    const port = createExaSearchPort({ apiKey: 'k', fetch: fakeFetch })
    const candidates = await port.images?.('cats', new AbortController().signal)
    expect(candidates).toHaveLength(10)
    expect(candidates?.slice(0, 5)).toEqual([
      { url: 'https://example.test/main-0.jpg' },
      { url: 'https://example.test/main-1.jpg' },
      { url: 'https://example.test/main-2.jpg' },
      { url: 'https://example.test/main-3.jpg' },
      { url: 'https://example.test/main-4.jpg' }
    ])
  })
})
