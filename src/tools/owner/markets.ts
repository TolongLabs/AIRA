import { readFileSync } from 'node:fs'

export interface Quote {
  symbol: string
  name?: string
  price: number
  currency?: string
  change?: number
  changePct?: number
  marketState?: string
  asOf?: string
}

export interface Trend {
  symbol: string
  price: number
  high52?: number
  low52?: number
  positionPct?: number
  ma50?: number
  ma200?: number
  volatilityPct?: number
  changePct?: number
  span: string
}

export interface Headline {
  title: string
  source?: string
  url?: string
  published?: string
}

export type MarketResult<T> = { ok: true; data: T } | { ok: false; reason: string }

export interface MarketsPort {
  quotes(symbols: string[], options: { region?: string; signal?: AbortSignal }): Promise<MarketResult<Quote[]>>
  analyse(
    symbol: string,
    options: { span?: string; withNews?: boolean; region?: string; signal?: AbortSignal }
  ): Promise<MarketResult<{ trend: Trend; headlines: Headline[] }>>
  news(
    query: string,
    options: { limit?: number; region?: string; signal?: AbortSignal }
  ): Promise<MarketResult<Headline[]>>
  search(
    query: string,
    options: { region?: string; signal?: AbortSignal }
  ): Promise<MarketResult<{ symbol: string; name: string }[]>>
}

export interface RegionMeta {
  label: string
  suffix: string
  currency: string
  indices: readonly string[]
  exchanges: readonly string[]
  locale: readonly [string, string]
}

const DEFAULT_TIMEOUT_MS = 10_000
const NEWS_MAX_AGE_DAYS = 7
const USER_AGENT = 'aira-markets/1.0 (+local companion bot)'

export const CRYPTO: Record<string, string> = {
  btc: 'bitcoin',
  eth: 'ethereum',
  sol: 'solana',
  xrp: 'ripple',
  doge: 'dogecoin',
  ada: 'cardano',
  bnb: 'binancecoin'
}

export const INDEX_ALIASES: Record<string, string> = {
  spx: '^GSPC',
  sp500: '^GSPC',
  ndx: '^NDX',
  nasdaq: '^IXIC',
  dji: '^DJI',
  dow: '^DJI',
  nikkei: '^N225',
  hsi: '^HSI',
  sti: '^STI',
  dax: '^GDAXI',
  ftse: '^FTSE',
  vix: '^VIX',
  klci: '^KLSE',
  klse: '^KLSE',
  kospi: '^KS11',
  asx: '^AXJO',
  sensex: '^BSESN',
  nifty: '^NSEI',
  tsx: '^GSPTSE',
  cac: '^FCHI',
  sti_etf: 'ES3.SI'
}

const NEWS_TERMS: Record<string, string> = {
  spx: 'S&P 500',
  sp500: 'S&P 500',
  '^gspc': 'S&P 500',
  ndx: 'Nasdaq 100',
  '^ndx': 'Nasdaq 100',
  nasdaq: 'Nasdaq Composite',
  '^ixic': 'Nasdaq Composite',
  dji: 'Dow Jones Industrial Average',
  dow: 'Dow Jones Industrial Average',
  '^dji': 'Dow Jones Industrial Average',
  nikkei: 'Nikkei 225',
  '^n225': 'Nikkei 225',
  hsi: 'Hang Seng Index',
  '^hsi': 'Hang Seng Index',
  sti: 'Straits Times Index',
  '^sti': 'Straits Times Index',
  dax: 'DAX index',
  '^gdaxi': 'DAX index',
  ftse: 'FTSE 100',
  '^ftse': 'FTSE 100',
  vix: 'VIX volatility index',
  '^vix': 'VIX volatility index',
  klci: 'FTSE Bursa Malaysia KLCI',
  klse: 'FTSE Bursa Malaysia KLCI',
  '^klse': 'FTSE Bursa Malaysia KLCI',
  kospi: 'KOSPI',
  '^ks11': 'KOSPI',
  asx: 'ASX 200',
  '^axjo': 'ASX 200',
  sensex: 'BSE Sensex',
  '^bsesn': 'BSE Sensex',
  nifty: 'Nifty 50',
  '^nsei': 'Nifty 50',
  tsx: 'S&P/TSX Composite',
  '^gsptse': 'S&P/TSX Composite',
  cac: 'CAC 40',
  '^fchi': 'CAC 40',
  btc: 'Bitcoin',
  eth: 'Ethereum',
  sol: 'Solana cryptocurrency',
  xrp: 'XRP Ripple',
  doge: 'Dogecoin',
  ada: 'Cardano',
  bnb: 'BNB Binance',
  'gc=f': 'gold price',
  gold: 'gold price',
  xauusd: 'gold price',
  'si=f': 'silver price',
  silver: 'silver price',
  xagusd: 'silver price',
  'cl=f': 'oil price',
  oil: 'oil price',
  brent: 'oil price',
  'bz=f': 'oil price',
  crude: 'oil price',
  'hg=f': 'copper price',
  copper: 'copper price',
  'ng=f': 'natural gas price',
  'pl=f': 'platinum price',
  platinum: 'platinum price',
  'pa=f': 'palladium price'
}

