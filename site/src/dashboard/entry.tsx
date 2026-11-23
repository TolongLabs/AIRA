import { authHeaders, requestToken } from '@/lib/api'
import { useCoreTransport } from '@/lib/core'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  BookOpen,
  ChartNoAxesCombined,
  Clock3,
  LayoutDashboard,
  MessagesSquare,
  Moon,
  Palette,
  PanelLeft,
  Settings,
  Sun
} from 'lucide-react'
import { DashboardContext } from './context'
import { translateLegacyBookmark } from './legacy-bookmarks'
import { dashboardHref, destinations, previewMount } from './navigation'
import { WorkspaceErrorBoundary } from './workspace-error'
import Appearance, { Backdrop } from './appearance'
import { Overview } from './overview'
import '@/styles.css'
import './shell.css'

useCoreTransport(async (path, init) => {
  const url = path.replace(/^\/api\//, '/owner-api/core/')
  const load = () =>
    fetch(url, { ...init, headers: authHeaders(Object.fromEntries(new Headers(init.headers).entries())) })
  const result = await load()
  if (result.status !== 401) return result
  await requestToken()
  return load()
})

const ChatSettings = lazy(() => import('@/pages/chats'))
const StudioEditor = lazy(() => import('./studio-editor'))
const Library = lazy(() => import('@/pages/library'))
const views = {
  'characters/simulator': lazy(() => import('./studio-editor').then((m) => ({ default: m.StudioSimulator }))),
  'system/appearance': Appearance,
  chats: lazy(() => import('./directory')),
  'chats/defaults': lazy(() => import('./chat-defaults')),
  'chats/files': lazy(() => import('@/pages/send')),
  library: Library,
  'library/graph': lazy(() => import('@/pages/graph')),
  markets: lazy(() => import('@/pages/markets')),
  automations: lazy(() => import('@/pages/cron')),
  'automations/routines': lazy(() => import('@/pages/cron')),
  'automations/notices': lazy(() => import('@/pages/notices')),
  system: lazy(() => import('@/pages/settings')),
  'system/settings': lazy(() => import('@/pages/settings')),
  characters: lazy(() => import('./characters')),
  'system/health': lazy(() => import('./health'))
}
const icons = [LayoutDashboard, MessagesSquare, Palette, BookOpen, Clock3, ChartNoAxesCombined, Settings]
function preference(key: string) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function persist(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* Session-only preference. */
  }
}
const themeKey = 'tolongai-theme'

// Legacy `#…` bookmarks resolve to canonical routes before the router parses
// the path (docs/trd/dashboard-routes.md#legacy-bookmarks-and-operations).
// Replace-only, so the legacy URL never enters history.
/** Resolve a legacy fragment on first load, before the router parses the path.
 *  Replace-only: the legacy URL never enters history, so back cannot loop.
 *  Returns true when the URL was rewritten. No-op outside a browser. */
function applyLegacyBookmark(): boolean {
  try {
    if (typeof window === 'undefined' || !window.location || !window.history?.replaceState) return false
    const { pathname, search, hash } = window.location
    const target = translateLegacyBookmark({ pathname, search, hash }, previewMount)
    if (!target) return false
    const url = target.path + target.search + target.hash
    if (url === pathname + search + hash) return false
    window.history.replaceState(null, '', url)
    return true
  } catch {
    return false
  }
}

applyLegacyBookmark()

