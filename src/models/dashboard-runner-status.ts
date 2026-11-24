import type { HostSettingsSnapshot } from '../config/dashboard-types.js'

type RouterStatus = HostSettingsSnapshot['router']
export async function runnerStatus(endpoint: string, token: string | undefined): Promise<RouterStatus> {
  if (!token || token.length < 16) return { available: false, status: 'Runner credential missing' }
  if (!/^http:\/\/(?:localhost|127\.0\.0\.1|host\.docker\.internal):\d+$/.test(endpoint))
    return { available: false, status: 'Runner endpoint unavailable' }
  try {
    const response = await fetch(endpoint + '/ready', {
      headers: { authorization: 'Bearer ' + token },
      redirect: 'error',
      signal: AbortSignal.timeout(4200)
    })
    if (response.status === 401) return { available: false, status: 'Runner credential rejected' }
    const ready = (await response.json()) as { protocol?: unknown; available?: unknown } | null
    if (response.ok && ready?.protocol === 'aira-claude-runner')
      return ready.available === true
        ? { available: true, status: 'Available' }
        : { available: false, status: 'Claude Code is signed out or unavailable' }
  } catch {}
  return { available: false, status: 'Runner unavailable' }
}
