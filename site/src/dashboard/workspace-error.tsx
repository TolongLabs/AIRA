import { Component, type ReactNode } from 'react'
import { dashboardHref } from './navigation'

/* Route-level recovery for the lazy dashboard workspace (docs/trd/deployment.md#dashboard-entry-recovery).
 *
 * A deploy replaces hashed page modules: a tab opened before the switch can
 * fail its dynamic import with a missing chunk. An unexpected render fault can
 * also break one route. Either must leave the shell, the main navigation and
 * the page heading in place, with one sanitized recovery and no auto-reload.
 *
 * Redaction: the fallback never prints the caught error, its message, a URL
 * or a stack, and componentDidCatch records nothing identifying. Retry is an
 * explicit button only, so a still-missing chunk cannot loop the page. */

export function isStaleChunkError(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const name = (value as { name?: unknown }).name
  const message = (value as { message?: unknown }).message
  const text = [typeof name === 'string' ? name : '', typeof message === 'string' ? message : ''].join(' ')
  return (
    text.includes('ChunkLoadError') ||
    text.includes('Failed to fetch dynamically imported module') ||
    text.includes('Importing a module script failed') ||
    text.includes('Loading chunk') ||
    text.includes('Loading CSS chunk')
  )
}

export class WorkspaceErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean; stale: boolean }> {
  state = { failed: false, stale: false }

  static getDerivedStateFromError(error: unknown) {
    return { failed: true, stale: isStaleChunkError(error) }
  }

  reload = () => {
    window.location.reload()
  }

  render() {
    if (!this.state.failed) return this.props.children
    const title = this.state.stale ? 'This view needs a refresh' : 'This view failed to load'
    return (
      <section role="alert" aria-labelledby="workspace-error-title">
        <h2 id="workspace-error-title" ref={focusHeading} tabIndex={-1}>
          {title}
        </h2>
        <p>
          {this.state.stale
            ? 'The dashboard could not load a required file. Reload to request the current version.'
            : 'This view could not be displayed. Reload the dashboard or return to Overview.'}
        </p>
        <p>
          <button type="button" onClick={this.reload}>
            Reload the dashboard
          </button>{' '}
          <a href={dashboardHref('overview')}>Back to Overview</a>
        </p>
      </section>
    )
  }
}

function focusHeading(node: HTMLHeadingElement | null) {
  node?.focus({ preventScroll: true })
}
