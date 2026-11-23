import { DashboardContext } from '../dashboard/context'
import { useContext, useEffect, useRef, useState } from 'react'
import {
  Bell,
  LayoutDashboard,
  MessagesSquare,
  LineChart,
  Library,
  Network,
  Clock,
  Settings2,
  PanelLeft,
  Send,
  Sun,
  Moon
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { CursorGlow } from '@/components/ambience'

/* One shell, byte-identical across every page. The nav set and its order are
   part of the contract — a page that invents its own header is the thing that
   made this app read as several different sites.

   THE CHROME IS ISLANDS, NOT BARS.
   The header used to be a full-width row welded to the top edge: wordmark,
   six pills, a theme button, and then the page beginning underneath it. Every
   page paid the same 100px of nothing before its first fact, the nav grew
   wider than the content it navigated, and at 1440 the whole thing read as
   one jumbled band rather than as a place with rooms in it.

   So: a rail that floats clear of all four edges, collapsed to icons until
   you want it, over a page that scrolls underneath. The rail dims what it
   covers when it opens, the page ends on a footer it was lying on top of the
   whole time, and the reading column is the only full-width thing on screen. */

const NAV = [
  { href: '/', label: 'Dashboard', key: 'index', icon: LayoutDashboard },
  { href: '/app/markets.html', label: 'Markets', key: 'markets', icon: LineChart },
  { href: '/app/library.html', label: 'Library', key: 'library', icon: Library },
  { href: '/app/graph.html', label: 'Graph', key: 'graph', icon: Network },
  { href: '/app/chats.html', label: 'Chats', key: 'chats', icon: MessagesSquare },
  { href: '/app/send.html', label: 'Send', key: 'send', icon: Send },
  { href: '/app/cron.html', label: 'Cron', key: 'cron', icon: Clock },
  { href: '/app/notices.html', label: 'Notices', key: 'notices', icon: Bell },
  { href: '/app/settings.html', label: 'Settings', key: 'settings', icon: Settings2 }
] as const

export type PageKey = (typeof NAV)[number]['key']

const KEY = 'tolongai-theme'

/* Opening on a cursor that merely crossed the rail is worse than not opening
   at all; closing the instant it leaves makes the thing feel nervous. */
const OPEN_DELAY_MS = 120
const CLOSE_DELAY_MS = 200

/* Renames must not cost a reader their setting. Same migration the memento →
   mirai rename used, one hop further along. */
;(function migrateThemeKey() {
  try {
    const old = localStorage.getItem('mirai-theme')
    if (old && !localStorage.getItem(KEY)) localStorage.setItem(KEY, old)
    localStorage.removeItem('mirai-theme')
  } catch {
    /* private mode: the pre-paint script in each entry already handled it */
  }
})()

type Theme = 'light' | 'dark'

/* Two states, not three. "Auto" was a state whose button could not say what
   the page currently looked like — the reader had to know the icon meant
   "whatever the OS says", then work out what the OS was saying. The OS still
   decides the FIRST paint, because an unset key falls through to the media
   query; it stops deciding the moment anyone touches this. */
function useTheme() {
  const [theme, setTheme] = useState<Theme>('dark')

  useEffect(() => {
    const stored = localStorage.getItem(KEY)
    if (stored === 'light' || stored === 'dark') {
      setTheme(stored)
      return
    }
    setTheme(window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
  }, [])

  function toggle() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    document.documentElement.setAttribute('data-theme', next)
    localStorage.setItem(KEY, next)
  }

  return { theme, toggle }
}

/**
 * The rail. A floating glass island, detached from all four edges, that
 * expands on intent and dims what sits beneath it.
 *
 * Three triggers, not one. Hover alone would strand keyboard and touch users:
 *
 *   1. pointer hover, delayed so a cursor crossing the edge does not dim the app
 *   2. focus-visible, so tabbing in produces the same state as pointing at it
 *   3. an explicit pin, which is the only honest answer for touch
 *
 * The dim lives on one fixed scrim rendered by the shell, never as a filter
 * over the content tree: filtering a large subtree on every hover janks.
 */
function SidebarIsland({
  page,
  brand,
  onExpandedChange
}: {
  page: PageKey
  brand: string
  onExpandedChange: (expanded: boolean) => void
}) {
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [pinned, setPinned] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const expanded = pinned || hovered || focused

  useEffect(() => onExpandedChange(expanded), [expanded, onExpandedChange])
  useEffect(() => () => clearTimeout(timer.current), [])

  const schedule = (next: boolean) => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setHovered(next), next ? OPEN_DELAY_MS : CLOSE_DELAY_MS)
  }

  return (
    <nav
      aria-label="primary"
      className={cn(
        // Below md the island is the wrong shape for a thumb and hover does
        // not exist, so it is replaced by a bottom dock rather than shrunk.
        'hidden md:flex',
        'glass fixed top-4 bottom-4 left-4 flex-col rounded-[var(--radius-float)] p-2',
        'transition-[width] duration-[220ms] ease-out',
        expanded ? 'w-60' : 'w-[4.4rem]'
      )}
      style={{ zIndex: 'var(--z-island)' }}
      onPointerEnter={() => schedule(true)}
      onPointerLeave={() => schedule(false)}
      // Keyboard focus expands the island; a mouse click does not. Clicking an
      // item leaves it focused, so treating every focus as intent would hold
      // the island open until the user clicked elsewhere entirely.
      onFocus={(e) => {
        if (e.target instanceof Element && e.target.matches(':focus-visible')) setFocused(true)
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false)
      }}
    >
      <a
        href="/"
        className="flex h-12 items-center overflow-hidden rounded-[var(--radius-control)] px-2.5 no-underline"
      >
        {/* Collapsed, the wordmark is its initial — the same serif, the same
            ink, just the part that still fits. A separate icon would be a
            second logo to keep in sync with the first. */}
        <span className="font-serif text-[1.7rem] leading-none tracking-[-0.01em] text-ink">{brand.slice(0, 1)}</span>
        <span
          className={cn(
            'font-serif text-[1.7rem] leading-none tracking-[-0.01em] whitespace-nowrap text-ink transition-opacity duration-150',
            expanded ? 'opacity-100' : 'pointer-events-none opacity-0'
          )}
        >
          {brand.slice(1)}
        </span>
      </a>

      <ul className="mt-3 flex flex-1 list-none flex-col gap-1 p-0">
        {NAV.map((item) => {
          const on = item.key === page
          const Icon = item.icon
          return (
            <li key={item.key}>
              <a
                href={item.href}
                aria-current={on ? 'page' : undefined}
                title={item.label}
                className={cn(
                  'flex h-11 items-center gap-3 overflow-hidden rounded-[var(--radius-control)] px-3 text-[0.92rem] no-underline transition-colors',
                  on
                    ? 'bg-accent-soft font-semibold text-accent'
                    : 'font-medium text-muted hover:bg-card-2 hover:text-ink'
                )}
              >
                <Icon className="size-[18px] shrink-0" />
                <span
                  className={cn(
                    'whitespace-nowrap transition-opacity duration-150',
                    expanded ? 'opacity-100' : 'pointer-events-none opacity-0'
                  )}
                >
                  {item.label}
                </span>
              </a>
            </li>
          )
        })}
      </ul>

      {/* Touch has no hover and a keyboard user should not have to hold focus
          to read a label. Pinning is the accessible equivalent. */}
      <div className="border-t border-line pt-2">
        <button
          type="button"
          aria-pressed={pinned}
          aria-label={pinned ? 'Unpin the menu' : 'Pin the menu open'}
          onClick={() => setPinned((v) => !v)}
          className="flex h-11 w-full cursor-pointer items-center gap-3 overflow-hidden rounded-[var(--radius-control)] px-3 text-[0.92rem] font-medium text-muted transition-colors hover:bg-card-2 hover:text-ink"
        >
          <PanelLeft className={cn('size-[18px] shrink-0', pinned && 'text-accent')} />
          <span
            className={cn(
              'whitespace-nowrap transition-opacity duration-150',
              expanded ? 'opacity-100' : 'pointer-events-none opacity-0'
            )}
          >
            {pinned ? 'Unpin' : 'Pin open'}
          </span>
        </button>
      </div>
    </nav>
  )
}

