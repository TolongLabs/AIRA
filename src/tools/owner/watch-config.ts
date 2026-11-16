import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { parse, stringify } from 'yaml'

export type AlertDirection = 'above' | 'below' | 'moves'

export interface AlertRule {
  symbol: string
  direction: string
  level: number
  to?: string
  [key: string]: unknown
}

export interface Position {
  qty: number
  cost: number
}

export interface WatchConfig {
  watchlist: string[]
  watch?: string[]
  alerts: AlertRule[]
  chats?: Record<string, unknown>
  [key: string]: unknown
}

export interface PnlRow {
  symbol: string
  qty: number
  cost: number
  price: number
  value: number
  gain: number
  gainPct: number
  currency: string
  name: string
}

export interface PnlMissingRow {
  symbol: string
  qty: number
  cost: number
}

export interface QuoteLike {
  price?: number
  currency?: string
  name?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function cleanSymbols(symbols: unknown): string[] {
  if (!Array.isArray(symbols)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of symbols) {
    const sym = String(item ?? '')
      .trim()
      .toLowerCase()
    if (sym && !seen.has(sym)) {
      seen.add(sym)
      out.push(sym)
    }
  }
  return out
}

export function loadWatchConfig(configPath: string): WatchConfig {
  let raw: unknown
  try {
    const text = readFileSync(configPath, 'utf8')
    raw = parse(text) ?? {}
  } catch {
    return { watchlist: [], alerts: [] }
  }
  if (!isRecord(raw)) {
    return { watchlist: [], alerts: [] }
  }
  const data: Record<string, unknown> = { ...raw }
  const watchRaw = Array.isArray(data.watchlist) && data.watchlist.length > 0 ? data.watchlist : data.watch
  data.watchlist = Array.isArray(watchRaw)
    ? watchRaw
        .map((s) =>
          String(s ?? '')
            .trim()
            .toLowerCase()
        )
        .filter(Boolean)
    : []
  data.alerts = Array.isArray(data.alerts) ? data.alerts.filter(isRecord) : []
  return data as WatchConfig
}

export function chatWatchlists(data: WatchConfig): Record<string, string[]> {
  const chats = isRecord(data.chats) ? data.chats : {}
  const out: Record<string, string[]> = {}
  for (const [key, entry] of Object.entries(chats)) {
    const syms = isRecord(entry) ? entry.watchlist : entry
    const cleaned = cleanSymbols(syms)
    if (cleaned.length > 0) {
      out[key] = cleaned
    }
  }
  return out
}

export function chatInherits(data: WatchConfig): Set<string> {
  const chats = isRecord(data.chats) ? data.chats : {}
  const out = new Set<string>()
  for (const [key, entry] of Object.entries(chats)) {
    if (isRecord(entry) && entry.inherit) {
      out.add(key)
    }
  }
  return out
}

export function watchlistFor(chatKey: string, data: WatchConfig): string[] {
  const own = chatWatchlists(data)[chatKey]
  if (own) return [...own]
  if (chatInherits(data).has(chatKey)) return [...data.watchlist]
  return []
}

export function setChatInherit(configPath: string, chatKey: string, want: boolean): WatchConfig {
  const key = chatKey.trim()
  if (!key) throw new Error('chatKey is required')
  const data = loadWatchConfig(configPath)
  const chats: Record<string, unknown> = isRecord(data.chats) ? { ...data.chats } : {}
  const existing = chats[key]
  const entry: Record<string, unknown> = isRecord(existing) ? { ...existing } : {}
  if (want) {
    entry.inherit = true
    Reflect.deleteProperty(entry, 'watchlist')
    chats[key] = entry
  } else {
    Reflect.deleteProperty(entry, 'inherit')
    if (Object.keys(entry).length > 0) {
      chats[key] = entry
    } else {
      Reflect.deleteProperty(chats, key)
    }
  }
  return saveWatchConfig(configPath, { chats })
}

export function positionsFor(chatKey: string, data: WatchConfig): Record<string, Position> {
  const chats = isRecord(data.chats) ? data.chats : {}
  const entry = chats[chatKey]
  const held = isRecord(entry) && isRecord(entry.positions) ? entry.positions : {}
  const out: Record<string, Position> = {}
  for (const [sym, row] of Object.entries(held)) {
    if (!isRecord(row)) continue
    const qty = Number(row.qty ?? 0)
    const cost = Number(row.cost ?? 0)
    if (Number.isFinite(qty) && Number.isFinite(cost) && qty !== 0 && cost > 0) {
      out[sym.toLowerCase()] = { qty, cost }
    }
  }
  return out
}

export function setPosition(
  configPath: string,
  chatKey: string,
  symbol: string,
  options: { qty?: number; cost?: number }
): Record<string, Position> {
  const key = chatKey.trim()
  const sym = symbol.trim().toLowerCase()
  if (!key || !sym) throw new Error('chatKey and symbol are required')

  const data = loadWatchConfig(configPath)
  const chats: Record<string, unknown> = isRecord(data.chats) ? { ...data.chats } : {}
  const existing = chats[key]
  const entry: Record<string, unknown> = isRecord(existing) ? { ...existing } : {}
  const held: Record<string, unknown> = isRecord(entry.positions) ? { ...entry.positions } : {}

  if (options.qty !== undefined && Number(options.qty) === 0) {
    Reflect.deleteProperty(held, sym)
  } else {
    const row: Record<string, unknown> = isRecord(held[sym]) ? { ...held[sym] } : {}
    if (options.qty !== undefined) {
      const qty = Number(options.qty)
      if (!Number.isFinite(qty)) throw new Error('invalid quantity')
      row.qty = qty
    }
    if (options.cost !== undefined) {
      const cost = Number(options.cost)
      if (!Number.isFinite(cost)) throw new Error('invalid cost')
      row.cost = cost
    }
    if (!row.qty || !row.cost || Number(row.cost) <= 0) {
      throw new Error('a position needs both a quantity and a cost')
    }
    held[sym] = row
  }

  if (Object.keys(held).length > 0) {
    entry.positions = held
    Reflect.deleteProperty(entry, 'inherit')
    const currentWatch = Array.isArray(entry.watchlist) ? entry.watchlist.map(String) : watchlistFor(key, data)
    for (const s of Object.keys(held)) {
      if (!currentWatch.includes(s)) currentWatch.push(s)
    }
    entry.watchlist = cleanSymbols(currentWatch)
  } else {
    Reflect.deleteProperty(entry, 'positions')
  }

  if (Object.keys(entry).length > 0) {
    chats[key] = entry
  } else {
    Reflect.deleteProperty(chats, key)
  }

  const saved = saveWatchConfig(configPath, { chats })
  return positionsFor(key, saved)
}

export function pnl(chatKey: string, quotesBy: Record<string, QuoteLike>, data: WatchConfig): PnlRow[] {
  const held = positionsFor(chatKey, data)
  const rows: PnlRow[] = []
  for (const [sym, row] of Object.entries(held)) {
    const q = quotesBy[sym] ?? quotesBy[sym.toUpperCase()]
    if (!q || typeof q.price !== 'number' || !Number.isFinite(q.price)) continue
    const value = q.price * row.qty
    const book = row.cost * row.qty
    rows.push({
      symbol: sym,
      qty: row.qty,
      cost: row.cost,
      price: q.price,
      value,
      gain: value - book,
      gainPct: book ? ((value - book) / book) * 100 : 0,
      currency: q.currency ?? '',
      name: q.name ?? ''
    })
  }
  return rows.sort((a, b) => Math.abs(b.gainPct) - Math.abs(a.gainPct))
}

export function pnlMissing(chatKey: string, quotesBy: Record<string, QuoteLike>, data: WatchConfig): PnlMissingRow[] {
  const held = positionsFor(chatKey, data)
  const out: PnlMissingRow[] = []
  for (const [sym, row] of Object.entries(held)) {
    const q = quotesBy[sym] ?? quotesBy[sym.toUpperCase()]
    if (!q || typeof q.price !== 'number' || !Number.isFinite(q.price)) {
      out.push({ symbol: sym, qty: row.qty, cost: row.cost })
    }
  }
  return out.sort((a, b) => a.symbol.localeCompare(b.symbol))
}

export function setChatWatchlist(configPath: string, chatKey: string, symbols: string[]): WatchConfig {
  const key = chatKey.trim()
  if (!key) throw new Error('chatKey is required')
  const cleaned = cleanSymbols(symbols)
  const data = loadWatchConfig(configPath)
  const chats: Record<string, unknown> = isRecord(data.chats) ? { ...data.chats } : {}
  const existing = chats[key]
  const entry: Record<string, unknown> = isRecord(existing) ? { ...existing } : {}
  if (cleaned.length > 0) {
    entry.watchlist = cleaned
    Reflect.deleteProperty(entry, 'inherit')
    chats[key] = entry
  } else {
    Reflect.deleteProperty(entry, 'watchlist')
    if (Object.keys(entry).length > 0) {
      chats[key] = entry
    } else {
      Reflect.deleteProperty(chats, key)
    }
  }
  return saveWatchConfig(configPath, { chats })
}

export function saveWatchConfig(
  configPath: string,
  patch: {
    watchlist?: string[]
    alerts?: AlertRule[]
    chats?: Record<string, unknown>
    [key: string]: unknown
  }
): WatchConfig {
  const data: Record<string, unknown> = { ...loadWatchConfig(configPath) }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    if (k === 'watchlist') {
      data.watchlist = cleanSymbols(v)
    } else if (k === 'alerts' && Array.isArray(v)) {
      data.alerts = [...v]
    } else {
      data[k] = v
    }
  }
  const watchlist = Array.isArray(data.watchlist) ? data.watchlist : []
  data.watchlist = watchlist
  data.watch = [...watchlist]

  const dir = dirname(configPath)
  mkdirSync(dir, { recursive: true })
  const tmpPath = join(dir, `.${basename(configPath)}.${process.pid}.${Date.now()}.tmp`)
  const text = stringify(data)
  try {
    writeFileSync(tmpPath, text, 'utf8')
    renameSync(tmpPath, configPath)
  } catch (err) {
    try {
      rmSync(tmpPath, { force: true })
    } catch {
      // Best-effort cleanup of temp file.
    }
    throw err
  }
  return data as WatchConfig
}
