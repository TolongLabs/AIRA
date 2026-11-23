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
import { dashboardHref, destinations, previewMount } from './navigation'
import { Overview } from './overview'
import '@/styles.css'
import './shell.css'

const ChatSettings = lazy(() => import('@/pages/chats'))
const views = {
  chats: lazy(() => import('./directory')),
  'chats/files': lazy(() => import('@/pages/send')),
  library: lazy(() => import('@/pages/library')),
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
function Dashboard() {
  const path = location.pathname.startsWith(previewMount + '/')
    ? location.pathname.slice(previewMount.length + 1)
    : 'overview'
  const section = path.split('/')[0]
  const title = destinations.find(([key]) => key === section)?.[1] ?? 'Page unavailable'
  const drawer = useRef<HTMLDialogElement>(null)
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
  const View = views[path as keyof typeof views]
  function nav(mobile: boolean) {
    return (
      <>
        <button
          className="dashboard-brand"
          aria-label={mobile ? 'Close navigation' : compact ? 'Expand sidebar' : 'Collapse sidebar'}
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
          {section === 'library' && (
            <nav aria-label="Library views">
              <a href={dashboardHref('library')}>Items</a> <a href={dashboardHref('library/graph')}>Graph</a>
            </nav>
          )}
          {section === 'system' && (
            <nav aria-label="System views">
              <a href={dashboardHref('system/health')}>Health</a>{' '}
              <a href={dashboardHref('system/settings')}>Host Settings</a>
            </nav>
          )}
          <Suspense fallback={<p role="status">Loading…</p>}>
            {path === 'overview' ? (
              <Overview />
            ) : chatRoute ? (
              <ChatSettings selectedId={chatRoute[1]} compose={chatRoute[2] === 'send'} />
            ) : View ? (
              <View />
            ) : (
              <p>Page unavailable.</p>
            )}
          </Suspense>
        </main>
      </div>
    </DashboardContext.Provider>
  )
}
createRoot(document.getElementById('root')!).render(<Dashboard />)