const NEWS_MENTIONS: Record<string, readonly string[]> = {
  'S&P 500': ['s&p 500', 's&p500', 'sp500', 's&p', 'wall street', 'us stocks'],
  'Nasdaq 100': ['nasdaq'],
  'Nasdaq Composite': ['nasdaq'],
  'Dow Jones Industrial Average': ['dow jones', 'the dow', 'dow '],
  'Nikkei 225': ['nikkei'],
  'Hang Seng Index': ['hang seng'],
  'Straits Times Index': ['straits times', 'sti '],
  'DAX index': ['dax'],
  'FTSE 100': ['ftse'],
  'VIX volatility index': ['vix', 'volatility index'],
  'FTSE Bursa Malaysia KLCI': ['klci', 'bursa malaysia'],
  KOSPI: ['kospi'],
  'ASX 200': ['asx'],
  'BSE Sensex': ['sensex'],
  'Nifty 50': ['nifty'],
  'S&P/TSX Composite': ['tsx', 's&p/tsx'],
  'CAC 40': ['cac 40'],
  Bitcoin: ['bitcoin', 'btc'],
  Ethereum: ['ethereum', 'ether ', 'eth '],
  'Solana cryptocurrency': ['solana'],
  'XRP Ripple': ['xrp', 'ripple'],
  Dogecoin: ['dogecoin', 'doge'],
  Cardano: ['cardano', 'ada '],
  'BNB Binance': ['bnb', 'binance'],
  'gold price': ['gold', 'xau'],
  'silver price': ['silver', 'xag'],
  'oil price': ['oil', 'crude', 'brent', 'wti'],
  'copper price': ['copper'],
  'natural gas price': ['natural gas', 'lng', 'gas price'],
  'platinum price': ['platinum'],
  'palladium price': ['palladium']
}

export const REGIONS: Record<string, RegionMeta> = {
  global: {
    label: 'Global / US',
    suffix: '',
    currency: 'USD',
    indices: ['spx', 'ndx', 'dji'],
    exchanges: [],
    locale: ['US', 'en-US']
  },
  sg: {
    label: 'Singapore',
    suffix: '.SI',
    currency: 'SGD',
    indices: ['sti', 'spx'],
    exchanges: ['SES', 'Singapore'],
    locale: ['SG', 'en-SG']
  },
  my: {
    label: 'Malaysia',
    suffix: '.KL',
    currency: 'MYR',
    indices: ['klci', 'spx'],
    exchanges: ['KLS', 'Kuala Lumpur'],
    locale: ['MY', 'en-MY']
  },
  jp: {
    label: 'Japan',
    suffix: '.T',
    currency: 'JPY',
    indices: ['nikkei', 'spx'],
    exchanges: ['JPX', 'Tokyo', 'Osaka'],
    locale: ['JP', 'en-JP']
  },
  hk: {
    label: 'Hong Kong',
    suffix: '.HK',
    currency: 'HKD',
    indices: ['hsi', 'spx'],
    exchanges: ['HKG', 'Hong Kong'],
    locale: ['HK', 'en-HK']
  },
  uk: {
    label: 'United Kingdom',
    suffix: '.L',
    currency: 'GBP',
    indices: ['ftse', 'spx'],
    exchanges: ['LSE', 'London'],
    locale: ['GB', 'en-GB']
  },
  au: {
    label: 'Australia',
    suffix: '.AX',
    currency: 'AUD',
    indices: ['asx', 'spx'],
    exchanges: ['ASX', 'Sydney'],
    locale: ['AU', 'en-AU']
  }
}

