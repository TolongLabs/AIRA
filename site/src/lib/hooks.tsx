import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { get } from '@/lib/api'
import { createPortal } from 'react-dom'
import hotToast, { Toaster as HotToaster, useToasterStore } from 'react-hot-toast'
import { useContext } from 'react'
import { DashboardContext } from '@/dashboard/context'

/* ── data ─────────────────────────────────────────────────────────────── */

export interface Async<T> {
  data: T | null
  error: string | null
  loading: boolean
  reload: () => Promise<T | null>
}

/** GET a JSON endpoint, with the failure surfaced instead of swallowed. */
export function useApi<T>(path: string | null): Async<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const generation = useRef(0)
  const reload = useCallback(async (): Promise<T | null> => {
    const current = ++generation.current
    if (!path) return null
    setLoading(true)
    try {
      const next = await get<T>(path)
      if (current !== generation.current) return null
      setData(next)
      setError(null)
      return next
    } catch (e) {
      if (current === generation.current) setError(e instanceof Error ? e.message : 'Owner request failed')
      return null
    } finally {
      if (current === generation.current) setLoading(false)
    }
  }, [path])
  useEffect(() => {
    setData(null)
    setError(null)
    void reload()
    return () => {
      generation.current++
    }
  }, [reload])
  return { data, error, loading, reload }
}

/* ── theme colours, resolved ──────────────────────────────────────────────
   Charts need real colour values, not `var(--accent)`: Chrome does not
   resolve CSS variables inside SVG *presentation attributes*, which is how
   recharts applies fill and stroke — so the bars rendered invisible. Read the
   computed value once and re-read whenever the theme flips. */

export function useThemeColors<K extends string>(names: Record<K, string>): Record<K, string> {
  const read = useCallback(() => {
    const cs = getComputedStyle(document.documentElement)
    const out = {} as Record<K, string>
    for (const key of Object.keys(names) as K[]) out[key] = cs.getPropertyValue(names[key]).trim()
    return out
    // names is a literal at every call site; re-reading on identity churn
    // would loop forever, so it is deliberately not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const [colors, setColors] = useState(read)

  useEffect(() => {
    const apply = () => setColors(read())
    const mo = new MutationObserver(apply)
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    })
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', apply)
    return () => {
      mo.disconnect()
      mq.removeEventListener('change', apply)
    }
  }, [read])

  return colors
}

/* ── toasts ───────────────────────────────────────────────────────────── */

export function toast(message: string, ok = true) {
  return ok ? hotToast.success(message) : hotToast.error(message)
}

export function ToastHost() {
  const { toasts } = useToasterStore()
  const visible = toasts.length > 0
  const [placed, setPlaced] = useState(false)
  const [layer] = useState(() => {
    const node = document.createElement('div')
    node.className = 'owner-toast-layer'
    node.setAttribute('popover', 'manual')
    return node
  })
  useLayoutEffect(() => {
    if (!visible) {
      setPlaced(false)
      return
    }
    function place() {
      // A native modal makes outside nodes inert. Radix hides outside content from screen readers.
      const dialog =
        document.querySelector('dialog:modal') ??
        Array.from(
          document.querySelectorAll('[role="dialog"][data-state="open"],[role="alertdialog"][data-state="open"]')
        ).at(-1)
      const host = dialog ?? document.body
      if (layer.parentElement !== host) host.append(layer)
      if (layer.showPopover && !layer.matches(':popover-open')) layer.showPopover()
    }
    place()
    // ToastBar measures on mount to start its animation. Its host must already be visible.
    setPlaced(true)
    const observer = new MutationObserver(place)
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['open', 'data-state']
    })
    return () => {
      observer.disconnect()
      layer.remove()
    }
  }, [visible, layer])
  if (!visible || !placed) return null
  return createPortal(
    <HotToaster
      position="bottom-center"
      containerStyle={{ bottom: 'max(24px, env(safe-area-inset-bottom))' }}
      toastOptions={{ className: 'owner-toast', duration: 4500, error: { duration: 6500 } }}
    />,
    layer
  )
}

export function Toaster() {
  return useContext(DashboardContext) ? null : <ToastHost />
}

/* ── misc ─────────────────────────────────────────────────────────────── */

/** Two-step destructive confirm, inline — never a native confirm() dialog. */
export function useArmed(ms = 3000) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const h = window.setTimeout(() => setArmed(false), ms)
    return () => window.clearTimeout(h)
  }, [armed, ms])
  return [armed, setArmed] as const
}
