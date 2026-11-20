import { parseOfficialSocialPostUrl, platformOwnsHost, type SocialPlatform, type SocialPostTarget } from './urls.js'

// A share or short link names its post only through its redirects (docs/trd/tools.md#social-post-reader).

export const SHARE_TIMEOUT_MS = 1500
export const MAX_SHARE_REDIRECTS = 2
const REDIRECTS = new Set([301, 302, 303, 307, 308])

/** True for an HTTPS address on one of the platform's own domains, with no credentials and no port. */
function isOwnHttps(href: string, platform: SocialPlatform): boolean {
  const url = new URL(href)
  return (
    url.protocol === 'https:' &&
    url.username === '' &&
    url.password === '' &&
    url.port === '' &&
    platformOwnsHost(url.hostname.toLowerCase(), platform)
  )
}

/**
 * Settles with `work`'s value, or with undefined as soon as `budget` aborts. Either way it removes its abort listener,
 * so a late answer leaves nothing behind. A rejection of `work` reaches the caller only while the budget still runs.
 */
function untilBudget<T>(work: Promise<T>, budget: AbortSignal): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve, reject) => {
    const onAbort = () => resolve(undefined)
    const detach = () => budget.removeEventListener('abort', onAbort)
    work.then(
      (value) => {
        detach()
        resolve(value)
      },
      (error: unknown) => {
        detach()
        reject(error)
      }
    )
    if (budget.aborted) onAbort()
    else budget.addEventListener('abort', onAbort, { once: true })
  })
}

/** Starts cancelling a response body without waiting for it, so a cancel that never settles holds nothing. */
function release(response: Response): void {
  const cancelled = (async () => response.body?.cancel())()
  cancelled.catch(() => undefined)
}

/**
 * The post a share or short link redirects to. Follows at most MAX_SHARE_REDIRECTS redirects through `fetcher`,
 * each answer read without following it. A hop may land on an HTTPS address of the platform's own domain that names
 * no post, and is followed once. Any other `Location` must parse as an official link of the share's own platform.
 * A hop to another host or platform, a missing `Location`, a further share after the last allowed hop, or a timeout
 * fails the link. Resolves to null on any failure.
 */
export async function resolveShareLink(
  share: SocialPostTarget,
  fetcher: typeof fetch,
  signal?: AbortSignal
): Promise<SocialPostTarget | null> {
  if (signal?.aborted) return null
  // One wall-time budget for the whole resolution, ended by its timer or the caller's abort. Each fetch races the
  // budget, so an injected fetch that ignores its signal cannot hold the resolver. A late answer is dropped: it starts
  // no hop and populates no cache. Response bodies are released without a wait, so no cleanup extends the budget.
  const budget = new AbortController()
  const timer = setTimeout(() => budget.abort(), SHARE_TIMEOUT_MS)
  const onCallerAbort = () => budget.abort()
  signal?.addEventListener('abort', onCallerAbort, { once: true })
  let url = share.canonicalUrl
  try {
    for (let hop = 0; hop < MAX_SHARE_REDIRECTS; hop++) {
      if (budget.signal.aborted) return null
      const fetched = (async () => fetcher(url, { redirect: 'manual', signal: budget.signal }))()
      const response = await untilBudget(fetched, budget.signal)
      // Timed out, aborted, or the guarded fetch refused: no hop, no cache entry.
      if (!response || budget.signal.aborted) return null
      release(response)
      if (!REDIRECTS.has(response.status)) return null
      const location = response.headers.get('location')
      if (!location) return null
      const href = new URL(location, url).href
      const next = parseOfficialSocialPostUrl(href)
      if (next) {
        if (next.platform !== share.platform) return null
        if (!next.needsRedirect) return next
        url = next.canonicalUrl
        continue
      }
      // One hop may land on the platform's own domain without naming a post. The last allowed hop must name one.
      if (hop + 1 >= MAX_SHARE_REDIRECTS || !isOwnHttps(href, share.platform)) return null
      url = href
    }
    return null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onCallerAbort)
  }
}