export const DEFAULT_REGION = 'global'

const HISTORY_SPANS: Record<string, readonly [string, string]> = {
  '1d': ['1d', '5m'],
  '1w': ['5d', '30m'],
  '1m': ['1mo', '1d'],
  '1mo': ['1mo', '1d'],
  '6mo': ['6mo', '1d'],
  '1y': ['1y', '1d'],
  '5y': ['5y', '1wk']
}

const BARE_TICKER = /^[a-z0-9]{1,6}$/
const TT_TICKER = /^[a-z]{1,5}$/
const YAHOO_RSS_SYMBOL = /^[A-Za-z0-9.^=-]{1,12}$/
const TERM_TAIL =
  /\s+(?:index|composite|corporation|corp\.?|company|holdings?|group|berhad|bhd\.?|limited|ltd\.?|inc\.?|plc|llc|nv|sa|ag|co\.?|cryptocurrency|\d{2,4})\.?$/i
const NEWS_JUNK =
  /prediction market|price (?:on|range on) \w+ \d{1,2}, \d{4}|^\$[A-Za-z0-9.]+ ?\([A-Za-z0-9.]+\)\$?$|^\W*[A-Z0-9.]{1,8}\W*$|forecast for \d{4}-\d{2}-\d{2}/i
const TITLE_NOISE = /[^a-z0-9 ]+/g
const GENERIC_NAME = new Set([
  'bank',
  'banking',
  'berhad',
  'bhd',
  'group',
  'holdings',
  'limited',
  'ltd',
  'inc',
  'corp',
  'corporation',
  'plc',
  'co',
  'company',
  'the',
  'and',
  'of',
  'public',
  'international'
])
const DEDUPE_STOP = new Set([
  'the',
  'a',
  'an',
  'of',
  'in',
  'on',
  'for',
  'to',
  'as',
  'at',
  'is',
  'its',
  'and',
  'after',
  'amid',
  'with'
])

export function loadRegions(filePath: string): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string') out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

export function regionFor(scopeKey: string | undefined, regions: Record<string, string>): string {
  if (!scopeKey) return DEFAULT_REGION
  const key = (regions[scopeKey] ?? '').trim().toLowerCase()
  return key in REGIONS ? key : DEFAULT_REGION
}

export function regionOfSymbol(symbol: string): string {
  const s = symbol.trim().toUpperCase()
  for (const [key, meta] of Object.entries(REGIONS)) {
    if (meta.suffix && s.endsWith(meta.suffix)) return key
  }
  return DEFAULT_REGION
}

export function marketHub(region?: string): string {
  const label = (REGIONS[(region ?? '').toLowerCase()]?.label ?? '').trim()
  return label ? `${label} market` : 'Markets'
}

export function classify(
  symbol: string,
  options?: { extraCrypto?: Record<string, string>; region?: string }
): { kind: 'crypto' | 'yahoo'; mapped: string } {
  const s = symbol.trim().toLowerCase()
  const crypto = options?.extraCrypto ? { ...CRYPTO, ...options.extraCrypto } : CRYPTO
  const geckoId = crypto[s]
  if (geckoId) return { kind: 'crypto', mapped: geckoId }
  const alias = INDEX_ALIASES[s]
  if (alias) return { kind: 'yahoo', mapped: alias }
  const suffix = REGIONS[(options?.region ?? '').toLowerCase()]?.suffix ?? ''
  if (suffix && BARE_TICKER.test(s)) {
    return { kind: 'yahoo', mapped: s.toUpperCase() + suffix }
  }
  return { kind: 'yahoo', mapped: s.toUpperCase() }
}

export function newsTerm(symbol: string): string {
  const s = symbol.trim().toLowerCase()
  if (s in NEWS_TERMS) return NEWS_TERMS[s] ?? ''
  const base = s.split('-')[0] ?? ''
  if ((s.endsWith('-usd') || s.endsWith('-usdt')) && base in NEWS_TERMS) {
    return NEWS_TERMS[base] ?? ''
  }
  return ''
}

