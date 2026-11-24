import { Loading } from '@/dashboard/loading'
import { useContext, useEffect, useMemo, useRef, useState } from 'react'
import { Bot, Cpu, FileText, HousePlug, Mic, Plus, Save, Trash2, TrendingUp, X } from 'lucide-react'
import type { Chat, Settings } from '@/lib/api'
import { get, post } from '@/lib/api'
import {
  HOST_WRITE_SPECS,
  checkBeforeSave,
  checkReadback,
  parseSettingsPayload,
  type HostWriteTarget,
  type SettingsLike
} from '@/lib/host-settings-conflict'
import { toast, Toaster, useApi } from '@/lib/hooks'
import { cn } from '@/lib/utils'
import { Shell } from '@/components/shell'
import { DashboardContext } from '@/dashboard/context'
import { WorkspaceTabs } from '@/dashboard/workspace-tools'
import {
  Badge,
  Button,
  Card,
  ConfirmAction,
  Empty,
  Field,
  Input,
  Kicker,
  Picker,
  Section,
  Segmented,
  Spinner,
  Textarea,
  Toggle
} from '@/components/ui'
import ProfileFiles from '@/dashboard/profile-files'
import { SymbolSearch } from '@/components/symbol-search'

/* The old settings page was one rail with five cramped panels and a client
   who could not find how to rename a chat. This one gives every concern a
   whole page of its own, and the chat list is the front door because "pick a
   chat, then say how she behaves there" is the only mental model that ever
   made sense to a non-technical reader. */

type Tab = 'providers' | 'models' | 'markets' | 'avatar' | 'voice' | 'home' | 'files'

/* No blurbs. Each one restated its own tab label in a cuter voice — "Chats:
   who she talks to, and how" — which is a line of text between the reader and
   the thing they clicked to reach. The sections say what they are. */
type WatchlistReceipt = { scope_key: string; inherits_default: boolean; watchlist: string[] }

const TABS: { key: Tab; label: string; icon: typeof Bot }[] = [
  { key: 'models', label: 'Models', icon: Cpu },
  { key: 'markets', label: 'Markets', icon: TrendingUp },
  { key: 'avatar', label: 'Avatar', icon: Bot },
  { key: 'voice', label: 'Voice notes', icon: Mic },
  { key: 'home', label: 'Home Assistant', icon: HousePlug },
  { key: 'files', label: 'Profile files', icon: FileText }
]

const DASHBOARD_TABS = [
  { key: 'models', label: 'Models' },
  { key: 'providers', label: 'Providers and Learning' },
  { key: 'voice', label: 'Voice and Avatar' },
  { key: 'home', label: 'Home Assistant' },
  { key: 'files', label: 'Profile Files' }
] as const