/** The small-screen replacement for the rail, not a squeezed version of it.
 *  Touch has no hover, so labels are simply always visible, and it never dims
 *  the content: on a phone the content is the entire screen. */
function MobileDock({ page }: { page: PageKey }) {
  const dock = useRef<HTMLElement>(null)

  /* Nine labelled items need about 460px and a 390px phone gives the dock
     366, so it scrolls sideways inside its island rather than running off
     the screen, where the last two could not be reached at all. The page you
     are on is scrolled into view, so Settings is not hidden on Settings. */
  useEffect(() => {
    const nav = dock.current
    const on = nav?.querySelector<HTMLElement>('[aria-current="page"]')
    if (nav && on && nav.scrollWidth > nav.clientWidth)
      nav.scrollLeft = on.offsetLeft - (nav.clientWidth - on.offsetWidth) / 2
  }, [page])

  return (
    <nav
      ref={dock}
      aria-label="primary"
      // justify-between, not justify-around: around centres content that is
      // wider than the box, which puts the first item out of scroll reach.
      className="glass fixed inset-x-3 bottom-3 flex items-stretch justify-between overflow-x-auto rounded-[var(--radius-float)] p-1.5 [scrollbar-width:none] md:hidden"
      style={{ zIndex: 'var(--z-island)' }}
    >
      {NAV.map((item) => {
        const on = item.key === page
        const Icon = item.icon
        return (
          <a
            key={item.key}
            href={item.href}
            aria-current={on ? 'page' : undefined}
            className={cn(
              'flex min-h-12 flex-1 flex-col items-center justify-center gap-0.5 rounded-[var(--radius-control)] px-1 py-1.5 text-[0.6rem] font-medium no-underline transition-colors',
              on ? 'bg-accent-soft text-accent' : 'text-muted'
            )}
          >
            <Icon className="size-[18px]" />
            {item.label}
          </a>
        )
      })}
    </nav>
  )
}

