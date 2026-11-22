import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { loadWatchConfig, saveWatchConfig } from '../tools/owner/watch-config.js'

const target = z.string().regex(/^[a-z][a-z0-9_-]*:[^\s,]+$/)
const symbol = z.string().regex(/^[a-z0-9^=.-]{1,15}$/i)
const alert = z
  .object({ symbol, direction: z.enum(['above', 'below', 'moves']), level: z.number().finite(), to: target.optional() })
  .passthrough()
const digest = z.object({
  enabled: z.boolean(),
  to: z.array(target),
  hours: z.array(z.number().int().min(0).max(23)).optional()
})
const edit = z.strictObject({
  expected: z.record(z.string(), z.unknown()),
  watchlist: z.array(symbol).optional(),
  alerts: z.array(alert).optional(),
  default_target: z.union([target, z.literal('')]).optional(),
  news_digest: digest.optional()
})
export function changeOwnerMarkets(path: string, input: unknown) {
  const parsed = edit.safeParse(input)
  if (!parsed.success) return { status: 400, body: { error: 'Invalid market settings' } }
  const { expected, ...patch } = parsed.data
  if (
    !Object.keys(patch).length ||
    patch.alerts?.some((row) => row.direction === 'moves' && row.level <= 0) ||
    (patch.news_digest?.enabled && !patch.news_digest.to.length)
  )
    return { status: 400, body: { error: 'Invalid alert or digest' } }
  const current = loadWatchConfig(path, true)
  for (const key of Object.keys(patch)) {
    if (!Object.hasOwn(expected, key) || !isDeepStrictEqual(current[key] ?? null, expected[key]))
      return { status: 409, body: { error: 'Market settings changed. Reload before saving.' } }
  }
  if (patch.news_digest && typeof current.news_digest === 'object' && current.news_digest !== null)
    patch.news_digest = { ...current.news_digest, ...patch.news_digest }
  return { status: 200, body: { markets: saveWatchConfig(path, patch) } }
}