function ChatWatchlists({ chats, regions }: { chats: Chat[]; regions: { value: string; label: string }[] }) {
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

  /* Following the default is a choice a chat makes, not the state it starts
     in. It used to be inferred from "has no list of its own", which meant a
     group nobody had configured answered "how are our stocks doing" with the
     owner's portfolio — the same defect the per-chat list exists to fix, one
     level up. There is no way to express "this chat follows nothing" when
     empty means inherit, so it is now stored. */
  async function setFollowsDefault(chat: Chat, want: boolean) {
    const key = chat.scope_key ?? chat.jid
    const scopeKey = chat.scope_key ?? chat.jid
    return runSerialized(key, async () => {
      setBusy((was) => ({ ...was, [key]: true }))
      try {
        const r = await post<WatchlistReceipt>('/api/settings/watchlist_inherit', {
          scope_key: scopeKey,
          inherit: want
        })
        if (r.scope_key !== scopeKey || r.inherits_default !== want) throw new Error('Unexpected watchlist update')
        const nextInherit = r.inherits_default
        const nextRows = r.watchlist
        rowsRef.current = { ...rowsRef.current, [key]: nextRows }
        setInherit((was) => ({ ...was, [key]: nextInherit }))
        setRows((was) => ({ ...was, [key]: nextRows }))
        if (nextInherit) setOwn((was) => ({ ...was, [key]: false }))
        toast(nextInherit ? 'following the default list ✓' : 'no longer following it ✓')
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
        const r = await post<WatchlistReceipt>('/api/settings/watchlist', {
          scope_key: scopeKey,
          symbols: next.join(' ')
        })
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
  if (!named.length) return <Empty>No chats yet.</Empty>

  return (
    <div>
      {named.map((c) => {
        const key = c.scope_key ?? c.jid
        const list = rows[key] ?? rowsRef.current[key] ?? []
        const isOpen = open === key
        const isBusy = !!busy[key]
        return (
          <div key={key} className="border-t border-line-2 py-3 first:border-t-0 first:pt-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <b className="font-semibold">{c.label || c.name || c.jid}</b>
              <Badge>{c.kind}</Badge>
              <span className="text-[0.82rem] text-muted">
                {own[key] ? 'its own list' : inherit[key] ? 'following the default list' : 'no tickers here'}
              </span>
              <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setOpen(isOpen ? '' : key)}>
                {isOpen ? 'done' : 'edit'}
              </Button>
            </div>

            {/* An inherited symbol gets no × — removing one would silently
                fork this chat off the default list, which is a bigger decision
                than the control would look like. Adding one forks it openly. */}
            <div className="mt-2 flex flex-wrap gap-2">
              {list.map((sym) =>
                own[key] ? (
                  <span
                    key={sym}
                    className="inline-flex items-center gap-2 rounded-full border border-line py-1 pr-1.5 pl-3.5 font-mono text-[0.78rem] uppercase"
                  >
                    {sym}
                    <button
                      type="button"
                      aria-label={`remove ${sym} from ${c.label || c.name}`}
                      disabled={isBusy}
                      onClick={() => void mutate(c, (prev) => prev.filter((x) => x !== sym))}
                      className="cursor-pointer rounded-full border-0 bg-transparent p-1 text-muted hover:text-down disabled:cursor-default disabled:opacity-40"
                    >
                      <X className="size-3.5" />
                    </button>
                  </span>
                ) : (
                  <span
                    key={sym}
                    className="rounded-full border border-line-2 px-3.5 py-1 font-mono text-[0.78rem] text-muted uppercase"
                  >
                    {sym}
                  </span>
                )
              )}
              {!list.length && (
                <span className="text-[0.82rem] text-faint">
                  Nothing tracked here. Add a ticker below, or follow the default list.
                </span>
              )}
            </div>

            {isOpen && (
              <div className="mt-3">
                <SymbolSearch
                  regions={regions}
                  onPick={(sym) => void mutate(c, (prev) => [...new Set([...prev, sym])])}
                />
                {!own[key] && (
                  <p className="mt-2 mb-0 max-w-prose text-[0.82rem] text-muted">
                    {inherit[key]
                      ? `Adding one here gives this chat its own list, starting from the ${list.length} it follows now.`
                      : 'Adding one here gives this chat its own list.'}
                  </p>
                )}
                {/* The default list is opt-in, so this is a real switch rather
                    than the thing that happens when you empty the list. */}
                <label className="mt-3 flex cursor-pointer items-start gap-2.5">
                  <input
                    type="checkbox"
                    className="mt-0.5 size-4 cursor-pointer accent-[var(--accent)]"
                    checked={!!inherit[key]}
                    disabled={!!own[key] || isBusy}
                    onChange={(e) => void setFollowsDefault(c, e.target.checked)}
                  />
                  <span className="text-[0.82rem] text-muted">
                    Follow the default list from Markets
                    {own[key] ? " — turn this chat's own list off first." : '.'}
                  </span>
                </label>
                {own[key] && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="mt-2"
                    disabled={isBusy}
                    onClick={() => void mutate(c, () => [])}
                  >
                    clear this chat’s list
                  </Button>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/* ── host conflict guard ──────────────────────────────────────────────
 *
 * Host settings have no host-side compare-and-swap: no revision, no `expected`
 * field, no 409. Every `POST` below last-write-wins against any other writer,
 * and this guard does not change that — it only notices before overwriting and
 * proves after that what was sent is what the host now holds. Owned by
 * docs/trd/dashboard-state.md (host settings rows).
 *
 * Per save: the local draft stays untouched until the readback passes; a fresh
 * `GET /api/settings` is compared against the base snapshot on the affected
 * public keys only (stale keeps the draft and names the moved keys); the
 * `POST` carries only affected keys, never read-only keys or unrelated stale
 * fields, and never a write-only credential next to its flag; a second `GET`
 * must show the sent values (the home token is checked by its masked
 * `token_set` flag only, never read back). A failed read is offline, not
 * stale: the write may have landed, so the draft stays and nothing is claimed.
 * A no-op draft sends no `POST`. Residual window, stated plainly: the fresh
 * `GET` and the `POST` are not one atomic host transaction, so two writers
 * inside that window still last-write-win. */

type HostNotice = {
  kind: 'stale' | 'offline' | 'mismatch' | 'unsupported'
  text: string
}

function HostNoticeLine({ notice, onReload }: { notice: HostNotice | null; onReload?: () => void }) {
  if (!notice) return null
  return (
    <p role="status" className="mt-3 mb-0 max-w-prose text-[0.85rem] text-amber">
      {notice.text}{' '}
      {notice.kind === 'stale' && onReload && (
        <Button variant="ghost" size="sm" onClick={onReload}>
          Load theirs
        </Button>
      )}
    </p>
  )
}

function useHostGuard(target: HostWriteTarget, settings: Settings) {
  const spec = HOST_WRITE_SPECS[target]
  const baseRef = useRef<SettingsLike | null>(null)
  const startedRef = useRef(false)
  const [notice, setNotice] = useState<HostNotice | null>(null)
  const [checking, setChecking] = useState(false)

  /* The base advances only on our own verified save or an explicit reload —
     never by following a prop refresh, or another session's write would become
     the base and the stale check would go blind. */
  useEffect(() => {
    if (!startedRef.current && settings) {
      baseRef.current = settings as unknown as SettingsLike
      startedRef.current = true
    }
  }, [settings])

  async function saveGuarded(opts: {
    intended: Record<string, unknown>
    endpoint: string
    hasWriteOnlyChange?: boolean
    bodyFrom: (fresh: SettingsLike) => Record<string, unknown>
  }): Promise<SettingsLike | null> {
    const base = baseRef.current ?? (settings as unknown as SettingsLike)
    /* Intended keys must stay inside the target's affected public set: a
       read-only, write-only-flag or unknown key is refused before any `GET`. */
    const outside = Object.keys(opts.intended).filter((key) => !spec.affected.includes(key))
    if (outside.length) {
      toast(`unsupported field — nothing sent (${outside.join(', ')})`, false)
      return null
    }
    setChecking(true)
    try {
      let fresh: SettingsLike
      try {
        fresh = parseSettingsPayload(await get('/api/settings'), '/api/settings')
      } catch {
        setNotice({
          kind: 'offline',
          text: 'The host did not answer, so nothing was sent and the draft is kept. Retry when it is back.'
        })
        toast('host did not answer — draft kept', false)
        return null
      }
      const before = checkBeforeSave(base, fresh, opts.intended, Object.keys(opts.intended), opts.hasWriteOnlyChange)
      if (before.kind === 'unsupported') {
        setNotice({
          kind: 'unsupported',
          text: 'The host did not return ' + before.missing.join(', ') + '. Your draft is kept.'
        })
        return null
      }
      if (before.kind === 'noop') {
        baseRef.current = fresh
        toast('already saved ✓')
        return fresh
      }
      if (before.kind === 'stale') {
        setNotice({
          kind: 'stale',
          text: `Changed in another session (${before.changed.join(', ')}) — the draft is kept. Load theirs to compare before saving again.`
        })
        toast('changed in another session — draft kept', false)
        return null
      }
      try {
        await post(opts.endpoint, opts.bodyFrom(fresh))
      } catch (e) {
        toast((e as Error).message, false)
        return null
      }
      let back: SettingsLike
      try {
        back = parseSettingsPayload(await get('/api/settings'), '/api/settings')
      } catch {
        setNotice({
          kind: 'offline',
          text: 'Saved, but the readback failed, so it is kept as a draft until the host answers again.'
        })
        toast('saved, but the readback failed — draft kept', false)
        return null
      }
      const { mismatched, unsupported } = checkReadback(back, opts.intended)
      if (unsupported.length) {
        setNotice({
          kind: 'unsupported',
          text: `The host did not return ${unsupported.join(', ')} — unsupported there. The draft is kept.`
        })
        toast('host did not return that field — draft kept', false)
        return null
      }
      if (mismatched.length) {
        setNotice({
          kind: 'mismatch',
          text: `The host shows a different value for ${mismatched.join(', ')} — the draft is kept.`
        })
        toast('host shows a different value — draft kept', false)
        return null
      }
      baseRef.current = back
      setNotice(null)
      return back
    } finally {
      setChecking(false)
    }
  }

  async function reloadTheirs(apply?: (fresh: SettingsLike) => void): Promise<void> {
    try {
      const fresh = parseSettingsPayload(await get('/api/settings'), '/api/settings')
      baseRef.current = fresh
      apply?.(fresh)
      setNotice(null)
    } catch {
      toast('host did not answer — draft kept', false)
    }
  }

  return { notice, setNotice, checking, saveGuarded, reloadTheirs }
}

function ollamaFrom(fresh: SettingsLike): { enabled: boolean; endpoint: string; fallback: string } {
  const ollama = (fresh as unknown as Settings)?.models?.ollama
  return {
    enabled: ollama?.enabled ?? false,
    endpoint: ollama?.endpoint ?? '',
    fallback: ollama?.fallback ?? ''
  }
}

/* ── markets ──────────────────────────────────────────────────────────── */

/* Adding an instrument and arming an alert both moved to the Markets page,
   where the prices are — a decision entirely about prices was being made on
   a page with none on it. What is left here is the wiring nobody makes while
   reading a chart: which chats follow a list of their own instead of yours,
   and where an alert that belongs to no chat gets delivered. */

/* Which model answers, per role and per chat, and where the local one lives.
   The two roles are separate controls because they are separate questions:
   conversation is a routing contract a small model can lose, and delegated
   coding is real work on a real machine. A chat's own choice is set on the
   Chats page, next to the chat it belongs to — this page is the default
   everything falls back to. */
/* Where the picker's lists came from. The lists are discovered — Claude from
   the Models API, OpenRouter and Codex when this machine is logged in to them —
   so the page says which ones answered, and a non-Claude pick is labelled as
   sending her conversations to that provider. */
function ProviderStatus({
  providers,
  busy,
  onRefresh
}: {
  providers: Record<string, { state: string; count?: number; error?: string }>
  busy: boolean
  onRefresh: () => void
}) {
  const names: Record<string, string> = {
    claude: 'Claude',
    openrouter: 'OpenRouter',
    codex: 'Codex'
  }
  const line = (key: string) => {
    const p = providers[key]
    if (!p) return null
    const what =
      p.state === 'live'
        ? `${p.count} models`
        : p.state === 'cached'
          ? `${p.count} models (last good list — ${p.error ?? 'fetch failed'})`
          : p.state
    return (
      <li key={key}>
        <span className="text-ink">{names[key] ?? key}</span>: {what}
      </li>
    )
  }
  return (
    <div className="mb-5 max-w-prose text-[0.82rem] text-muted">
      <ul className="m-0 mb-2 list-none p-0">{Object.keys(names).map(line)}</ul>
      <p className="mt-0 mb-2">
        OpenRouter and Codex models answer through their own providers, so choosing one for conversation sends her chats
        there instead of your Claude plan.
      </p>
      <Button variant="ghost" disabled={busy} onClick={onRefresh}>
        Refresh model lists
      </Button>
    </div>
  )
}

/* Which engine answers her web searches. Exa answers in under a second with
   a passage from each page; DDGS adds pages Exa misses. "Both" asks the two
   at once. The status line says when Exa is switched off, because nothing
   else on any page would: searches quietly switch to DDGS. Exa reports what
   each search cost, but not the balance left, so that stays on its
   dashboard. */
function SearchSection({ settings, onChanged }: { settings: Settings; onChanged: () => void }) {
  const s = settings.search
  const [busy, setBusy] = useState(false)
  const guard = useHostGuard('search', settings)
  if (!s) return null
  const modes = s.modes ?? []
  const current = modes.find((x) => x.id === s.mode)
  const offUntil = (s.exa_off_until ?? 0) * 1000
  const off = offUntil > Date.now()
  const why =
    {
      credits: 'is out of credits or over its budget',
      auth: 'refused its API key',
      rate: 'is rate-limiting'
    }[s.exa_off_reason ?? ''] ?? 'is unavailable'
  const dollars = s.usage?.dollars
  const searches = s.usage?.searches

  async function save(id: string) {
    if (busy || guard.checking || id === s?.mode) return
    setBusy(true)
    try {
      const back = await guard.saveGuarded({
        intended: { 'search.mode': id },
        endpoint: '/api/settings/search',
        bodyFrom: () => ({ mode: id })
      })
      if (!back) return
      toast('saved ✓')
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section title="Web search">
      <p className="mt-0 mb-4 max-w-prose text-[0.9rem] text-muted">
        Which engine answers when she looks something up. Exa is fast and gives her a passage from each page to cite;
        DDGS adds pages Exa misses, such as menu photos. Applies from her next search.
      </p>
      <Segmented
        options={modes.map((x) => x.id)}
        labels={Object.fromEntries(modes.map((x) => [x.id, x.label]))}
        value={s.mode}
        onChange={(id) => void save(id)}
      />
      {current?.note && <p className="mt-2 mb-0 max-w-prose text-[0.82rem] text-muted">{current.note}</p>}
      <HostNoticeLine notice={guard.notice} onReload={() => void guard.reloadTheirs().then(onChanged)} />
      {!s.exa_key && s.mode !== 'ddgs' ? (
        <p className="mt-3 mb-0 max-w-prose text-[0.85rem] text-amber">
          No Exa key is set, so every search uses DDGS. Add <code>EXA_API_KEY</code> to <code>~/.hermes/.env</code>.
        </p>
      ) : off && s.mode !== 'ddgs' ? (
        <p className="mt-3 mb-0 max-w-prose text-[0.85rem] text-amber">
          Exa {why}, so searches use DDGS until{' '}
          {new Date(offUntil).toLocaleString([], {
            weekday: 'short',
            hour: '2-digit',
            minute: '2-digit'
          })}
          . It is tried again then.
        </p>
      ) : null}
      {s.exa_key && (
        <p className="mt-3 mb-0 max-w-prose text-[0.82rem] text-muted">
          {typeof dollars === 'number' && typeof searches === 'number'
            ? `Exa this month: $${dollars.toFixed(2)} over ${searches} ${
                searches === 1 ? 'search' : 'searches'
              }, as Exa reported each one. `
            : ''}
          The balance left and the full usage are on the{' '}
          <a href="https://dashboard.exa.ai/billing" target="_blank" rel="noreferrer" className="text-accent">
            Exa dashboard
          </a>
          . When the credits run out, searches switch to DDGS by themselves.
        </p>
      )}
    </Section>
  )
}

/* Learning from every message. Each reply is graded by the reaction it got,
   and each chat's way of talking is written down; both reach her next turn.
   The switch applies with no restart. AIRA_LEARN=0 is the hard kill switch and
   wins, so the page says when it is set: otherwise "On" would show while
   nothing happens. The server sends counts only, never a lesson or a chat. */
function LearningSection({ settings, onChanged }: { settings: Settings; onChanged: () => void }) {
  const l = settings.learning
  const [busy, setBusy] = useState(false)
  const guard = useHostGuard('learning', settings)
  if (!l) return null
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
  const kept = l.chats
    ? `${count(l.lessons, 'lesson', 'lessons')}, ${count(
        l.style_rules,
        'style rule',
        'style rules'
      )} across ${count(l.chats, 'chat', 'chats')}`
    : 'nothing learned yet'
  // The day's allowance starts again at midnight UTC (brain.learn).
  const now = new Date()
  const resets = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))

  async function save(value: 'on' | 'off') {
    if (busy || guard.checking || value === l?.learning) return
    setBusy(true)
    try {
      const back = await guard.saveGuarded({
        intended: { 'learning.learning': value },
        endpoint: '/api/settings/learning',
        bodyFrom: () => ({ learning: value })
      })
      if (!back) return
      toast('saved ✓')
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section title="Learning">
      <p className="mt-0 mb-4 max-w-prose text-[0.9rem] text-muted">
        She grades each reply by the reaction it got and learns how each chat talks, then uses both on her next reply.
        On is the default. Off stops the grading and leaves what she learned unused; nothing is deleted. Applies from
        her next message.
      </p>
      <Segmented
        options={['on', 'off'] as const}
        labels={{ on: 'On', off: 'Off' }}
        value={l.learning}
        onChange={(v) => void save(v)}
      />
      <p className="mt-2 mb-0 max-w-prose text-[0.82rem] text-muted">
        {l.error
          ? `What she learned could not be read (${l.error}).`
          : `${l.calls_today} of ${l.day_cap} grading calls used today · ${kept}`}
      </p>
      <HostNoticeLine notice={guard.notice} onReload={() => void guard.reloadTheirs().then(onChanged)} />
      {l.env_off ? (
        <p className="mt-3 mb-0 max-w-prose text-[0.85rem] text-amber">
          <code>AIRA_LEARN=0</code> is set, so learning stays off whatever is chosen here. Remove it from{' '}
          <code>~/.hermes/.env</code> and restart AIRA to use this switch.
        </p>
      ) : l.learning === 'on' && l.calls_today >= l.day_cap ? (
        <p className="mt-3 mb-0 max-w-prose text-[0.85rem] text-amber">
          Today’s {l.day_cap} grading calls are used, so grading waits until{' '}
          {resets.toLocaleString([], {
            weekday: 'short',
            hour: '2-digit',
            minute: '2-digit'
          })}
          . What she learned before is still used.
        </p>
      ) : null}
    </Section>
  )
}

/* Song lessons: Opus writes each line's reading, 中文 and English; ModelScope
   fills what it leaves out. When ModelScope runs out, the owner sees it here. */
function LessonsSection({ settings }: { settings: Settings }) {
  const l = settings.lessons
  if (!l) return null
  const paused = (l.paused ?? []).filter((p) => p.until * 1000 > Date.now())
  const short = (m: string) => m.split('/').pop() ?? m
  return (
    <Section title="Song lessons">
      <p className="mt-0 mb-3 max-w-prose text-[0.9rem] text-muted">
        Claude Opus writes each line of a song lesson. DeepSeek, then Qwen, on ModelScope fill any line it leaves out.
      </p>
      {paused.length ? (
        paused.map((p) => (
          <p key={p.model} className="mt-0 mb-2 max-w-prose text-[0.85rem] text-amber">
            {short(p.model)} is paused for lessons until{' '}
            {new Date(p.until * 1000).toLocaleString([], {
              weekday: 'short',
              hour: '2-digit',
              minute: '2-digit'
            })}
            : {p.why}
          </p>
        ))
      ) : (
        <p className="mt-0 mb-2 max-w-prose text-[0.85rem] text-muted">
          No ModelScope model is paused.
          {l.last?.line ? ` Last failure: ${l.last.line}.` : ''}
        </p>
      )}
      <p className="mt-0 mb-0 max-w-prose text-[0.82rem] text-muted">
        ModelScope allows {l.daily_allowance ?? 2000} calls a day, reset at midnight; it does not report what is left.
        The count is on the{' '}
        <a href="https://www.modelscope.ai/my/overview" target="_blank" rel="noreferrer" className="text-accent">
          ModelScope site
        </a>{' '}
        under API usage.
      </p>
    </Section>
  )
}

const FIELD_PATH: Record<string, string> = { chat: 'models.chat', agent: 'models.agent', effort: 'models.effort' }

function ModelsTab({ settings, onChanged }: { settings: Settings; onChanged: () => void }) {
  const dashboard = useContext(DashboardContext)
  const m = settings.models ?? {}
  const cat = m.catalogue ?? []
  const ollama = m.ollama ?? { enabled: false, endpoint: '', fallback: '' }
  const [endpoint, setEndpoint] = useState(ollama.endpoint)
  const [probe, setProbe] = useState<{
    reachable: boolean
    tags: string[]
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const guard = useHostGuard('models', settings)

  async function saveField(patch: Record<string, unknown>) {
    const intended = Object.fromEntries(
      Object.entries(patch)
        .filter(([key]) => key in FIELD_PATH)
        .map(([key, value]) => [FIELD_PATH[key], value])
    )
    if (!Object.keys(intended).length) {
      toast('unsupported field — nothing sent', false)
      return
    }
    setBusy(true)
    try {
      const back = await guard.saveGuarded({
        intended,
        endpoint: '/api/settings/models',
        bodyFrom: () => patch
      })
      if (!back) return
      toast('saved ✓')
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  /* The object is rebuilt from the fresh read on every save: spreading the
     displayed `ollama` over a stale snapshot would resend endpoint and
     fallback values another session already changed. */
  async function saveOllama(change: { enabled?: boolean; endpoint?: string; fallback?: string }) {
    const intended = Object.fromEntries(Object.entries(change).map(([key, value]) => [`models.ollama.${key}`, value]))
    setBusy(true)
    try {
      const back = await guard.saveGuarded({
        intended,
        endpoint: '/api/settings/models',
        bodyFrom: (fresh) => ({ ollama: { ...ollamaFrom(fresh), ...change } })
      })
      if (!back) return
      toast('saved ✓')
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  async function test() {
    setProbe(null)
    setBusy(true)
    try {
      // Probe what is typed, not what was last saved: testing after editing
      // the address must check the new one, not the old one.
      const r = (await post('/api/settings/models_probe', { endpoint })) as {
        reachable: boolean
        tags?: unknown
      }
      // `tags` has been absent before — never trust it straight into `.join`.
      const tags = Array.isArray(r.tags) ? r.tags.map(String) : []
      setProbe({ reachable: !!r.reachable, tags })
      let summary = 'nothing answered'
      if (r.reachable) summary = tags.length ? `serving ${tags.length} model(s) ✓` : 'reachable — serving nothing yet'
      toast(summary, !!r.reachable)
    } catch (e) {
      toast((e as Error).message, false)
    } finally {
      setBusy(false)
    }
  }

  const picker = (role: 'chat' | 'agent', value: string, hint: string) => {
    // The agent hint has always said a local model is not offered here, while
    // this mapped the unfiltered catalogue — so one could be picked, saved,
    // and then silently overridden by the router with only a log line.
    // Delegated coding runs an agent with this machine in reach, so it stays
    // on Claude — the server refuses anything else for that role too.
    const opts = role === 'agent' ? cat.filter((c) => c.kind === 'claude' || c.kind === 'cloud') : cat
    // A stored value the catalogue does not carry still has to be shown as
    // itself. A native <select> with no matching option renders its FIRST one,
    // so the page displayed some other model entirely — and the catalogue
    // drops local models the moment Ollama is down, and never contains an
    // arbitrary AIRA_CHAT_MODEL. Carried as its own row with the reason on it.
    const known = opts.some((c) => c.id === value)
    return (
      <div className="mb-4">
        <label className="mb-1 block text-[0.82rem] text-muted">{hint}</label>
        <Picker
          ariaLabel={hint}
          className="w-full max-w-md"
          placeholder="— not set —"
          searchPlaceholder="type a model name…"
          value={value}
          disabled={busy}
          onChange={(v) => void saveField({ [role]: v })}
          options={[
            ...(value && !known ? [{ value, label: value, hint: 'set, not in the catalogue' }] : []),
            // The note belongs in the LABEL, not the hint: a hint only shows
            // while the list is open, and "Opus 4.7 — steadiest" is exactly
            // what the closed control said before and should still say.
            ...opts.map((c) => ({
              value: c.id,
              label: c.note ? `${c.label} — ${c.note}` : c.label
            }))
          ]}
        />
      </div>
    )
  }

  return (
    <div className={dashboard ? 'workspace-grid host-models' : undefined}>
      <Section title={dashboard ? 'Model Profiles' : 'Defaults'}>
        <p className="mt-0 mb-4 max-w-prose text-[0.9rem] text-muted">
          What every chat uses unless it has been given its own. Set a chat's own model on the Chats page.
        </p>
        {picker('chat', m.chat ?? '', 'Conversation')}
        {picker('agent', m.agent ?? '', 'Delegated coding (Claude models only)')}
        <ProviderStatus
          providers={m.providers ?? {}}
          busy={busy}
          onRefresh={async () => {
            setBusy(true)
            try {
              await post('/api/settings/models_refresh', {})
              toast('model lists refreshed ✓')
              onChanged()
            } catch (e) {
              toast((e as Error).message, false)
            } finally {
              setBusy(false)
            }
          }}
        />

        {/* Effort has been live since August — AIRA_CHAT_EFFORT, currently
            high — with nothing on this page saying so or able to change it.
            It applies to her conversation turns, not to delegated coding,
            which never passes the flag. */}
        <div className="mb-1">
          <label className="mb-1 block text-[0.82rem] text-muted">How hard she thinks before replying</label>
          <Segmented
            options={(m.efforts ?? []).map((e) => e.label)}
            value={(m.efforts ?? []).find((e) => e.id === (m.effort ?? ''))?.label ?? ''}
            onChange={(label) => {
              const hit = (m.efforts ?? []).find((e) => e.label === label)
              if (hit) void saveField({ effort: hit.id })
            }}
          />
          <p className="mt-2 mb-0 max-w-prose text-[0.82rem] text-muted">
            {/* The note is a fragment ("steadier on long instructions") with
                no full stop, so it ran straight into the sentence after it:
                "steadier on long instructions Applies to her replies…". */}
            {(() => {
              const note = (m.efforts ?? []).find((e) => e.id === (m.effort ?? ''))?.note
              return note ? `${note.replace(/[.\s]+$/, '')}. ` : ''
            })()}
            Applies to her replies from the next message. Delegated coding is unaffected.
          </p>
        </div>
        <HostNoticeLine notice={guard.notice} onReload={() => void guard.reloadTheirs().then(onChanged)} />
      </Section>

      {!dashboard && (
        <>
          <SearchSection settings={settings} onChanged={onChanged} />
          <LearningSection settings={settings} onChanged={onChanged} />
          <LessonsSection settings={settings} />
        </>
      )}

      <Section title={dashboard ? 'Local Models' : 'Local models'}>
        <p className="mt-0 mb-4 max-w-prose text-[0.9rem] text-muted">
          An Ollama endpoint. With a fallback chosen, a cloud call that fails — timeout, auth, quota — is answered
          locally instead of failing the turn. Every fallback is written to the router log, so a reply that did not come
          from the model you picked says so.
        </p>
        <label className="mb-4 flex items-center gap-2 text-[0.95rem]">
          <input
            type="checkbox"
            checked={ollama.enabled}
            disabled={busy}
            onChange={(e) => void saveOllama({ enabled: e.target.checked })}
          />
          Use a local endpoint
        </label>
        <label className="mb-1 block text-[0.82rem] text-muted">Endpoint</label>
        <div className="mb-4 flex flex-wrap gap-2">
          <input
            className="min-h-11 min-w-0 flex-1 rounded-card border border-line bg-sunk px-3 text-ink"
            value={endpoint}
            disabled={busy}
            placeholder="http://127.0.0.1:11434"
            onChange={(e) => {
              setProbe(null)
              setEndpoint(e.target.value)
            }}
          />
          <Button
            variant="ghost"
            disabled={busy || endpoint === ollama.endpoint}
            onClick={() => void saveOllama({ endpoint })}
          >
            <Save /> Save
          </Button>
          <Button variant="ghost" disabled={busy} onClick={test}>
            Test
          </Button>
        </div>
        {probe && (
          <p className="mt-0 mb-4 text-[0.86rem] text-muted">
            {probe.reachable
              ? `Reachable. Serving: ${(probe.tags ?? []).join(', ') || 'nothing yet'}`
              : 'Nothing answered at that address.'}
          </p>
        )}
        <label className="mb-1 block text-[0.82rem] text-muted">Fall back to</label>
        <Picker
          ariaLabel="fall back to"
          className="w-full max-w-md"
          placeholder="None — show an error instead"
          searchPlaceholder="type a model name…"
          value={ollama.fallback}
          disabled={busy || !ollama.enabled}
          onChange={(v) => void saveOllama({ fallback: v })}
          options={[
            { value: '', label: 'None — show an error instead' },
            ...cat.filter((c) => c.kind === 'local').map((c) => ({ value: c.label, label: c.label }))
          ]}
        />
        {ollama.enabled && !m.local_available && (
          <p className="mt-3 mb-0 text-[0.86rem] text-down">
            That endpoint is not responding, so there are no local models to choose from.
          </p>
        )}
        <HostNoticeLine notice={guard.notice} onReload={() => void guard.reloadTheirs().then(onChanged)} />
      </Section>
    </div>
  )
}

function MarketsTab({ settings, onChanged }: { settings: Settings; onChanged: () => void }) {
  const chats = useApi<{ chats: Chat[] }>('/api/chats').data?.chats ?? []
  const watch = (settings.markets?.watchlist ?? []).map(String)
  const regions = settings.regions ?? []
  const target = String(settings.markets?.default_target ?? '')

  const digest = settings.markets?.news_digest ?? {}
  const digestOn = Boolean((digest as { enabled?: boolean }).enabled)
  const digestTo = ((digest as { to?: unknown[] }).to ?? []).map(String)
  const rawHours = (digest as { hours?: unknown }).hours
  // `hours` is edited nowhere on this page — carry it through every save, or
  // toggling the digest silently unschedules it.
  const digestHours = Array.isArray(rawHours) ? rawHours.map(Number).filter((n) => Number.isFinite(n)) : []

  async function save(patch: {
    default_target?: string
    news_digest?: { enabled: boolean; to: string[]; hours?: number[] }
  }) {
    try {
      await post('/api/settings/markets', {
        ...patch,
        expected: Object.fromEntries(
          Object.keys(patch).map((key) => [
            key,
            (settings.markets as Record<string, unknown> | undefined)?.[key] ?? null
          ])
        )
      })
      toast('saved ✓')
      onChanged()
    } catch (e) {
      toast((e as Error).message, false)
    }
  }

  return (
    <>
      <Section
        title="The default watchlist"
        action={
          <a className="text-[0.85rem] text-muted no-underline hover:text-accent" href="/app/markets.html">
            open Markets →
          </a>
        }
      >
        <Card className="p-5">
          <div className="flex flex-wrap items-center gap-2">
            {watch.map((s) => (
              <span
                key={s}
                className="rounded-full border border-line-2 px-3.5 py-1 font-mono text-[0.78rem] text-muted uppercase"
              >
                {s}
              </span>
            ))}
            {!watch.length && <Empty>Nothing tracked yet.</Empty>}
          </div>
          <p className="mt-4 mb-0 max-w-prose text-[0.92rem] text-muted">
            Chats below can follow this list. Add, remove and reorder on the Markets page.
          </p>
        </Card>
      </Section>

      <Section title="What each chat follows">
        <Card className="p-5">
          <p className="mt-0 mb-4 max-w-prose text-[0.92rem] text-muted">
            A chat with no list of its own is answered from the default list. Give one its own and "how are our stocks"
            in that group means their holdings, not yours.
          </p>
          <ChatWatchlists chats={chats} regions={regions} />
        </Card>
      </Section>

      <Section title="Where alerts go">
        <Card className="p-5">
          {/* An alert armed IN a chat replies to that chat. One armed on the
              Markets page belongs to no chat, so without a target here the
              poller fires it into a log line and nobody hears about the move. */}
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
              onChange={(v) => void save({ default_target: v })}
              options={chats.map((c) => ({
                value: c.target,
                label: c.label || c.name || c.jid,
                hint: String(c.jid).split('@')[0]
              }))}
            />
          </Field>
        </Card>
      </Section>

      {/* The hourly digest is world news first — the market feeds answer
          "what happened to this instrument", the front page answers "what
          happened", and the second is what an hourly message is for. A
          watchlist story rides along only when its symbol actually moved that
          day, so most hours this is world-only, which is correct. Composed
          without a model, so the hourly cadence costs nothing. */}
      <Section title="Hourly news digest">
        <Card className="space-y-4 p-5">
          <Toggle
            checked={digestOn}
            disabled={!digestOn && digestTo.length === 0}
            onChange={(v) => void save({ news_digest: { enabled: v, to: digestTo, hours: digestHours } })}
            label="Send an hourly world-news digest"
            hint={
              digestTo.length === 0
                ? 'Pick a chat below first.'
                : 'World headlines every hour. Your instruments are only mentioned on a day they actually moved.'
            }
          />
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
                // The picker edits only the first recipient — keep the rest,
                // and `hours`, or choosing a chat silently drops both.
                const tail = digestTo.slice(1).filter((t) => t !== v)
                const to = v ? [v, ...tail] : tail
                void save({
                  news_digest: { enabled: to.length ? digestOn : false, to, hours: digestHours }
                })
              }}
              options={chats.map((c) => ({
                value: c.target,
                label: c.label || c.name || c.jid,
                hint: String(c.jid).split('@')[0]
              }))}
            />
          </Field>
        </Card>
      </Section>

      <Section title="Or just ask her">
        <Card className="p-5">
          <p className="m-0 max-w-prose text-[0.92rem] text-read">
            Anything on the Markets page can be said in the chat instead — “track Nvidia and tell me if it drops under
            100”, “what am I watching?”, “alert me if Bitcoin moves more than 5% today”. She resolves the name to a
            ticker, writes it to the same list, and the five-minute poller does the watching.
          </p>
        </Card>
      </Section>
    </>
  )
}

/* ── avatar / home ────────────────────────────────────────────────────── */

function AvatarTab({ settings, onChanged }: { settings: Settings; onChanged: () => void }) {
  const [model, setModel] = useState(settings.avatar?.model ?? '')
  const guard = useHostGuard('avatar', settings)
  const mirror = !!settings.avatar?.mirror

  async function save(patch: { model?: string; mirror?: boolean }) {
    const intended = Object.fromEntries(Object.entries(patch).map(([key, value]) => [`avatar.${key}`, value]))
    const back = await guard.saveGuarded({
      intended,
      endpoint: '/api/settings/avatar',
      bodyFrom: () => patch
    })
    if (!back) return
    toast('saved ✓')
    onChanged()
  }

  return (
    <Section title="Avatar">
      <Card className="p-5">
        <p className="mt-0 mb-5 max-w-prose text-[0.92rem] text-muted">
          Choose the Live2D model and orientation for the host display.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="model">
            <Input value={model} onChange={(e) => setModel(e.target.value)} className="w-64" />
          </Field>
          <Button variant="primary" onClick={() => void save({ model })}>
            <Save />
            Save
          </Button>
        </div>
        <div className="mt-5">
          <Toggle checked={mirror} label="Mirror the model horizontally" onChange={(v) => void save({ mirror: v })} />
        </div>
        <HostNoticeLine
          notice={guard.notice}
          onReload={() =>
            void guard
              .reloadTheirs((fresh) => setModel((fresh as unknown as Settings)?.avatar?.model ?? ''))
              .then(onChanged)
          }
        />
      </Card>
    </Section>
  )
}

/* The master voice-note switch.
 *
 * Off means off — not "off unless a chat says otherwise". It works the way a
 * dead GPU box already does: the command provider declines the job and the
 * text reply goes out untouched, which is why it needs no restart and why it
 * beats every per-chat choice instead of merely seeding them. */
function VoiceTab({ settings, onChanged }: { settings: Settings; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  const guardMute = useHostGuard('tts', settings)
  const guardProvider = useHostGuard('tts_provider', settings)
  const guardLang = useHostGuard('tts_lang', settings)
  const on = settings.tts?.enabled !== false
  const speaking = settings.tts?.speaking ?? 0
  const silenced = settings.tts?.silenced ?? 0
  // No UI writes this. Read only so the page can say so if it is true — see
  // the warning below.
  const hiddenDefaultOn = !!settings.tts?.auto_tts
  const langAware = settings.tts?.lang_aware !== false
  // The audio language, which is a different axis from whether she speaks.
  // `langs` comes from the server rather than being listed here, so that
  // ungating Chinese is a server-side change and not a frontend release.
  const langs = settings.tts?.langs ?? ['auto', 'ja', 'en']
  // Whose voice. Two engines run side by side on the GPU box; this is the
  // only place to choose between them.
  const provider = settings.tts?.provider ?? ''
  const providers = settings.tts?.providers ?? []

  async function saveProvider(next: string) {
    if (busy || guardProvider.checking) return
    setBusy(true)
    try {
      const back = await guardProvider.saveGuarded({
        intended: { 'tts.provider': next },
        endpoint: '/api/settings/tts_provider',
        bodyFrom: () => ({ provider: next })
      })
      if (!back) return
      toast('voice changed \u2713')
      onChanged()
    } finally {
      setBusy(false)
    }
  }
  const lang = settings.tts?.lang ?? 'auto'
  const langOverrides = settings.tts?.lang_overrides ?? 0

  async function saveLang(next: string) {
    if (busy || guardLang.checking) return
    setBusy(true)
    try {
      const back = await guardLang.saveGuarded({
        intended: { 'tts.lang': next },
        endpoint: '/api/settings/tts_lang',
        bodyFrom: () => ({ lang: next })
      })
      if (!back) return
      toast('saved \u2713')
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  async function save(enabled: boolean) {
    if (busy || guardMute.checking) return
    setBusy(true)
    try {
      const back = await guardMute.saveGuarded({
        intended: { 'tts.enabled': enabled },
        endpoint: '/api/settings/tts',
        bodyFrom: () => ({ enabled })
      })
      if (!back) return
      // No restart: the script that reads the marker runs once per request.
      toast(enabled ? 'voice notes on ✓' : 'voice notes off everywhere ✓')
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section title="Voice notes">
      <Card className="p-5">
        <p className="mt-0 mb-5 max-w-prose text-[0.92rem] text-muted">
          Whether her replies are spoken aloud and delivered as WhatsApp voice notes. Speech is generated on the GPU box
          over Tailscale, so a reply takes longer to arrive and does not arrive at all while that machine is off — the
          text still goes out either way.
        </p>
        {/* A MUTE, not a power switch — and labelled as one.

            Called "Voice notes" it read as the master enable, which is the
            single thing everyone got wrong: turning it on enables nothing. It
            only stops overruling. Naming the verb removes the ambiguity that
            no amount of hint text could. */}
        <Toggle
          checked={!on}
          disabled={busy}
          label="Mute voice notes everywhere"
          onChange={(v) => void save(!v)}
          hint={
            !on
              ? 'Nothing is spoken in any chat. Every per-chat setting is kept and speaks again when you unmute.'
              : speaking === 0
                ? 'Not muted — but no chat is set to speak, so nothing is spoken yet. Set one on Chats.'
                : `Not muted. ${speaking === 1 ? 'One chat speaks' : `${speaking} chats speak`}${silenced ? `, ${silenced} silenced` : ''}.`
          }
        />
        {hiddenDefaultOn && (
          /* The latent trap. `voice.auto_tts: true` in config.yaml makes EVERY
             chat without its own setting speak, and nothing on this page can
             change it. It is normally absent; if somebody sets it by hand, the
             counts above stop describing what happens and the page has to say
             so rather than quietly disagree with the bot. */
          <p className="mt-4 mb-0 max-w-prose text-[0.85rem] text-amber">
            <code>voice.auto_tts</code> is set to true in config.yaml, so every chat without a setting of its own also
            speaks — beyond the {speaking} counted here. Nothing on this page can change that; remove the key to go back
            to per-chat only.
          </p>
        )}
        {/* An override the Chats page cannot show or clear still governs the
            gateway. Without this the counts above read "3 chats speak" beside
            a Chats page showing none, and nothing said why. */}
        {(settings.tts?.unreachable?.length || settings.tts?.lang_unreachable?.length) && (
          <p className="mt-4 mb-0 max-w-prose text-[0.85rem] text-amber">
            Counted above but not editable here:{' '}
            <code>{[...(settings.tts?.unreachable ?? []), ...(settings.tts?.lang_unreachable ?? [])].join(', ')}</code>.
            These are legacy or non-WhatsApp keys — the Chats page looks rows up by <code>whatsapp:&lt;jid&gt;</code>,
            so they appear on no row. They are still in force; change them on disk.
          </p>
        )}
        <HostNoticeLine notice={guardMute.notice} onReload={() => void guardMute.reloadTheirs().then(onChanged)} />
      </Card>

      {providers.length > 1 && (
        <Card className="mt-5 p-5">
          <p className="mt-0 mb-5 max-w-prose text-[0.92rem] text-muted">
            Whose voice she speaks in. Both engines run side by side on the GPU box, so switching is instant and
            reversible — but they are two different characters, not two qualities of the same one. There is no automatic
            failover between them for that reason: if the chosen one is down, she stays silent rather than answering in
            the other one's voice.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Segmented
              options={providers.map((p: string) => VOICE_LABELS[p] ?? p)}
              value={VOICE_LABELS[provider] ?? provider}
              onChange={(v) =>
                void saveProvider(providers.find((p: string) => (VOICE_LABELS[p] ?? p) === v) ?? provider)
              }
            />
            {busy && <span className="text-sm text-muted">saving…</span>}
          </div>
          <p className="mt-4 mb-0 max-w-prose text-[0.85rem] text-muted">
            {VOICE_NOTES[provider] ?? 'Configured under tts.providers in config.yaml.'}
          </p>
          <HostNoticeLine
            notice={guardProvider.notice}
            onReload={() => void guardProvider.reloadTheirs().then(onChanged)}
          />
        </Card>
      )}

      {/* Separate card, because it answers a separate question. The switch
          above is WHETHER she speaks; this is WHAT LANGUAGE she speaks in,
          and conflating them into one card invites reading the language as a
          sub-setting of the toggle rather than an independent axis. */}
      <Card className="mt-5 p-5">
        <p className="mt-0 mb-5 max-w-prose text-[0.92rem] text-muted">
          {!langAware && (
            /* Under Isla this whole card is decoration: isla-tts.py never
               reads gateway_tts_language.json and is not passed --chat-id, so
               neither the default here nor any per-chat override reaches it.
               Isla is Japanese-trained and speaks only the Japanese spans of a
               reply — a hard-coded language policy that these controls appear
               to govern and do not. Said out loud rather than left looking
               live. */
            <span className="text-amber">
              Not used by Isla — it speaks only the Japanese parts of a reply, whatever is set here. Switch to Riina
              above for this to do anything.{' '}
            </span>
          )}
          Which language her voice notes are in. <strong className="text-fg">Not</strong> the language she writes in —
          she can reply in English and speak Japanese, and the two are set separately. Each language uses a different
          recording of her voice, so picking the wrong one is audible.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          {/* Options are the raw codes with display labels alongside. Matching
              on the label and falling back to `auto` saved any language with
              no label here as `auto` — silently changing what it meant. */}
          <Segmented
            options={langs.includes(lang) ? langs : [...langs, lang]}
            labels={LANG_LABELS}
            value={lang}
            onChange={(v) => void saveLang(v)}
          />
          {busy && <span className="text-sm text-muted">saving…</span>}
        </div>
        <p className="mt-4 mb-0 max-w-prose text-[0.85rem] text-muted">
          {lang === 'auto'
            ? 'She speaks whatever language she happened to write in.'
            : `Every chat that has not chosen for itself speaks ${LANG_LABELS[lang] ?? lang}. A reply with nothing in that language is sent as text only, rather than read aloud in the wrong voice.`}
          {langOverrides > 0 && (
            <>
              {' '}
              {langOverrides === 1 ? 'One chat has' : `${langOverrides} chats have`} a language of{' '}
              {langOverrides === 1 ? 'its' : 'their'} own — on{' '}
              <a href="/app/chats.html" className="text-accent">
                Chats
              </a>
              , under Persona.
            </>
          )}
        </p>
        <HostNoticeLine notice={guardLang.notice} onReload={() => void guardLang.reloadTheirs().then(onChanged)} />
      </Card>
    </Section>
  )
}

/* Names, not codes — and "auto" needs saying plainly, because what the server
   actually does is read the SCRIPT of the text it is handed. It never
   translates, so the honest name is "match the reply". */
const VOICE_LABELS: Record<string, string> = {
  isla: 'Isla',
  riina: 'Riina'
}

/* What each one actually is, because "isla" and "riina" say nothing about the
   trade between them. */
const VOICE_NOTES: Record<string, string> = {
  isla: 'GPT-SoVITS on port 9880. Japanese-trained: she speaks only the Japanese part of a reply, and an English-only reply is sent as text with no voice note.',
  riina:
    'VoxCPM2 on port 9881. Speaks Japanese, English and Chinese. Japanese and English each get their own recording of her voice; Chinese borrows the English one, so it works but sounds like her English voice.'
}

const LANG_LABELS: Record<string, string> = {
  auto: 'Match the reply',
  ja: 'Japanese',
  en: 'English',
  zh: 'Chinese'
}

function HomeTab({ settings, onChanged }: { settings: Settings; onChanged: () => void }) {
  const [ip, setIp] = useState(settings.home?.ip ?? '')
  const [token, setToken] = useState('')
  const guard = useHostGuard('home', settings)

  return (
    <Section title="Home Assistant">
      <Card className="p-5">
        <p className="mt-0 mb-5 max-w-prose text-[0.92rem] text-muted">
          Where your Home Assistant lives. Saved now, wired up in a later phase. The token is write-only — it goes in
          and never comes back out.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="address">
            <Input value={ip} placeholder="192.168.x.x" onChange={(e) => setIp(e.target.value)} className="w-52" />
          </Field>
          <Field label={settings.home?.token_set ? 'token (already set)' : 'token'}>
            <Input
              type="password"
              value={token}
              autoComplete="off"
              placeholder="write-only"
              onChange={(e) => setToken(e.target.value)}
              className="w-72"
            />
          </Field>
          <Button
            variant="primary"
            disabled={guard.checking}
            onClick={async () => {
              /* The token is write-only: it is sent when present but never part
                 of the readback. The readback checks the public address plus the
                 masked `token_set` flag, and the field is cleared on success so
                 the hidden value lives nowhere in state. */
              const back = await guard.saveGuarded({
                intended: { 'home.ip': ip },
                endpoint: '/api/settings/home',
                hasWriteOnlyChange: Boolean(token),
                bodyFrom: () => ({ ip, ...(token ? { token } : {}) })
              })
              if (!back) return
              if (token && (back as unknown as Settings)?.home?.token_set !== true) {
                guard.setNotice({
                  kind: 'mismatch',
                  text: 'The host did not confirm the token — the address is kept as a draft.'
                })
                toast('host did not confirm the token — draft kept', false)
                return
              }
              setToken('')
              toast('saved ✓')
              onChanged()
            }}
          >
            <Save />
            Save
          </Button>
        </div>
        <HostNoticeLine
          notice={guard.notice}
          onReload={() =>
            void guard
              .reloadTheirs((fresh) => {
                setIp((fresh as unknown as Settings)?.home?.ip ?? '')
                setToken('')
              })
              .then(onChanged)
          }
        />
      </Card>
    </Section>
  )
}

/* ── files ────────────────────────────────────────────────────────────── */

function FilesTab({ settings, onChanged, active }: { settings: Settings; onChanged: () => void; active: boolean }) {
  const [kind, setKind] = useState<'soul' | 'rules' | 'agents'>('soul')
  const [name, setName] = useState('')
  const [text, setText] = useState('')
  const [loaded, setLoaded] = useState('')
  const [busy, setBusy] = useState(false)
  /* A name chosen in the New dialog but not yet saved. It has to survive the
     re-fetch effect below, which otherwise snaps `name` back to something that
     exists on disk the moment the list reloads. Scoped to its kind: a name
     drafted for `soul` must not pin the `rules` picker to a file that does
     not exist there. */
  const [pending, setPending] = useState<{ kind: string; name: string } | null>(null)
  const pendingName = pending && pending.kind === kind ? pending.name : null
  const [ready, setReady] = useState<{ kind: string; name: string } | null>(null)
  const [loadError, setLoadError] = useState('')
  const [fileNotice, setFileNotice] = useState<HostNotice | null>(null)
  const [readAttempt, setReadAttempt] = useState(0)
  const lastKind = useRef(kind)

  const names = useMemo(() => {
    if (kind === 'soul') return settings.personalities ?? []
    if (kind === 'rules') return settings.modes ?? []
    return []
  }, [kind, settings])

  /* Open on the file most likely meant — the persona and mode actually in
     use — instead of whatever sorts first alphabetically. This runs on kind
     changes and when the current file stops existing (e.g. after a delete),
     never on a plain settings reload: re-picking the default after every Save
     is what used to load another file over the one just written. */
  useEffect(() => {
    const kindChanged = lastKind.current !== kind
    lastKind.current = kind
    // The name is claimed by the save, not by the dialog: once the reloaded
    // list holds the pending file it is real and the hold can go.
    if (pendingName) {
      if (names.includes(pendingName)) setPending(null)
      return
    }
    // Already open on a live file — a settings reload must not move it.
    if (!kindChanged && name && names.includes(name)) return
    const want = kind === 'soul' ? settings.bindings?.defaults?.personality : settings.bindings?.defaults?.mode
    setName(names.includes(want ?? '') ? want! : (names[0] ?? ''))
  }, [kind, names, settings, pendingName, name])

  useEffect(() => {
    setLoadError('')
    if (pendingName && name === pendingName) {
      setReady({ kind, name })
      return
    }
    setReady(null)
    setText('')
    setLoaded('')
    if (names.length && !name) return
    const target = { kind, name: names.length ? name : '' }
    let live = true
    const url =
      `/api/settings/file?kind=${encodeURIComponent(kind)}` + (names.length ? `&name=${encodeURIComponent(name)}` : '')
    get<{ kind: string; name: string; text: string }>(url)
      .then((file) => {
        if (!live) return
        if (file.kind !== target.kind || file.name !== target.name || typeof file.text !== 'string')
          throw new Error('Invalid profile file response')
        setText(file.text)
        setLoaded(file.text)
        setReady(target)
      })
      .catch((error: Error) => {
        if (live) setLoadError(error.message)
      })
    return () => {
      live = false
    }
  }, [kind, name, names.length, pendingName, readAttempt])

  const editable = ready?.kind === kind && ready.name === name && !busy
  const dirty = text !== loaded

  /* Switching file, kind or tab with unsaved text used to throw the text away
     without a word — only a full page unload was guarded. Block the switch
     and keep the text instead: Save or Revert first, then move. */
  function keepUnsaved(what: string) {
    if (busy) return false
    if (!dirty) return true
    toast(`Unsaved changes kept — Save or Revert before opening ${what}`, false)
    return false
  }
  function guardedSetKind(next: 'soul' | 'rules' | 'agents') {
    if (next === kind) return
    if (!keepUnsaved('another file')) return
    setPending(null)
    setKind(next)
  }
  function guardedSetName(next: string) {
    if (next === name) return
    if (!keepUnsaved('another file')) return
    setName(next)
  }

  async function save() {
    const target = ready
    if (!editable || !target) return
    setBusy(true)
    try {
      /* A pending name exists nowhere on the host yet, so there is nothing to
         conflict with. Anything already on disk is re-read first: saving over
         text another session changed keeps the draft instead. */
      const isNew = !!pendingName && target.name === pendingName
      if (!isNew) {
        let freshText: string
        try {
          const f = await get<{ kind: string; name: string; text: string }>(
            `/api/settings/file?kind=${encodeURIComponent(target.kind)}${target.name ? `&name=${encodeURIComponent(target.name)}` : ''}`
          )
          if (f.kind !== target.kind || f.name !== target.name || typeof f.text !== 'string')
            throw new Error('Invalid profile file response')
          freshText = f.text
        } catch (e) {
          setFileNotice({
            kind: 'offline',
            text: 'The host file could not be re-read, so nothing was written and the draft is kept.'
          })
          toast((e as Error).message, false)
          return
        }
        if (freshText !== loaded) {
          setFileNotice({
            kind: 'stale',
            text: 'Changed in another session — the draft is kept. Load theirs to compare before saving again.'
          })
          toast('changed in another session — draft kept', false)
          return
        }
      }
      let receipt: { kind: string; name: string; bytes: number }
      try {
        receipt = await post<{ kind: string; name: string; bytes: number }>('/api/settings/file', {
          kind: target.kind,
          ...(target.name ? { name: target.name } : {}),
          text
        })
      } catch (e) {
        toast((e as Error).message, false)
        return
      }
      if (
        receipt.kind !== target.kind ||
        receipt.name !== target.name ||
        receipt.bytes !== new TextEncoder().encode(text).length
      ) {
        setFileNotice({
          kind: 'mismatch',
          text: 'The host acknowledgement did not match this file — the draft is kept. Reload to check the saved text.'
        })
        toast('Invalid file save acknowledgement. Reload to check the saved text.', false)
        return
      }
      setLoaded(text)
      setFileNotice(null)
      // The name is claimed by the save, not by the dialog. Pending clears in
      // the select effect once the reloaded list contains the new file —
      // clearing it here would snap the editor back to the default first.
      onChanged()
      toast('Owner profile file saved.')
    } finally {
      setBusy(false)
    }
  }

  async function reloadTheirsFile() {
    const target = ready
    if (!target) return
    try {
      const f = await get<{ kind: string; name: string; text: string }>(
        `/api/settings/file?kind=${encodeURIComponent(target.kind)}${target.name ? `&name=${encodeURIComponent(target.name)}` : ''}`
      )
      if (f.kind !== target.kind || f.name !== target.name || typeof f.text !== 'string')
        throw new Error('Invalid profile file response')
      setText(f.text)
      setLoaded(f.text)
      setFileNotice(null)
      onChanged()
    } catch (e) {
      toast((e as Error).message, false)
    }
  }

  async function remove() {
    // The native window.confirm() is gone: docs/DESIGN.md bans its sibling
    // window.prompt() by name, a browser chrome dialog in a product with a
    // designed toast system was the odd one out, and it is unstyleable and
    // unthemeable. ConfirmAction asks the question now.
    setBusy(true)
    try {
      await post('/api/settings/file_delete', { kind, name })
      setPending(null)
      onChanged()
      toast(`${name} removed`)
    } catch (e) {
      toast((e as Error).message, false)
      throw e // keep the confirm open on a refused delete
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (active && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        if (dirty && !loadError) void save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  useEffect(() => {
    function warn(e: BeforeUnloadEvent) {
      if (dirty) e.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  return (
    <Section title="Profile files">
      <Card className="p-5">
        <p className="mt-0 mb-5 max-w-prose text-[0.92rem] text-muted">
          These files configure the host owner service. The WhatsApp core loads the character pack bound to each chat.
          Review the selected file before saving.
        </p>

        <div className="flex flex-wrap items-end gap-3">
          <Field label="what kind">
            <Segmented options={['soul', 'rules', 'agents'] as const} value={kind} onChange={guardedSetKind} />
          </Field>
          {names.length > 0 && (
            <Field label="which one">
              <Picker
                ariaLabel="which personality or mode"
                placeholder="pick one…"
                searchPlaceholder="type a name…"
                value={name}
                onChange={guardedSetName}
                options={names.map((n) => ({ value: n, label: n }))}
              />
            </Field>
          )}
          {/* Add and remove. The editor could open a file and overwrite it and
              do nothing else, so a personality typed by mistake was permanent
              and the list only ever grew — an append-only log with a text box
              on it rather than a settings page. A new one opens pre-filled
              from the default of its kind, because a blank soul is not a
              starting point, it is a broken character. */}
          {kind !== 'agents' && (
            <div className="flex items-center gap-2">
              <Button
                onClick={() => {
                  if (!keepUnsaved('a new file')) return
                  const raw = window.prompt(
                    kind === 'soul'
                      ? 'Name for the new personality (letters, digits, - and _)'
                      : 'Name for the new mode (letters, digits, - and _)'
                  )
                  const fresh = (raw ?? '')
                    .trim()
                    .toLowerCase()
                    .replace(/[^a-z0-9_-]/g, '')
                  if (!fresh) return
                  if (names.includes(fresh)) {
                    toast(`${fresh} already exists — opening it`, false)
                    setName(fresh)
                    return
                  }
                  // Nothing is written until Save: the name is claimed by the
                  // save, not by the dialog, so a change of mind costs nothing.
                  setPending({ kind, name: fresh })
                  setName(fresh)
                  toast(
                    `New ${kind === 'soul' ? 'personality' : 'mode'} "${fresh}" — edit it and save to create it`,
                    true
                  )
                }}
              >
                <Plus /> New
              </Button>
              <ConfirmAction
                // A new key per target: an armed confirm must not survive a
                // change of file and delete something it no longer names.
                key={`${kind}:${name}`}
                size="md"
                label="Delete"
                confirmLabel="Delete"
                icon={<Trash2 />}
                disabled={busy || !name || !!pendingName || names.length < 2}
                question={`Delete the ${kind === 'soul' ? 'personality' : 'mode'} “${name}”?`}
                warning="The file is removed, not hidden. This can’t be undone."
                onConfirm={remove}
              />
            </div>
          )}
        </div>

        {loadError && (
          <div role="alert">
            {loadError} <Button onClick={() => setReadAttempt((n) => n + 1)}>Retry load</Button>
          </div>
        )}
        <HostNoticeLine notice={fileNotice} onReload={() => void reloadTheirsFile()} />
        <Textarea
          disabled={!editable}
          value={text}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          className="mt-4 h-[42vh] max-h-[560px] min-h-56 font-mono text-[0.8rem] leading-relaxed"
        />
      </Card>

      {/* Fixed to the viewport: impossible to scroll away from or miss. */}
      {dirty && (
        <div className="fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 items-center gap-4 rounded-full border border-accent bg-card-2 py-3 pr-3 pl-6 font-semibold shadow-float">
          <span>Unsaved changes</span>
          <Button variant="ghost" disabled={busy} onClick={() => setText(loaded)}>
            Revert
          </Button>
          <Button variant="primary" disabled={busy || !!loadError} onClick={() => void save()}>
            {busy ? <Spinner /> : <Save />}
            Save
          </Button>
        </div>
      )}
    </Section>
  )
}

/* ── page ─────────────────────────────────────────────────────────────── */

export default function SettingsPage() {
  const dashboard = useContext(DashboardContext)
  const settings = useApi<Settings>('/api/settings')
  const [tab, setTab] = useState<Tab>(() => {
    const h = location.hash.slice(1) as Tab
    /* Models, which is what the sidebar draws first. This said "markets"
       because the Chats tab was removed and the literal was swapped to its
       neighbour rather than to the new first tab — so the page opened on a
       tab nobody navigated to. */
    return TABS.some((t) => t.key === h) || (dashboard && h === 'providers') ? h : 'models'
  })

  useEffect(() => {
    /* Old deep links kept working rather than 404-ing into an empty page.
       Chats left this page for one of its own, so its three old hashes send
       readers there the same way #cron already did. */
    const moved: Record<string, string> = {
      chats: '/app/chats.html',
      proactive: '/app/chats.html',
      bindings: '/app/chats.html',
      cron: '/app/cron.html'
    }
    function route() {
      const h = location.hash.slice(1)
      if (moved[h]) {
        location.replace(moved[h])
        return
      }
      const next = h as Tab
      if (TABS.some((t) => t.key === next) || (dashboard && next === 'providers')) setTab(next)
    }
    route()
    window.addEventListener('hashchange', route)
    return () => window.removeEventListener('hashchange', route)
  }, [dashboard])

  return (
    <Shell page="settings" title="Settings">
      <Toaster />

      <div className={dashboard ? 'host-settings-view' : 'grid gap-8 lg:grid-cols-[240px_minmax(0,1fr)]'}>
        {dashboard ? (
          <WorkspaceTabs
            label="Host setting categories"
            entries={DASHBOARD_TABS.map((entry) => ({
              href: '#' + entry.key,
              label: entry.label,
              active: entry.key === tab || (entry.key === 'voice' && tab === 'avatar')
            }))}
          />
        ) : (
          <nav className="lg:sticky lg:top-6 lg:self-start">
            <Kicker className="mb-2">Sections</Kicker>
            <div className="flex flex-wrap gap-1 lg:flex-col">
              {TABS.map((t) => {
                const Icon = t.icon
                const on = t.key === tab
                return (
                  <a
                    key={t.key}
                    href={`#${t.key}`}
                    aria-current={on ? 'page' : undefined}
                    className={cn(
                      'flex min-h-11 items-center gap-2.5 rounded-card px-3 text-[0.95rem] no-underline transition-colors',
                      on ? 'bg-accent-soft font-semibold text-accent' : 'text-muted hover:bg-card-2 hover:text-ink'
                    )}
                  >
                    <Icon className="size-[18px]" />
                    {t.label}
                  </a>
                )
              })}
            </div>
          </nav>
        )}

        <div className="min-w-0">
          {settings.error && (!dashboard || tab !== 'files') && (
            <Card className="border-down/40 p-4 text-down">Could not load settings: {settings.error}</Card>
          )}
          {settings.loading && !settings.data && (!dashboard || tab !== 'files') && <Loading />}
          {dashboard && (
            <div hidden={tab !== 'files'}>
              <ProfileFiles active={tab === 'files'} />
            </div>
          )}

          {settings.data && (
            <>
              {['models', 'voice'].includes(tab) && (
                <p className="mb-3 text-muted">
                  These settings belong to the host owner service. The WhatsApp core uses its deployed model and media
                  configuration.
                </p>
              )}
              {tab === 'models' && <ModelsTab settings={settings.data} onChanged={settings.reload} />}
              {tab === 'markets' && (
                <div className={dashboard ? 'settings-bento' : undefined}>
                  <MarketsTab settings={settings.data} onChanged={settings.reload} />
                </div>
              )}
              {tab === 'avatar' && !dashboard && <AvatarTab settings={settings.data} onChanged={settings.reload} />}
              {dashboard && (tab === 'avatar' || tab === 'voice') && (
                <div className="settings-bento settings-voice">
                  <VoiceTab settings={settings.data} onChanged={settings.reload} />
                  <AvatarTab settings={settings.data} onChanged={settings.reload} />
                </div>
              )}
              {dashboard && tab === 'providers' && (
                <div className="settings-bento settings-providers">
                  {!settings.data.search && !settings.data.learning && !settings.data.lessons && (
                    <section className="dashboard-pane">
                      <h2>Providers and Learning</h2>
                      <p>The host has no provider or learning settings available.</p>
                    </section>
                  )}
                  <SearchSection settings={settings.data} onChanged={settings.reload} />
                  <div>
                    <LearningSection settings={settings.data} onChanged={settings.reload} />
                    <LessonsSection settings={settings.data} />
                  </div>
                </div>
              )}
              {!dashboard && tab === 'voice' && <VoiceTab settings={settings.data} onChanged={settings.reload} />}
              {tab === 'home' && (
                <div className="settings-bento">
                  <HomeTab settings={settings.data} onChanged={settings.reload} />
                  {dashboard && (
                    <section className="dashboard-pane">
                      <h2>Connection Settings</h2>
                      <dl>
                        <dt>Address</dt>
                        <dd>{settings.data.home?.ip || 'Unconfigured'}</dd>
                        <dt>Access token</dt>
                        <dd>{settings.data.home?.token_set ? 'Configured' : 'Missing'}</dd>
                      </dl>
                    </section>
                  )}
                </div>
              )}
              {/* Always mounted and hidden elsewhere: unmounting on every tab
                  switch is what threw unsaved file text away. Switches of file
                  and kind are guarded inside FilesTab instead. */}
              <div hidden={tab !== 'files'}>
                {!dashboard && (
                  <FilesTab active={tab === 'files'} settings={settings.data} onChanged={settings.reload} />
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </Shell>
  )
}
