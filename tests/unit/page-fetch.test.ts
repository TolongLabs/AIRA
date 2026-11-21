import { describe, expect, it } from 'vitest'
import { isBlockedPage } from '../../src/tools/blocked-page.js'
import { createFetchPagePort } from '../../src/tools/ports.js'

const signal = new AbortController().signal
const publicHost = async () => ['93.184.216.34']
const LONG_PAGE = `Weekly notes: ${'Example summary text for the page. '.repeat(20)}`

const page = (title: string, body: string): Response =>
  new Response(`<html><head><title>${title}</title></head><body>${body}</body></html>`, {
    headers: { 'content-type': 'text/html; charset=utf-8' }
  })

const redirect = (location: string, setCookie?: string): Response =>
  new Response(null, { status: 307, headers: setCookie ? { location, 'set-cookie': setCookie } : { location } })

/** The cookie header a request carried, or undefined. */
const cookieSent = (init: RequestInit | undefined): string | undefined =>
  (init?.headers as Record<string, string> | undefined)?.cookie

describe('isBlockedPage', () => {
  it('treats a page with an access-block marker under 1,000 characters as blocked', () => {
    expect(isBlockedPage('Access denied. Reference 1234.', 'https://example.com/')).toBe(true)
    expect(isBlockedPage('Just a moment... Checking your browser', 'https://example.com/')).toBe(true)
    expect(isBlockedPage('Request Blocked By Network Security', 'https://example.com/')).toBe(true)
    expect(isBlockedPage('Please Log in to continue.', 'https://example.com/')).toBe(true)
  })

  it('treats short host-only or site-label text as blocked, never a normal page title', () => {
    expect(isBlockedPage('Example', 'https://example.com.my/notes/')).toBe(true)
    expect(isBlockedPage('www.example.com.my', 'https://www.example.com.my/')).toBe(true)
    expect(isBlockedPage('example.com.my', 'https://www.example.com.my/')).toBe(true)
    expect(isBlockedPage('example.com.my', 'https://portal.example.com.my/notes/')).toBe(true)
    expect(isBlockedPage('example', 'https://www.example.com.my/')).toBe(true)
    expect(isBlockedPage('www.reddit.com', 'https://www.reddit.com/')).toBe(true)
    expect(isBlockedPage('reddit.com', 'https://www.reddit.com/')).toBe(true)
    expect(isBlockedPage('Reddit', 'https://www.reddit.com/')).toBe(true)
    expect(isBlockedPage('bbc.co.uk', 'https://news.bbc.co.uk/')).toBe(true)
    expect(isBlockedPage('BBC', 'https://news.bbc.co.uk/')).toBe(true)
    expect(isBlockedPage('www.long-example-site.com', 'https://www.long-example-site.com/')).toBe(false)
    expect(isBlockedPage('Status is up', 'https://example.com/', 'Example')).toBe(false)
    expect(isBlockedPage('Status is up', 'https://example.com/')).toBe(false)
  })

  it('treats an empty body with only a block-marker title as blocked', () => {
    expect(isBlockedPage('', 'https://example.com/', 'Just a moment...')).toBe(true)
    expect(isBlockedPage('', 'https://example.com/', 'Access denied')).toBe(true)
    expect(isBlockedPage('', 'https://example.com/', 'Example')).toBe(false)
  })

  it('treats a short challenge page as blocked by its text or its title', () => {
    expect(isBlockedPage('Please complete the CAPTCHA to continue.', 'https://example.com/')).toBe(true)
    expect(isBlockedPage('Verify you are human by completing the action below.', 'https://example.com/')).toBe(true)
    expect(isBlockedPage('Enable JavaScript and cookies to continue', 'https://example.com/')).toBe(true)
    expect(isBlockedPage('Reference #18.abc', 'https://example.com/', 'Access Denied')).toBe(true)
    expect(isBlockedPage('Ray ID: 1234', 'https://example.com/', 'Just a moment...')).toBe(true)
    expect(isBlockedPage(`Opening hours. ${'x'.repeat(1000)}`, 'https://example.com/', 'Just a moment')).toBe(false)
    expect(isBlockedPage('The road was blocked by snow overnight.', 'https://example.com/', 'Snow day')).toBe(false)
    expect(isBlockedPage('Fixed reCAPTCHA v3 on the signup form.', 'https://example.com/', 'Changelog')).toBe(false)
  })

  it('reads a long page with a marker word, and a short real page', () => {
    expect(isBlockedPage(`Access denied. ${'x'.repeat(1000)}`, 'https://example.com/')).toBe(false)
    expect(isBlockedPage('Hi, the page is up.', 'https://example.com/')).toBe(false)
    expect(isBlockedPage('', 'https://example.com/')).toBe(false)
  })
})

