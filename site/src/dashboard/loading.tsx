import './loading.css'
import type { ReactNode } from 'react'

/** One live status per pending region. The visual bars carry no semantics. */
export function Loading({
  children = 'Loading…',
  layout = 'rows'
}: {
  children?: ReactNode
  layout?: 'rows' | 'cards' | 'metric'
}) {
  return (
    <span role="status" className="workspace-loading" data-layout={layout}>
      <span className="sr-only">{children}</span>
      <span aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
    </span>
  )
}
