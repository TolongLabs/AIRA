import { z } from 'zod'
import type { HandlerResult, ToolContext, ToolDefinition } from '../types.js'
import type { Headline, MarketsPort, Quote } from './markets.js'
import {
  type AlertRule,
  chatWatchlists,
  cleanSymbols,
  loadWatchConfig,
  pnl,
  pnlMissing,
  positionsFor,
  type QuoteLike,
  saveWatchConfig,
  setChatWatchlist,
  setPosition,
  watchlistFor
} from './watch-config.js'

const FEATURE = 'features.owner'

const quoteSchema = z.strictObject({
  symbols: z.array(z.string().trim().min(1)).min(1).max(20)
})

const analyseSchema = z.strictObject({
  symbol: z.string().trim().min(1),
  span: z.enum(['1mo', '6mo', '1y', '5y']).optional(),
  with_news: z.boolean().optional()
})

const newsSchema = z.strictObject({
  query: z.string().trim().min(1),
  limit: z.number().int().min(1).max(15).optional()
})

const WATCH_KINDS = ['list', 'search', 'add', 'remove', 'alert', 'unalert', 'hold', 'sold'] as const

const watchSchema = z.strictObject({
  kind: z.enum(WATCH_KINDS),
  query: z.string().trim().min(1).optional(),
  symbols: z.array(z.string().trim().min(1)).optional(),
  symbol: z.string().trim().min(1).optional(),
  direction: z.enum(['above', 'below', 'moves']).optional(),
  qty: z.number().optional(),
  cost: z.number().optional(),
  level: z.number().optional()
})

function failKind(signal: AbortSignal): 'timeout' | 'error' {
  return signal.aborted ? 'timeout' : 'error'
}

function indexQuotes(list: Quote[]): Record<string, Quote> {
  const out: Record<string, Quote> = {}
  for (const q of list) {
    out[q.symbol.toLowerCase()] = q
  }
  return out
}

function alertsForChat(alerts: AlertRule[], chatKey: string): AlertRule[] {
  return alerts.filter((rule) => (rule.to ?? '') === chatKey)
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback
}

function marketQuoteTool(markets: MarketsPort): ToolDefinition<z.infer<typeof quoteSchema>> {
  return {
    name: 'market_quote',
    description:
      'Live prices for one or more tickers, indices or coins. Use when they ask what something is trading at right now. Not for how it has been doing (market_analyse), headlines (market_news), or following it (market_watch).',
    schema: quoteSchema,
    mode: 'both',
    mutates: false,
    feature: FEATURE,
    async handler(args, context) {
      const syms = args.symbols
        .slice(0, 20)
        .map((s) => s.trim())
        .filter(Boolean)
      const res = await markets.quotes(syms, { signal: context.signal })
      if (!res.ok) {
        return { ok: false, kind: failKind(context.signal), reason: res.reason }
      }
      const quotes = indexQuotes(res.data)
      const missing = syms.map((s) => s.toLowerCase()).filter((s) => !(s in quotes))
      const data: Record<string, unknown> = { quotes }
      if (missing.length > 0) {
        data.no_data = missing
      }
      return { ok: true, data }
    }
  }
}

function marketAnalyseTool(markets: MarketsPort): ToolDefinition<z.infer<typeof analyseSchema>> {
  return {
    name: 'market_analyse',
    description:
      'The whole picture on one symbol: price, 52-week position, moving averages, volatility and recent headlines. Use when they ask how something is doing, not just what it costs. Not for a bare price: that is market_quote.',
    schema: analyseSchema,
    mode: 'both',
    mutates: false,
    feature: FEATURE,
    async handler(args, context) {
      const symbol = args.symbol.trim().toLowerCase()
      const span = args.span ?? '1y'
      const withNews = args.with_news ?? true
      const res = await markets.analyse(symbol, { span, withNews, signal: context.signal })
      if (!res.ok) {
        return { ok: false, kind: failKind(context.signal), reason: res.reason }
      }
      const data: { symbol: string; trend: unknown; news?: Headline[] } = {
        symbol,
        trend: res.data.trend
      }
      if (withNews) {
        data.news = res.data.headlines
      }
      return { ok: true, data }
    }
  }
}