/* Brand and zone, fetched once. Both are runtime config: the name has changed
   twice already and the zone is the whole reason the timestamps were wrong all
   morning, so neither is compiled in. Cheap, uncached-by-choice, public. */
type Env = { brand: string; tagline: string; timezone: string }

const FALLBACK: Env = {
  brand: 'TolongAI',
  tagline: 'One companion across every chat.',
  timezone: ''
}

function useEnv(): Env {
  const [env, setEnv] = useState<Env>(FALLBACK)
  useEffect(() => {
    let live = true
    fetch('/owner-api/env')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!live || !d?.brand) return
        setEnv({ brand: d.brand, tagline: d.tagline ?? FALLBACK.tagline, timezone: d.timezone ?? '' })
        // The tab still says whatever the built HTML said. Follow the brand.
        document.title = document.title.replace(/·\s*[^·]+$/, `· ${d.brand}`)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [])
  return env
}

/* HER clock, not the reader's and not the server's.
   Everything this app schedules — quiet hours, proactive openings, reminders,
   which day a conversation belongs to — happens in the client's zone, and the
   server sits twelve hours away from it. A header that shows what time the bot
   thinks it is turns "why did she message at 3am" into something you can see
   rather than something you have to reason about. */
function ClientClock({ timezone }: { timezone: string }) {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    // Tick on the minute, not every second: a seconds display in a header is
    // motion nobody asked for, and this only ever shows minutes.
    const id = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(id)
  }, [])

  /* THE CONFIGURED zone, not the browser's. It read the browser's before, and
     on a machine set to UTC that produced "Sat 16:41 Reykjavik" — a city
     nobody involved has ever been to, and worse, a time that had nothing to do
     with the one her quiet hours and her openings are computed in. The point
     of putting a clock up here was to make THAT number visible. */
  const zone = timezone
  if (!zone) return <span title="Owner timezone unavailable">Clock unavailable</span>
  let text: string
  try {
    text = new Intl.DateTimeFormat(undefined, {
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: zone
    }).format(now)
  } catch {
    return <span title="Invalid owner timezone">Clock unavailable</span>
  }

  return (
    <span
      className="tnum hidden items-baseline gap-2 sm:inline-flex"
      title={`Her clock — ${zone}. Everything she schedules happens here.`}
    >
      <span className="font-mono text-[0.78rem] text-ink">{text}</span>
      <span className="font-mono text-[0.62rem] tracking-[0.1em] text-faint uppercase">
        {(zone.split('/').pop() ?? zone).replace(/_/g, ' ')}
      </span>
    </span>
  )
}

