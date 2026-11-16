import { describe, expect, it } from 'vitest'
import {
  classify,
  createMarketsPort,
  marketHub,
  newsMentions,
  newsTerm,
  regionFor,
  regionOfSymbol,
  shorterTerm
} from '../../src/tools/owner/markets.js'

const FIXED_NOW = new Date('2026-11-17T06:00:00.000Z')

describe('markets helpers and classification', () => {
  it('resolves crypto, index aliases, and regional bare tickers', () => {
    expect(classify('spx')).toEqual({ kind: 'yahoo', mapped: '^GSPC' })
    expect(classify('btc')).toEqual({ kind: 'crypto', mapped: 'bitcoin' })
    expect(classify('d05', { region: 'sg' })).toEqual({ kind: 'yahoo', mapped: 'D05.SI' })
    expect(classify('D05.SI', { region: 'my' })).toEqual({ kind: 'yahoo', mapped: 'D05.SI' })
    expect(classify('spx', { region: 'sg' })).toEqual({ kind: 'yahoo', mapped: '^GSPC' })
  })

  it('maps symbol suffixes to regions and market hubs', () => {
    expect(regionOfSymbol('1155.KL')).toBe('my')
    expect(regionOfSymbol('D05.SI')).toBe('sg')
    expect(regionOfSymbol('AAPL')).toBe('global')
    expect(marketHub('sg')).toBe('Singapore market')
    expect(marketHub('unknown')).toBe('Markets')
    expect(regionFor('chat-123456', { 'chat-123456': 'my' })).toBe('my')
    expect(regionFor('chat-123456', { 'chat-123456': 'invalid' })).toBe('global')
  })

  it('derives news terms, shorter terms, and mention filters', () => {
    expect(newsTerm('spx')).toBe('S&P 500')
    expect(newsTerm('ada-usd')).toBe('Cardano')
    expect(shorterTerm('Hang Seng Index')).toBe('Hang Seng')
    expect(shorterTerm('Malayan Banking Berhad')).toBe('Malayan Banking')
    expect(newsMentions('S&P 500')).toContain('s&p 500')
  })
})

