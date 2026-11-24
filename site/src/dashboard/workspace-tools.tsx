import { createContext, useContext, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export const WorkspaceToolsContext = createContext<HTMLDivElement | null>(null)

export function WorkspaceTools({ children }: { children: ReactNode }) {
  const host = useContext(WorkspaceToolsContext)
  return host ? createPortal(children, host) : null
}

export function WorkspaceTabs({
  label,
  entries
}: {
  label: string
  entries: { href: string; label: string; active: boolean }[]
}) {
  return (
    <nav
      className="workspace-tabs"
      aria-label={label}
      onKeyDown={(event) => {
        const links = Array.from(event.currentTarget.querySelectorAll('a'))
        const current = links.indexOf(event.target as HTMLAnchorElement)
        if (current < 0) return
        const index =
          event.key === 'ArrowRight'
            ? (current + 1) % links.length
            : event.key === 'ArrowLeft'
              ? (current + links.length - 1) % links.length
              : event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? links.length - 1
                  : -1
        if (index < 0) return
        event.preventDefault()
        links[index]?.focus()
      }}
    >
      {entries.map((entry) => (
        <a key={entry.href} href={entry.href} aria-current={entry.active ? 'page' : undefined}>
          {entry.label}
        </a>
      ))}
    </nav>
  )
}
