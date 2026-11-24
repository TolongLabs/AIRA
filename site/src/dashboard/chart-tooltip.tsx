import { autoUpdate, flip, offset, shift, useFloating } from '@floating-ui/react-dom'
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export function useChartTooltip() {
  const plot = useRef<HTMLDivElement>(null)
  const id = useId()
  const [active, setActive] = useState<number | null>(null)
  const pinned = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const hold = useCallback(() => clearTimeout(timer.current), [])
  const hide = useCallback(() => {
    hold()
    pinned.current = false
    setActive(null)
  }, [hold])
  function show(index: number) {
    hold()
    setActive(index)
  }
  function hover(index: number) {
    if (!pinned.current) show(index)
  }
  function pin(index: number) {
    if (pinned.current && active === index) hide()
    else {
      pinned.current = true
      show(index)
    }
  }
  function leave() {
    hold()
    if (!pinned.current) timer.current = setTimeout(hide, 160)
  }
  const open = active !== null
  useEffect(() => {
    if (!open) return
    const away = (event: PointerEvent) => {
      const target = event.target as Node
      if (!plot.current?.contains(target) && !document.getElementById(id)?.contains(target)) hide()
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') hide()
    }
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', escape)
    return () => {
      hold()
      document.removeEventListener('pointerdown', away)
      document.removeEventListener('keydown', escape)
    }
  }, [open, hide, hold, id])
  return { plot, id, active, hide, hover, show, pin, leave, hold }
}

export function ChartTooltip({ tip, children }: { tip: ReturnType<typeof useChartTooltip>; children: ReactNode }) {
  const { plot, active } = tip
  // Anchor above the selected column so the tooltip never covers neighboring day cells.
  const reference = useMemo(() => {
    const chart = plot.current
    const cell = active === null ? null : chart?.children[active]
    if (!chart || !cell) return null
    return {
      contextElement: cell,
      getBoundingClientRect() {
        const { x, width } = cell.getBoundingClientRect()
        const { y, height } = chart.getBoundingClientRect()
        return new DOMRect(x, y, width, height)
      }
    }
  }, [plot, active])
  const { refs, floatingStyles, isPositioned } = useFloating({
    elements: { reference },
    placement: 'top',
    strategy: 'fixed',
    open: !!reference,
    middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate
  })
  if (!reference) return null
  return createPortal(
    <div
      id={tip.id}
      role="tooltip"
      ref={refs.setFloating}
      className="aira-tooltip chart-tooltip"
      style={{ ...floatingStyles, visibility: isPositioned ? 'visible' : 'hidden' }}
      onPointerEnter={tip.hold}
      onPointerLeave={tip.leave}
    >
      {children}
    </div>,
    document.body
  )
}
