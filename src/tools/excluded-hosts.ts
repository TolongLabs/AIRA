export const EXCLUDED_DOMAINS = ['linkedin.com', 'lnkd.in', 'licdn.com'] as const

export function isExcludedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.+$/, '')
  return EXCLUDED_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`))
}

export function isExcludedUrl(url: string): boolean {
  const parsed = URL.parse(url)
  return parsed !== null && isExcludedHost(parsed.hostname)
}
