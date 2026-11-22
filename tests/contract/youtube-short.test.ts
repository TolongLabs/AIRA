import { expect, it, vi } from 'vitest'
import { confirmsShort } from '../../src/media/youtube-short.js'

const url = 'https://www.youtube.com/shorts/example1234'
it.each([
  [200, url, true],
  [200, 'https://www.youtube.com/watch?v=example1234', false],
  [200, 'https://www.youtube.com/shorts/another1234', false],
  [303, url, false],
  [403, url, false]
] as const)('checks the official Shorts page, status %i and canonical %s', async (status, canonical, expected) => {
  const fetcher = vi.fn(
    async () =>
      new Response('<html><head><link rel="canonical" href="' + canonical + '"></head></html>', {
        status,
        headers: { 'content-type': 'text/html' }
      })
  )
  expect(await confirmsShort(url, new AbortController().signal, fetcher)).toBe(expected)
  expect(fetcher).toHaveBeenCalledWith(url, expect.objectContaining({ redirect: 'manual' }))
})
