import { scrollSurface } from '@/dashboard/scroll'
import { Loading } from '@/dashboard/loading'
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { ArrowDown, ArrowUp, Bell, Plus, RefreshCw, TrendingDown, TrendingUp, X } from 'lucide-react'
import type { Chat, Dashboard, History, NewsItem, Quote, Settings } from '@/lib/api'
import { OwnerRequestError, get, post } from '@/lib/api'
import { toast, Toaster, useApi, useThemeColors } from '@/lib/hooks'
import type { Async } from '@/lib/hooks'
import { ago, price } from '@/lib/utils'
import { Shell } from '@/components/shell'
import {
  Button,
  Card,
  CardHead,
  ConfirmAction,
  Empty,
  Field,
  Input,
  Picker,
  Section,
  Segmented,
  Spinner,
  Toggle
} from '@/components/ui'
import { SymbolSearch } from '@/components/symbol-search'
import { DashboardContext } from '../dashboard/context'
import { WorkspaceTools } from '@/dashboard/workspace-tools'
import { FormSelect } from '@/dashboard/form-select'
import '../dashboard/markets.css'

/* WHY THIS PAGE IS SHAPED LIKE THIS
   It used to be a row of wrapping pills over a chart, and the only way to add
   an instrument was Settings → Markets — a different page, with no prices on
   it, for a decision that is entirely about prices. Two consequences the
   client hit within a minute of using it: you could not compare the things
   you follow (a wrapped row aligns nothing, so five prices sat at five
   different x-positions), and a symbol you added landed at the END of the
   row, under the fold, with no way to say you wanted it first.

   So: a watchlist RAIL — one aligned row per instrument, sortable by its own
   column headers, with the search that adds one sitting at the top of it.
   That is the layout every finance product converged on (Yahoo Finance,
   Robinhood) for the same reason — a list of homogeneous things you sort and
   compare is a table, not a card wall. Adding happens where the prices are,
   and arming an alert does too, because "tell me when it drops under 100" is
   a thought you have while looking at the chart, not while in Settings. */

/* Tickers are jargon. Every symbol carries its real name here because a
   reader took SPX for SpaceX — the feed supplies one, and this map covers the
   aliases it does not. */
const NAME_FALLBACK: Record<string, string> = {
  spx: 'S&P 500',
  sp500: 'S&P 500',
  ndx: 'Nasdaq 100',
  nasdaq: 'Nasdaq Composite',
  dji: 'Dow Jones',
  dow: 'Dow Jones',
  nikkei: 'Nikkei 225',
  hsi: 'Hang Seng',
  sti: 'Straits Times',
  dax: 'DAX',
  ftse: 'FTSE 100',
  vix: 'VIX volatility',
  btc: 'Bitcoin',
  eth: 'Ethereum'
}

const SPANS = ['1d', '1w', '1m', '1y', '5y'] as const
type Span = (typeof SPANS)[number]

/* Spoken form, for the label beside the percentage. "over 1m" reads as a
   filename; "over the past month" reads as English. */
const SPAN_LABEL: Record<Span, string> = {
  '1d': 'today',
  '1w': 'the past week',
  '1m': 'the past month',
  '1y': 'the past year',
  '5y': 'the past five years'
}

/* ── dashboard tabs ─────────────────────────────────────────────────────
   The orchestrator owns routing: entry.tsx maps a preview path to this page
   and server.ts maps it to preview.html. This page only READS the logical
   path and keeps it in its links, so /markets, /markets/watchlist,
   /markets/alerts and /markets/news all land here and each tab stays
   addressable with a cold load. Legacy /app/markets.html keeps its hash
   workflow untouched. */

type MarketTab = 'watchlist' | 'alerts' | 'news'

const MARKET_TABS: { key: MarketTab; label: string }[] = [
  { key: 'watchlist', label: 'Watchlist' },
  { key: 'alerts', label: 'Alerts and Delivery' },
  { key: 'news', label: 'News' }
]

function parseMarketTab(): MarketTab {
  try {
    const m = location.pathname.match(/\/markets(?:\/(watchlist|alerts|news))?\/?$/)
    if (m?.[1]) return m[1] as MarketTab
    const h = location.hash.replace(/^#\/?/, '').split(/[?/]/)[0]
    if (h === 'watchlist' || h === 'alerts' || h === 'news') return h
    const q = new URLSearchParams(location.search).get('tab')
    if (q === 'watchlist' || q === 'alerts' || q === 'news') return q
  } catch {
    /* non-browser render or private mode — the default stands */
  }
  return 'watchlist'
}

/* The href each tab keeps in the DOM: the logical preview path when this
   page is served under one, otherwise the legacy hash. Cold loads, refresh
   and history all resolve through parseMarketTab above. */
function marketTabHref(tab: MarketTab): string {
  try {
    const m = location.pathname.match(/^(.*\/markets)(?:\/(?:watchlist|alerts|news))?\/?$/)
    if (m?.[1]) return `${m[1]}/${tab}`
  } catch {
    /* fall through to the hash */
  }
  return `#${tab}`
}

function isConflictMessage(message: string): boolean {
  const m = message.toLowerCase()
  return m.includes('conflict') || m.includes('changed in another') || m.includes('stale') || m.includes('409')
}

/* A POST that loses a stale-write race must not vanish into a toast. The
   banner used to watch the settings GET only, so a 409 never showed there.
   This typed conflict keeps the requested patch as the draft, compares it
   against fresh authority, and retries only the same fields with a fresh
   stamp — never a full overwrite of fields changed elsewhere. */
type MarketsPatch = {
  watchlist?: string[]
  alerts?: AlertRule[]
  default_target?: string
  news_digest?: { enabled: boolean; to: string[]; hours?: number[] }
}

interface MarketsConflict {
  patch: MarketsPatch
  message: string
  fresh: Settings['markets'] | null
  checking: boolean
  confirmed: boolean
  retrying: boolean
  error: string | null
}

function isMarketsConflictError(e: unknown): boolean {
  if (e instanceof OwnerRequestError && e.status === 409) return true
  return e instanceof Error && isConflictMessage(e.message)
}

function formatConflictValue(key: string, value: unknown): string {
  if (value == null) return '(empty)'
  if (Array.isArray(value)) {
    if (!value.length) return '(none)'
    if (key === 'watchlist') return value.map((s) => String(s).toUpperCase()).join(', ')
    return value
      .map((row) => {
        if (row && typeof row === 'object') {
          const r = row as { symbol?: unknown; direction?: unknown; level?: unknown }
          return `${String(r.symbol ?? '?').toUpperCase()} ${String(r.direction ?? '')} ${String(r.level ?? '')}`.trim()
        }
        return String(row)
      })
      .join(' · ')
  }
  if (typeof value === 'object') {
    const v = value as { enabled?: unknown; to?: unknown }
    const to = Array.isArray(v.to) ? v.to.map(String).join(', ') : ''
    return `${v.enabled ? 'on' : 'off'}${to ? ` → ${to}` : ''}`
  }
  return String(value) || '(none)'
}

function MarketsConflictPanel({
  conflict,
  stale,
  onCheckFresh,
  onConfirm,
  onRetry,
  onDiscard
}: {
  conflict: MarketsConflict
  stale: Settings['markets'] | null
  onCheckFresh: () => void
  onConfirm: (v: boolean) => void
  onRetry: () => void
  onDiscard: () => void
}) {
  const keys = Object.keys(conflict.patch)
  const current = conflict.fresh ?? stale
  const canRetry = conflict.fresh != null && conflict.confirmed && !conflict.checking && !conflict.retrying
  return (
    <div role="alert" className="mkd-conflict">
      <p className="m-0 text-[0.9rem]">
        <b>Settings changed elsewhere — your change was not saved.</b> {conflict.message}
      </p>
      <p className="mb-0 text-[0.85rem] text-muted">
        Your draft is kept. Only {keys.length ? keys.join(', ') : 'these fields'} will be retried — nothing else
        changes.
      </p>
      <ul className="mt-2 mb-0 flex flex-col gap-1 text-[0.85rem]">
        {keys.map((key) => (
          <li key={key}>
            <code>{key}</code>: you asked{' '}
            <b>{formatConflictValue(key, (conflict.patch as Record<string, unknown>)[key])}</b>
            {' · '}now <b>{formatConflictValue(key, (current as Record<string, unknown> | null)?.[key] ?? null)}</b>
          </li>
        ))}
      </ul>
      {!conflict.fresh && (
        <p className="mb-0 text-[0.85rem] text-muted">
          Check the fresh values first, then confirm and retry. The draft stays until you discard it.
        </p>
      )}
      <label className="mt-2 flex items-center gap-2 text-[0.85rem]">
        <input
          type="checkbox"
          checked={conflict.confirmed}
          disabled={conflict.fresh == null}
          onChange={(e) => onConfirm(e.target.checked)}
          className="dashboard-choice size-4"
        />
        <span>I compared my draft with the current values and want to retry only these fields.</span>
      </label>
      {conflict.error && (
        <p role="status" className="mb-0 text-[0.85rem] text-down">
          {conflict.error}
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2">
        {!conflict.fresh && (
          <button type="button" className="mkd-link" disabled={conflict.checking} onClick={onCheckFresh}>
            {conflict.checking ? 'Checking…' : 'Reload and compare'}
          </button>
        )}
        {conflict.fresh && (
          <button type="button" className="mkd-link" disabled={conflict.checking} onClick={onCheckFresh}>
            {conflict.checking ? 'Checking…' : 'Check again'}
          </button>
        )}
        <button type="button" className="mkd-link" disabled={!canRetry} onClick={onRetry}>
          {conflict.retrying ? 'Retrying…' : 'Retry with fresh values'}
        </button>
        <button type="button" className="mkd-link" onClick={onDiscard}>
          Discard my draft and reload
        </button>
      </div>
    </div>
  )
}

interface AlertRule {
  symbol: string
  direction: 'above' | 'below' | 'moves'
  level: number
  /* Which chat answers it. Absent means the default target (set under
     Settings → Markets). Kept on every re-save so arming one alert never
     strips the routing off the others. */
  to?: string
}

/* ── watchlist ordering ───────────────────────────────────────────────────
   The stored watchlist is insertion order and stays that way: it is what she
   reads out when asked "what am I watching", and reordering it to suit a
   screen would change her answer. So order is a VIEW here, and "Added" runs
   newest-first by default — which is the complaint this exists to answer. */

type SortKey = 'added' | 'symbol' | 'price' | 'change'
type Sort = { key: SortKey; desc: boolean }

const SORT_STORE = 'markets.sort'
const DEFAULT_SORT: Sort = { key: 'added', desc: true }

function readSort(): Sort {
  try {
    const raw = JSON.parse(localStorage.getItem(SORT_STORE) || '')
    if (raw && ['added', 'symbol', 'price', 'change'].includes(raw.key))
      return { key: raw.key as SortKey, desc: !!raw.desc }
  } catch {
    /* first visit, or someone's storage is full — the default is fine */
  }
  return DEFAULT_SORT
}

/* What each header means when it points down, said in words. A caret alone
   tells you the direction and not the meaning: "Change ▼" is ambiguous
   between "biggest fallers" and "sorted descending". */
const SORT_HINT: Record<SortKey, [asc: string, desc: string]> = {
  added: ['oldest first', 'newest first'],
  symbol: ['A to Z', 'Z to A'],
  price: ['cheapest first', 'dearest first'],
  change: ['biggest fallers first', 'biggest risers first']
}

/* A point on a five-year chart labelled "Jan 28" cannot say WHICH January —
   the axis and the tooltip both dropped the year, and on the two spans that
   cross years that is the only part that matters. The axis stays terse (an
   apostrophe year is enough to place a tick); the tooltip spells it out. */
function axisLabel(t: number, span: Span): string {
  const d = new Date(t * 1000)
  if (span === '1d')
    return d.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit'
    })
  if (span === '1w') return d.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric' })
  if (span === '1m') return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  // 1y and 5y: the year is the point.
  return `${d.toLocaleDateString('en-US', { month: 'short' })} '${String(d.getFullYear()).slice(2)}`
}

function dayLabel(d: Date): string {
  const today = new Date()
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString()
  const yesterday = new Date(today.getTime() - 86400000)
  if (same(d, today)) return 'Today'
  if (same(d, yesterday)) return 'Yesterday'
  return d.toLocaleDateString('en-US', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric'
  })
}

