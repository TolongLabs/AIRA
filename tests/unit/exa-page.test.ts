import { describe, expect, it } from 'vitest'
import { createExaPagePort } from '../../src/tools/exa.js'
import { createFetchPagePort, type PagePort } from '../../src/tools/ports.js'

const fallback: PagePort = {
  read: async () => ({ title: 'plain', text: 'plain text' }),
  download: async () => ({ data: Buffer.from('x'), contentType: 'image/png' })
}
const publicHost = async () => ['93.184.216.34']
const htmlResponse = (title: string, body: string): Response =>
  new Response(`<html><head><title>${title}</title></head><body>${body}</body></html>`, {
    headers: { 'content-type': 'text/html; charset=utf-8' }
  })
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

  it('falls back to the plain reader on an error status, an empty text, a block page or a network failure', async () => {
    for (const fetchFn of [
      exaReturns(500, {}),
      exaReturns(200, { results: [{ title: 'x', text: '   ' }] }),
      exaReturns(200, { results: [{ title: 'Just a moment...', text: 'Just a moment... Checking your browser' }] }),
      exaReturns(200, { results: [{ title: 'Example', text: 'Access denied. Reference 1234.' }] }),
      exaReturns(200, { results: [{ title: 'Attention Required!', text: 'Please complete the captcha.' }] }),
      exaReturns(200, { results: [{ title: 'Access Denied', text: 'Reference #18.abc' }] }),
      exaReturns(200, { results: [] }),
      (async () => {
        throw new Error('down')
      }) as unknown as typeof fetch
    ]) {
      const port = createExaPagePort({ apiKey: 'k', fallback, fetch: fetchFn })
      expect(await port.read('https://example.com/a', signal)).toEqual({ title: 'plain', text: 'plain text' })
    }
  })

  it('does not start the plain reader after the caller gave up', async () => {
    const abort = new AbortController()
    let plainCalls = 0
    const port = createExaPagePort({
      apiKey: 'k',
      fallback: {
        ...fallback,
        read: async () => {
          plainCalls++
          return { title: 'plain', text: 'plain text' }
        }
      },
      fetch: (async () => {
        abort.abort()
        throw new DOMException('aborted', 'AbortError')
      }) as unknown as typeof fetch
    })
    await expect(port.read('https://example.com/a', abort.signal)).rejects.toThrow()
    expect(plainCalls).toBe(0)
  })

  it('falls back to the plain reader when the text only names the site, whatever the title', async () => {
    const port = createExaPagePort({
      apiKey: 'k',
      fallback,
      fetch: exaReturns(200, { results: [{ title: 'Front page of the internet', text: 'Reddit' }] })
    })
    expect(await port.read('https://www.reddit.com/', signal)).toEqual({ title: 'plain', text: 'plain text' })
  })

  it('downloads through the plain reader, which checks every address', async () => {
    const port = createExaPagePort({ apiKey: 'k', fallback, fetch: exaReturns(500, {}) })
    expect((await port.download('https://example.com/i.png', signal, 10)).contentType).toBe('image/png')
  })

  it('fails when Exa and the real plain port both return short host-only text (with or without www)', async () => {
    const url = 'https://www.example.com.my/notes/'
    for (const hostText of ['www.example.com.my', 'example.com.my']) {
      let exaCalls = 0
      let plainCalls = 0
      const plain = createFetchPagePort({
        lookup: publicHost,
        fetch: (async () => {
          plainCalls++
          return htmlResponse('Home', hostText)
        }) as unknown as typeof fetch
      })
      const port = createExaPagePort({
        apiKey: 'k',
        fallback: plain,
        fetch: (async () => {
          exaCalls++
          return new Response(JSON.stringify({ results: [{ title: 'Home', text: hostText }] }), { status: 200 })
        }) as unknown as typeof fetch
      })

      await expect(port.read(url, signal)).rejects.toThrow('blocked page')
      expect(exaCalls).toBe(1)
      expect(plainCalls).toBe(1)
    }
  })

  it('fails when Exa falls back to a real plain port serving a script-only challenge with a block-marker title', async () => {
    let exaCalls = 0
    let plainCalls = 0
    const plain = createFetchPagePort({
      lookup: publicHost,
      fetch: (async () => {
        plainCalls++
        return htmlResponse('Just a moment...', '<script>window.challenge = true</script>')
      }) as unknown as typeof fetch
    })
    const port = createExaPagePort({
      apiKey: 'k',
      fallback: plain,
      fetch: (async () => {
        exaCalls++
        return new Response(JSON.stringify({ results: [{ title: 'Just a moment...', text: '' }] }), { status: 200 })
      }) as unknown as typeof fetch
    })

    await expect(port.read('https://www.example.com.my/notes/', signal)).rejects.toThrow('blocked page')
    expect(exaCalls).toBe(1)
    expect(plainCalls).toBe(1)
  })
})
