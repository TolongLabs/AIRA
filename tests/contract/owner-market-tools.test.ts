import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse, stringify } from 'yaml'
import { loadPack } from '../../src/character/loader.js'
import { createLogger } from '../../src/records/logger.js'
import { createRedactor } from '../../src/records/redact.js'
import { ensureChat, setChatStatus } from '../../src/settings/chats.js'
import { resolveSettings } from '../../src/settings/settings.js'
import { openTurn, receiveInbound } from '../../src/storage/turns.js'
import { marketTools } from '../../src/tools/owner/market-tools.js'
import type { MarketsPort } from '../../src/tools/owner/markets.js'
import { loadWatchConfig, watchlistFor } from '../../src/tools/owner/watch-config.js'
import { createToolRegistry } from '../../src/tools/registry.js'
import { createTurnSources } from '../../src/turn/sources.js'
import type { TurnContext } from '../../src/turn/types.js'
import { tmpDir, tmpStorage } from '../support/tmp.js'

const pack = loadPack('characters/example', 'repository')

function makeFakeMarkets(): MarketsPort {
  return {
    async quotes(symbols) {
      const data = symbols
        .filter((s) => s.toLowerCase() !== 'unknown')
        .map((s) => ({
          symbol: s.toLowerCase(),
          name: `${s.toUpperCase()} Corp`,
          price: s.toLowerCase() === 'nvda' ? 150 : 100,
          currency: 'USD',
          changePct: 1.5
        }))
      return { ok: true, data }
    },
    async analyse(symbol, options) {
      return {
        ok: true,
        data: {
          trend: {
            symbol,
            price: 150,
            high52: 180,
            low52: 90,
            positionPct: 66.7,
            ma50: 140,
            ma200: 120,
            volatilityPct: 25,
            changePct: 10,
            span: options.span ?? '1y'
          },
          headlines: options.withNews === false ? [] : [{ title: `${symbol} rallies`, source: 'Wire' }]
        }
      }
    },
    async news(query, options) {
      if (query === 'empty') return { ok: true, data: [] }
      return {
        ok: true,
        data: [{ title: `News for ${query}`, source: 'Wire' }].slice(0, options.limit ?? 8)
      }
    },
    async search(query) {
      return {
        ok: true,
        data: [{ symbol: query.toLowerCase(), name: `${query} Inc` }]
      }
    }
  }
}

let seq = 0
function setup(options: { markets?: MarketsPort; configPath?: string } = {}) {
  const storage = tmpStorage()
  const registry = createToolRegistry({
    storage,
    config: { tools: { defaultTimeoutMs: 500 } },
    logger: createLogger({ level: 'error', module: 'owner-market-tools-test', sink: () => {} }),
    redactor: createRedactor()
  })
  for (const tool of marketTools({ markets: options.markets ?? makeFakeMarkets(), configPath: options.configPath })) {
    registry.register(tool)
  }

  const makeCtx = (overrides: { waId?: string; owner?: boolean } = {}): TurnContext => {
    seq++
    const chat = ensureChat(storage, { waId: overrides.waId ?? `000000-${seq}@g.us`, type: 'group' })
    setChatStatus(storage, { chatId: chat.chatId, status: 'active', actor: 'test' })
    const senderId = `member-${seq}`
    const mid = `mid-${seq}`
    const turnId = `turn-${seq}`
    receiveInbound(storage, { chatId: chat.chatId, mid, senderId })
    openTurn(storage, { turnId, chatId: chat.chatId, senderId, kind: 'reply', mids: [mid] })
    const settings = resolveSettings(storage, chat)
    if (overrides.owner !== false) {
      settings['features.owner'] = { value: true, level: 'chat' }
    }
    return {
      turnId,
      chat,
      senderId,
      character: pack,
      settings,
      kind: 'reply',
      delivery: { kind: 'reply' },
      deadline: Date.now() + 10_000,
      sources: createTurnSources()
    }
  }

  return { storage, registry, makeCtx }
}