function fullMoment(t: number, span: Span): string {
  const d = new Date(t * 1000)
  const day = d.toLocaleDateString('en-US', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  })
  return span === '1d' ? `${day} · ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` : day
}

/* What the hover actually needs to answer: WHEN, how much, and how far that is
   from where this span started. The old one printed the axis label and a price,
   so on 5Y it read "Jan 28 · 1,234" — a number at an unknown moment, with no
   way to tell a spike from the level it had held all year. */
function ChartTip({
  t,
  v,
  span,
  currency,
  first
}: {
  t: number
  v: number
  span: Span
  currency?: string
  first?: { t: number; v: number }
}) {
  const base = first?.v
  const delta = base ? v - base : null
  const pct = base ? ((v - base) / base) * 100 : null
  const up = (delta ?? 0) >= 0
  return (
    <div className="aira-tooltip px-3.5 py-2.5">
      <div className="text-[0.75rem] tracking-[0.04em] tip-muted uppercase">{fullMoment(t, span)}</div>
      <div className="tnum mt-1 font-serif text-[1.35rem] leading-none">{price(v, currency)}</div>
      {pct != null && delta != null && (
        <div className="tnum mt-1.5 text-[0.82rem]" style={{ color: up ? 'var(--tip-up)' : 'var(--tip-down)' }}>
          {up ? '+' : '−'}
          {Math.abs(pct).toFixed(2)}%
          <span className="ml-1.5 tip-muted">
            ({up ? '+' : '−'}
            {price(Math.abs(delta), currency)} since {first ? fullMoment(first.t, span === '1d' ? '1d' : '1y') : ''})
          </span>
        </div>
      )}
    </div>
  )
}

/* ── the watchlist rail ───────────────────────────────────────────────── */

/* Column widths live here so the header and every row read from one place —
   they are what makes five prices comparable at a glance instead of five
   numbers at five x-positions. */
const COL_PRICE = 'w-[4.75rem] shrink-0 text-right'
const COL_MOVE = 'w-[4.5rem] shrink-0 text-right'
const COL_KILL = 'w-7 shrink-0'

function SortButton({
  label,
  target,
  sort,
  onSort,
  className
}: {
  label: string
  target: SortKey
  sort: Sort
  onSort: (s: Sort) => void
  className?: string
}) {
  const on = sort.key === target
  const desc = on ? sort.desc : target !== 'symbol' // sensible first press
  return (
    <button
      type="button"
      // aria-sort belongs on the header CELL, and this button IS the cell.
      aria-label={`${label} — ${SORT_HINT[target][desc && on ? 1 : 0]}`}
      onClick={() => onSort({ key: target, desc: on ? !sort.desc : desc })}
      title={SORT_HINT[target][desc && on ? 1 : 0]}
      className={
        'inline-flex cursor-pointer items-center gap-0.5 rounded-[6px] border-0 bg-transparent py-1 font-mono text-[0.66rem] tracking-[0.08em] uppercase transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none ' +
        (on ? 'text-accent ' : 'text-muted hover:text-ink ') +
        (className ?? '')
      }
    >
      {label}
      {on && (sort.desc ? <ArrowDown className="size-3" aria-hidden /> : <ArrowUp className="size-3" aria-hidden />)}
    </button>
  )
}

function WatchRow({
  symbol,
  name,
  quote,
  selected,
  disabled,
  onSelect,
  onRemove
}: {
  symbol: string
  name: string
  quote?: Quote
  selected: boolean
  disabled?: boolean
  onSelect: () => void
  onRemove: () => void
}) {
  const pct = quote?.change_pct
  return (
    <div
      className={
        'flex items-stretch border-t border-line-2 first:border-t-0 ' +
        (selected ? 'bg-accent-soft' : 'hover:bg-card-2')
      }
    >
      <button
        type="button"
        aria-pressed={selected}
        onClick={onSelect}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 border-0 bg-transparent py-2.5 pr-1 pl-4 text-left focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
      >
        <span className="min-w-0 flex-1">
          <b
            className={'block font-mono text-[0.82rem] tracking-[0.02em] uppercase ' + (selected ? 'text-accent' : '')}
          >
            {symbol}
          </b>
          <span className="block truncate text-[0.78rem] text-muted">{name || '—'}</span>
        </span>
        <span className={'tnum text-[0.85rem] ' + COL_PRICE}>
          {quote?.price != null ? (
            price(quote.price, quote.currency)
          ) : (
            /* A symbol added ten seconds ago, before its quote lands. Not an
               error and not a zero — the poller has simply not been round. */
            <span className="text-faint">···</span>
          )}
        </span>
        <span
          className={
            'tnum text-[0.82rem] ' + COL_MOVE + (pct == null ? ' text-faint' : pct >= 0 ? ' text-up' : ' text-down')
          }
        >
          {pct == null ? '···' : `${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(2)}%`}
        </span>
      </button>
      <span className={'flex items-center justify-center ' + COL_KILL}>
        <button
          type="button"
          aria-label={`stop following ${symbol}`}
          onClick={onRemove}
          disabled={disabled}
          /* Always visible rather than revealed on hover: hover does not
             exist on a phone, and a control you cannot reach on a phone is a
             control that is not there. */
          className="cursor-pointer rounded-full border-0 bg-transparent p-1 text-faint transition-colors hover:text-down focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none disabled:cursor-default disabled:opacity-40"
        >
          <X className="size-3.5" />
        </button>
      </span>
    </div>
  )
}

/* ── alerts ──────────────────────────────────────────────────────────────
   Armed alerts used to be READ here and SET in Settings, which meant the page
   showing you the price told you to go somewhere else to act on it. */