describe('createMarketsPort', () => {
  it('routes index aliases to Yahoo and crypto symbols to CoinGecko', async () => {
    const requestedUrls: string[] = []
    const fakeFetch = (async (input: string | URL | Request) => {
      const url = String(input)
      requestedUrls.push(url)
      if (url.startsWith('https://query1.finance.yahoo.com/v8/finance/chart/')) {
        return new Response(
          JSON.stringify({
            chart: {
              result: [
                {
                  meta: {
                    shortName: 'S&P 500',
                    currency: 'USD',
                    regularMarketPrice: 6000.5,
                    chartPreviousClose: 5950.0,
                    marketState: 'REGULAR',
                    regularMarketTime: 1763359200
                  }
                }
              ]
            }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }
      if (url.startsWith('https://api.coingecko.com/api/v3/simple/price')) {
        return new Response(
          JSON.stringify({
            bitcoin: { usd: 91234.5, usd_24h_change: 2.345 }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }
      return new Response('not found', { status: 404 })
    }) as typeof fetch

    const port = createMarketsPort({ fetch: fakeFetch, now: () => FIXED_NOW })
    const res = await port.quotes(['spx', 'btc'], {})

    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(requestedUrls).toEqual([
      'https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=1d&range=1d',
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true'
    ])
    expect(res.data).toEqual([
      {
        symbol: 'spx',
        name: 'S&P 500',
        price: 6000.5,
        currency: 'USD',
        change: 50.5,
        changePct: 0.85,
        marketState: 'REGULAR',
        asOf: '2025-11-17T06:00:00.000Z'
      },
      {
        symbol: 'btc',
        name: 'Bitcoin',
        price: 91234.5,
        currency: 'USD',
        changePct: 2.35,
        asOf: FIXED_NOW.toISOString()
      }
    ])
  })

  it('computes trend statistics on a hand-made price series', async () => {
    // 50 closes: 100, 102, 100, 102, ... ending at 102 (index 49 is odd -> 102)
    // Wait: let's make 50 points alternating 100 and 102:
    // even i -> 100, odd i -> 102, then last point (i=49) = 102.
    // min = 100, max = 102, last = 102 -> positionPct = 100
    // mean of 50 points (25x 100 + 25x 102) = 101 -> ma50 = 101
    // changePct from closes[0]=100 to closes[49]=102 = +2%
    const closes = Array.from({ length: 50 }, (_, i) => (i % 2 === 0 ? 100 : 102))
    const timestamps = Array.from({ length: 50 }, (_, i) => 1760000000 + i * 86400)

    const fakeFetch = (async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/v8/finance/chart/')) {
        return new Response(
          JSON.stringify({
            chart: {
              result: [
                {
                  meta: { shortName: 'Test Corp', currency: 'USD', regularMarketPrice: 102 },
                  timestamp: timestamps,
                  indicators: { quote: [{ close: closes }] }
                }
              ]
            }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }
      return new Response('', { status: 404 })
    }) as typeof fetch

    // Expected annualised volatility for alternating +0.02 and -0.019607843... across 49 returns:
    const rets: number[] = []
    for (let i = 1; i < closes.length; i += 1) {
      const prev = closes[i - 1]
      const curr = closes[i]
      if (prev !== undefined && curr !== undefined) rets.push((curr - prev) / prev)
    }
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length
    const variance = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1)
    const expectedVol = Math.round(Math.sqrt(variance) * Math.sqrt(252) * 100 * 10) / 10

    const port = createMarketsPort({ fetch: fakeFetch, now: () => FIXED_NOW })
    const res = await port.analyse('test', { span: '1y', withNews: false })

    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.data.headlines).toEqual([])
    expect(res.data.trend).toEqual({
      symbol: 'test',
      price: 102,
      high52: 102,
      low52: 100,
      positionPct: 100,
      ma50: 101,
      volatilityPct: expectedVol,
      changePct: 2,
      span: '1y'
    })
  })

  it('merges, filters, and deduplicates news headlines from RSS and TickerTick', async () => {
    const recentDate = 'Mon, 16 Nov 2026 10:00:00 GMT'
    const oldDate = 'Mon, 01 Nov 2026 10:00:00 GMT'

    const yahooRss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <item>
    <title>Apple beats quarterly estimates</title>
    <link>https://www.reuters.com/apple-beats</link>
    <pubDate>${recentDate}</pubDate>
  </item>
  <item>
    <title>Apple stale story from weeks ago</title>
    <link>https://example.test/old</link>
    <pubDate>${oldDate}</pubDate>
  </item>
</channel></rss>`

    const gnewsRss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <item>
    <title>Apple beats quarterly estimates, analysts cheer - Financial Times</title>
    <link>https://news.google.com/rss/articles/123</link>
    <source url="https://www.ft.com">Financial Times</source>
    <pubDate>${recentDate}</pubDate>
  </item>
  <item>
    <title>AAPL price on Nov 16, 2026 at 10am EDT Crypto Prediction Market</title>
    <link>https://example.test/junk</link>
    <pubDate>${recentDate}</pubDate>
  </item>
</channel></rss>`

    const fakeFetch = (async (input: string | URL | Request) => {
      const url = String(input)
      if (url.startsWith('https://api.tickertick.com/feed')) {
        return new Response(
          JSON.stringify({
            stories: [
              {
                title: 'Apple launches new chip',
                url: 'https://example.test/chip',
                time: Date.parse('2026-11-16T12:00:00Z'),
                site: 'macrumors.com'
              }
            ]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }
      if (url.startsWith('https://feeds.finance.yahoo.com/rss/2.0/headline')) {
        return new Response(yahooRss, { status: 200, headers: { 'content-type': 'application/rss+xml' } })
      }
      if (url.startsWith('https://news.google.com/rss/search')) {
        return new Response(gnewsRss, { status: 200, headers: { 'content-type': 'application/rss+xml' } })
      }
      return new Response('', { status: 404 })
    }) as typeof fetch

    const port = createMarketsPort({ fetch: fakeFetch, now: () => FIXED_NOW })
    const res = await port.news('aapl', { limit: 5 })

    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.data).toEqual([
      {
        title: 'Apple launches new chip',
        source: 'macrumors.com',
        url: 'https://example.test/chip',
        published: 'Mon, 16 Nov 2026 12:00:00 GMT'
      },
      {
        title: 'Apple beats quarterly estimates',
        source: 'reuters.com',
        url: 'https://www.reuters.com/apple-beats',
        published: recentDate
      }
    ])
  })

  it('searches Yahoo Finance and ranks regional listings first', async () => {
    const fakeFetch = (async (input: string | URL | Request) => {
      const url = String(input)
      if (url.startsWith('https://query1.finance.yahoo.com/v1/finance/search')) {
        return new Response(
          JSON.stringify({
            quotes: [
              { symbol: 'DBSDY', shortname: 'DBS Group Holdings', exchDisp: 'OTC Markets', quoteType: 'EQUITY' },
              { symbol: 'D05.SI', shortname: 'DBS Group', exchDisp: 'Singapore', quoteType: 'EQUITY' }
            ]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }
      return new Response('', { status: 404 })
    }) as typeof fetch

    const port = createMarketsPort({ fetch: fakeFetch })
    const res = await port.search('DBS', { region: 'sg' })

    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.data).toEqual([
      { symbol: 'D05.SI', name: 'DBS Group' },
      { symbol: 'DBSDY', name: 'DBS Group Holdings' }
    ])
  })

  it('returns typed failures on provider errors and timeouts', async () => {
    const errorPort = createMarketsPort({
      fetch: (async () => new Response('upstream error', { status: 503 })) as typeof fetch
    })
    const quoteErr = await errorPort.quotes(['aapl'], {})
    expect(quoteErr).toEqual({ ok: false, reason: 'yahoo quote failed (503)' })

    const searchErr = await errorPort.search('apple', {})
    expect(searchErr).toEqual({ ok: false, reason: 'yahoo search failed (503)' })

    const hangingFetch = ((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })) as typeof fetch
    const timeoutPort = createMarketsPort({ fetch: hangingFetch, timeoutMs: 15 })

    const analyseTimeout = await timeoutPort.analyse('aapl', { withNews: false })
    expect(analyseTimeout).toEqual({ ok: false, reason: 'yahoo history failed (timeout)' })

    const newsTimeout = await timeoutPort.news('aapl', {})
    expect(newsTimeout).toEqual({ ok: false, reason: 'news rss failed (timeout)' })
  })
})
