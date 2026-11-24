import { authHeaders, requestToken } from '@/lib/api'
import { useCoreTransport } from '@/lib/core'
import { lazy, startTransition, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { MouseEvent } from 'react'
import { createRoot } from 'react-dom/client'
import {
  BookOpen,
  ChartNoAxesCombined,
  Clock3,
  LayoutDashboard,
  MessagesSquare,
  Moon,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  Sun
} from 'lucide-react'
import { DashboardContext } from './context'
import { SidebarLinks } from './sidebar-links'
import { WorkspaceToolsContext, WorkspaceTabs } from './workspace-tools'
import { translateLegacyBookmark } from './legacy-bookmarks'
import { dashboardHref, destinations, previewMount } from './navigation'
import { WorkspaceErrorBoundary } from './workspace-error'
import Appearance, { Backdrop } from './appearance'
import { Loading } from './loading'
import { scrollSurface } from './scroll'
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
  system: lazy(() => import('./health')),
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

type ListPosition = { address: string; top: number; href: string; index: number }

function Dashboard() {
  const [address, setAddress] = useState(() => location.pathname + location.search)
  const path = address.split('?')[0]!.slice(previewMount.length + 1)
  const section = path.split('/')[0]
  const routeTitles: Record<string, string> = {
    chats: 'Chat Directory',
    'chats/defaults': 'Chat Defaults',
    'chats/files': 'Send File',
    'system/appearance': 'Appearance'
  }
  const title = routeTitles[path] ?? destinations.find(([key]) => key === section)?.[1] ?? 'Page unavailable'
  const drawer = useRef<HTMLDialogElement>(null)
  const [toolsHost, setToolsHost] = useState<HTMLDivElement | null>(null)
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
  useEffect(() => {
    function onPop() {
      pendingPosition.current = history.state?.listPosition ?? null
      focusOnNavigation.current = true
      startTransition(() => setAddress(location.pathname + location.search))
    }
    addEventListener('popstate', onPop)
    return () => removeEventListener('popstate', onPop)
  }, [])
  const focusOnNavigation = useRef(false)
  const pendingPosition = useRef<ListPosition | null>(null)
  useLayoutEffect(() => {
    if (!focusOnNavigation.current) return
    focusOnNavigation.current = false
    document.getElementById('workspace')?.focus({ preventScroll: true })
    const surface = scrollSurface()
    const position = pendingPosition.current
    pendingPosition.current = null
    surface.scrollTo({ top: 0, behavior: 'instant' })
    if (!position || position.address !== location.pathname + location.search) return
    const restore = () => {
      const row = Array.from(surface.querySelectorAll('a')).filter((a) => a.href === position.href)[position.index ?? 0]
      if (!row) return false
      surface.scrollTop = position.top
      row.focus({ preventScroll: true })
      return true
    }
    if (restore()) return
    const observer = new MutationObserver(() => {
      if (restore()) observer.disconnect()
    })
    observer.observe(surface, { childList: true, subtree: true })
    const cancel = () => observer.disconnect()
    surface.addEventListener('pointerdown', cancel, { once: true })
    surface.addEventListener('keydown', cancel, { once: true })
    return () => {
      observer.disconnect()
      surface.removeEventListener('pointerdown', cancel)
      surface.removeEventListener('keydown', cancel)
    }
  }, [address])

  function follow(event: MouseEvent) {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return
    const link = (event.target as Element).closest<HTMLAnchorElement>('a[href]')
    if (!link || link.target || link.hasAttribute('download')) return
    const url = new URL(link.href)
    const next = url.pathname.slice(previewMount.length + 1)
    const isEditor = (route: string) =>
      route === 'system/settings' || /^characters\/(new|import|simulator|[^/]+\/(edit|footer))$/.test(route)
    if (
      url.origin !== location.origin ||
      url.hash ||
      !url.pathname.startsWith(previewMount + '/') ||
      !destinations.some(([key]) => next === key || next.startsWith(key + '/')) ||
      isEditor(path) ||
      isEditor(next)
    )
      return
    event.preventDefault()
    drawer.current?.close()
    const target = url.pathname + url.search
    if (target === location.pathname + location.search) return
    const from = location.pathname + location.search
    const returnTo: ListPosition | undefined = history.state?.returnTo
    const position: ListPosition | undefined = link.closest('.directory, .automations-list, .lib-dash-rows')
      ? {
          address: from,
          top: scrollSurface().scrollTop,
          href: link.href,
          index: Array.from(scrollSurface().querySelectorAll('a'))
            .filter((a) => a.href === link.href)
            .indexOf(link)
        }
      : undefined
    if (position) history.replaceState({ ...history.state, listPosition: position }, '')
    pendingPosition.current = returnTo?.address === target ? returnTo : null
    history.pushState(position ? { returnTo: position } : null, '', target)
    focusOnNavigation.current = true
    startTransition(() => setAddress(target))
  }

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
          <span className="dashboard-mark" aria-hidden="true">
            <img alt="" src="/app/dashboard/glyph.svg" />
            {mobile || !compact ? <PanelLeftClose /> : <PanelLeftOpen />}
          </span>
          <span className="dashboard-wordmark">AIRA</span>
        </button>
        <SidebarLinks
          active={section}
          entries={destinations.map(([key, label], index) => ({
            key,
            label,
            href: dashboardHref(key),
            Icon: icons[index]!
          }))}
        />
        {mobile && path === 'chats' && (
          <nav aria-label="Chat tools" className="drawer-chat-tools">
            <a href={dashboardHref('chats/defaults')}>Chat Defaults</a>
            <a href={dashboardHref('chats/files')}>Send File</a>
          </nav>
        )}
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
      <div className="dashboard-shell" data-compact={compact} onClick={follow}>
        <a className="dashboard-skip" href="#workspace">
          Skip to content
        </a>
        <Backdrop />
        <aside>{nav(false)}</aside>
        <header>
          <button aria-label="Open navigation" onClick={() => drawer.current?.showModal()}>
            <img alt="" src="/app/dashboard/glyph.svg" />
          </button>
          <span aria-hidden="true">
            {chatRoute ? (chatRoute[2] === 'send' ? 'Send Message' : 'Chat Settings') : title}
          </span>
        </header>
        <dialog ref={drawer} aria-label="Navigation">
          {nav(true)}
        </dialog>
        <main id="workspace" data-page={path} tabIndex={-1}>
          {path !== 'system/appearance' &&
            !chatRoute &&
            !edit &&
            path !== 'characters/new' &&
            path !== 'characters/import' && (
              <div className="workspace-heading">
                <h1>{title}</h1>
                <div ref={setToolsHost} className="workspace-tools">
                  {section === 'automations' && (
                    <WorkspaceTabs
                      label="Automation views"
                      entries={[
                        {
                          label: 'Routines',
                          href: dashboardHref('automations/routines'),
                          active: !path.startsWith('automations/notices')
                        },
                        {
                          label: 'Session Notices',
                          href: dashboardHref('automations/notices'),
                          active: path.startsWith('automations/notices')
                        }
                      ]}
                    />
                  )}
                  {section === 'system' && path !== 'system/appearance' && (
                    <WorkspaceTabs
                      label="System views"
                      entries={[
                        {
                          label: 'Service Health',
                          href: dashboardHref('system/health'),
                          active: path === 'system' || path === 'system/health'
                        },
                        {
                          label: 'Host Settings',
                          href: dashboardHref('system/settings'),
                          active: path === 'system/settings'
                        },
                        {
                          label: 'Appearance',
                          href: dashboardHref('system/appearance'),
                          active: path === 'system/appearance'
                        }
                      ]}
                    />
                  )}
                </div>
              </div>
            )}
          <WorkspaceToolsContext.Provider value={toolsHost}>
            <Suspense key={section} fallback={<Loading layout="cards">Loading {title}…</Loading>}>
              <WorkspaceErrorBoundary key={address}>
                <div className="dashboard-view">
                  {path === 'overview' ? (
                    <Overview />
                  ) : chatRoute ? (
                    <ChatSettings selectedId={chatRoute[1]} compose={chatRoute[2] === 'send'} />
                  ) : path === 'characters/new' || path === 'characters/import' || edit ? (
                    <StudioEditor
                      mode={edit ? 'edit' : path === 'characters/new' ? 'create' : 'import'}
                      id={edit?.[1]}
                    />
                  ) : footer ? (
                    <ChatSettings footerId={footer[1]} />
                  ) : item || path === 'library/costs' ? (
                    <Library selectedId={item?.[1]} view={item ? 'items' : 'costs'} />
                  ) : View ? (
                    <View />
                  ) : (
                    <p>Page unavailable.</p>
                  )}
                </div>
              </WorkspaceErrorBoundary>
            </Suspense>
          </WorkspaceToolsContext.Provider>
        </main>
      </div>
    </DashboardContext.Provider>
  )
}
createRoot(document.getElementById('root')!, {
  // A caught view error can contain owner data. Keep the workspace recovery UI and log a fixed event only.
  onCaughtError: () => console.warn('dashboard.workspace_failed')
}).render(<Dashboard />)
