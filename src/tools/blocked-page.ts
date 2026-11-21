/** Phrases that only an access-block or challenge page carries. Matched case-insensitively. */
const BLOCK_MARKERS = [
  'access denied',
  'just a moment',
  'blocked by network security',
  'log in to continue',
  'complete the captcha',
  'solve the captcha',
  'captcha challenge',
  'attention required',
  'verify you are human',
  'are you a robot',
  'enable javascript and cookies'
]
const SITE_NAME_MAX_CHARS = 25
const MARKED_MAX_CHARS = 1_000

function charCount(text: string): number {
  return [...text].length
}

/** Lower case, single spaces, and no leading or trailing punctuation, so `Example.` matches `example`. */
function comparable(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    .trim()
}

function hasBlockMarker(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').toLowerCase()
  return BLOCK_MARKERS.some((marker) => normalized.includes(marker))
}

/** Second-level labels that sit under a two-letter country suffix, as in `example.com.my` or `bbc.co.uk`. */
const GENERIC_SECOND_LEVEL = new Set(['ac', 'co', 'com', 'edu', 'gov', 'net', 'org'])

/**
 * Candidate host and site names for a URL: full hostname (including `www.`), host without `www.`, registrable domain
 * under the two-letter country suffix heuristic, and site label.
 */
function siteNames(url: string): string[] {
  let fullHost = ''
  try {
    fullHost = new URL(url).hostname.replace(/\.$/, '')
  } catch {
    return []
  }
  const host = fullHost.replace(/^www\./, '')
  const labels = host.split('.')
  const tld = labels.at(-1) ?? ''
  const second = labels.at(-2) ?? ''
  const underCountrySuffix = labels.length >= 3 && tld.length === 2 && GENERIC_SECOND_LEVEL.has(second)
  const suffixLabels = underCountrySuffix ? 3 : 2
  const registrable = labels.slice(-suffixLabels).join('.')
  const label = labels.at(-suffixLabels) ?? host
  const names = new Set([fullHost, host, registrable, label].map(comparable).filter((name) => name.length > 0))
  return [...names]
}

/**
 * True when a page's text is a failed read, not content: a short text that is only the site's host, registrable
 * domain, or site label, or a body under 1,000 characters whose text or title holds an access-block marker. Exa's
 * page port and the plain fetch both use it (docs/trd/tools.md).
 */
export function isBlockedPage(text: string, url: string, title = ''): boolean {
  const body = text.trim()
  if (charCount(body) < SITE_NAME_MAX_CHARS && siteNames(url).includes(comparable(body))) return true
  const heading = title.trim()
  return (
    charCount(body) < MARKED_MAX_CHARS &&
    (hasBlockMarker(body) || (charCount(heading) < MARKED_MAX_CHARS && hasBlockMarker(heading)))
  )
}
