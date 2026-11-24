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
    <nav className="workspace-tabs" aria-label={label}>
      {entries.map((entry) => (
        <a key={entry.href} href={entry.href} aria-current={entry.active ? 'page' : undefined}>
          {entry.label}
        </a>
      ))}
    </nav>
  )
}
