import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { isForbiddenIp, isForbiddenUrl } from '../tools/ports.js'

export type Lookup = (host: string) => Promise<string[]>

const defaultLookup: Lookup = async (host) => (await dnsLookup(host, { all: true })).map((entry) => entry.address)

export async function publicAddress(host: string, lookup: Lookup = defaultLookup): Promise<boolean> {
  const normalized = host.replace(/^\[|\]$/g, '')
  const addresses = isIP(normalized) ? [normalized] : await lookup(normalized)
  return addresses.length > 0 && addresses.every((address) => isIP(address) !== 0 && !isForbiddenIp(address))
}

/** Social endpoints never follow redirects, including redirects to private hosts. */
export function checkedFetcher(fetcher: typeof fetch, lookup?: Lookup): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (isForbiddenUrl(url.href) || !(await publicAddress(url.hostname, lookup))) {
      throw new Error('forbidden address')
    }
    init?.signal?.throwIfAborted()
    return fetcher(input, { ...init, redirect: 'manual' })
  }
}