describe('owner market tools', () => {
  it('omits market_watch when configPath is not set and gates on features.owner', async () => {
    const withoutWatch = marketTools({ markets: makeFakeMarkets() })
    expect(withoutWatch.map((t) => t.name)).toEqual(['market_quote', 'market_analyse', 'market_news'])

    const { registry, makeCtx } = setup()
    const ctx = makeCtx({ owner: false })
    const res = await registry.call('market_quote', { symbols: ['nvda'] }, ctx, {
      callId: 'c1',
      source: 'model'
    })
    expect(res).toEqual({ ok: false, kind: 'refused', reason: 'feature features.owner is disabled' })
  })

  it('runs market_quote, market_analyse and market_news with fake port', async () => {
    const { registry, makeCtx } = setup()
    const ctx = makeCtx()

    const qRes = await registry.call('market_quote', { symbols: ['nvda', 'unknown'] }, ctx, {
      callId: 'q1',
      source: 'model'
    })
    expect(qRes.ok).toBe(true)
    if (qRes.ok) {
      const data = qRes.data as { quotes: Record<string, { price: number }>; no_data?: string[] }
      expect(data.quotes.nvda?.price).toBe(150)
      expect(data.no_data).toEqual(['unknown'])
    }

    const aRes = await registry.call('market_analyse', { symbol: 'nvda', span: '6mo' }, ctx, {
      callId: 'a1',
      source: 'model'
    })
    expect(aRes.ok).toBe(true)
    if (aRes.ok) {
      const data = aRes.data as { symbol: string; trend: { span: string }; news?: unknown[] }
      expect(data.symbol).toBe('nvda')
      expect(data.trend.span).toBe('6mo')
      expect(data.news).toHaveLength(1)
    }

    const nRes = await registry.call('market_news', { query: 'fed rates', limit: 3 }, ctx, {
      callId: 'n1',
      source: 'model'
    })
    expect(nRes.ok).toBe(true)
    if (nRes.ok) {
      const data = nRes.data as { query: string; items: { title: string }[] }
      expect(data.items[0]?.title).toBe('News for fed rates')
    }
  })

  it('returns typed failure when port fails', async () => {
    const failingPort: MarketsPort = {
      async quotes() {
        return { ok: false, reason: 'upstream down' }
      },
      async analyse() {
        return { ok: false, reason: 'upstream down' }
      },
      async news() {
        return { ok: false, reason: 'upstream down' }
      },
      async search() {
        return { ok: false, reason: 'upstream down' }
      }
    }
    const { registry, makeCtx } = setup({ markets: failingPort })
    const ctx = makeCtx()
    const res = await registry.call('market_quote', { symbols: ['nvda'] }, ctx, {
      callId: 'f1',
      source: 'model'
    })
    expect(res).toEqual({ ok: false, kind: 'error', reason: 'upstream down' })
  })

  it('market_watch add, remove, alert, unalert, hold, sold and list preserve unknown keys and other chats', async () => {
    const dir = tmpDir('aira-watch-')
    const configPath = join(dir, 'markets.yaml')
    const otherChat = '123456@g.us'
    const myChat = '000000@g.us'

    writeFileSync(
      configPath,
      stringify({
        default_target: '00000000@s.whatsapp.net',
        watchlist: ['spx'],
        alerts: [{ symbol: 'eth', direction: 'below', level: 2000, to: otherChat }],
        chats: {
          [otherChat]: { watchlist: ['eth'] }
        }
      }),
      'utf8'
    )

    const { registry, makeCtx } = setup({ configPath })
    const ctx = makeCtx({ waId: myChat })

    const addRes = await registry.call('market_watch_add', { symbols: ['nvda', 'btc'] }, ctx, {
      callId: 'w1',
      source: 'model'
    })
    expect(addRes.ok).toBe(true)
    if (addRes.ok) expect(addRes.receipt?.kind).toBe('market_watch.added')

    const remRes = await registry.call('market_watch_remove', { symbols: ['btc'] }, ctx, {
      callId: 'w2',
      source: 'model'
    })
    expect(remRes.ok).toBe(true)

    const alertRes = await registry.call('market_alert_set', { symbol: 'nvda', direction: 'above', level: 200 }, ctx, {
      callId: 'w3',
      source: 'model'
    })
    expect(alertRes.ok).toBe(true)

    const holdRes = await registry.call('market_holding_set', { symbol: 'nvda', qty: 10, cost: 120 }, ctx, {
      callId: 'w4',
      source: 'model'
    })
    expect(holdRes.ok).toBe(true)

    const listRes = await registry.call('market_watch_list', {}, ctx, {
      callId: 'w5',
      source: 'model'
    })
    expect(listRes.ok).toBe(true)
    if (listRes.ok) {
      const data = listRes.data as {
        watchlist: string[]
        alerts: { symbol: string; to?: string }[]
        positions?: { symbol: string; gain: number }[]
      }
      expect(data.watchlist).toEqual(['nvda'])
      expect(data.alerts).toEqual([{ symbol: 'nvda', direction: 'above', level: 200, to: myChat }])
      expect(data.positions?.[0]?.symbol).toBe('nvda')
      expect(data.positions?.[0]?.gain).toBe(300)
    }

    const unalertRes = await registry.call('market_alert_clear', { symbol: 'nvda', direction: 'above' }, ctx, {
      callId: 'w6',
      source: 'model'
    })
    expect(unalertRes.ok).toBe(true)

    const soldRes = await registry.call('market_holding_clear', { symbol: 'nvda' }, ctx, {
      callId: 'w7',
      source: 'model'
    })
    expect(soldRes.ok).toBe(true)

    const raw = parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
    expect(raw.default_target).toBe('00000000@s.whatsapp.net')
    expect(raw.watch).toEqual(['spx'])
    const loaded = loadWatchConfig(configPath)
    expect(watchlistFor(otherChat, loaded)).toEqual(['eth'])
    expect(loaded.alerts).toEqual([{ symbol: 'eth', direction: 'below', level: 2000, to: otherChat }])
  })

  it('cleared default watchlist stays cleared and site-wide alerts are listable and clearable', async () => {
    const dir = tmpDir('aira-watch-site-')
    const configPath = join(dir, 'markets.yaml')
    const myChat = '000000000000@g.us'
    const otherChat = '0000000000000@g.us'

    writeFileSync(
      configPath,
      stringify({
        watchlist: [],
        watch: ['spx'],
        alerts: [
          { symbol: 'nvda', direction: 'above', level: 200 },
          { symbol: 'eth', direction: 'below', level: 2000, to: otherChat }
        ]
      }),
      'utf8'
    )

    // A cleared default list is not resurrected from the legacy `watch` key.
    expect(loadWatchConfig(configPath).watchlist).toEqual([])

    const { registry, makeCtx } = setup({ configPath })
    const ctx = makeCtx({ waId: myChat })

    // A site-wide rule (no `to`) shows up in the chat's list instead of being invisible.
    const listRes = await registry.call('market_watch_list', {}, ctx, {
      callId: 's1',
      source: 'model'
    })
    expect(listRes.ok).toBe(true)
    if (listRes.ok) {
      const data = listRes.data as { alerts: { symbol: string; to?: string }[] }
      expect(data.alerts).toEqual([{ symbol: 'nvda', direction: 'above', level: 200 }])
    }

    // Arming the same rule adopts the site-wide one instead of duplicating it.
    const alertRes = await registry.call('market_alert_set', { symbol: 'nvda', direction: 'above', level: 210 }, ctx, {
      callId: 's2',
      source: 'model'
    })
    expect(alertRes.ok).toBe(true)
    if (alertRes.ok) {
      const data = alertRes.data as { alerts: { symbol: string; level: number; to?: string }[] }
      expect(data.alerts).toEqual([{ symbol: 'nvda', direction: 'above', level: 210, to: myChat }])
    }

    // Reject a missing level instead of arming a broken rule.
    const badRes = await registry.call('market_alert_set', { symbol: 'nvda', direction: 'above' }, ctx, {
      callId: 's3',
      source: 'model'
    })
    expect(badRes.ok).toBe(false)

    const unRes = await registry.call('market_alert_clear', { symbol: 'nvda', direction: 'above' }, ctx, {
      callId: 's4',
      source: 'model'
    })
    expect(unRes.ok).toBe(true)

    // The other chat's alert survives; nothing site-wide is left behind.
    const loaded = loadWatchConfig(configPath)
    expect(loaded.alerts).toEqual([{ symbol: 'eth', direction: 'below', level: 2000, to: otherChat }])
    expect(loaded.watchlist).toEqual([])
  })

  it('leaves no receipt when writing the config file fails', async () => {
    const dir = tmpDir('aira-watch-fail-')
    // Point configPath at an existing directory so renameSync fails with EISDIR.
    const badConfigPath = join(dir, 'not-a-file')
    mkdirSync(badConfigPath)

    const { storage, registry, makeCtx } = setup({ configPath: badConfigPath })
    const ctx = makeCtx({ waId: '000000@g.us' })

    const res = await registry.call('market_watch_add', { symbols: ['nvda'] }, ctx, {
      callId: 'fail1',
      source: 'model'
    })
    expect(res.ok).toBe(false)

    const count = storage.read((db) => (db.prepare('SELECT count(*) as n FROM receipt').get() as { n: number }).n)
    expect(count).toBe(0)
  })
})
