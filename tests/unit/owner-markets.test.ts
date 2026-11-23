import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { changeOwnerMarkets } from '../../src/api/owner-markets.js'
import { loadWatchConfig, setChatWatchlist, watchlistFor } from '../../src/tools/owner/watch-config.js'
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

it('accepts alerts written by a chat tool beside a default alert', () => {
  const path = join(tmpDir(), 'markets.yaml')
  const scoped = { symbol: 'fixture', direction: 'above', level: 9, to: 'fixture@g.us', note: 'keep' }
  writeFileSync(path, JSON.stringify({ alerts: [scoped] }))
  const alerts = [scoped, { symbol: 'fixture', direction: 'above', level: 12 }]
  expect(changeOwnerMarkets(path, { expected: { alerts: [scoped] }, alerts }).status).toBe(200)
  expect(loadWatchConfig(path).alerts).toEqual(alerts)
})

it('shares scoped watchlists with the host and reads old bare-ID entries', () => {
  const path = join(tmpDir(), 'markets.yaml')
  const id = 'fixture@g.us'
  const scope = 'group/whatsapp/fixture.g.us'
  writeFileSync(
    path,
    JSON.stringify({ chats: { [id]: { positions: { abc: { qty: 1, cost: 2 } } }, [scope]: { watchlist: ['abc'] } } })
  )
  expect(watchlistFor(id, loadWatchConfig(path))).toEqual(['abc'])
  setChatWatchlist(path, id, ['def'])
  expect(loadWatchConfig(path).chats).toEqual({
    [scope]: { positions: { abc: { qty: 1, cost: 2 } }, watchlist: ['def'] }
  })
  expect(
    changeOwnerMarkets(path, { news_digest: { enabled: false, to: [] }, expected: { news_digest: null } }).status
  ).toBe(200)
})
