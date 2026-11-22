import { expect, it, vi } from 'vitest'
import { PendingRequests } from '../../src/social/pending.js'

import { sharePendingDownloads } from '../../src/social/shared-download.js'

it('coalesces identical transfers only while pending and within one network policy', async () => {
  const download = vi.fn(async () => ({ data: Buffer.from([1]), contentType: 'video/mp4' }))
  const origin = sharePendingDownloads(download)
  const cdn = sharePendingDownloads(download)
  const url = 'https://cdn.example.test/clip.mp4'
  const { signal } = new AbortController()
  await Promise.all([
    origin(url, signal, 100),
    origin(url, signal, 100),
    origin(url, signal, 200),
    origin(url, signal, 100, { referer: 'https://example.test/' }),
    origin(url, signal, 100, undefined, 20),
    cdn(url, signal, 100)
  ])
  expect(download).toHaveBeenCalledTimes(5)
  await origin(url, signal, 100)
  expect(download).toHaveBeenCalledTimes(6)
})

it('keeps shared work alive until the last caller leaves and allows a fresh retry', async () => {
  const requests = new PendingRequests<number>()
  const start = vi.fn(
    (signal: AbortSignal) =>
      new Promise<number>((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
  )
  const first = new AbortController()
  const second = new AbortController()
  const a = requests.run('same', first.signal, start)
  const b = requests.run('same', second.signal, start)
  await Promise.resolve()
  expect(start).toHaveBeenCalledTimes(1)
  first.abort()
  await expect(a).rejects.toThrow()
  expect(start.mock.calls[0]?.[0].aborted).toBe(false)
  second.abort()
  await expect(b).rejects.toThrow()
  expect(start.mock.calls[0]?.[0].aborted).toBe(true)
  await expect(requests.run('same', undefined, async () => 42)).resolves.toBe(42)
})