function Alerts({
  watch,
  alerts,
  quoteOf,
  disabled,
  onSave,
  focusSymbol
}: {
  watch: string[]
  alerts: AlertRule[]
  quoteOf: (s: string) => Quote | undefined
  disabled?: boolean
  onSave: (next: AlertRule[]) => Promise<void>
  /* Dashboard only: the Watchlist "Set alert" action names a symbol before
     navigating here. Legacy callers omit it and behave exactly as before. */
  focusSymbol?: string | null
}) {
  const [symbol, setSymbol] = useState('')
  const [direction, setDirection] = useState<AlertRule['direction']>('below')
  const [level, setLevel] = useState('')
  const [savingAlert, setSavingAlert] = useState(false)
  const busy = disabled || savingAlert

  useEffect(() => {
    if (focusSymbol) setSymbol(focusSymbol.toLowerCase())
  }, [focusSymbol])

  /* Nothing converts anywhere: a level is compared against the provider's own
     number, in the instrument's own currency. Naming it is the difference
     between "under 70" meaning S$70 and someone reading it as US$70. */
  const currencyOf = (s: string) => quoteOf(s)?.currency || ''
  const unit = currencyOf(symbol)

  return (
    <Card className="p-5">
      <div className="flex flex-col gap-1">
        {alerts.map((a, i) => {
          const q = quoteOf(a.symbol)
          const away =
            q?.price == null || (a.direction !== 'moves' && !(a.level > 0))
              ? null
              : a.direction === 'moves'
                ? `${Math.abs(q.change_pct ?? 0).toFixed(2)}% today`
                : `${(((q.price - a.level) / a.level) * 100).toFixed(1)}% away`
          return (
            <div
              key={`${a.symbol}-${a.direction}-${i}`}
              className="flex flex-wrap items-center gap-3 border-t border-line-2 py-2.5 first:border-t-0 first:pt-0"
            >
              <Bell className="size-4 shrink-0 text-amber" aria-hidden />
              <b className="font-mono text-[0.85rem] uppercase">{a.symbol}</b>
              <span className="text-[0.92rem] text-read">
                {a.direction === 'moves'
                  ? `moves more than ${a.level}% in a day`
                  : `goes ${a.direction} ${price(a.level, currencyOf(a.symbol))}`}
              </span>
              {a.to && <span className="text-muted">{a.to}</span>}
              {away && <span className="ml-auto text-[0.82rem] text-muted">{away}</span>}
              <Button
                size="sm"
                variant="ghost"
                className={away ? '' : 'ml-auto'}
                disabled={busy}
                onClick={async () => {
                  setSavingAlert(true)
                  try {
                    await onSave(alerts.filter((_, j) => j !== i))
                  } finally {
                    setSavingAlert(false)
                  }
                }}
              >
                <X />
                remove
              </Button>
            </div>
          )
        })}
        {!alerts.length && <Empty>No alerts set. An alert messages you once when it triggers.</Empty>}
      </div>

      <form
        className="mt-5 flex flex-wrap items-end gap-3 border-t border-line pt-5"
        onSubmit={(e) => {
          e.preventDefault()
          if (busy) return
          const sym = symbol.trim().toLowerCase()
          const n = parseFloat(level)
          if (!sym || Number.isNaN(n)) {
            toast('pick a symbol and a number', false)
            return
          }
          if (!(n > 0)) {
            toast('pick a level above zero', false)
            return
          }
          setSavingAlert(true)
          void onSave([
            ...alerts.filter((a) => a.to || a.symbol !== sym || a.direction !== direction),
            {
              ...alerts.find((a) => !a.to && a.symbol === sym && a.direction === direction),
              symbol: sym,
              direction,
              level: n
            }
          ])
            .then(() => setLevel(''))
            .finally(() => setSavingAlert(false))
        }}
      >
        <Field label="which one">
          {/* Grows with the watchlist, so it is the picker rather than a
              dropdown you scroll once the list is real. */}
          <Picker
            ariaLabel="which symbol"
            className="min-w-36"
            placeholder="pick…"
            searchPlaceholder="type a ticker…"
            value={symbol}
            onChange={setSymbol}
            options={watch.map((s) => ({ value: s, label: s.toUpperCase() }))}
          />
        </Field>
        <Field label="tell me when">
          <Segmented
            options={['below', 'above', 'moves'] as const}
            value={direction}
            onChange={(v) => setDirection(v)}
          />
        </Field>
        <Field
          htmlFor="market-alert-threshold"
          label={direction === 'moves' ? 'by more than (%)' : unit ? `the price is (${unit})` : 'the price is'}
        >
          <Input
            id="market-alert-threshold"
            type="number"
            step="any"
            value={level}
            placeholder={direction === 'moves' ? '5' : '100'}
            onChange={(e) => setLevel(e.target.value)}
            className="w-32"
          />
        </Field>
        <Button variant="primary" type="submit" className="mb-0.5" disabled={busy}>
          {savingAlert ? 'Arming…' : 'Arm alert'}
        </Button>
      </form>
    </Card>
  )
}

