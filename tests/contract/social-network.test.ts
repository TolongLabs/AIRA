import { describe, expect, it, vi } from 'vitest'
import { checkedFetcher, publicAddress } from '../../src/social/fetch.js'
import { resolveShareLink } from '../../src/social/share.js'
import { findLinkTarget, parseSocialPostUrl } from '../../src/social/urls.js'
import { SocialPostViewer } from '../../src/social/viewer.js'

const settings = { timeoutMs: 40, maxTextChars: 1500, cacheTtlMs: 0, maxCacheEntries: 2, ytDlpPath: 'unused' }
const json = (body: unknown) => new Response(JSON.stringify(body))

describe('social network boundaries', () => {
  it.each([[], ['127.0.0.1'], ['8.8.8.8', '192.168.1.1'], ['::1'], ['not-an-address']])(
    'rejects empty, invalid, private or mixed DNS answers: %j',
    async (...addresses) => {
      const fetcher = vi.fn(async () => json({}))
      const lookup = vi.fn(async () => addresses)
      await expect(checkedFetcher(fetcher, lookup)('https://example.test/post')).rejects.toThrow('forbidden')
      expect(fetcher).not.toHaveBeenCalled()
    }
  )

  it('does not follow a redirect from an allowed endpoint', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/' } }))
    const lookup = vi.fn(async () => ['8.8.8.8'])
    const viewer = new SocialPostViewer(settings, {
      fetcher,
      lookup,
      runExtractor: vi.fn(async () => ({ reason: 'unused' })),
      warn: vi.fn()
    })
    expect(await viewer.lookup(parseSocialPostUrl('https://x.com/example_user/status/123')!)).toMatchObject({
      status: 'failed',
      reason: 'http_302'
    })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ redirect: 'manual' }))
  })

  it('checks IP literals without DNS and rejects private addresses', async () => {
    const lookup = vi.fn(async () => ['8.8.8.8'])
    expect(await publicAddress('127.0.0.1', lookup)).toBe(false)
    expect(await publicAddress('[::ffff:127.0.0.1]', lookup)).toBe(false)
    expect(await publicAddress('8.8.8.8', lookup)).toBe(true)
    expect(lookup).not.toHaveBeenCalled()
  })

  it('keeps a Bluesky post when PDS DNS fails', async () => {
    const lookup = vi.fn(async (host: string) => {
      if (host === 'pds.example.test') throw new Error('DNS unavailable')
      return ['8.8.8.8']
    })
    const viewer = new SocialPostViewer(settings, {
      lookup,
      runExtractor: vi.fn(async () => ({ reason: 'unused' })),
      warn: vi.fn(),
      fetcher: async (input) =>
        String(input).startsWith('https://plc.directory/')
          ? json({
              service: [
                { id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: 'https://pds.example.test' }
              ]
            })
          : json({
              thread: {
                post: {
                  author: { did: 'did:plc:example' },
                  record: {
                    text: 'Still readable',
                    embed: { video: { ref: { $link: 'examplecid' }, mimeType: 'video/mp4' } }
                  }
                }
              }
            })
    })
    expect(
      await viewer.lookup(parseSocialPostUrl('https://bsky.app/profile/did:plc:example/post/abc123')!)
    ).toMatchObject({ status: 'found', post: { text: 'Still readable', video: null } })
  })

  it('picks one link from newest-first texts, then the quote', () => {
    const quote = 'https://x.com/example_quote/status/303'
    expect(
      findLinkTarget([
        'newest https://t.co/example https://x.com/example_user/status/101 https://x.com/example_user/status/102',
        'older https://x.com/example_old/status/202',
        quote
      ])?.id
    ).toBe('101')
    expect(findLinkTarget(['no link', quote])?.id).toBe('303')
    expect(findLinkTarget(['https://t.co/example'])).toBeNull()
    expect(findLinkTarget(['https://reddit.com/r/example/s/share'])).toMatchObject({ needsRedirect: true })
  })

  it('does not share Bluesky cache entries between different posting accounts', () => {
    const first = parseSocialPostUrl('https://bsky.app/profile/example_one.test/post/abc123')!
    const second = parseSocialPostUrl('https://bsky.app/profile/example_two.test/post/abc123')!
    expect(first.lookupKey).not.toBe(second.lookupKey)
  })

  it('never contacts a mirror host: every fetch and DNS lookup names the platform address', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request) => json({}))
    const lookup = vi.fn(async (_host: string) => ['8.8.8.8'])
    const viewer = new SocialPostViewer(settings, {
      fetcher,
      lookup,
      runExtractor: vi.fn(async () => ({ reason: 'unused' })),
      warn: vi.fn()
    })
    await viewer.lookup(parseSocialPostUrl('https://mirror.example.test/example_user/status/1234567890123456789')!)
    const contacted = [
      ...fetcher.mock.calls.map(([input]) => String(input)),
      ...lookup.mock.calls.map(([host]) => String(host))
    ]
    expect(contacted.length).toBeGreaterThan(0)
    expect(contacted.join(' ')).not.toContain('mirror.example.test')
  })
})

describe('share hops stay on the platform', () => {
  const share = parseSocialPostUrl('https://www.facebook.com/share/AbCdEf9x/')!

  it.each([
    ['another host', 'https://evil.example/someone/unrecognised/'],
    ['a mirror host', 'https://fbmirror.test/someone/unrecognised/'],
    ['plain http', 'http://www.facebook.com/someone/unrecognised/'],
    ['an explicit port', 'https://www.facebook.com:8443/someone/unrecognised/'],
    ['credentials', 'https://user:pw@www.facebook.com/someone/unrecognised/'],
    ['another platform', 'https://www.youtube.com/someone/unrecognised/']
  ])('never follows an intermediate hop to %s', async (_name, location) => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      if (String(input) !== share.canonicalUrl) throw new Error(`unexpected address ${String(input)}`)
      return new Response(null, { status: 302, headers: { location } })
    })
    expect(await resolveShareLink(share, fetcher)).toBeNull()
    expect(fetcher).toHaveBeenCalledOnce()
  })
})
