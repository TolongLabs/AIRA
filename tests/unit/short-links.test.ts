import { describe, expect, it, vi } from 'vitest'
import { cleanReply } from '../../src/format/clean.js'
import { forReplay } from '../../src/format/footer.js'
import { createFooterLinks } from '../../src/format/short-links.js'

const config = { baseUrl: 'https://links.example', timeoutMs: 80 }
const urls = ['https://first.example/one', 'https://second.example/two', 'https://third.example/three']

const cleaned = (body: string) =>
  cleanReply(body, {
    toolNames: [],
    speakerNames: [],
    lengthBypass: true,
    shape: {},
    fixedBlocks: [],
    leakCheck: false,
    fallbackLine: 'Fallback',
    bubbleMaxChars: 3800,
    maxBubbles: 1,
    toolsOk: ['web_search'],
    sources: urls
  })

describe('footer short links', () => {
  it('uses the configured host and keeps only the domains of failed and late requests', async () => {
    vi.useFakeTimers()
    try {
      const signals: AbortSignal[] = []
      const fetcher = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = JSON.parse(String(init?.body)).url
        if (init?.signal) signals.push(init.signal)
        if (url === urls[0]) return Response.json({ code: 'Ab37eX', short: 'https://other.example/wrong' })
        if (url === urls[1]) return new Response(null, { status: 503 })
        return new Promise<Response>(() => {})
      })
      const shorten = createFooterLinks(config, 'test-secret', fetcher)!
      const pending = shorten(cleaned('A reply.'), 40)
      await vi.advanceTimersByTimeAsync(40)
      const content = await pending

      expect(fetcher).toHaveBeenCalledTimes(3)
      expect(fetcher).toHaveBeenCalledWith(
        'https://links.example/api/links',
        expect.objectContaining({ method: 'POST', redirect: 'error' })
      )
      expect(signals[0]?.aborted).toBe(true)
      expect(content).toBe(
        'A reply.\n\n_🛠️ searched the web_\n🔗 first.example https://links.example/Ab37eX\n🔗 second.example\n🔗 third.example'
      )
      expect(forReplay(content)).toBe('A reply.')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a full body and footer below the gateway limit', async () => {
    const body = 'A'.repeat(3800)
    const reply = cleaned(body)
    const shorten = createFooterLinks(config, 'test-secret', async () => Response.json({ code: 'Ab37eX' }))!
    const result = await shorten(reply, 100)
    expect(result.split('\n')[0]).toHaveLength(3800)
    expect(result.length).toBeLessThan(4096)
    expect(result).toContain('https://links.example/Ab37eX')
    expect(createFooterLinks({ ...config, baseUrl: '' }, 'test-secret')).toBeUndefined()
    expect(createFooterLinks(config)).toBeUndefined()
    expect(reply.content).toContain('_🔗 first.example · second.example · third.example_')
  })
})
