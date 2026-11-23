import { ownerCronTransport } from './owner-cron.js'
export async function authorizeOwner(
  deps: { ownerApiOrigin?: string; ownerApiSocket?: string },
  token: string
): Promise<{ ok: true } | { ok: false; status: number; code: string }> {
  const origin = deps.ownerApiOrigin ?? 'http://owner.internal'
  try {
    const call = ownerCronTransport(origin, deps.ownerApiSocket, token, '/api/settings')
    const result = await call()
    if (result.status === 401) return { ok: false, status: 401, code: 'Owner token required' }
    if (result.status !== 200) return { ok: false, status: 502, code: 'owner_service_unavailable' }
    const markets = result.body.markets
    if (!markets || typeof markets !== 'object' || Array.isArray(markets))
      return { ok: false, status: 502, code: 'owner_service_unavailable' }
    return { ok: true }
  } catch {
    return { ok: false, status: 502, code: 'owner_service_unavailable' }
  }
}
