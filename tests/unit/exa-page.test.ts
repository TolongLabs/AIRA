import { describe, expect, it } from 'vitest'
import { createExaPagePort } from '../../src/tools/exa.js'
import type { PagePort } from '../../src/tools/ports.js'

const fallback: PagePort = {
  read: async () => ({ title: 'plain', text: 'plain text' }),
  download: async () => ({ data: Buffer.from('x'), contentType: 'image/png' })
}
const signal = new AbortController().signal
const exaReturns = (status: number, body: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status })) as typeof fetch

describe('Exa page reader', () => {
  it('reads through Exa contents with a live-crawl fallback and the key in a header', async () => {
    let sent: { url: string; init: RequestInit } | undefined
    const port = createExaPagePort({
      apiKey: 'test-key',
      fallback,
      maxChars: 10,
      fetch: (async (url: string, init: RequestInit) => {
        sent = { url, init }
        return new Response(JSON.stringify({ results: [{ title: 'Article', text: '  0123456789abcdef  ' }] }))
      }) as unknown as typeof fetch
    })
    expect(await port.read('https://example.com/a', signal)).toEqual({ title: 'Article', text: '0123456789' })
    expect(sent?.url).toBe('https://api.exa.ai/contents')
    expect(JSON.parse(String(sent?.init.body))).toEqual({
      urls: ['https://example.com/a'],
      text: { maxCharacters: 10 },
      livecrawl: 'fallback'
    })
    expect((sent!.init.headers as Record<string, string>)['x-api-key']).toBe('test-key')
  })

  it('falls back to the plain reader on an error status, an empty text or a network failure', async () => {
    for (const fetchFn of [
      exaReturns(500, {}),
      exaReturns(200, { results: [{ title: 'x', text: '   ' }] }),
      exaReturns(200, { results: [] }),
      (async () => {
        throw new Error('down')
      }) as unknown as typeof fetch
    ]) {
      const port = createExaPagePort({ apiKey: 'k', fallback, fetch: fetchFn })
      expect(await port.read('https://example.com/a', signal)).toEqual({ title: 'plain', text: 'plain text' })
    }
  })

  it('downloads through the plain reader, which checks every address', async () => {
    const port = createExaPagePort({ apiKey: 'k', fallback, fetch: exaReturns(500, {}) })
    expect((await port.download('https://example.com/i.png', signal, 10)).contentType).toBe('image/png')
  })
})