export function shorterTerm(term: string): string {
  const raw = term.trim()
  const out = raw.replace(TERM_TAIL, '').replace(/^[ .,-]+|[ .,-]+$/g, '')
  return out && out.toLowerCase() !== raw.toLowerCase() ? out : ''
}

function nameTokens(name: string): string[] {
  const words = name.toLowerCase().replace(TITLE_NOISE, ' ').split(/\s+/)
  return words.filter((w) => w.length >= 4 && !GENERIC_NAME.has(w))
}

export function newsMentions(term: string): string[] {
  const explicit = NEWS_MENTIONS[term]
  return explicit ? [...explicit] : nameTokens(term)
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return value
}

function domainOf(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return host.startsWith('www.') ? host.slice(4) : host
  } catch {
    return ''
  }
}

function parsePubTs(text: string): number {
  if (!text) return 0
  const ms = Date.parse(text)
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0
}

function dedupeKey(title: string): string {
  const words = title
    .toLowerCase()
    .replace(TITLE_NOISE, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0 && !DEDUPE_STOP.has(w))
  return words.slice(0, 6).join(' ')
}

function decodeXmlEntities(text: string): string {
  const withoutCdata = text.replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1')
  return withoutCdata
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
}

function extractTag(block: string, tag: string): string {
  const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'))
  return match?.[1] ? decodeXmlEntities(match[1]).trim() : ''
}

function extractSource(block: string): { name: string; url: string } {
  const match = block.match(/<source(?:\s([^>]*))?>([\s\S]*?)<\/source>/i)
  if (!match) return { name: '', url: '' }
  const attrs = match[1] ?? ''
  const urlMatch = attrs.match(/\burl=["']([^"']*)["']/i)
  return {
    name: decodeXmlEntities(match[2] ?? '').trim(),
    url: decodeXmlEntities(urlMatch?.[1] ?? '').trim()
  }
}

interface RawNewsItem {
  title: string
  url: string
  published: string
  ts: number
  source: string
  also: number
}

function parseRssItems(xmlText: string, limit: number): RawNewsItem[] {
  const out: RawNewsItem[] = []
  const itemRegex = /<item\b[^>]*>([\s\S]*?)<\/item>/gi
  let match: RegExpExecArray | null = itemRegex.exec(xmlText)
  while (match !== null) {
    const block = match[1] ?? ''
    let title = extractTag(block, 'title')
    if (title) {
      const link = extractTag(block, 'link')
      const src = extractSource(block)
      const domain = domainOf(src.url || link)
      const published = extractTag(block, 'pubDate')
      if (src.name && title.endsWith(` - ${src.name}`)) {
        title = title.slice(0, title.length - src.name.length - 3).trimEnd()
      }
      out.push({
        title: title.slice(0, 200),
        url: link.slice(0, 400),
        published: published.slice(0, 40),
        ts: parsePubTs(published),
        source: (src.name || domain || '').slice(0, 60),
        also: 0
      })
      if (out.length >= limit) break
    }
    match = itemRegex.exec(xmlText)
  }
  return out
}

type FetchTextResult = { ok: true; text: string } | { ok: false; reason: string }
type FetchJsonResult = { ok: true; data: unknown } | { ok: false; reason: string }

async function fetchText(
  fetchFn: typeof fetch,
  url: string,
  timeoutMs: number,
  label: string,
  signal?: AbortSignal
): Promise<FetchTextResult> {
  if (signal?.aborted) {
    return { ok: false, reason: `${label} failed (aborted)` }
  }
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
  let response: Response
  try {
    response = await fetchFn(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: combined
    })
  } catch {
    const kind = signal?.aborted ? 'aborted' : combined.aborted ? 'timeout' : 'network'
    return { ok: false, reason: `${label} failed (${kind})` }
  }
  if (!response.ok) {
    return { ok: false, reason: `${label} failed (${response.status})` }
  }
  try {
    const text = await response.text()
    return { ok: true, text }
  } catch {
    return { ok: false, reason: `${label} failed (read_error)` }
  }
}

