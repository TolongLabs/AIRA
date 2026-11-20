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
  // Wall-time budget for the whole resolution. The passed fetcher is already guarded (DNS + private-host check),
  // and an injected fetch may ignore its abort signal, so each hop races the fetch against the remaining budget.
  // A late response loses the race and never starts another hop or populates the cache.
  const deadline = Date.now() + SHARE_TIMEOUT_MS
  const timeoutController = new AbortController()
  const timer = setTimeout(() => timeoutController.abort(), SHARE_TIMEOUT_MS)
  const budget = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal
  let url = share.canonicalUrl
  try {
    for (let hop = 0; hop < MAX_SHARE_REDIRECTS; hop++) {
      const remaining = deadline - Date.now()
      if (remaining <= 0 || signal?.aborted || budget.aborted) return null
      let response: Response | null
      try {
        response = (await Promise.race([
          fetcher(url, { redirect: 'manual', signal: budget }),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), remaining))
        ])) as Response | null
      } catch {
        return null
      }
      // Timed out, aborted, or the guarded fetch refused: no hop, no cache entry.
      if (response === null || signal?.aborted || budget.aborted) return null
      await response.body?.cancel()
      if (signal?.aborted || budget.aborted || Date.now() >= deadline) return null
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
  }
}
