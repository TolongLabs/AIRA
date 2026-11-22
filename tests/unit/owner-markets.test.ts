import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { changeOwnerMarkets } from '../../src/api/owner-markets.js'
import { loadWatchConfig } from '../../src/tools/owner/watch-config.js'
import { tmpDir } from '../support/tmp.js'

it('detects a stale replacement and preserves digest fields and unrelated lists', () => {
  const path = join(tmpDir(), 'markets.yaml')
  const digest = { enabled: false, to: ['whatsapp:fixture'], hours: [7, 14], timezone: 'UTC' }
  writeFileSync(path, JSON.stringify({ watchlist: ['one'], news_digest: digest, other: { keep: true } }))
  expect(changeOwnerMarkets(path, { watchlist: ['two'], expected: { watchlist: ['one'] } }).status).toBe(200)
  expect(changeOwnerMarkets(path, { watchlist: [], expected: { watchlist: ['one'] } }).status).toBe(409)
  expect(
    changeOwnerMarkets(path, {
      news_digest: { enabled: true, to: digest.to, hours: digest.hours },
      expected: { news_digest: digest }
    }).status
  ).toBe(200)
  expect(loadWatchConfig(path)).toMatchObject({
    watchlist: ['two'],
    other: { keep: true },
    news_digest: { ...digest, enabled: true }
  })
  writeFileSync(path, '[broken')
  expect(() => changeOwnerMarkets(path, { watchlist: [], expected: { watchlist: [] } })).toThrow()
  expect(readFileSync(path, 'utf8')).toBe('[broken')
})
