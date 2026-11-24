import { useEffect, useId, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { get } from '@/lib/api'
import { Field, Input, Spinner } from '@/components/ui'

/* Lifted out of the settings page when adding a symbol moved to Markets,
   where you can see the price you are deciding about. Two callers now — the
   Markets watchlist rail and the per-chat lists in Settings — so it lives
   here rather than being imported across pages. */

/** Find a ticker by company name — nobody knows that Toyota is 7203.T. */
export function SymbolSearch({
  regions,
  onPick,
  label = 'find something to track',
  hint = 'Type a company or index — DBS, Maybank, Toyota, S&P — or a ticker if you know it. Local listings work: Genting finds G13.SI, Public Bank finds 1295.KL.',
  autoFocus
}: {
  regions: { value: string; label: string }[]
  onPick: (symbol: string) => void
  label?: string
  hint?: string
  autoFocus?: boolean
}) {
  const inputId = useId()
  const [q, setQ] = useState('')
  const [region, setRegion] = useState('')
  const [hits, setHits] = useState<{ symbol: string; name: string; type: string; exchange: string }[]>([])
  const [busy, setBusy] = useState(false)
  const [searched, setSearched] = useState(false)
  /* Guards the debounced remote lookup: without it a slow reply for an older
     term overwrites the hits for what is actually typed. */
  const reqId = useRef(0)

  useEffect(() => {
    const term = q.trim()
    if (term.length < 2) {
      reqId.current += 1
      setHits([])
      setSearched(false)
      return
    }
    // Debounced: this is a live remote lookup on every keystroke otherwise.
    const h = window.setTimeout(async () => {
      const my = ++reqId.current
      setBusy(true)
      try {
        const r = await get<{
          results: { symbol: string; name: string; type: string; exchange: string }[]
        }>(`/api/market/search?q=${encodeURIComponent(term)}` + (region ? `&region=${encodeURIComponent(region)}` : ''))
        if (my !== reqId.current) return
        setHits(r.results ?? [])
      } catch {
        if (my !== reqId.current) return
        setHits([])
      } finally {
        if (my !== reqId.current) return
        setBusy(false)
        setSearched(true)
      }
    }, 300)
    return () => window.clearTimeout(h)
  }, [q, region])

  return (
    <div>
      <Field htmlFor={inputId} label={label} hint={hint}>
        <div className="flex max-w-2xl flex-wrap items-center gap-2">
          <div className="relative min-w-[13rem] flex-1">
            <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
            <Input
              value={q}
              id={inputId}
              placeholder="dbs"
              autoFocus={autoFocus}
              onChange={(e) => setQ(e.target.value)}
              className="pl-9"
            />
            {busy && <Spinner className="absolute top-1/2 right-3 -translate-y-1/2" />}
          </div>
          {/* Ranking, not filtering: a Singaporean gets the SGX line first and
              the Frankfurt depositary receipt still sits underneath. */}
          <select
            value={region}
            aria-label="market to favour"
            onChange={(e) => setRegion(e.target.value)}
            className="h-10 cursor-pointer rounded-card border border-line bg-card-2 px-3 text-[0.9rem] text-ink focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
          >
            <option value="">every market</option>
            {regions
              .filter((r) => r.value !== 'global')
              .map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label} first
                </option>
              ))}
          </select>
        </div>
      </Field>

      {hits.length > 0 && (
        /* Capped and scrolling: eight hits unrolled at full height push the
           watchlist itself off the bottom of the rail this now sits in. */
        <div className="mt-2 max-h-[17rem] max-w-md overflow-y-auto rounded-card border border-line">
          {hits.map((h) => (
            <button
              key={h.symbol}
              type="button"
              onClick={() => {
                onPick(h.symbol.toLowerCase())
                setQ('')
                setHits([])
              }}
              className="flex w-full cursor-pointer items-baseline gap-3 border-t border-line-2 bg-transparent px-3 py-2.5 text-left first:border-t-0 hover:bg-card-2 focus-visible:bg-card-2 focus-visible:outline-none"
            >
              <b className="font-mono text-[0.82rem]">{h.symbol}</b>
              <span className="min-w-0 flex-1 truncate text-[0.9rem]">{h.name}</span>
              <span className="shrink-0 text-[0.75rem] text-muted">{h.exchange}</span>
            </button>
          ))}
        </div>
      )}

      {/* Silence used to be the only answer here, which reads as "broken".
          Most empty results mean the company is not listed anywhere — private
          firms have no ticker to find. */}
      {searched && !busy && !hits.length && q.trim().length >= 2 && (
        <p className="mt-2 max-w-md text-[0.88rem] text-muted">
          Nothing listed under “{q.trim()}”. Private companies have no ticker to find — Cognosphere (HoYoverse) is one.
          Otherwise try the name as the exchange writes it, the parent company (Shopee trades as Sea Limited, SE), or
          the ticker itself: 1155.KL, D05.SI, 7203.T.
        </p>
      )}
    </div>
  )
}
