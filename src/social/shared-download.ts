import type { PagePort } from '../tools/ports.js'
import { PendingRequests } from './pending.js'

export function sharePendingDownloads(download: PagePort['download']): PagePort['download'] {
  const pending = new PendingRequests<Awaited<ReturnType<PagePort['download']>>>()
  return (url, signal, maxBytes, headers, rangeBytes) => {
    const key = JSON.stringify([url, maxBytes, headers, rangeBytes])
    return pending.run(key, signal, (sharedSignal) => download(url, sharedSignal, maxBytes, headers, rangeBytes))
  }
}
