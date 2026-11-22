import { useCallback, useEffect, useRef, useState } from 'react'
import { get } from '@/lib/api'
import { cn } from '@/lib/utils'

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

type Toast = { id: number; text: string; ok: boolean }
let push: ((t: Toast) => void) | null = null
let nextId = 1

/** Fire-and-forget feedback. Mount <Toaster/> once per page. */
export function toast(text: string, ok = true) {
  push?.({ id: nextId++, text, ok })
}

export function Toaster() {
  const [items, setItems] = useState<Toast[]>([])
  const timers = useRef<Map<number, number>>(new Map())

  useEffect(() => {
    push = (t) => {
      setItems((xs) => [...xs, t])
      const handle = window.setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== t.id)), t.ok ? 2200 : 5000)
      timers.current.set(t.id, handle)
    }
    const pending = timers.current
    return () => {
      push = null
      pending.forEach((h) => window.clearTimeout(h))
    }
  }, [])

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2"
    >
      {items.map((t) => (
        <div
          key={t.id}
          className={cn(
            'rounded-full border px-5 py-2.5 text-[0.9rem] font-medium shadow-float',
            t.ok ? 'border-line-strong bg-card-2 text-ink' : 'border-down/40 bg-card-2 text-down'
          )}
        >
          {t.text}
        </div>
      ))}
    </div>
  )
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