describe('createFetchPagePort redirects and cookies', () => {
  it('resolves a cookie loop: the site sets a cookie and redirects to itself, then serves the page', async () => {
    const seen: { url: string; cookie: string | undefined }[] = []
    const fetchFn = async (url: string, init: RequestInit) => {
      seen.push({ url, cookie: cookieSent(init) })
      if (cookieSent(init) === 'session=abc') return page('Weekly notes', LONG_PAGE)
      return redirect('https://example.com/notes/', 'session=abc; Path=/; HttpOnly')
    }
    const port = createFetchPagePort({ fetch: fetchFn as typeof fetch, lookup: publicHost })

    expect(await port.read('https://example.com/notes/', signal)).toEqual({
      title: 'Weekly notes',
      text: expect.stringContaining('Example summary text')
    })
    expect(seen.map((call) => call.cookie)).toEqual([undefined, 'session=abc'])
  })

  it('keeps cookies for one lookup only: the next read starts with no cookie', async () => {
    const seen: (string | undefined)[] = []
    const fetchFn = async (_url: string, init: RequestInit) => {
      seen.push(cookieSent(init))
      if (cookieSent(init) === 'session=abc') return page('Weekly notes', LONG_PAGE)
      return redirect('https://example.com/notes/', 'session=abc; Path=/')
    }
    const port = createFetchPagePort({ fetch: fetchFn as typeof fetch, lookup: publicHost })

    await port.read('https://example.com/notes/', signal)
    seen.length = 0
    await port.read('https://example.com/notes/', signal)
    expect(seen[0]).toBeUndefined()
  })

  it('sends a cookie only to the host that set it', async () => {
    const seen: { url: string; cookie: string | undefined }[] = []
    const fetchFn = async (url: string, init: RequestInit) => {
      seen.push({ url, cookie: cookieSent(init) })
      if (url === 'https://example.com/a') return redirect('https://other.example/b', 'token=xyz; Secure')
      return page('Other', LONG_PAGE)
    }
    const port = createFetchPagePort({ fetch: fetchFn as typeof fetch, lookup: publicHost })

    await port.read('https://example.com/a', signal)
    expect(seen).toEqual([
      { url: 'https://example.com/a', cookie: undefined },
      { url: 'https://other.example/b', cookie: undefined }
    ])
  })

  it('never resolves a loop that keeps redirecting: fails after five followed redirects', async () => {
    let calls = 0
    const fetchFn = async () => {
      calls++
      return redirect('https://example.com/loop', 'session=abc; Path=/')
    }
    const port = createFetchPagePort({ fetch: fetchFn as typeof fetch, lookup: publicHost })

    await expect(port.read('https://example.com/loop', signal)).rejects.toThrow('too many redirects')
    expect(calls).toBe(6)
  })

  it('follows exactly five redirects to a page', async () => {
    const hops = ['a', 'b', 'c', 'd', 'e']
    const fetchFn = async (url: string) => {
      const next = hops.findIndex((name) => url.endsWith(`/${name}`))
      if (next === -1) return page('Final', LONG_PAGE)
      return redirect(`https://example.com/${hops[next + 1] ?? 'end'}`)
    }
    const port = createFetchPagePort({ fetch: fetchFn as typeof fetch, lookup: publicHost })

    await expect(port.read('https://example.com/a', signal)).resolves.toMatchObject({ title: 'Final' })
  })
})

describe('createFetchPagePort block pages', () => {
  it('fails a block page as a failed read', async () => {
    const fetchFn = async () => page('Access denied', 'Access denied. Reference 1234. Please try again later.')
    const port = createFetchPagePort({ fetch: fetchFn as typeof fetch, lookup: publicHost })

    await expect(port.read('https://example.com/', signal)).rejects.toThrow('blocked page')
  })

  it('reads a normal short page', async () => {
    const fetchFn = async () => page('Greeting', 'Hi, the page is up.')
    const port = createFetchPagePort({ fetch: fetchFn as typeof fetch, lookup: publicHost })

    expect(await port.read('https://example.com/', signal)).toEqual({ title: 'Greeting', text: 'Hi, the page is up.' })
  })

  it('fails when the site refuses every fetch with a status', async () => {
    const fetchFn = async () => new Response('denied', { status: 403, headers: { 'content-type': 'text/html' } })
    const port = createFetchPagePort({ fetch: fetchFn as typeof fetch, lookup: publicHost })

    await expect(port.read('https://example.com/', signal)).rejects.toThrow('http status 403')
  })

  it('fails a short page whose text only names the site, with or without a title', async () => {
    for (const title of ['Home', '']) {
      const fetchFn = async () => page(title, 'Reddit')
      const port = createFetchPagePort({ fetch: fetchFn as typeof fetch, lookup: publicHost })

      await expect(port.read('https://www.reddit.com/', signal)).rejects.toThrow('blocked page')
    }
  })

  it('reads a short real page whose title is the same as its text', async () => {
    const fetchFn = async () => page('Status is up', 'Status is up')
    const port = createFetchPagePort({ fetch: fetchFn as typeof fetch, lookup: publicHost })

    expect(await port.read('https://example.com/', signal)).toEqual({ title: 'Status is up', text: 'Status is up' })
  })

  it('fails short host-only text with and without www, and registrable ccTLD text', async () => {
    for (const [url, hostText] of [
      ['https://www.example.com.my/notes/', 'www.example.com.my'],
      ['https://www.example.com.my/notes/', 'example.com.my'],
      ['https://portal.example.com.my/notes/', 'example.com.my'],
      ['https://www.reddit.com/', 'www.reddit.com'],
      ['https://www.reddit.com/', 'reddit.com']
    ] as const) {
      const fetchFn = async () => page('Home', hostText)
      const port = createFetchPagePort({ fetch: fetchFn as typeof fetch, lookup: publicHost })

      await expect(port.read(url, signal)).rejects.toThrow('blocked page')
    }
  })

  it('fails a script-only challenge with only a block-marker title rather than returning an empty read', async () => {
    for (const [title, body] of [
      ['Just a moment...', '<script>window.challenge = true</script>'],
      ['Access denied', '<script>window.challenge = true</script><noscript>Enable JS</noscript>']
    ] as const) {
      const fetchFn = async () => page(title, body)
      const port = createFetchPagePort({ fetch: fetchFn as typeof fetch, lookup: publicHost })

      await expect(port.read('https://www.example.com.my/notes/', signal)).rejects.toThrow('blocked page')
    }
  })
})
