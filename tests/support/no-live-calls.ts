import { afterEach, beforeEach } from 'vitest'

// The Zero Live Calls gate (docs/trd/harness.md#fixed-gates): no test may reach a host other than this machine.
// A request to anywhere else throws, so the test that made it fails.

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])
const realFetch = globalThis.fetch

function hostOf(input: Parameters<typeof fetch>[0]): string {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  return new URL(url).hostname
}

/** Every live call a test tried, across the run. Read by the gate test. */
export const liveCalls: string[] = []

beforeEach(() => {
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const host = hostOf(input)
    if (!LOOPBACK.has(host)) {
      liveCalls.push(host)
      throw new Error(`live call to ${host}: tests run with zero live calls`)
    }
    return realFetch(input, init)
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
})