function Dashboard() {
  const path = location.pathname.startsWith(previewMount + '/')
    ? location.pathname.slice(previewMount.length + 1)
    : 'overview'
  const section = path.split('/')[0]
  const title = destinations.find(([key]) => key === section)?.[1] ?? 'Page unavailable'
  const drawer = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const phone = window.matchMedia('(max-width: 760px)')
    function resize() {
      if (phone.matches || !drawer.current?.open) return
      drawer.current.close()
      document.getElementById('workspace')?.focus()
    }
    phone.addEventListener('change', resize)
    return () => phone.removeEventListener('change', resize)
  }, [])
  const [compact, setCompact] = useState(preference('aira-compact-rail') === 'true')
  const [theme, setTheme] = useState(() => {
    const saved = preference(themeKey)
    return saved === 'dark' || saved === 'light'
      ? saved
      : matchMedia('(prefers-color-scheme:dark)').matches
        ? 'dark'
        : 'light'
  })
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    persist(themeKey, theme)
  }, [theme])
  useEffect(() => {
    document.title = title + ' · AIRA'
  }, [title])
  const chatRoute = /^chats\/(c_[a-zA-Z0-9_-]+)\/(settings|send)$/.exec(path)
  const edit = /^characters\/([a-z0-9_-]+)\/edit$/.exec(path)
  const item = /^library\/item\/([^/]+)$/.exec(path)
  const footer = /^characters\/([a-z0-9_-]+)\/footer$/.exec(path)
  const View = path.startsWith('automations/routines/')
    ? views['automations/routines']
    : section === 'markets'
      ? views.markets
      : views[path as keyof typeof views]
  function nav(mobile: boolean) {
    return (
      <>
        <button
          className="dashboard-brand"
          aria-label={mobile ? 'AIRA, close navigation' : compact ? 'Expand sidebar' : 'AIRA, collapse sidebar'}
          onClick={() => {
            if (mobile) drawer.current?.close()
            else {
              setCompact(!compact)
              persist('aira-compact-rail', String(!compact))
            }
          }}
        >
          <img alt="" src="/app/dashboard/glyph.svg" />
          <PanelLeft aria-hidden="true" />
          <span>AIRA</span>
        </button>
        <nav aria-label="Main navigation">
          {destinations.map(([key, label], i) => {
            const Icon = icons[i]!
            return (
              <a
                key={key}
                aria-label={label}
                aria-current={section === key ? 'page' : undefined}
                href={dashboardHref(key)}
              >
                <Icon aria-hidden="true" />
                <span>{label}</span>
              </a>
            )
          })}
        </nav>
        <button
          className="dashboard-theme"
          aria-label={'Switch to ' + (theme === 'light' ? 'dark' : 'light') + ' mode'}
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        >
          {theme === 'dark' ? <Sun /> : <Moon />}
          <span>{theme === 'dark' ? 'Light Mode' : 'Dark Mode'}</span>
        </button>
      </>
    )
  }
  return (
    <DashboardContext.Provider value={true}>
      <div className="dashboard-shell" data-compact={compact}>
        <a className="dashboard-skip" href="#workspace">
          Skip to content
        </a>
        <Backdrop />
        <aside>{nav(false)}</aside>
        <header>
          <button aria-label="Open navigation" onClick={() => drawer.current?.showModal()}>
            <img alt="" src="/app/dashboard/glyph.svg" />
          </button>
          <span>AIRA</span>
        </header>
        <dialog ref={drawer} aria-label="Navigation">
          {nav(true)}
        </dialog>
        <main id="workspace" tabIndex={-1}>
          <h1>{title}</h1>
          {section === 'automations' && (
            <nav aria-label="Automation views">
              <a href={dashboardHref('automations/routines')}>Routines</a>{' '}
              <a href={dashboardHref('automations/notices')}>Session Notices</a>
            </nav>
          )}
          {section === 'system' && (
            <nav aria-label="System views">
              <a href={dashboardHref('system/health')}>Health</a>{' '}
              <a href={dashboardHref('system/settings')}>Host Settings</a>{' '}
              <a href={dashboardHref('system/appearance')}>Appearance</a>
            </nav>
          )}
          <WorkspaceErrorBoundary key={path}>
            <Suspense fallback={<p role="status">Loading…</p>}>
              {path === 'overview' ? (
                <Overview />
              ) : chatRoute ? (
                <ChatSettings selectedId={chatRoute[1]} compose={chatRoute[2] === 'send'} />
              ) : path === 'characters/new' || path === 'characters/import' || edit ? (
                <StudioEditor mode={edit ? 'edit' : path === 'characters/new' ? 'create' : 'import'} id={edit?.[1]} />
              ) : footer ? (
                <ChatSettings footerId={footer[1]} />
              ) : item || path === 'library/costs' ? (
                <Library selectedId={item?.[1]} view={item ? 'items' : 'costs'} />
              ) : View ? (
                <View />
              ) : (
                <p>Page unavailable.</p>
              )}
            </Suspense>
          </WorkspaceErrorBoundary>
        </main>
      </div>
    </DashboardContext.Provider>
  )
}
createRoot(document.getElementById('root')!, {
  // A caught view error can contain owner data. Keep the workspace recovery UI and log a fixed event only.
  onCaughtError: () => console.warn('dashboard.workspace_failed')
}).render(<Dashboard />)