export default function MarketsPage() {
  const settings = useApi<Settings>('/api/settings')
  const dash = useApi<Dashboard>('/api/dashboard')

  const watch = useMemo(() => (settings.data?.markets?.watchlist ?? []).map(String), [settings.data])
  const quotes = useMemo(() => dash.data?.markets?.quotes ?? {}, [dash.data])
  const alerts = useMemo(() => (settings.data?.markets?.alerts ?? []) as AlertRule[], [settings.data])
  const regions = settings.data?.regions ?? []

  const [sym, setSym] = useState<string | null>(null)
  const [span, setSpan] = useState<Span>('1m')
  const [hist, setHist] = useState<History | null>(null)
  const [loadingChart, setLoadingChart] = useState(false)
  const [chartErr, setChartErr] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [adding, setAdding] = useState(false)
  const [mutating, setMutating] = useState(false)
  const [sort, setSort] = useState<Sort>(readSort)
  /* A stale POST (409) keeps its requested patch here until the owner picks a
     side. The banner never auto-reloads it away, and retry needs a fresh read
     plus an explicit confirm — otherwise one tab silently wins over another. */
  const [conflict, setConflict] = useState<MarketsConflict | null>(null)
  /* Quotes fetched on demand for a symbol added seconds ago, laid over the
     poller's snapshot until the next poll makes them the same thing. */
  const [live, setLive] = useState<Record<string, Quote>>({})

  useEffect(() => {
    try {
      localStorage.setItem(SORT_STORE, JSON.stringify(sort))
    } catch {
      /* private mode; the sort simply does not survive a reload */
    }
  }, [sort])

  const quoteOf = useCallback(
    (s: string) => {
      const k = s.toLowerCase()
      return live[k] ?? quotes[s] ?? quotes[k]
    },
    [live, quotes]
  )

  const nameOf = useCallback((s: string) => quoteOf(s)?.name || NAME_FALLBACK[s.toLowerCase()] || '', [quoteOf])

  const ordered = useMemo(() => {
    const rows = watch.map((s, i) => ({ s, i }))
    rows.sort((a, b) => {
      if (sort.key === 'symbol') return a.s.localeCompare(b.s)
      // Unpriced symbols sink to the bottom either way round: a blank is not
      // "cheapest", it is "not known yet". -Infinity did the opposite of what
      // the comment claimed — ascending put every unpriced row FIRST, and the
      // reverse() below then buried the priced ones. Sort the known values
      // among themselves and keep the unknown ones last in both directions.
      const rank = (v: number | undefined | null) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
      const cmp = (x: number | null, y: number | null) => {
        if (x === null && y === null) return 0
        if (x === null) return 1 // unknown: always after
        if (y === null) return -1
        return x - y
      }
      if (sort.key === 'price') return cmp(rank(quoteOf(a.s)?.price), rank(quoteOf(b.s)?.price))
      if (sort.key === 'change') return cmp(rank(quoteOf(a.s)?.change_pct), rank(quoteOf(b.s)?.change_pct))
      return a.i - b.i
    })
    if (sort.desc) {
      // Reverse only the rows that HAVE a value, so "unknown" does not become
      // "top of the list" the moment somebody clicks the header twice.
      const valued = sort.key === 'price' || sort.key === 'change'
      const known = rows.filter((r) => {
        if (!valued) return true
        const q = quoteOf(r.s)
        const v = sort.key === 'change' ? q?.change_pct : q?.price
        return typeof v === 'number' && Number.isFinite(v)
      })
      const unknown = rows.filter((r) => !known.includes(r))
      known.reverse()
      rows.length = 0
      rows.push(...known, ...unknown)
    }
    return rows.map((r) => r.s)
  }, [watch, sort, quoteOf])

  useEffect(() => {
    if (!sym && ordered.length) setSym(ordered[0])
  }, [ordered, sym])

  useEffect(() => {
    if (!sym) {
      setHist(null)
      setChartErr(null)
      setLoadingChart(false)
      return
    }
    let live = true
    setLoadingChart(true)
    setChartErr(null)
    get<History>(`/api/market/history?symbol=${encodeURIComponent(sym)}&span=${encodeURIComponent(span)}`)
      .then((d) => live && setHist(d))
      .catch((e: Error) => live && (setChartErr(e.message), setHist(null)))
      .finally(() => live && setLoadingChart(false))
    return () => {
      live = false
    }
  }, [sym, span])

  const quote = sym ? quoteOf(sym) : undefined

  const series = useMemo(
    () =>
      (hist?.points ?? []).map(([t, v]) => ({
        t,
        v,
        label: axisLabel(t, span)
      })),
    [hist, span]
  )

  /* The figure beside the price is the move ACROSS THE SPAN ON SCREEN.
     It used to be `quote.change_pct` — the quote's daily change — which does
     not depend on the span at all, so 1D, 1W, 1M, 1Y and 5Y all read the same
     0.43% while the chart under them plainly showed five different stories.

     1D is the exception, and it is the one that made the rail and this header
     disagree by a few tenths for the same instrument on the same day: the
     daily convention measures from YESTERDAY'S CLOSE, while an intraday
     series starts at the first tick after the open. The quote carries the
     conventional number, so on 1D the quote wins and every "today" on the
     page — hero, rail, header — is the same number. Every longer span has no
     previous close to speak of, so there the series is the only truth.

     `null` when there is nothing to measure, rather than falling back to the
     daily number: a percentage that silently means something other than the
     button you just pressed is the bug, not the fix. */
  const move = useMemo(() => {
    if (span === '1d' && quote?.change_pct != null) return { pct: quote.change_pct }
    if (series.length < 2) return null
    const base = series[0].v
    const last = series[series.length - 1].v
    if (!base) return null
    return { pct: ((last - base) / base) * 100 }
  }, [series, span, quote])

  const changeUp = (move?.pct ?? quote?.change_pct ?? 0) >= 0
  const c = useThemeColors({
    up: '--up',
    down: '--down',
    line: '--line',
    muted: '--muted',
    card2: '--card-2',
    lineStrong: '--line-strong',
    ink: '--ink'
  })
  const rising = series.length > 1 && series[series.length - 1].v >= series[0].v
  const stroke = rising ? c.up : c.down

  /* News comes from the deterministic RSS poller and the keyless providers
     behind brain.markets.news — never a model. It used to be flattened into
     one pile across every symbol, so the page you opened for BTC showed
     Nikkei headlines and you could not tell which story belonged to what. */
  const [scope, setScope] = useState<'one' | 'all'>('one')
  const [fresh, setFresh] = useState<Record<string, NewsItem[]>>({})

  /* Dashboard mode only. Legacy /app/markets.html renders the rail below
     unchanged; under DashboardContext the same host facts render as tabs.
     The tab is read from the logical path on every navigation so a cold load
     on /markets/alerts lands on Alerts. */
  const inDashboard = useContext(DashboardContext)
  const [tab, setTab] = useState<MarketTab>(() => parseMarketTab())
  const [alertFor, setAlertFor] = useState<string | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!inDashboard) return
    const route = () => setTab(parseMarketTab())
    window.addEventListener('popstate', route)
    window.addEventListener('hashchange', route)
    return () => {
      window.removeEventListener('popstate', route)
      window.removeEventListener('hashchange', route)
    }
  }, [inDashboard])

  function selectTab(next: MarketTab) {
    setTab(next)
    if (!inDashboard) return
    try {
      history.pushState(null, '', marketTabHref(next))
    } catch {
      /* private mode or non-pushState mount — the state still switched */
    }
    scrollSurface().scrollTo({ top: 0, behavior: 'instant' })
    panelRef.current?.focus({ preventScroll: true })
  }

  const news = useMemo(() => {
    const blobs = dash.data?.markets?.news ?? {}
    const pick = (key: string) => {
      const k = Object.keys(blobs).find((b) => b.toLowerCase() === key.toLowerCase())
      // `??` only falls through on null/undefined, so a live fetch that
      // legitimately returned ZERO stories masked the poller's stored blob and
      // wiped the headlines already on screen — "0 stories ✓" erasing a list
      // that was correct. An empty live result is not better information than
      // a stored one.
      const live = fresh[key.toLowerCase()]
      if (live && live.length) return live
      return k ? (blobs[k].items ?? []) : []
    }
    const wanted = scope === 'one' && sym ? [sym] : watch
    const rows: (NewsItem & { ts: number; symbol: string })[] = []
    let fetched = 0
    for (const s of wanted) {
      const k = Object.keys(blobs).find((b) => b.toLowerCase() === s.toLowerCase())
      if (k && blobs[k].ts) fetched = Math.max(fetched, blobs[k].ts ?? 0)
      for (const it of pick(s))
        rows.push({
          ...it,
          symbol: s.toUpperCase(),
          ts: it.ts ?? (Date.parse(it.published ?? '') || 0) / 1000
        })
    }
    // One story carried by two providers is one story.
    const seen = new Set<string>()
    const items = rows
      .sort((a, b) => b.ts - a.ts)
      .filter((r) => {
        const key = (r.title ?? '')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, ' ')
          .trim()
          .slice(0, 48)
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      .slice(0, 24)
    return { items, fetched }
  }, [dash.data, fresh, scope, sym, watch])

  async function saveMarkets(patch: MarketsPatch) {
    if (conflict) throw new Error('Settings changed elsewhere — resolve the conflict below before saving again')
    if (!settings.data) throw new Error('settings are still loading — try again in a moment')
    if (settings.error) throw new Error(String(settings.error))
    setMutating(true)
    try {
      await post('/api/settings/markets', {
        ...patch,
        expected: Object.fromEntries(
          Object.keys(patch).map((key) => [
            key,
            (settings.data?.markets as Record<string, unknown> | undefined)?.[key] ?? null
          ])
        )
      })
      await settings.reload()
    } catch (e) {
      if (isMarketsConflictError(e)) {
        const message = e instanceof Error ? e.message : 'Market settings changed. Reload before saving.'
        setConflict({ patch, message, fresh: null, checking: false, confirmed: false, retrying: false, error: null })
      }
      throw e
    } finally {
      setMutating(false)
    }
  }

  async function checkConflictFresh() {
    if (!conflict || conflict.checking) return
    setConflict((c) => (c ? { ...c, checking: true, error: null } : c))
    try {
      const freshSettings = await get<Settings>('/api/settings')
      const freshMarkets = freshSettings?.markets ?? null
      await settings.reload()
      setConflict((c) => (c ? { ...c, fresh: freshMarkets, checking: false } : c))
    } catch (e) {
      setConflict((c) => (c ? { ...c, checking: false, error: (e as Error).message } : c))
    }
  }

  async function retryConflict() {
    if (!conflict || conflict.retrying || conflict.checking || !conflict.fresh || !conflict.confirmed) return
    const patch = conflict.patch
    setConflict((c) => (c ? { ...c, retrying: true, error: null } : c))
    try {
      const keys = Object.keys(patch)
      const expected = Object.fromEntries(
        keys.map((key) => [key, (conflict.fresh as Record<string, unknown> | undefined)?.[key] ?? null])
      )
      await post('/api/settings/markets', { ...patch, expected })
      await settings.reload()
      setConflict(null)
      toast('saved ✓')
      void dash.reload()
    } catch (e) {
      const message = (e as Error).message
      if (isMarketsConflictError(e)) {
        try {
          const freshSettings = await get<Settings>('/api/settings')
          await settings.reload()
          setConflict((c) =>
            c
              ? {
                  ...c,
                  fresh: freshSettings?.markets ?? null,
                  retrying: false,
                  confirmed: false,
                  message,
                  error: 'Still changed elsewhere — compare again, then retry.'
                }
              : c
          )
        } catch {
          setConflict((c) => (c ? { ...c, retrying: false, message, error: message } : c))
        }
      } else {
        setConflict((c) => (c ? { ...c, retrying: false, error: message } : c))
      }
      toast(message, false)
    }
  }

  function discardConflict() {
    setConflict(null)
    void settings.reload()
  }

  function confirmConflict(v: boolean) {
    setConflict((c) => (c ? { ...c, confirmed: v } : c))
  }

  /* Append, always. The stored list is insertion order and the rail sorts a
     copy of it — so "newest first" is a header press, not a rewrite of what
     she reads back when asked what you follow. */
  async function addSymbol(s: string) {
    if (!settings.data || settings.error) {
      toast('settings are still loading — try again in a moment', false)
      return
    }
    if (mutating) {
      toast('still saving — try again in a moment', false)
      return
    }
    if (watch.includes(s)) {
      setSym(s)
      setAdding(false)
      toast(`already following ${s.toUpperCase()}`)
      return
    }
    try {
      await saveMarkets({ watchlist: [...watch, s] })
      setSym(s)
      setAdding(false)
      toast(`${s.toUpperCase()} added ✓`)
    } catch (e) {
      toast((e as Error).message, false)
      return
    }
    /* Price it now. The poller runs every five minutes, so without this the
       row you just created sits blank for up to five of them. */
    try {
      const r = await post<{ quotes: Record<string, Quote> }>('/api/market/quote', {
        symbols: [s]
      })
      const got = Object.fromEntries(Object.entries(r.quotes ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
      setLive((was) => ({ ...was, ...got }))
    } catch {
      /* The row shows ··· until the poller comes round. Not worth a toast:
         the symbol IS added, which is what was asked for. */
    }
  }

  async function dropSymbol(s: string) {
    if (!settings.data || settings.error) {
      toast('settings are still loading — try again in a moment', false)
      return
    }
    if (mutating) return
    try {
      await saveMarkets({ watchlist: watch.filter((x) => x !== s) })
      if (sym === s) {
        /* Name the replacement HERE rather than clearing the selection and
           letting the effect refill it. `settings.reload()` is a round trip,
           so for a moment `ordered` still contains the symbol just deleted —
           the effect saw that stale list and re-selected the very thing that
           had been removed, leaving its name in the hero and its chart on
           screen with no row in the rail. Taking the neighbour from the sort
           the reader is actually looking at also beats falling back to
           whatever the stored list happens to start with. */
        const next = ordered.filter((x) => x !== s)[0] ?? null
        setSym(next)
        if (!next) {
          setHist(null)
          setChartErr(null)
        }
      }
      // A stale price for something no longer followed would be handed
      // straight back if it were ever re-added.
      setLive(({ [s.toLowerCase()]: _gone, ...rest }) => rest)
      toast(`stopped following ${s.toUpperCase()} ✓`)
    } catch (e) {
      toast((e as Error).message, false)
    }
  }

  async function refreshNews() {
    if (!sym) return
    setRefreshing(true)
    try {
      // Straight at the providers for the instrument on screen. Starting the
      // five-minute poller instead was the old behaviour, and it skips any
      // symbol fetched in the last twenty minutes — so "refresh" usually did
      // nothing and read as broken.
      const r = await post<{ items: NewsItem[] }>('/api/market/news', {
        symbol: sym,
        limit: 12
      })
      setFresh((was) => ({ ...was, [sym.toLowerCase()]: r.items ?? [] }))
      toast(`${(r.items ?? []).length} stories ✓`)
    } catch (e) {
      toast((e as Error).message, false)
    } finally {
      setRefreshing(false)
    }
  }

  return (
    /* Dashboard mode: the same host facts as tabs. Legacy below is untouched. */
    inDashboard ? (
      <DashboardMarkets
        settings={settings}
        dash={dash}
        watch={watch}
        alerts={alerts}
        regions={regions}
        sym={sym}
        setSym={setSym}
        span={span}
        setSpan={setSpan}
        hist={hist}
        loadingChart={loadingChart}
        chartErr={chartErr}
        refreshing={refreshing}
        adding={adding}
        setAdding={setAdding}
        mutating={mutating}
        sort={sort}
        setSort={setSort}
        quoteOf={quoteOf}
        nameOf={nameOf}
        ordered={ordered}
        quote={quote}
        series={series}
        move={move}
        changeUp={changeUp}
        stroke={stroke}
        colors={c}
        scope={scope}
        setScope={setScope}
        news={news}
        tab={tab}
        selectTab={selectTab}
        alertFor={alertFor}
        setAlertFor={setAlertFor}
        panelRef={panelRef}
        saveMarkets={saveMarkets}
        addSymbol={addSymbol}
        dropSymbol={dropSymbol}
        refreshNews={refreshNews}
        conflict={conflict}
        onCheckFresh={() => void checkConflictFresh()}
        onConfirmConflict={confirmConflict}
        onRetryConflict={() => void retryConflict()}
        onDiscardConflict={discardConflict}
      />
    ) : (
      <Shell
        page="markets"
        title="Markets"
        wide
        /* The instrument you are looking at, said out loud. A page titled
         "Markets" tells a reader nothing they did not know when they clicked
         Markets; the level and the move are what they came for. */
        hero={
          quote
            ? [
                { n: sym?.toUpperCase() },
                { t: ' is at ' },
                { n: price(quote.price, quote.currency) },
                ...(quote.change_pct != null
                  ? ([
                      { t: quote.change_pct >= 0 ? ', up ' : ', down ' },
                      { n: `${Math.abs(quote.change_pct).toFixed(2)}%` },
                      { t: ' today' }
                    ] as const)
                  : []),
                ...(alerts.length ? ([{ t: '. ' }, { n: String(alerts.length) }, { t: ' armed' }] as const) : [])
              ]
            : watch.length
              ? [{ n: String(watch.length) }, { t: ' instruments tracked' }]
              : [{ t: 'Nothing followed yet' }]
        }
      >
        <Toaster />
        {conflict && (
          <div className="mb-6">
            <MarketsConflictPanel
              conflict={conflict}
              stale={settings.data?.markets ?? null}
              onCheckFresh={() => void checkConflictFresh()}
              onConfirm={confirmConflict}
              onRetry={() => void retryConflict()}
              onDiscard={discardConflict}
            />
          </div>
        )}

        <div className="grid items-start gap-x-8 gap-y-10 xl:grid-cols-[22rem_minmax(0,1fr)]">
          {/* ── rail ──────────────────────────────────────────────────── */}
          <aside className="xl:sticky xl:top-8">
            <Section
              title="Watchlist"
              action={
                <Button
                  size="sm"
                  variant={adding ? 'ghost' : 'primary'}
                  aria-expanded={adding}
                  onClick={() => setAdding((v) => !v)}
                >
                  {adding ? <X /> : <Plus />}
                  {adding ? 'close' : 'Add'}
                </Button>
              }
            >
              <Card className="overflow-hidden p-0">
                {adding && (
                  <div className="border-b border-line bg-sunk p-4">
                    <SymbolSearch
                      regions={regions}
                      autoFocus
                      label="add an instrument"
                      hint="A company, an index or a ticker — DBS, Nikkei, Toyota, BTC. Local listings work: Public Bank finds 1295.KL."
                      onPick={(s) => void addSymbol(s)}
                    />
                  </div>
                )}

                {watch.length > 0 && (
                  /* This row mirrors WatchRow's box model exactly — same
                   flex-1 name cell, same column widths, same padding, same
                   trailing slot for the × — so every label sits over its own
                   numbers. A header four pixels off its column undoes the one
                   thing a list buys you over a wall of cards. */
                  <div className="flex items-center border-b border-line bg-sunk">
                    <div className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-1 pl-3">
                      <span className="flex min-w-0 flex-1 items-center gap-0.5">
                        <SortButton label="Added" target="added" sort={sort} onSort={setSort} className="px-1" />
                        <SortButton label="A–Z" target="symbol" sort={sort} onSort={setSort} className="px-1" />
                      </span>
                      <SortButton
                        label="Price"
                        target="price"
                        sort={sort}
                        onSort={setSort}
                        className={'justify-end ' + COL_PRICE}
                      />
                      <SortButton
                        label="Move"
                        target="change"
                        sort={sort}
                        onSort={setSort}
                        className={'justify-end ' + COL_MOVE}
                      />
                    </div>
                    <span className={COL_KILL} aria-hidden />
                  </div>
                )}

                {ordered.map((s) => (
                  <WatchRow
                    key={s}
                    symbol={s.toUpperCase()}
                    name={nameOf(s)}
                    quote={quoteOf(s)}
                    selected={s.toLowerCase() === String(sym).toLowerCase()}
                    disabled={mutating || !settings.data || !!settings.error || !!conflict}
                    onSelect={() => setSym(s)}
                    onRemove={() => void dropSymbol(s)}
                  />
                ))}

                {/* An empty state that teaches: the thing to do next is one
                  button away and named, rather than "add symbols in Settings
                  → Markets" — a sentence that sent you to another page. */}
                {!watch.length && !adding && (
                  <div className="p-5">
                    <CardHead title="Nothing followed yet" />
                    <p className="mt-2 mb-3 text-[0.92rem] text-muted">
                      Add a company, an index or a coin and its price, chart and headlines appear here. She reads this
                      same list when you ask her how the market is doing.
                    </p>
                    <Button variant="primary" size="sm" onClick={() => setAdding(true)}>
                      <Plus />
                      Add the first one
                    </Button>
                  </div>
                )}
              </Card>

              {watch.length > 1 && (
                <p className="mt-2 mb-0 text-[0.78rem] text-faint">
                  {watch.length} followed · sorted by {sort.key === 'symbol' ? 'name' : sort.key},{' '}
                  {SORT_HINT[sort.key][sort.desc ? 1 : 0]}
                </p>
              )}
            </Section>
          </aside>

          {/* ── chart, alerts, news ───────────────────────────────────── */}
          <div className="min-w-0">
            <Section title={sym ? `${sym.toUpperCase()} — ${nameOf(sym)}` : 'Chart'}>
              <Card className="p-5">
                <div className="flex flex-wrap items-baseline gap-x-5 gap-y-2">
                  <span className="tnum font-serif text-[2rem] leading-none">
                    {price(quote?.price ?? hist?.price, quote?.currency ?? hist?.currency)}
                  </span>
                  {quote?.exchange && <span className="text-[0.82rem] text-faint">{quote.exchange}</span>}
                  {move != null && (
                    <span
                      className={
                        'inline-flex items-baseline gap-1.5 font-semibold ' + (changeUp ? 'text-up' : 'text-down')
                      }
                    >
                      <span className="inline-flex items-center gap-1.5">
                        {changeUp ? (
                          <TrendingUp className="size-4" aria-hidden />
                        ) : (
                          <TrendingDown className="size-4" aria-hidden />
                        )}
                        {Math.abs(move.pct).toFixed(2)}%
                      </span>
                      {/* Which window this is a percentage OF. Without it the
                        number is just as ambiguous as when it never moved. */}
                      <span className="text-[0.78rem] font-normal text-muted">
                        {span === '1d' ? 'today' : `over ${SPAN_LABEL[span]}`}
                      </span>
                    </span>
                  )}
                  <span className="ml-auto flex gap-1" role="group" aria-label="chart range">
                    {SPANS.map((s) => (
                      <button
                        key={s}
                        type="button"
                        aria-pressed={s === span}
                        onClick={() => setSpan(s)}
                        className={
                          'min-h-9 min-w-12 cursor-pointer rounded-[8px] border font-mono text-[0.72rem] uppercase tracking-[0.06em] transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none ' +
                          (s === span
                            ? 'border-accent bg-accent-soft text-accent'
                            : 'border-line bg-transparent text-muted hover:text-ink')
                        }
                      >
                        {s}
                      </button>
                    ))}
                  </span>
                </div>

                <div className="relative mt-4 h-[clamp(240px,45vh,420px)]">
                  {/* A skeleton on the first load and a dimmed chart on every
                    span change after it: a spinner over a chart you already
                    have throws away the shape you were reading. */}
                  {loadingChart && !series.length && (
                    <div className="absolute inset-0 z-10 animate-pulse rounded-card bg-card-2" />
                  )}
                  {chartErr && (
                    <div
                      role="status"
                      className="absolute inset-0 z-10 grid place-items-center text-[0.92rem] text-down"
                    >
                      Chart unavailable: {chartErr}
                    </div>
                  )}
                  <div
                    className={
                      'h-full transition-opacity duration-200 ' +
                      (loadingChart && series.length ? 'opacity-40' : 'opacity-100')
                    }
                  >
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={series} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                        <defs>
                          <linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor={stroke} stopOpacity={0.28} />
                            <stop offset="100%" stopColor={stroke} stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid vertical={false} stroke={c.line} />
                        <XAxis
                          dataKey="label"
                          tickLine={false}
                          axisLine={false}
                          minTickGap={60}
                          tick={{ fill: c.muted, fontSize: 11 }}
                        />
                        <YAxis
                          domain={['auto', 'auto']}
                          width={62}
                          tickLine={false}
                          axisLine={false}
                          tick={{ fill: c.muted, fontSize: 11 }}
                          tickFormatter={(v: number) => price(v)}
                        />
                        <Tooltip
                          cursor={{
                            stroke: c.lineStrong,
                            strokeDasharray: '3 3'
                          }}
                          content={({ active, payload }) => {
                            const row = active ? payload?.[0]?.payload : null
                            if (!row) return null
                            return (
                              <ChartTip t={row.t} v={row.v} span={span} currency={hist?.currency} first={series[0]} />
                            )
                          }}
                        />
                        <Area
                          type="monotone"
                          dataKey="v"
                          stroke={stroke}
                          strokeWidth={2}
                          fill="url(#fill)"
                          dot={false}
                          isAnimationActive={false}
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                {series.length > 0 && (
                  <p className="mt-2 mb-0 text-[0.78rem] text-muted">
                    {series.length} points
                    {hist?.currency ? ` · ${hist.currency}` : ''}
                  </p>
                )}
              </Card>
            </Section>

            <Section title="Alerts">
              <Alerts
                watch={watch}
                alerts={alerts}
                quoteOf={quoteOf}
                disabled={!settings.data || !!settings.error || mutating || !!conflict}
                onSave={async (next) => {
                  if (!settings.data || settings.error) {
                    toast('settings are still loading — try again in a moment', false)
                    throw new Error('settings not ready')
                  }
                  try {
                    await saveMarkets({ alerts: next })
                    toast('saved ✓')
                  } catch (e) {
                    toast((e as Error).message, false)
                    throw e
                  }
                }}
              />
            </Section>

            <Section
              title="News"
              action={
                <span className="flex flex-wrap items-center gap-3">
                  {/* Which pile you are reading. Defaulting to everything is what
                    made a BTC page show Nikkei headlines with no way to tell. */}
                  <span className="flex overflow-hidden rounded-full border border-line">
                    {(['one', 'all'] as const).map((v) => (
                      <button
                        key={v}
                        type="button"
                        onClick={() => setScope(v)}
                        aria-pressed={scope === v}
                        className={
                          'cursor-pointer border-0 px-3 py-1 text-[0.78rem] focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none ' +
                          (scope === v ? 'bg-accent-soft text-accent' : 'bg-transparent text-muted')
                        }
                      >
                        {v === 'one' ? (sym?.toUpperCase() ?? 'this one') : 'everything'}
                      </button>
                    ))}
                  </span>
                  <span className="text-[0.82rem] text-muted">
                    {news.fetched ? `fetched ${ago(news.fetched)}` : ''}
                  </span>
                  <Button size="sm" variant="ghost" disabled={refreshing || !sym} onClick={() => void refreshNews()}>
                    {refreshing ? <Spinner /> : <RefreshCw />}
                    {refreshing ? 'fetching…' : 'refresh'}
                  </Button>
                </span>
              }
            >
              {news.items.length > 0 ? (
                <Card className="p-0">
                  {news.items.map((it, i) => {
                    const src = (it.source ?? '').trim() || it.domain || 'unattributed'
                    const when = it.ts ? new Date(it.ts * 1000) : null
                    const prev = i > 0 ? news.items[i - 1] : null
                    const day = when ? when.toDateString() : ''
                    const prevDay = prev?.ts ? new Date(prev.ts * 1000).toDateString() : ''
                    const newDay = day && day !== prevDay
                    return (
                      <div key={`${it.title}-${i}`}>
                        {/* Grouped by day, because "which day" is the first thing a
                          reader wants of a headline and "14h ago" hides it. */}
                        {newDay && (
                          <div className="border-t border-line-2 bg-sunk px-5 py-1.5 font-mono text-[0.68rem] tracking-[0.1em] text-muted uppercase first:border-t-0">
                            {dayLabel(when as Date)}
                          </div>
                        )}
                        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-line-2 px-5 py-3">
                          <a
                            href={it.link}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="min-w-0 flex-1 basis-full font-serif text-[1.05rem] leading-snug text-ink no-underline hover:text-accent sm:basis-auto"
                          >
                            {it.title || '(untitled)'}
                          </a>
                          {/* The publisher, always. The RSS <source> element was
                            parsed and dropped, so every story read as if it came
                            from nowhere — and "is this credible?" had no answer
                            on the page at all. */}
                          <span className="shrink-0 font-mono text-[0.72rem] tracking-[0.06em] text-read uppercase">
                            {src}
                          </span>
                          {(it.also ?? 0) > 0 && (
                            <span className="shrink-0 text-[0.75rem] text-faint">+{it.also} more outlets</span>
                          )}
                          {scope === 'all' && (
                            <span className="shrink-0 font-mono text-[0.7rem] text-muted">{it.symbol}</span>
                          )}
                          <span
                            className="shrink-0 text-[0.78rem] text-muted"
                            title={when ? when.toLocaleString() : 'no date on this story'}
                          >
                            {it.ts ? ago(it.ts) : 'undated'}
                          </span>
                        </div>
                      </div>
                    )
                  })}
                </Card>
              ) : (
                <Card className="p-5">
                  <CardHead title={sym ? `Nothing for ${sym.toUpperCase()} this week` : 'No stories yet'} />
                  <p className="mt-2 mb-0 max-w-prose text-muted">
                    Stories older than a week are dropped rather than shown as news. Headlines come from TickerTick,
                    Yahoo Finance and Google News — all keyless, none billed — refreshed by the five-minute poller;
                    “refresh” goes and asks them right now.
                  </p>
                </Card>
              )}
            </Section>
          </div>
        </div>
      </Shell>
    )
  )
}

/* ── dashboard mode ─────────────────────────────────────────────────────
   Same host facts as the legacy rail, laid out for the dashboard shell:
   tabs across the top right, a 60/40 Watchlist split, Alerts with its
   delivery wiring, and News on its own tab. Every number comes from
   /api/dashboard or /api/market/history; nothing is invented. Writes go
   through the same /api/settings/markets save with the expected stamp, so
   a stale edit is refused and reloaded rather than silently winning. */

interface DashProps {
  settings: Async<Settings>
  dash: Async<Dashboard>
  watch: string[]
  alerts: AlertRule[]
  regions: { value: string; label: string }[]
  sym: string | null
  setSym: (s: string | null) => void
  span: Span
  setSpan: (s: Span) => void
  hist: History | null
  loadingChart: boolean
  chartErr: string | null
  refreshing: boolean
  adding: boolean
  setAdding: (v: boolean | ((v: boolean) => boolean)) => void
  mutating: boolean
  sort: Sort
  setSort: (s: Sort) => void
  quoteOf: (s: string) => Quote | undefined
  nameOf: (s: string) => string
  ordered: string[]
  quote: Quote | undefined
  series: { t: number; v: number; label: string }[]
  move: { pct: number } | null
  changeUp: boolean
  stroke: string
  colors: Record<string, string>
  scope: 'one' | 'all'
  setScope: (s: 'one' | 'all') => void
  news: { items: (NewsItem & { ts: number; symbol: string })[]; fetched: number }
  tab: MarketTab
  selectTab: (t: MarketTab) => void
  alertFor: string | null
  setAlertFor: (s: string | null) => void
  panelRef: { current: HTMLDivElement | null }
  saveMarkets: (patch: MarketsPatch) => Promise<void>
  addSymbol: (s: string) => Promise<void>
  dropSymbol: (s: string) => Promise<void>
  refreshNews: () => Promise<void>
  conflict: MarketsConflict | null
  onCheckFresh: () => void
  onConfirmConflict: (v: boolean) => void
  onRetryConflict: () => void
  onDiscardConflict: () => void
}

function DashboardMarkets(props: DashProps) {
  const { settings, tab, selectTab, panelRef, conflict } = props
  const activeLabel = MARKET_TABS.find((t) => t.key === tab)?.label ?? 'Watchlist'
  const staleMarkets = settings.data?.markets ?? null
  return (
    <div className="mkd">
      <Toaster />
      <WorkspaceTools>
        <nav aria-label="Markets views" className="workspace-tabs">
          {MARKET_TABS.map((t) => {
            const on = t.key === tab
            return (
              <a
                key={t.key}
                href={marketTabHref(t.key)}
                aria-current={on ? 'page' : undefined}
                onClick={(e) => {
                  e.preventDefault()
                  if (!on) selectTab(t.key)
                }}
              >
                {t.label}
              </a>
            )
          })}
        </nav>
      </WorkspaceTools>
      {conflict ? (
        <MarketsConflictPanel
          conflict={conflict}
          stale={staleMarkets}
          onCheckFresh={props.onCheckFresh}
          onConfirm={props.onConfirmConflict}
          onRetry={props.onRetryConflict}
          onDiscard={props.onDiscardConflict}
        />
      ) : (
        settings.error &&
        isConflictMessage(settings.error) && (
          <p role="alert" className="mkd-conflict">
            Settings changed elsewhere: {settings.error}{' '}
            <button type="button" className="mkd-link" onClick={() => void settings.reload()}>
              Reload and compare
            </button>
          </p>
        )
      )}
      <div ref={panelRef} tabIndex={-1} className="mkd-panel" role="region" aria-label={activeLabel}>
        {tab === 'watchlist' && <DashWatchlist {...props} />}
        {tab === 'alerts' && <DashAlertsDelivery {...props} />}
        {tab === 'news' && <DashNews {...props} />}
      </div>
    </div>
  )
}

/* Watchlist tab: two cards, 60/40. Left adds, sorts and lists; right shows
   the selected instrument's actual quote, range chart and actions. */
function DashWatchlist(props: DashProps) {
  const {
    settings,
    dash,
    watch,
    regions,
    sym,
    setSym,
    span,
    setSpan,
    hist,
    loadingChart,
    chartErr,
    series,
    move,
    changeUp,
    stroke,
    colors,
    sort,
    setSort,
    quoteOf,
    nameOf,
    ordered,
    quote,
    mutating,
    selectTab,
    setAlertFor,
    setScope,
    addSymbol,
    dropSymbol
  } = props
  const listRef = useRef<HTMLDivElement>(null)
  const settingsBusy = mutating || !settings.data || !!settings.error || !!props.conflict
  const sortValue = `${sort.key}:${sort.desc ? 'desc' : 'asc'}`

  function moveSelection(delta: number) {
    if (!ordered.length) return
    const at = sym ? ordered.findIndex((s) => s.toLowerCase() === sym.toLowerCase()) : -1
    const next = ordered[(at + delta + ordered.length) % ordered.length] ?? null
    if (next) setSym(next)
  }

  return (
    <section aria-label="Watchlist" className="mkd-grid">
      <div className="mkd-card">
        <h2 className="mkd-h">Watchlist</h2>
        <details className="mkd-add">
          <summary>Add Instrument</summary>
          <SymbolSearch regions={regions} onPick={(symbol) => void addSymbol(symbol)} />
        </details>
        <div className="mkd-row">
          <label className="mkd-label" htmlFor="mkd-sort">
            Sort by
          </label>
          <FormSelect
            id="mkd-sort"
            label="Sort by"
            value={sortValue}
            options={[
              { value: 'added:desc', label: 'Newest first' },
              { value: 'added:asc', label: 'Oldest first' },
              { value: 'symbol:asc', label: 'Name, A to Z' },
              { value: 'symbol:desc', label: 'Name, Z to A' },
              { value: 'price:desc', label: 'Dearest first' },
              { value: 'price:asc', label: 'Cheapest first' },
              { value: 'change:desc', label: 'Biggest risers first' },
              { value: 'change:asc', label: 'Biggest fallers first' }
            ]}
            onChange={(value) => {
              const [key, direction] = value.split(':')
              setSort({ key: key as SortKey, desc: direction === 'desc' })
            }}
          />
        </div>
        {settings.loading && !settings.data ? (
          <Loading>Loading watchlist…</Loading>
        ) : settings.error ? (
          <p role="alert" className="mkd-error">
            Watchlist unavailable: {settings.error}{' '}
            <button type="button" className="mkd-link" onClick={() => void settings.reload()}>
              Retry
            </button>
          </p>
        ) : !watch.length ? (
          <p className="mkd-muted">
            Nothing followed yet. Add a company, an index or a coin above and its price, chart and headlines appear
            here.
          </p>
        ) : (
          <div
            ref={listRef}
            role="listbox"
            aria-label="Followed instruments"
            aria-activedescendant={sym ? `mkd-opt-${sym.toLowerCase()}` : undefined}
            tabIndex={0}
            className="mkd-list"
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                moveSelection(1)
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                moveSelection(-1)
              } else if (e.key === 'Home') {
                e.preventDefault()
                if (ordered[0]) setSym(ordered[0])
              } else if (e.key === 'End') {
                e.preventDefault()
                if (ordered[ordered.length - 1]) setSym(ordered[ordered.length - 1])
              }
            }}
          >
            {ordered.map((s) => {
              const q = quoteOf(s)
              const pct = q?.change_pct
              const on = sym?.toLowerCase() === s.toLowerCase()
              return (
                <button
                  key={s}
                  id={`mkd-opt-${s.toLowerCase()}`}
                  type="button"
                  role="option"
                  aria-selected={on}
                  onClick={() => setSym(s)}
                  className={'mkd-opt' + (on ? ' mkd-opt-on' : '')}
                >
                  <span className="mkd-opt-main">
                    <b className="mkd-sym">{s.toUpperCase()}</b>
                    <span className="mkd-name">{nameOf(s) || '—'}</span>
                  </span>
                  <span className="mkd-nums">
                    <span className="mkd-price">
                      {q?.price != null ? price(q.price, q.currency) : <span className="mkd-muted">···</span>}
                    </span>
                    <span className={'mkd-pct ' + (pct == null ? 'mkd-muted' : pct >= 0 ? 'mkd-up' : 'mkd-down')}>
                      {pct == null ? '···' : `${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(2)}%`}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
        )}
        {dash.error && (
          <p role="status" className="mkd-muted">
            Quotes unavailable right now — prices may be stale.
          </p>
        )}
      </div>

      <div className="mkd-card">
        {!sym ? (
          <>
            <h2 className="mkd-h">Instrument</h2>
            <p className="mkd-muted">Pick an instrument on the left to see its quote and chart.</p>
          </>
        ) : (
          <>
            <h2 className="mkd-h">
              {sym.toUpperCase()}
              {nameOf(sym) ? <span className="mkd-h-sub"> — {nameOf(sym)}</span> : null}
            </h2>
            <p className="mkd-quote">
              <b className="mkd-quote-price">{price(quote?.price ?? hist?.price, quote?.currency ?? hist?.currency)}</b>
              {quote?.currency && <span className="mkd-muted"> {quote.currency}</span>}
              {quote?.exchange && <span className="mkd-muted"> · {quote.exchange}</span>}
              {move != null && (
                <span className={changeUp ? 'mkd-up' : 'mkd-down'}>
                  {' '}
                  {changeUp ? '+' : '−'}
                  {Math.abs(move.pct).toFixed(2)}% {span === '1d' ? 'today' : `over ${SPAN_LABEL[span]}`}
                </span>
              )}
            </p>
            {!quote && !hist?.price && props.dash.loading && !props.dash.data && <Loading>Loading quote…</Loading>}
            {!quote && !hist?.price && !props.dash.loading && (
              <p role="status" className="mkd-muted">
                {props.dash.error ? 'Quote unavailable.' : 'No quote reported yet.'}
              </p>
            )}
            <div className="mkd-row" role="group" aria-label="Chart range">
              {SPANS.map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={s === span}
                  onClick={() => setSpan(s)}
                  className={'mkd-range' + (s === span ? ' mkd-range-on' : '')}
                >
                  {s}
                </button>
              ))}
            </div>
            <div className="mkd-chart">
              {loadingChart && !series.length ? (
                <Loading>Loading chart…</Loading>
              ) : chartErr ? (
                <p role="status" className="mkd-error">
                  Chart unavailable: {chartErr}
                </p>
              ) : !series.length ? (
                <p className="mkd-muted">No history for this range.</p>
              ) : (
                <ResponsiveContainer width="100%" height={240}>
                  <AreaChart data={series} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                    <defs>
                      <linearGradient id="mkd-fill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={stroke} stopOpacity={0.28} />
                        <stop offset="100%" stopColor={stroke} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid vertical={false} stroke={colors.line} />
                    <XAxis
                      dataKey="label"
                      tickLine={false}
                      axisLine={false}
                      minTickGap={60}
                      tick={{ fill: colors.muted, fontSize: 11 }}
                    />
                    <YAxis
                      domain={['auto', 'auto']}
                      width={62}
                      tickLine={false}
                      axisLine={false}
                      tick={{ fill: colors.muted, fontSize: 11 }}
                      tickFormatter={(v: number) => price(v)}
                    />
                    <Tooltip
                      cursor={{ stroke: colors.lineStrong, strokeDasharray: '3 3' }}
                      content={({ active, payload }) => {
                        const row = active ? payload?.[0]?.payload : null
                        if (!row) return null
                        return <ChartTip t={row.t} v={row.v} span={span} currency={hist?.currency} first={series[0]} />
                      }}
                    />
                    <Area
                      type="monotone"
                      dataKey="v"
                      stroke={stroke}
                      strokeWidth={2}
                      fill="url(#mkd-fill)"
                      dot={false}
                      isAnimationActive={false}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>
            {series.length > 0 && (
              <p className="mkd-muted">
                {series.length} points{hist?.currency ? ` · ${hist.currency}` : ''}
              </p>
            )}
            <div className="mkd-actions">
              <Button
                size="sm"
                variant="primary"
                disabled={settingsBusy}
                onClick={() => {
                  setAlertFor(sym.toLowerCase())
                  selectTab('alerts')
                }}
              >
                <Bell />
                Set alert
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setScope('one')
                  selectTab('news')
                }}
              >
                Instrument news
              </Button>
              <ConfirmAction
                key={`unfollow-${sym}`}
                size="sm"
                label="Unfollow"
                confirmLabel="Unfollow"
                question={`Stop following ${sym.toUpperCase()}?`}
                warning="It leaves every chat list and armed alert untouched. This only removes it from the default list."
                disabled={settingsBusy}
                onConfirm={() => dropSymbol(sym)}
              />
            </div>
          </>
        )}
      </div>
    </section>
  )
}

/* Alerts and Delivery tab: armed alerts plus where they go and the hourly
   digest — the wiring nobody makes while reading a chart. The per-chat
   lists live here too, reusing the same host endpoints as Settings. */
function DashAlertsDelivery(props: DashProps) {
  const { settings, dash, watch, alerts, quoteOf, mutating, alertFor, saveMarkets } = props
  const chats = useApi<{ chats: Chat[] }>('/api/chats')
  const rows = chats.data?.chats ?? []
  const target = String(settings.data?.markets?.default_target ?? '')
  const digest = settings.data?.markets?.news_digest ?? {}
  const digestOn = Boolean((digest as { enabled?: boolean }).enabled)
  const digestTo = ((digest as { to?: unknown[] }).to ?? []).map(String)
  const rawHours = (digest as { hours?: unknown }).hours
  const digestHours = Array.isArray(rawHours) ? rawHours.map(Number).filter((n) => Number.isFinite(n)) : []
  const disabled = mutating || !settings.data || !!settings.error || !!props.conflict

  async function saveDelivery(patch: {
    default_target?: string
    news_digest?: { enabled: boolean; to: string[]; hours?: number[] }
  }) {
    if (!settings.data || settings.error) {
      toast('settings are still loading — try again in a moment', false)
      return
    }
    if (props.conflict) {
      toast('Settings changed elsewhere — resolve the conflict above before saving again', false)
      return
    }
    try {
      await saveMarkets(patch)
      toast('saved ✓')
      void dash.reload()
    } catch (e) {
      toast((e as Error).message, false)
    }
  }

  return (
    <div className="mkd-stack">
      <section aria-label="Armed alerts" className="mkd-card">
        <h2 className="mkd-h">Armed alerts</h2>
        {settings.loading && !settings.data ? (
          <Loading>Loading alerts…</Loading>
        ) : settings.error ? (
          <p role="alert" className="mkd-error">
            Alerts unavailable: {settings.error}{' '}
            <button type="button" className="mkd-link" onClick={() => void settings.reload()}>
              Retry
            </button>
          </p>
        ) : (
          <Alerts
            watch={watch}
            alerts={alerts}
            quoteOf={quoteOf}
            disabled={disabled}
            focusSymbol={alertFor}
            onSave={async (next) => {
              if (!settings.data || settings.error) {
                toast('settings are still loading — try again in a moment', false)
                throw new Error('settings not ready')
              }
              try {
                await saveMarkets({ alerts: next })
                toast('saved ✓')
                void dash.reload()
              } catch (e) {
                toast((e as Error).message, false)
                throw e
              }
            }}
          />
        )}
      </section>

      <section aria-label="Delivery" className="mkd-card">
        <h2 className="mkd-h">Delivery</h2>
        <Field
          label="chat that receives alerts armed on the Markets page"
          hint={
            target
              ? 'Alerts you arm in a chat still answer that chat instead.'
              : 'No chat chosen, so these alerts will not be delivered.'
          }
        >
          <Picker
            ariaLabel="default chat"
            className="w-full max-w-md"
            placeholder="pick a chat…"
            searchPlaceholder="type a name or number…"
            value={target}
            onChange={(v) => void saveDelivery({ default_target: v })}
            options={rows.map((c) => ({
              value: c.target,
              label: c.label || c.name || c.jid,
              hint: String(c.jid).split('@')[0]
            }))}
          />
        </Field>
        <div className="mkd-gap">
          <Toggle
            checked={digestOn}
            disabled={!digestOn && digestTo.length === 0}
            onChange={(v) => void saveDelivery({ news_digest: { enabled: v, to: digestTo, hours: digestHours } })}
            label="Send an hourly world-news digest"
            hint={
              digestTo.length === 0
                ? 'Pick a chat below first.'
                : 'World headlines every hour. Your instruments are only mentioned on a day they actually moved.'
            }
          />
        </div>
        <Field
          label="chat that receives the digest"
          hint="The digest is assembled locally, so it costs nothing to run."
        >
          <Picker
            ariaLabel="chat that receives the digest"
            className="w-full max-w-md"
            placeholder="pick a chat…"
            searchPlaceholder="type a name or number…"
            value={digestTo[0] ?? ''}
            onChange={(v) => {
              const tail = digestTo.slice(1).filter((t) => t !== v)
              const to = v ? [v, ...tail] : tail
              void saveDelivery({
                news_digest: { enabled: to.length ? digestOn : false, to, hours: digestHours }
              })
            }}
            options={rows.map((c) => ({
              value: c.target,
              label: c.label || c.name || c.jid,
              hint: String(c.jid).split('@')[0]
            }))}
          />
        </Field>
        {chats.error && (
          <p role="status" className="mkd-muted">
            Chat list unavailable — delivery pickers may be empty.
          </p>
        )}
      </section>

      <section aria-label="Per-chat watchlists" className="mkd-card">
        <h2 className="mkd-h">Per-chat watchlists</h2>
        <p className="mkd-muted">
          A chat with no list of its own is answered from the default list. Give one its own and “how are our stocks” in
          that group means their holdings, not yours.
        </p>
        {chats.loading && !chats.data ? (
          <Loading>Loading chats…</Loading>
        ) : chats.error ? (
          <p role="alert" className="mkd-error">
            Chats unavailable: {chats.error}{' '}
            <button type="button" className="mkd-link" onClick={() => void chats.reload()}>
              Retry
            </button>
          </p>
        ) : (
          <DashChatWatchlists chats={rows} regions={props.regions} />
        )}
      </section>
    </div>
  )
}

/* Per-chat editor. Same host endpoints and receipt checks as Settings, kept
   here so the dashboard never imports across pages; settings.tsx is untouched. */
function DashChatWatchlists({ chats, regions }: { chats: Chat[]; regions: { value: string; label: string }[] }) {
  const [open, setOpen] = useState<string>('')
  const [rows, setRows] = useState<Record<string, string[]>>({})
  const [own, setOwn] = useState<Record<string, boolean>>({})
  const [inherit, setInherit] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const rowsRef = useRef<Record<string, string[]>>({})
  const chainRef = useRef<Record<string, Promise<void>>>({})

  useEffect(() => {
    const next = Object.fromEntries(chats.map((c) => [c.scope_key ?? c.jid, (c.watchlist ?? []).map(String)]))
    rowsRef.current = next
    setRows(next)
    setOwn(Object.fromEntries(chats.map((c) => [c.scope_key ?? c.jid, !!c.own_watchlist])))
    setInherit(Object.fromEntries(chats.map((c) => [c.scope_key ?? c.jid, !!c.inherits_watchlist])))
  }, [chats])

  function runSerialized(key: string, fn: () => Promise<void>): Promise<void> {
    const prev = chainRef.current[key] ?? Promise.resolve()
    const next = prev.then(fn)
    chainRef.current[key] = next.catch(() => {})
    return next
  }

  async function setFollowsDefault(chat: Chat, want: boolean) {
    const key = chat.scope_key ?? chat.jid
    const scopeKey = chat.scope_key ?? chat.jid
    return runSerialized(key, async () => {
      setBusy((was) => ({ ...was, [key]: true }))
      try {
        const r = await post<{ scope_key: string; inherits_default: boolean; watchlist: string[] }>(
          '/api/settings/watchlist_inherit',
          { scope_key: scopeKey, inherit: want }
        )
        if (r.scope_key !== scopeKey || r.inherits_default !== want) throw new Error('Unexpected watchlist update')
        rowsRef.current = { ...rowsRef.current, [key]: r.watchlist }
        setInherit((was) => ({ ...was, [key]: r.inherits_default }))
        setRows((was) => ({ ...was, [key]: r.watchlist }))
        if (r.inherits_default) setOwn((was) => ({ ...was, [key]: false }))
        toast(r.inherits_default ? 'following the default list ✓' : 'no longer following it ✓')
      } catch (e) {
        toast((e as Error).message, false)
      } finally {
        setBusy((was) => ({ ...was, [key]: false }))
      }
    })
  }

  function mutate(chat: Chat, update: (prev: string[]) => string[]) {
    const key = chat.scope_key ?? chat.jid
    const scopeKey = chat.scope_key ?? chat.jid
    return runSerialized(key, async () => {
      const prev = rowsRef.current[key] ?? []
      const next = update(prev)
      setBusy((was) => ({ ...was, [key]: true }))
      try {
        const r = await post<{ scope_key: string; inherits_default: boolean; watchlist: string[] }>(
          '/api/settings/watchlist',
          { scope_key: scopeKey, symbols: next.join(' ') }
        )
        if (r.scope_key !== scopeKey) throw new Error('Unexpected watchlist update')
        rowsRef.current = { ...rowsRef.current, [key]: r.watchlist }
        setRows((was) => ({ ...was, [key]: r.watchlist }))
        setInherit((was) => ({ ...was, [key]: r.inherits_default }))
        setOwn((was) => ({ ...was, [key]: !r.inherits_default && r.watchlist.length > 0 }))
        toast('saved ✓')
      } catch (e) {
        toast((e as Error).message, false)
      } finally {
        setBusy((was) => ({ ...was, [key]: false }))
      }
    })
  }

  const named = chats.filter((c) => !c.pending)
  if (!named.length) return <p className="mkd-muted">No chats yet.</p>

  return (
    <div className="mkd-chats">
      {named.map((c) => {
        const key = c.scope_key ?? c.jid
        const list = rows[key] ?? rowsRef.current[key] ?? []
        const isOpen = open === key
        const isBusy = !!busy[key]
        return (
          <div key={key} className="mkd-chat">
            <div className="mkd-chat-head">
              <b>{c.label || c.name || c.jid}</b>
              <span className="mkd-muted">
                {own[key] ? 'its own list' : inherit[key] ? 'follows default' : 'nothing here'}
              </span>
              <button type="button" className="mkd-link" onClick={() => setOpen(isOpen ? '' : key)}>
                {isOpen ? 'done' : 'edit'}
              </button>
            </div>
            <div className="mkd-tags">
              {list.map((s) =>
                own[key] ? (
                  <span key={s} className="mkd-tag">
                    {s}
                    <button
                      type="button"
                      aria-label={`remove ${s} from ${c.label || c.name}`}
                      disabled={isBusy}
                      onClick={() => void mutate(c, (prev) => prev.filter((x) => x !== s))}
                      className="mkd-x"
                    >
                      <X className="size-3.5" />
                    </button>
                  </span>
                ) : (
                  <span key={s} className="mkd-tag-dim">
                    {s}
                  </span>
                )
              )}
              {!list.length && <span className="mkd-muted">Nothing tracked here.</span>}
            </div>
            {isOpen && (
              <div className="mkd-gap">
                <SymbolSearch regions={regions} onPick={(s) => void mutate(c, (prev) => [...new Set([...prev, s])])} />
                <label className="mkd-check">
                  <input
                    type="checkbox"
                    className="dashboard-choice"
                    checked={!!inherit[key]}
                    disabled={!!own[key] || isBusy}
                    onChange={(e) => void setFollowsDefault(c, e.target.checked)}
                  />
                  <span className="mkd-muted">Follow the default list from Markets.</span>
                </label>
                {own[key] && (
                  <ConfirmAction
                    key={`clear-${key}`}
                    size="sm"
                    label="clear this chat’s list"
                    confirmLabel="Clear"
                    question={`Clear the list for ${c.label || c.name}?`}
                    warning="The chat then follows nothing until it is given a list or follows the default."
                    disabled={isBusy}
                    onConfirm={() => mutate(c, () => [])}
                  />
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/* News tab: the same deterministic poller stories, scoped to one instrument
   or everything, newest first. */
function DashNews(props: DashProps) {
  const { dash, sym, scope, setScope, news, refreshing, refreshNews } = props
  return (
    <section aria-label="News" className="mkd-card">
      <div className="mkd-news-head">
        <h2 className="mkd-h">News</h2>
        <div className="mkd-row" role="group" aria-label="News scope">
          {(['one', 'all'] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={scope === v}
              onClick={() => setScope(v)}
              className={'mkd-range' + (scope === v ? ' mkd-range-on' : '')}
            >
              {v === 'one' ? (sym?.toUpperCase() ?? 'this one') : 'everything'}
            </button>
          ))}
        </div>
        <span className="mkd-muted">{news.fetched ? `fetched ${ago(news.fetched)}` : ''}</span>
        <Button size="sm" variant="ghost" disabled={refreshing || !sym} onClick={() => void refreshNews()}>
          {refreshing ? <Spinner /> : <RefreshCw />}
          {refreshing ? 'fetching…' : 'refresh'}
        </Button>
      </div>
      {dash.loading && !dash.data ? (
        <Loading>Loading stories…</Loading>
      ) : dash.error && !news.items.length ? (
        <p role="alert" className="mkd-error">
          News unavailable: {dash.error}{' '}
          <button type="button" className="mkd-link" onClick={() => void dash.reload()}>
            Retry
          </button>
        </p>
      ) : news.items.length ? (
        <ul className="mkd-news">
          {news.items.map((it, i) => {
            const src = (it.source ?? '').trim() || it.domain || 'unattributed'
            const when = it.ts ? new Date(it.ts * 1000) : null
            const prev = i > 0 ? news.items[i - 1] : null
            const day = when ? when.toDateString() : ''
            const prevDay = prev?.ts ? new Date(prev.ts * 1000).toDateString() : ''
            return (
              <li key={`${it.title}-${i}`} className="mkd-story">
                {day && day !== prevDay && <p className="mkd-day">{dayLabel(when as Date)}</p>}
                <a href={it.link} target="_blank" rel="noopener noreferrer" className="mkd-title">
                  {it.title || '(untitled)'}
                </a>
                <span className="mkd-meta">
                  <span className="mkd-src">{src}</span>
                  {(it.also ?? 0) > 0 && <span>+{it.also} more</span>}
                  {scope === 'all' && <span>{it.symbol}</span>}
                  <span title={when ? when.toLocaleString() : 'no date'}>{it.ts ? ago(it.ts) : 'undated'}</span>
                </span>
              </li>
            )
          })}
        </ul>
      ) : (
        <>
          <p className="mkd-muted">{sym ? `Nothing for ${sym.toUpperCase()} this week` : 'No stories yet'}</p>
          <p className="mkd-muted">
            Stories older than a week are dropped rather than shown as news. Headlines come from TickerTick, Yahoo
            Finance and Google News — all keyless, none billed.
          </p>
        </>
      )}
    </section>
  )
}