function ThemeButton() {
  const { theme, toggle } = useTheme()
  const Icon = theme === 'dark' ? Sun : Moon
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
      title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
      className="grid size-9 cursor-pointer place-items-center rounded-[var(--radius-control)] border border-line text-muted transition-colors hover:border-accent hover:text-accent"
    >
      <Icon className="size-[17px]" />
    </button>
  )
}

/**
 * The layer the page is lying on top of.
 *
 * Fixed to the bottom of the viewport for the whole session while the page
 * above it is opaque, so reaching the end uncovers something that was always
 * there rather than scrolling a panel into view. Nothing animates; the
 * occluder moves.
 */
function SiteFooter({ env }: { env: Env }) {
  const footer = useRef<HTMLElement>(null)

  /* A fixed element's rect is always inside the viewport, so the browser sees
     no reason to scroll when focus reaches a footer link, and a keyboard user
     lands on a focus ring the page is currently covering. Guarded on `fixed`:
     below md the footer is in normal flow and the browser is already right. */
  useEffect(() => {
    const node = footer.current
    if (!node) return
    const reveal = () => {
      if (getComputedStyle(node).position !== 'fixed') return
      window.scrollTo({ top: document.documentElement.scrollHeight })
    }
    node.addEventListener('focusin', reveal)
    return () => node.removeEventListener('focusin', reveal)
  }, [])

  return (
    <footer className="site-footer" ref={footer}>
      <div className="mx-auto flex h-full max-w-[1240px] flex-col items-end justify-center gap-2 px-6 py-10 text-right">
        <span className="font-serif text-[2.2rem] leading-none tracking-[-0.01em]">{env.brand}</span>
        <p className="m-0 text-[0.95rem] font-medium opacity-90">{env.tagline}</p>
        <nav aria-label="secondary" className="mt-1 flex flex-wrap justify-end gap-x-4 gap-y-1">
          {NAV.map((item) => (
            <a
              key={item.key}
              href={item.href}
              className="text-[0.85rem] underline underline-offset-4 opacity-90 transition-opacity hover:opacity-100 hover:no-underline"
            >
              {item.label}
            </a>
          ))}
        </nav>
      </div>
    </footer>
  )
}

/* A hero SENTENCE, not a page title. The old head was "Dashboard" over a line
   of grey explanation — a label for a page the reader is already looking at,
   costing the most valuable band on the screen. This says what is true right
   now, at display size, with the numbers in full ink and the connecting words
   dropped back so the figures read first from across a room.

   `hero` is a list of tokens rather than a string because that emphasis is the
   whole effect: [{n: "249"}, {t: " words filed, "}, {n: "4"}, {t: " songs"}].

   `tone` exists for one reason: the dashboard's head states whether the thing
   is running, and a head that cannot go red cannot say "down". */
export type HeroToken = { n?: string | number; t?: string; tone?: 'down' }