function marketNewsTool(markets: MarketsPort): ToolDefinition<z.infer<typeof newsSchema>> {
  return {
    name: 'market_news',
    description:
      'Recent headlines for a ticker or a market topic. Use when they ask what is happening with a stock, an index or a market. Not for news outside the markets: that is web_search.',
    schema: newsSchema,
    mode: 'both',
    mutates: false,
    feature: FEATURE,
    async handler(args, context) {
      const query = args.query.trim()
      const limit = args.limit ?? 8
      const res = await markets.news(query, { limit, signal: context.signal })
      if (!res.ok) {
        return { ok: false, kind: failKind(context.signal), reason: res.reason }
      }
      if (res.data.length === 0) {
        return { ok: true, data: { query, items: [], note: 'no headlines found — say so plainly' } }
      }
      return { ok: true, data: { query, items: res.data } }
    }
  }
}

async function handleWatchList(
  markets: MarketsPort,
  configPath: string,
  chatKey: string,
  context: ToolContext
): Promise<HandlerResult> {
  const cfg = loadWatchConfig(configPath)
  const alerts = alertsForChat(cfg.alerts, chatKey)
  const watch = watchlistFor(chatKey, cfg)
  const own = Boolean(chatWatchlists(cfg)[chatKey])
  const held = positionsFor(chatKey, cfg)

  const out: Record<string, unknown> = {
    watchlist: watch,
    alerts,
    list_belongs_to: own ? 'this chat' : 'no list of its own yet'
  }

  let quotesBy: Record<string, QuoteLike> = {}
  if (watch.length > 0) {
    const res = await markets.quotes(watch.slice(0, 20), { signal: context.signal })
    if (res.ok) {
      const indexed = indexQuotes(res.data)
      out.quotes = indexed
      quotesBy = indexed
    } else {
      out.quotes_error = res.reason
    }
  }

  if (Object.keys(held).length > 0) {
    const rows = pnl(chatKey, quotesBy, cfg)
    const missing = pnlMissing(chatKey, quotesBy, cfg)
    out.positions = rows
    if (missing.length > 0) {
      out.positions_missing = missing
    }
  }

  return { ok: true, data: out }
}

function handleWatchAddRemove(
  configPath: string,
  chatKey: string,
  kind: 'add' | 'remove',
  rawSymbols: string[],
  context: ToolContext
): HandlerResult {
  const syms = cleanSymbols(rawSymbols)
  if (syms.length === 0) {
    return { ok: false, kind: 'invalid', reason: 'pass symbols, e.g. ["nvda"]' }
  }
  try {
    const { data } = context.commit(() => {
      const cfg = loadWatchConfig(configPath)
      const current = watchlistFor(chatKey, cfg)
      const next = kind === 'add' ? cleanSymbols([...current, ...syms]) : current.filter((s) => !syms.includes(s))
      setChatWatchlist(configPath, chatKey, next)
      return {
        data: {
          watchlist: next,
          changed: syms,
          scope: 'this chat',
          note: 'Tracked from the next five-minute poll.'
        },
        receipt: {
          kind: kind === 'add' ? 'market_watch.added' : 'market_watch.removed',
          target: context.chat.chatId,
          state: { watchlist: next, changed: syms }
        }
      }
    })
    return { ok: true, data }
  } catch (err) {
    return { ok: false, kind: 'error', reason: `could not save the watchlist: ${errorMessage(err, 'write failed')}` }
  }
}

function handleWatchHoldSold(
  configPath: string,
  chatKey: string,
  kind: 'hold' | 'sold',
  symbol: string,
  qty: number | undefined,
  cost: number | undefined,
  context: ToolContext
): HandlerResult {
  const sym = symbol.trim().toLowerCase()
  if (!sym) {
    return { ok: false, kind: 'invalid', reason: 'pass symbol' }
  }
  try {
    const { data } = context.commit(() => {
      const held =
        kind === 'sold'
          ? setPosition(configPath, chatKey, sym, { qty: 0 })
          : setPosition(configPath, chatKey, sym, { qty, cost })
      return {
        data: {
          positions: held,
          note: kind === 'sold' ? 'Dropped.' : 'Recorded.'
        },
        receipt: {
          kind: kind === 'sold' ? 'market_watch.sold' : 'market_watch.held',
          target: `${context.chat.chatId}:${sym}`,
          state: { positions: held }
        }
      }
    })
    return { ok: true, data }
  } catch (err) {
    const msg = errorMessage(err, 'write failed')
    const failureKind = msg.includes('needs both') || msg.includes('invalid') ? 'invalid' : 'error'
    return { ok: false, kind: failureKind, reason: msg }
  }
}