async function fetchJson(
  fetchFn: typeof fetch,
  url: string,
  timeoutMs: number,
  label: string,
  signal?: AbortSignal
): Promise<FetchJsonResult> {
  const res = await fetchText(fetchFn, url, timeoutMs, label, signal)
  if (!res.ok) return res
  try {
    return { ok: true, data: JSON.parse(res.text) as unknown }
  } catch {
    return { ok: false, reason: `${label} failed (invalid_json)` }
  }
}

interface SearchHit {
  symbol: string
  name: string
  longName: string
  type: string
  exchange: string
}

function localeFor(region?: string): readonly [string, string] {
  return REGIONS[(region ?? '').toLowerCase()]?.locale ?? ['US', 'en-US']
}

export function createMarketsPort(options?: {
  fetch?: typeof fetch
  timeoutMs?: number
  now?: () => Date
}): MarketsPort {
  const fetchFn = options?.fetch ?? fetch
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const now = options?.now ?? (() => new Date())

  async function yahooQuotes(
    symbols: string[],
    region?: string,
    signal?: AbortSignal
  ): Promise<{ quotes: Quote[]; failure?: string }> {
    const quotes: Quote[] = []
    let lastFailure: string | undefined
    for (const userSym of symbols) {
      const { mapped } = classify(userSym, { region })
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(mapped)}?interval=1d&range=1d`
      const res = await fetchJson(fetchFn, url, timeoutMs, 'yahoo quote', signal)
      if (!res.ok) {
        lastFailure = res.reason
        continue
      }
      const chart = (res.data as { chart?: { result?: unknown[] } } | null)?.chart
      const first = Array.isArray(chart?.result)
        ? (chart.result[0] as { meta?: Record<string, unknown> } | undefined)
        : undefined
      const meta = first?.meta
      if (!meta || typeof meta !== 'object') {
        lastFailure = 'yahoo quote failed (malformed)'
        continue
      }
      const price = toFiniteNumber(meta.regularMarketPrice)
      if (price === undefined) {
        lastFailure = 'yahoo quote failed (no_price)'
        continue
      }
      const prev = toFiniteNumber(meta.chartPreviousClose) ?? toFiniteNumber(meta.previousClose)
      const change = prev !== undefined ? roundTo(price - prev, 6) : undefined
      const changePct = prev !== undefined && prev !== 0 ? roundTo(((price - prev) / prev) * 100, 2) : undefined
      const name = String(meta.shortName || meta.longName || '').trim() || undefined
      const currency = String(meta.currency || '').trim() || undefined
      const marketState = String(meta.marketState || '').trim() || undefined
      const marketTime = toFiniteNumber(meta.regularMarketTime)
      const asOf = marketTime !== undefined ? new Date(marketTime * 1000).toISOString() : undefined
      quotes.push({
        symbol: userSym,
        ...(name ? { name } : {}),
        price,
        ...(currency ? { currency } : {}),
        ...(change !== undefined ? { change } : {}),
        ...(changePct !== undefined ? { changePct } : {}),
        ...(marketState ? { marketState } : {}),
        ...(asOf ? { asOf } : {})
      })
    }
    return { quotes, ...(lastFailure ? { failure: lastFailure } : {}) }
  }

  async function coingeckoQuotes(
    symbols: string[],
    region?: string,
    signal?: AbortSignal
  ): Promise<{ quotes: Quote[]; failure?: string }> {
    const idToSym = new Map<string, string>()
    for (const sym of symbols) {
      const { kind, mapped } = classify(sym, { region })
      if (kind === 'crypto') idToSym.set(mapped, sym)
    }
    if (idToSym.size === 0) return { quotes: [] }
    const ids = [...idToSym.keys()].join(',')
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`
    const res = await fetchJson(fetchFn, url, timeoutMs, 'coingecko quote', signal)
    if (!res.ok) return { quotes: [], failure: res.reason }
    if (!res.data || typeof res.data !== 'object' || Array.isArray(res.data)) {
      return { quotes: [], failure: 'coingecko quote failed (malformed)' }
    }
    const body = res.data as Record<string, { usd?: unknown; usd_24h_change?: unknown } | undefined>
    const quotes: Quote[] = []
    const stamp = now().toISOString()
    for (const [geckoId, userSym] of idToSym.entries()) {
      const row = body[geckoId]
      const price = toFiniteNumber(row?.usd)
      if (price === undefined) continue
      const rawChg = toFiniteNumber(row?.usd_24h_change)
      const changePct = rawChg !== undefined ? roundTo(rawChg, 2) : undefined
      const name = geckoId.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
      quotes.push({
        symbol: userSym,
        name,
        price,
        currency: 'USD',
        ...(changePct !== undefined ? { changePct } : {}),
        asOf: stamp
      })
    }
    return { quotes }
  }

  async function searchRaw(
    query: string,
    limit: number,
    region?: string,
    signal?: AbortSignal
  ): Promise<MarketResult<SearchHit[]>> {
    const q = query.trim()
    if (!q) return { ok: false, reason: 'empty_query' }
    const count = Math.max(1, Math.min(Math.trunc(limit), 20))
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=${count}&newsCount=0`
    const res = await fetchJson(fetchFn, url, timeoutMs, 'yahoo search', signal)
    if (!res.ok) return res
    const rawQuotes = (res.data as { quotes?: unknown } | null)?.quotes
    if (!Array.isArray(rawQuotes)) return { ok: false, reason: 'yahoo search failed (malformed)' }

    const out: SearchHit[] = []
    for (const entry of rawQuotes) {
      if (!entry || typeof entry !== 'object') continue
      const row = entry as Record<string, unknown>
      const symbol = String(row.symbol || '').trim()
      if (!symbol) continue
      const shortname = String(row.shortname || '').trim()
      const longname = String(row.longname || '').trim()
      out.push({
        symbol,
        name: shortname || longname,
        longName: longname || shortname,
        type: String(row.quoteType || '').toLowerCase(),
        exchange: String(row.exchDisp || '').trim()
      })
    }

    const home = REGIONS[(region ?? '').toLowerCase()]
    const hints = (home?.exchanges ?? []).map((h) => h.toLowerCase())
    const suffix = (home?.suffix ?? '').toLowerCase()
    if (hints.length > 0 || suffix) {
      const isLocal = (row: SearchHit): number => {
        const ex = row.exchange.toLowerCase()
        const sym = row.symbol.toLowerCase()
        return hints.some((h) => ex.includes(h)) || (suffix && sym.endsWith(suffix)) ? 0 : 1
      }
      out.sort((a, b) => isLocal(a) - isLocal(b))
    }
    return { ok: true, data: out.slice(0, limit) }
  }

  async function fetchNews(
    query: string,
    options: { limit?: number; region?: string; signal?: AbortSignal }
  ): Promise<MarketResult<Headline[]>> {
    const q = query.trim()
    if (!q) return { ok: false, reason: 'empty_query' }
    const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? 8), 15))
    const [gl, hl] = localeFor(options.region)

    const collected: RawNewsItem[] = []
    let succeeded = 0
    let lastFailure: string | undefined

    if (TT_TICKER.test(q.toLowerCase())) {
      const sym = q.toLowerCase()
      const ttQuery = `(diff (and tt:${sym} T:curated) T:ugc)`
      const url = `https://api.tickertick.com/feed?q=${encodeURIComponent(ttQuery)}&n=${Math.max(1, Math.min(limit, 20))}`
      const res = await fetchJson(fetchFn, url, timeoutMs, 'tickertick news', options.signal)
      if (res.ok) {
        succeeded += 1
        const stories = (res.data as { stories?: unknown } | null)?.stories
        if (Array.isArray(stories)) {
          for (const st of stories) {
            if (!st || typeof st !== 'object') continue
            const row = st as Record<string, unknown>
            const title = String(row.title || '').trim()
            if (!title) continue
            const ts = Math.floor(Number(row.time || 0) / 1000)
            const site = String(row.site || '').slice(0, 60)
            collected.push({
              title: title.slice(0, 200),
              url: String(row.url || '').slice(0, 400),
              published: ts > 0 ? new Date(ts * 1000).toUTCString().slice(0, 40) : '',
              ts,
              source: site,
              also: 0
            })
          }
        }
      } else {
        lastFailure = res.reason
      }
    }

    const feeds: { url: string; needs: string[] }[] = []
    if (YAHOO_RSS_SYMBOL.test(q)) {
      const named = newsTerm(q)
      const yahooSym = (INDEX_ALIASES[q.toLowerCase()] ?? q).toUpperCase()
      feeds.push({
        url: `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(yahooSym)}&region=${gl}&lang=${hl}`,
        needs: named ? newsMentions(named) : []
      })
    }

    let term = q
    let mustMention: string[] = []
    const named = newsTerm(q)
    if (named) {
      term = named
      mustMention = newsMentions(named)
    } else if (/\d/.test(q) || q.includes('.')) {
      const found = await searchRaw(q, 1, options.region, options.signal)
      if (found.ok && found.data[0] && (found.data[0].longName || found.data[0].name)) {
        const hit = found.data[0]
        term = hit.longName || hit.name
        mustMention = [...new Set([...nameTokens(term), ...nameTokens(hit.name)])]
      }
    }

    const gnewsUrl = (t: string): string =>
      `https://news.google.com/rss/search?q=${encodeURIComponent(t)}&hl=${hl}&gl=${gl}&ceid=${gl}:en`

    feeds.push({ url: gnewsUrl(term), needs: mustMention })
    const shorter = shorterTerm(term)
    if (shorter) {
      feeds.push({ url: gnewsUrl(shorter), needs: mustMention })
    }

    for (const feed of feeds) {
      const res = await fetchText(fetchFn, feed.url, timeoutMs, 'news rss', options.signal)
      if (!res.ok) {
        lastFailure = res.reason
        continue
      }
      succeeded += 1
      let items = parseRssItems(res.text, limit * 3)
      if (feed.needs.length > 0) {
        items = items.filter((item) => {
          const lower = item.title.toLowerCase()
          return feed.needs.some((tok) => lower.includes(tok))
        })
      }
      collected.push(...items.slice(0, limit * 2))
    }

    if (succeeded === 0 && lastFailure) {
      return { ok: false, reason: lastFailure }
    }

    const cutoff = Math.floor(now().getTime() / 1000) - NEWS_MAX_AGE_DAYS * 86_400
    const filtered = collected.filter((item) => !NEWS_JUNK.test(item.title))
    const merged = new Map<string, RawNewsItem>()

    for (const item of filtered) {
      if (item.ts > 0 && item.ts < cutoff) continue
      let key = dedupeKey(item.title) || item.url
      if (!merged.has(key) && key.includes(' ') && key.split(' ').length >= 3) {
        for (const seenKey of merged.keys()) {
          if (seenKey.startsWith(key) || key.startsWith(seenKey)) {
            key = seenKey
            break
          }
        }
      }
      const have = merged.get(key)
      if (!have) {
        merged.set(key, { ...item, also: 0 })
        continue
      }
      have.also += 1
      if ((!have.source && item.source) || (!have.ts && item.ts)) {
        merged.set(key, { ...item, also: have.also })
      }
    }

    const headlines: Headline[] = [...merged.values()]
      .sort((a, b) => b.ts - a.ts)
      .slice(0, limit)
      .map((item) => ({
        title: item.title,
        ...(item.source ? { source: item.source } : {}),
        ...(item.url ? { url: item.url } : {}),
        ...(item.published ? { published: item.published } : {})
      }))

    return { ok: true, data: headlines }
  }

  return {
    async quotes(symbols, opts) {
      const cleaned = symbols.map((s) => s.trim().toLowerCase()).filter(Boolean)
      if (cleaned.length === 0) return { ok: false, reason: 'no_symbols' }

      const cryptoSyms: string[] = []
      const yahooSyms: string[] = []
      for (const sym of cleaned) {
        if (classify(sym, { region: opts.region }).kind === 'crypto') {
          cryptoSyms.push(sym)
        } else {
          yahooSyms.push(sym)
        }
      }

      const [yahooRes, geckoRes] = await Promise.all([
        yahooSyms.length > 0
          ? yahooQuotes(yahooSyms, opts.region, opts.signal)
          : Promise.resolve({ quotes: [] as Quote[], failure: undefined as string | undefined }),
        cryptoSyms.length > 0
          ? coingeckoQuotes(cryptoSyms, opts.region, opts.signal)
          : Promise.resolve({ quotes: [] as Quote[], failure: undefined as string | undefined })
      ])

      const combined = [...yahooRes.quotes, ...geckoRes.quotes]
      if (combined.length === 0) {
        return { ok: false, reason: yahooRes.failure ?? geckoRes.failure ?? 'no_data' }
      }
      return { ok: true, data: combined }
    },

    async analyse(symbol, opts) {
      const sym = symbol.trim().toLowerCase()
      if (!sym) return { ok: false, reason: 'empty_symbol' }

      const [rng, interval] = HISTORY_SPANS[(opts.span ?? '1y').toLowerCase()] ?? ['1y', '1d']
      const { kind, mapped: classified } = classify(sym, { region: opts.region })
      const mapped = kind === 'crypto' ? `${sym.replace(/[^a-z0-9]/gi, '').toUpperCase()}-USD` : classified

      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(mapped)}?interval=${interval}&range=${rng}`
      const res = await fetchJson(fetchFn, url, timeoutMs, 'yahoo history', opts.signal)
      if (!res.ok) return res

      const chart = (res.data as { chart?: { result?: unknown[] } } | null)?.chart
      const first = Array.isArray(chart?.result)
        ? (chart.result[0] as
            | {
                indicators?: { quote?: { close?: unknown[] }[] }
              }
            | undefined)
        : undefined
      const rawCloses = first?.indicators?.quote?.[0]?.close
      if (!Array.isArray(rawCloses)) {
        return { ok: false, reason: 'yahoo history failed (malformed)' }
      }

      const closes: number[] = []
      for (const c of rawCloses) {
        if (typeof c === 'number' && Number.isFinite(c)) {
          closes.push(roundTo(c, 6))
        }
      }

      if (closes.length < 20) {
        return { ok: false, reason: 'insufficient_data' }
      }

      const last = closes[closes.length - 1]
      const firstClose = closes[0]
      if (last === undefined || firstClose === undefined) {
        return { ok: false, reason: 'insufficient_data' }
      }

      const lo = Math.min(...closes)
      const hi = Math.max(...closes)
      const sma = (n: number): number | undefined => {
        if (closes.length < n) return undefined
        const slice = closes.slice(-n)
        return roundTo(slice.reduce((acc, v) => acc + v, 0) / n, 6)
      }

      const rets: number[] = []
      for (let i = 1; i < closes.length; i += 1) {
        const prev = closes[i - 1]
        const curr = closes[i]
        if (prev !== undefined && curr !== undefined && prev !== 0) {
          rets.push((curr - prev) / prev)
        }
      }
      const tail = rets.length > 60 ? rets.slice(-60) : rets
      const mean = tail.reduce((acc, r) => acc + r, 0) / tail.length
      const variance = tail.reduce((acc, r) => acc + (r - mean) ** 2, 0) / Math.max(1, tail.length - 1)
      const volatilityPct = roundTo(Math.sqrt(variance) * Math.sqrt(252) * 100, 1)

      const ma50 = sma(50)
      const ma200 = sma(200)
      const positionPct = hi > lo ? roundTo(((last - lo) / (hi - lo)) * 100, 1) : undefined
      const changePct = firstClose !== 0 ? roundTo(((last - firstClose) / firstClose) * 100, 2) : undefined

      const trend: Trend = {
        symbol: sym,
        price: last,
        high52: roundTo(hi, 6),
        low52: roundTo(lo, 6),
        ...(positionPct !== undefined ? { positionPct } : {}),
        ...(ma50 !== undefined ? { ma50 } : {}),
        ...(ma200 !== undefined ? { ma200 } : {}),
        volatilityPct,
        ...(changePct !== undefined ? { changePct } : {}),
        span: rng
      }

      let headlines: Headline[] = []
      if (opts.withNews !== false) {
        const newsRes = await fetchNews(sym, { limit: 5, region: opts.region, signal: opts.signal })
        if (newsRes.ok) headlines = newsRes.data
      }

      return { ok: true, data: { trend, headlines } }
    },

    news(query, opts) {
      return fetchNews(query, opts)
    },

    async search(query, opts) {
      const res = await searchRaw(query, 8, opts.region, opts.signal)
      if (!res.ok) return res
      return {
        ok: true,
        data: res.data.map((hit) => ({ symbol: hit.symbol, name: hit.name }))
      }
    }
  }
}