function Hero({ tokens, title }: { tokens: HeroToken[]; title: string }) {
  return (
    <h1
      className="m-0 max-w-4xl [overflow-wrap:anywhere] text-balance font-serif text-[2.6rem] leading-[1.12] font-medium tracking-[-0.02em] lg:text-[3.2rem]"
      aria-label={title}
    >
      {tokens.map((tok, i) =>
        tok.n != null ? (
          <span key={i} className={cn('tnum', tok.tone === 'down' ? 'text-down' : 'text-ink')}>
            {tok.n}
          </span>
        ) : (
          <span key={i} className={tok.tone === 'down' ? 'text-down/70' : 'text-muted'}>
            {tok.t}
          </span>
        )
      )}
    </h1>
  )
}

export function Shell({
  page,
  title,
  hero,
  dek,
  actions,
  children,
  wide = false,
  full = false
}: {
  page: PageKey
  title: string
  hero?: HeroToken[]
  dek?: string
  actions?: React.ReactNode
  children: React.ReactNode
  wide?: boolean
  /** No reading column at all. For the graph, where the canvas IS the page and
   *  a 1400px cap just wastes the screen it was given. */
  full?: boolean
}) {
  const dashboard = useContext(DashboardContext)
  if (dashboard)
    return (
      <>
        {actions}
        {children}
      </>
    )
  return <LegacyShell {...{ page, title, hero, dek, actions, children, wide, full }} />
}

function LegacyShell({ page, title, hero, dek, actions, children, wide, full }: Parameters<typeof Shell>[0]) {
  const [dimmed, setDimmed] = useState(false)
  const env = useEnv()

  return (
    <>
      <CursorGlow />
      <SidebarIsland page={page} brand={env.brand} onExpandedChange={setDimmed} />
      <MobileDock page={page} />
      <div aria-hidden className="scrim" data-visible={dimmed} />

      {/* The opaque sheet. Left padding clears the collapsed rail rather than
          the expanded one: the rail opens OVER the page, which is the point of
          it being an island and the reason nothing reflows when it does. */}
      <div className="reveal-page above-ambience pb-28 md:pb-16 md:pl-[6.4rem]">
        <main className={cn('mx-auto px-5', full ? 'max-w-none' : wide ? 'max-w-[1400px]' : 'max-w-[1240px]')}>
          {/* THE HEADER.
              A masthead inside the reading column, not a band welded to the
              viewport — it scrolls away with the page because it is not a
              control surface.

              It carries three things and each one earns its place. The
              wordmark and the breadcrumb say what this is and where you are,
              which is what the rail stopped saying when navigation moved into
              it. The clock is HER clock: everything this app schedules happens
              in the client's zone and the server sits twelve hours from it, so
              seeing what time the bot thinks it is turns "why did she message
              at 3am" into something visible rather than something to reason
              about. And the theme control lives here now rather than in a
              floating island — which is also why the right edge finally lines
              up with the content beneath it, instead of being inset to dodge
              something hovering over it. */}
          <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b border-line pt-7 pb-4 md:pt-9">
            <div className="flex min-w-0 items-baseline gap-3">
              <a href="/" className="font-serif text-[1.55rem] leading-none tracking-[-0.01em] text-ink no-underline">
                {env.brand}
              </a>
              <span aria-hidden className="text-[1.1rem] leading-none text-faint">
                /
              </span>
              <span className="truncate font-mono text-[0.7rem] font-medium tracking-[0.14em] text-muted uppercase">
                {NAV.find((n) => n.key === page)?.label ?? title}
              </span>
            </div>

            <div className="flex max-w-full flex-wrap items-center gap-4">
              <ClientClock timezone={env.timezone} />
              <ThemeButton />
            </div>
          </header>

          <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4 pt-8 pb-9">
            <div className="min-w-0">
              {hero?.length ? (
                <Hero tokens={hero} title={title} />
              ) : (
                <h1 className="m-0 font-serif text-[2rem] leading-tight font-medium tracking-[-0.02em]">{title}</h1>
              )}
              {dek ? <p className="mt-2 mb-0 max-w-prose text-muted">{dek}</p> : null}
            </div>
            {actions ? <div className="flex shrink-0 items-center gap-3">{actions}</div> : null}
          </div>
          {children}
        </main>
      </div>

      <SiteFooter env={env} />
    </>
  )
}