function handleWatchAlert(
  configPath: string,
  chatKey: string,
  kind: 'alert' | 'unalert',
  symbol: string,
  direction: 'above' | 'below' | 'moves' | undefined,
  level: number | undefined,
  context: ToolContext
): HandlerResult {
  const sym = symbol.trim().toLowerCase()
  if (!sym) {
    return { ok: false, kind: 'invalid', reason: 'pass symbol' }
  }
  if (!direction) {
    return { ok: false, kind: 'invalid', reason: 'direction must be above, below or moves' }
  }
  if (kind === 'alert' && (level === undefined || !Number.isFinite(level))) {
    return { ok: false, kind: 'invalid', reason: 'pass level — a price, or a percent for moves' }
  }

  try {
    const { data } = context.commit(() => {
      const cfg = loadWatchConfig(configPath)
      let watch = watchlistFor(chatKey, cfg)
      const remaining = cfg.alerts.filter(
        (r) => !(r.symbol.toLowerCase() === sym && r.direction.toLowerCase() === direction && (r.to ?? '') === chatKey)
      )
      if (kind === 'alert') {
        remaining.push({ symbol: sym, direction, level: level!, to: chatKey })
        if (!watch.includes(sym)) {
          watch = [...watch, sym]
        }
        setChatWatchlist(configPath, chatKey, watch)
      }
      saveWatchConfig(configPath, { alerts: remaining })
      return {
        data: {
          watchlist: watch,
          alerts: alertsForChat(remaining, chatKey),
          note:
            kind === 'alert'
              ? 'Armed. It fires once when the level is crossed, not every five minutes while it sits there.'
              : 'Disarmed.'
        },
        receipt: {
          kind: kind === 'alert' ? 'market_watch.alert_armed' : 'market_watch.alert_disarmed',
          target: `${context.chat.chatId}:${sym}:${direction}`,
          state: { symbol: sym, direction, ...(kind === 'alert' ? { level } : {}) }
        }
      }
    })
    return { ok: true, data }
  } catch (err) {
    return { ok: false, kind: 'error', reason: `could not save that alert: ${errorMessage(err, 'write failed')}` }
  }
}

function marketWatchTool(markets: MarketsPort, configPath: string): ToolDefinition<z.infer<typeof watchSchema>> {
  return {
    name: 'market_watch',
    description:
      'The watchlist, the holdings and the price alerts. Add or remove a stock they want followed, resolve a company name to a ticker, arm or disarm a price alert, and record what they actually own. Not for a reminder at a time: that is reminder_set.',
    schema: watchSchema,
    mode: 'both',
    mutates: true,
    feature: FEATURE,
    async handler(args, context) {
      const chatKey = context.chat.waId
      let { symbol, symbols } = args

      if (args.kind !== 'list' && args.kind !== 'search' && !symbols?.length && !symbol && args.query) {
        const found = await markets.search(args.query, { signal: context.signal })
        if (!found.ok) {
          return { ok: false, kind: failKind(context.signal), reason: found.reason }
        }
        if (found.data.length === 0) {
          return {
            ok: false,
            kind: 'invalid',
            reason: `nothing matched "${args.query}" — ask them to spell the company name, or give the ticker`
          }
        }
        if (found.data.length > 1 && found.data[0]!.symbol.toLowerCase() !== args.query.toLowerCase()) {
          return {
            ok: true,
            data: {
              query: args.query,
              results: found.data,
              note: 'More than one company matches. Ask which one, then call market_watch again with that ticker in symbol.'
            }
          }
        }
        symbol = found.data[0]!.symbol
        symbols = [symbol]
      }

      if (args.kind === 'search') {
        if (!args.query) {
          return { ok: false, kind: 'invalid', reason: 'pass query — a company or index name' }
        }
        const found = await markets.search(args.query, { signal: context.signal })
        if (!found.ok) {
          return { ok: false, kind: failKind(context.signal), reason: found.reason }
        }
        return {
          ok: true,
          data: {
            query: args.query,
            results: found.data,
            note:
              found.data.length === 0
                ? 'Nothing matched. Ask them to spell the company name, or give the ticker.'
                : 'Pick the one they meant, then call market_watch again with add.'
          }
        }
      }

      if (args.kind === 'list') {
        return handleWatchList(markets, configPath, chatKey, context)
      }

      if (args.kind === 'add' || args.kind === 'remove') {
        const raw = symbols ?? (symbol ? [symbol] : [])
        return handleWatchAddRemove(configPath, chatKey, args.kind, raw, context)
      }

      if (args.kind === 'hold' || args.kind === 'sold') {
        return handleWatchHoldSold(configPath, chatKey, args.kind, symbol ?? '', args.qty, args.cost, context)
      }

      return handleWatchAlert(configPath, chatKey, args.kind, symbol ?? '', args.direction, args.level, context)
    }
  }
}

export function marketTools(ports: { markets: MarketsPort; configPath?: string }): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    marketQuoteTool(ports.markets) as ToolDefinition,
    marketAnalyseTool(ports.markets) as ToolDefinition,
    marketNewsTool(ports.markets) as ToolDefinition
  ]
  if (ports.configPath) {
    const watch = marketWatchTool(ports.markets, ports.configPath).handler
    for (const spec of WATCH_TOOLS) {
      tools.push({
        name: spec.name,
        description: spec.description,
        schema: spec.schema,
        mode: 'both',
        mutates: spec.mutates,
        feature: FEATURE,
        handler: (args: Record<string, unknown>, context) => watch({ ...args, kind: spec.kind } as never, context)
      } as ToolDefinition)
    }
  }
  return tools
}

const symbolsOrQuery = {
  symbols: z.array(z.string().trim().min(1)).optional(),
  symbol: z.string().trim().min(1).optional(),
  query: z.string().trim().min(1).optional()
}

/** The watchlist, holdings and alerts as atomic tools: one action each (docs/trd/tools.md#atomic-tools). */
const WATCH_TOOLS: {
  name: string
  kind: (typeof WATCH_KINDS)[number]
  mutates: boolean
  description: string
  schema: z.ZodType
}[] = [
  {
    name: 'market_watch_list',
    kind: 'list',
    mutates: false,
    description: 'The watchlist, holdings and price alerts of this chat, with current prices.',
    schema: z.strictObject({})
  },
  {
    name: 'market_symbol_search',
    kind: 'search',
    mutates: false,
    description: 'Find the ticker for a company or asset name before adding it.',
    schema: z.strictObject({ query: z.string().trim().min(1) })
  },
  {
    name: 'market_watch_add',
    kind: 'add',
    mutates: true,
    description: 'Add one or more stocks, indices or coins to this chat watchlist.',
    schema: z.strictObject(symbolsOrQuery)
  },
  {
    name: 'market_watch_remove',
    kind: 'remove',
    mutates: true,
    description: 'Remove one or more symbols from this chat watchlist.',
    schema: z.strictObject(symbolsOrQuery)
  },
  {
    name: 'market_alert_set',
    kind: 'alert',
    mutates: true,
    description: 'Arm a price alert on one symbol: above or below a level, or on a big move.',
    schema: z.strictObject({
      ...symbolsOrQuery,
      direction: z.enum(['above', 'below', 'moves']).optional(),
      level: z.number().optional()
    })
  },
  {
    name: 'market_alert_clear',
    kind: 'unalert',
    mutates: true,
    description: 'Disarm the price alert on one symbol.',
    schema: z.strictObject({ ...symbolsOrQuery, direction: z.enum(['above', 'below', 'moves']).optional() })
  },
  {
    name: 'market_holding_set',
    kind: 'hold',
    mutates: true,
    description: 'Record what they own of one symbol: quantity and cost per unit.',
    schema: z.strictObject({ ...symbolsOrQuery, qty: z.number().optional(), cost: z.number().optional() })
  },
  {
    name: 'market_holding_clear',
    kind: 'sold',
    mutates: true,
    description: 'Remove a holding they sold.',
    schema: z.strictObject(symbolsOrQuery)
  }
]
