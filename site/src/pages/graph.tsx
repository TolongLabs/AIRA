import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import { get } from '@/lib/api'
import { Shell } from '@/components/shell'
import { Input } from '@/components/ui'
import { cn, num } from '@/lib/utils'

/* The graph is a canvas app wearing the app shell. React owns the chrome —
   lens tabs, search, inspector — and the simulation owns the pixels; they
   meet at a ref, never through state, because re-rendering React at 60fps to
   move dots is how you get a slideshow. */

type Lens = 'all' | 'ideas' | 'library'

interface RawNode {
  /** the chat this was filed from — "shared library" when it belongs to no one */
  owner?: string
  /** true/false for the kinds that can finish; null for knowledge, which never does */
  done?: boolean | null
  id: string
  type: string
  label: string
  url?: string
}
interface RawEdge {
  s: string
  t: string
  r: string
}
interface GraphData {
  nodes: RawNode[]
  edges: RawEdge[]
  counts: Record<string, number>
}

interface Node extends RawNode {
  x: number
  y: number
  vx: number
  vy: number
  deg: number
}
interface Edge {
  a: Node
  b: Node
  r: string
}

const TYPE_VAR: Record<string, string> = {
  song: '--song',
  artist: '--artist',
  grammar: '--gram',
  pattern: '--gram',
  vocab: '--vocab',
  word: '--vocab',
  idea: '--mem',
  note: '--mem'
}

/** Connections must be visible at a glance: 4px isolated, ~10px at three
 *  links, capped at 22 for hubs. */
const radius = (deg: number) => 4 + Math.min(18, Math.pow(deg, 0.6) * 3.2)

const REP = 1600
const SPRING = 0.03
const LEN = 80
const CENTER = 0.0009
const DAMP = 0.82
/* A node may not cross more than this per step. Without a ceiling the first
   frames at full alpha hand every node an enormous impulse — 300-odd nodes
   all repelling at once — and the graph visibly detonates before it settles. */
const MAX_V = 14
/* Iterations run before the first paint. The layout arrives composed instead
   of arriving as an explosion the reader has to sit through; at ~300 nodes
   this is a fraction of a second, once, on load. */
const PREWARM = 140
/* What is left running when the reader first sees it: enough to breathe and
   to answer a drag, not enough to wander. */
const SETTLED_ALPHA = 0.05

/** One integration step over the whole layout. Lives outside the component so
 *  the pre-warm loop and the animation frame run the IDENTICAL physics —
 *  settling with one set of forces and then displaying under another is how a
 *  graph that looked calm on load starts drifting a second later. */
function integrate(s: { nodes: Node[]; edges: Edge[]; alpha: number; drag: Node | null }) {
  const { nodes, edges } = s
  for (let i = 0; i < nodes.length; i++) {
    const ni = nodes[i]
    for (let j = i + 1; j < nodes.length; j++) {
      const nj = nodes[j]
      let dx = ni.x - nj.x,
        dy = ni.y - nj.y
      let d2 = dx * dx + dy * dy
      if (d2 < 1) {
        d2 = 1
        dx = Math.random() - 0.5
        dy = Math.random() - 0.5
      }
      if (d2 > 640000) continue // far enough to ignore
      const f = ((REP * (1 + (ni.deg + nj.deg) * 0.05)) / d2) * s.alpha
      const d = Math.sqrt(d2)
      const fx = (dx / d) * f,
        fy = (dy / d) * f
      ni.vx += fx
      ni.vy += fy
      nj.vx -= fx
      nj.vy -= fy
    }
  }
  for (const e of edges) {
    const dx = e.b.x - e.a.x,
      dy = e.b.y - e.a.y
    const d = Math.hypot(dx, dy) || 1
    const rest = LEN * (1 + Math.min(1.6, (e.a.deg + e.b.deg) * 0.015))
    const f = SPRING * (d - rest) * s.alpha
    const fx = (dx / d) * f,
      fy = (dy / d) * f
    e.a.vx += fx
    e.a.vy += fy
    e.b.vx -= fx
    e.b.vy -= fy
  }
  for (const n of nodes) {
    if (n === s.drag) continue
    n.vx -= n.x * CENTER
    n.vy -= n.y * CENTER
    n.vx *= DAMP
    n.vy *= DAMP
    const speed = Math.hypot(n.vx, n.vy)
    if (speed > MAX_V) {
      n.vx = (n.vx / speed) * MAX_V
      n.vy = (n.vy / speed) * MAX_V
    }
    n.x += n.vx
    n.y += n.vy
  }
  s.alpha *= 0.985
}

export default function GraphPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [lens, setLens] = useState<Lens>('all')
  const [query, setQuery] = useState('')
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [total, setTotal] = useState({ nodes: 0, edges: 0 })
  /* There was no loading state at all, so "no data yet" and "nothing filed"
     were the same screen — an empty state without this flashes on every mount
     and every lens switch. */
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selected, setSelected] = useState<{
    label: string
    type: string
    owner?: string
    done?: boolean | null
    url?: string
    links: { label: string; type: string; url?: string }[]
  } | null>(null)

  /* everything the simulation mutates lives here, out of React's way */
  const sim = useRef({
    nodes: [] as Node[],
    edges: [] as Edge[],
    alpha: 1,
    view: { cx: 0, cy: 0, s: 1 },
    drag: null as Node | null,
    pan: null as { x: number; y: number } | null,
    hover: null as Node | null,
    query: '',
    raf: 0
  })

  const matches = useCallback((n: Node) => !sim.current.query || n.label.toLowerCase().includes(sim.current.query), [])

  /* ── load + seed ─────────────────────────────────────────────────────── */
  useEffect(() => {
    let live = true
    setLoadError(null)
    get<GraphData>(`/api/graph?lens=${lens}`)
      .then((d) => {
        if (!live) return
        const byId = new Map<string, Node>()
        const nodes: Node[] = d.nodes.map((r) => {
          const n: Node = { ...r, x: 0, y: 0, vx: 0, vy: 0, deg: 0 }
          byId.set(r.id, n)
          return n
        })
        const edges: Edge[] = []
        for (const e of d.edges) {
          const a = byId.get(e.s),
            b = byId.get(e.t)
          if (!a || !b) continue
          a.deg++
          b.deg++
          edges.push({ a, b, r: e.r })
        }

        /* Hub-seeded layout: the best-connected nodes get placed on a ring far
         apart, and their satellites spiral out beside them. Random seeding
         made every cluster start on top of every other and then explode. */
        const hubs = [...nodes]
          .filter((n) => n.deg >= 5)
          .sort((a, b) => b.deg - a.deg)
          .slice(0, 12)
        const hubOf = new Map<Node, Node>()
        hubs.forEach((h, i) => {
          const R = 260 + 22 * hubs.length
          const a = (i / Math.max(1, hubs.length)) * Math.PI * 2
          h.x = Math.cos(a) * R
          h.y = Math.sin(a) * R
          hubOf.set(h, h)
        })
        const GOLDEN = Math.PI * (3 - Math.sqrt(5))
        let k = 0
        for (const n of nodes) {
          if (hubOf.has(n)) continue
          const near = edges.find((e) => (e.a === n && hubOf.has(e.b)) || (e.b === n && hubOf.has(e.a)))
          const hub = near ? (near.a === n ? near.b : near.a) : null
          const step = k++
          const ang = step * GOLDEN
          const rad = 40 + Math.sqrt(step + 1) * 26
          n.x = (hub?.x ?? 0) + Math.cos(ang) * rad
          n.y = (hub?.y ?? 0) + Math.sin(ang) * rad
        }

        sim.current.nodes = nodes
        sim.current.edges = edges

        /* Settle it before anybody sees it. The seeding is a guess; the physics
         is what turns it into a layout, and watching that happen is not a
         feature — it reads as the page malfunctioning. */
        const warm = { nodes, edges, alpha: 1, drag: null }
        for (let i = 0; i < PREWARM; i++) integrate(warm)
        for (const n of nodes) {
          n.vx = 0
          n.vy = 0
        }
        sim.current.alpha = SETTLED_ALPHA
        setCounts(d.counts)
        setLoaded(true)
        setLoadError(null)
        setTotal({ nodes: nodes.length, edges: edges.length })
        setSelected(null)
      })
      .catch((e: Error) => {
        if (!live) return
        /* Do not leave the previous lens on screen as if it were this one. */
        sim.current.nodes = []
        sim.current.edges = []
        sim.current.alpha = SETTLED_ALPHA
        setCounts({})
        setTotal({ nodes: 0, edges: 0 })
        setSelected(null)
        setLoaded(true)
        setLoadError(e.message)
      })
    return () => {
      live = false
    }
  }, [lens])

  useEffect(() => {
    sim.current.query = query.trim().toLowerCase()
  }, [query])

  /* ── the loop ────────────────────────────────────────────────────────── */
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    let W = 0,
      H = 0

    const css = getComputedStyle(document.documentElement)
    let theme = readTheme()
    function readTheme() {
      const v = (n: string) => css.getPropertyValue(n).trim()
      return {
        paper: v('--card'),
        ink: v('--ink'),
        faint: v('--faint'),
        muted: v('--muted'),
        accent: v('--accent'),
        type: Object.fromEntries(Object.entries(TYPE_VAR).map(([k, varName]) => [k, v(varName)])) as Record<
          string,
          string
        >
      }
    }
    const themeWatch = new MutationObserver(() => {
      theme = readTheme()
    })
    themeWatch.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    })

    function resize() {
      const dpr = window.devicePixelRatio || 1
      W = canvas!.clientWidth
      H = canvas!.clientHeight
      canvas!.width = W * dpr
      canvas!.height = H * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    window.addEventListener('resize', resize)

    const s = sim.current
    const sx = (x: number) => (x - s.view.cx) * s.view.s + W / 2
    const sy = (y: number) => (y - s.view.cy) * s.view.s + H / 2
    const wx = (x: number) => (x - W / 2) / s.view.s + s.view.cx
    const wy = (y: number) => (y - H / 2) / s.view.s + s.view.cy

    function step() {
      if (s.alpha > 0.02) integrate(s)
      draw()
      s.raf = requestAnimationFrame(step)
    }

    function draw() {
      ctx.clearRect(0, 0, W, H)
      const { nodes, edges } = s
      if (!nodes.length) return

      /* --faint, not --line: on an AMOLED ground the hairline token is very
         nearly black and the edges disappeared entirely. */
      ctx.lineWidth = 1.25
      ctx.strokeStyle = theme.faint
      for (const e of edges) {
        const dim = s.query && !(matches(e.a) || matches(e.b))
        ctx.globalAlpha = dim ? 0.08 : 0.65
        ctx.beginPath()
        ctx.moveTo(sx(e.a.x), sy(e.a.y))
        ctx.lineTo(sx(e.b.x), sy(e.b.y))
        ctx.stroke()
      }

      for (const n of nodes) {
        const ok = matches(n)
        ctx.globalAlpha = s.query && !ok ? 0.12 : 1
        ctx.fillStyle = theme.type[n.type] ?? theme.muted
        ctx.beginPath()
        ctx.arc(sx(n.x), sy(n.y), radius(n.deg) * s.view.s, 0, Math.PI * 2)
        ctx.fill()
      }

      ctx.globalAlpha = 1
      const labelled = [...nodes].sort((a, b) => b.deg - a.deg).slice(0, 16)
      for (const n of labelled) {
        if (n.deg < 3) continue
        const px = Math.round(12 + Math.min(6, n.deg * 0.5))
        ctx.font = `${px}px system-ui, -apple-system, sans-serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'bottom'
        ctx.lineWidth = 3
        ctx.strokeStyle = theme.paper
        const x = sx(n.x),
          y = sy(n.y) - radius(n.deg) * s.view.s - 5
        ctx.strokeText(n.label, x, y)
        ctx.fillStyle = theme.ink
        ctx.fillText(n.label, x, y)
      }
      ctx.lineWidth = 1
    }

    function nodeAt(px: number, py: number) {
      const { nodes } = s
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i]
        const hit = Math.max(12, radius(n.deg) * s.view.s + 4)
        if (Math.hypot(sx(n.x) - px, sy(n.y) - py) <= hit) return n
      }
      return null
    }

    function pos(e: PointerEvent) {
      const r = canvas!.getBoundingClientRect()
      return { x: e.clientX - r.left, y: e.clientY - r.top }
    }

    function onDown(e: PointerEvent) {
      const p = pos(e)
      const n = nodeAt(p.x, p.y)
      canvas!.setPointerCapture(e.pointerId)
      if (n) {
        s.drag = n
        s.alpha = Math.max(s.alpha, 0.35) // a drag wakes the layout
        setSelected({
          label: n.label,
          type: n.type,
          owner: n.owner,
          done: n.done,
          url: n.url,
          links: s.edges
            .filter((edge) => edge.a === n || edge.b === n)
            .map((edge) => (edge.a === n ? edge.b : edge.a))
            .slice(0, 40)
            .map((m) => ({ label: m.label, type: m.type, url: m.url }))
        })
      } else {
        s.pan = { x: p.x, y: p.y }
      }
    }
    function onMove(e: PointerEvent) {
      const p = pos(e)
      if (s.drag) {
        s.drag.x = wx(p.x)
        s.drag.y = wy(p.y)
        s.drag.vx = 0
        s.drag.vy = 0
      } else if (s.pan) {
        s.view.cx -= (p.x - s.pan.x) / s.view.s
        s.view.cy -= (p.y - s.pan.y) / s.view.s
        s.pan = { x: p.x, y: p.y }
      } else {
        canvas!.style.cursor = nodeAt(p.x, p.y) ? 'pointer' : 'grab'
      }
    }
    function onUp() {
      s.drag = null
      s.pan = null
    }
    function onWheel(e: WheelEvent) {
      e.preventDefault()
      const r = canvas!.getBoundingClientRect()
      const mx = e.clientX - r.left,
        my = e.clientY - r.top
      const before = { x: wx(mx), y: wy(my) }
      const k = Math.exp(-e.deltaY * 0.0015)
      s.view.s = Math.min(4, Math.max(0.15, s.view.s * k))
      s.view.cx = before.x - (mx - W / 2) / s.view.s
      s.view.cy = before.y - (my - H / 2) / s.view.s
    }

    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointercancel', onUp)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    s.raf = requestAnimationFrame(step)

    return () => {
      cancelAnimationFrame(s.raf)
      themeWatch.disconnect()
      window.removeEventListener('resize', resize)
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onUp)
      canvas.removeEventListener('wheel', onWheel)
    }
  }, [matches])

  const legend = useMemo(
    () =>
      Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6),
    [counts]
  )

  return (
    <Shell
      page="graph"
      title="Graph"
      hero={
        /* A brand-new instance has nothing filed, and "0 nodes, 0 connections"
           at 3.2rem is a headline about an absence. Say it in words instead. */
        total.nodes
          ? [{ n: num(total.nodes) }, { t: ' nodes, ' }, { n: num(total.edges) }, { t: ' connections' }]
          : [{ t: 'Nothing filed yet' }]
      }
      full
    >
      {/* The canvas is the page. Taller too — the old height left a band of
          empty paper under it at every viewport over about 900px. */}
      <div className="relative h-[calc(100vh-190px)] min-h-[560px] overflow-hidden rounded-card border border-line bg-card">
        <canvas ref={canvasRef} className="block size-full touch-none" style={{ cursor: 'grab' }} />

        {/* Nothing draws on an empty graph, so without this the page is a
            blank rectangle with a zero in the corner. Nothing here creates
            nodes — she files them as she talks — so the empty state points at
            the place where that happens rather than offering a dead button. */}
        {loaded && !total.nodes && !loadError && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
            <div className="pointer-events-auto max-w-md text-center">
              <b className="mb-2 block font-serif text-[1.3rem] leading-tight font-normal">
                {lens === 'all' ? 'Nothing filed yet' : `Nothing filed under ${lens} yet`}
              </b>
              <p className="mt-0 mb-4 text-[0.92rem] text-muted">
                This draws itself from what she files as you talk to her — notes, people, songs and the words they
                teach.
                {lens !== 'all' && ' Other lenses may have something.'}
              </p>
              <a
                href="/app/chats.html"
                className="inline-flex min-h-11 items-center rounded-card border border-line px-4 text-[0.9rem] text-accent"
              >
                Go to Chats
              </a>
            </div>
          </div>
        )}

        {/* controls float over the canvas, not in a bar that steals its height */}
        <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-wrap items-start justify-between gap-3 p-3">
          <div className="pointer-events-auto flex gap-1 rounded-full border border-line bg-card/90 p-1 backdrop-blur">
            {(['all', 'ideas', 'library'] as Lens[]).map((l) => (
              <button
                key={l}
                type="button"
                aria-pressed={l === lens}
                onClick={() => {
                  setLoadError(null)
                  setLens(l)
                }}
                className={cn(
                  'min-h-9 cursor-pointer rounded-full border-0 px-4 text-[0.88rem] font-medium capitalize transition-colors',
                  l === lens ? 'bg-accent-soft text-accent' : 'bg-transparent text-muted hover:text-ink'
                )}
              >
                {l}
              </button>
            ))}
          </div>

          <div className="pointer-events-auto relative">
            <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
            <Input
              value={query}
              placeholder="search nodes…"
              onChange={(e) => setQuery(e.target.value)}
              className="w-64 bg-card/90 pl-9 backdrop-blur"
            />
          </div>
        </div>

        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-wrap items-end justify-between gap-3 p-3 text-[0.78rem]">
          {/* An empty legend still drew its capsule — a bordered pill with
              nothing inside it, floating over a blank canvas. */}
          {legend.length > 0 && (
            <div className="pointer-events-auto flex flex-wrap gap-3 rounded-full border border-line bg-card/90 px-4 py-2 backdrop-blur">
              {legend.map(([type, n]) => (
                <span key={type} className="flex items-center gap-1.5 text-muted">
                  <span
                    className="size-2 rounded-full"
                    style={{
                      background: `var(${TYPE_VAR[type] ?? '--muted'})`
                    }}
                  />
                  <span className="font-mono uppercase tracking-[0.08em]">{type}</span>
                  <span className="tnum">{n}</span>
                </span>
              ))}
            </div>
          )}
          {total.nodes > 0 && (
            <span className="rounded-full border border-line bg-card/90 px-4 py-2 text-muted backdrop-blur">
              {total.nodes} nodes · {total.edges} edges
            </span>
          )}
          {loadError && (
            <span
              role="alert"
              className="pointer-events-auto rounded-full border border-down/40 bg-card/90 px-4 py-2 text-down backdrop-blur"
            >
              Could not load {lens}: {loadError}
            </span>
          )}
        </div>

        {selected && (
          <aside className="absolute top-16 right-3 max-h-[70%] w-80 overflow-auto rounded-card border border-line bg-card p-4 shadow-float">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="m-0 font-mono text-[0.66rem] uppercase tracking-[0.12em] text-muted">{selected.type}</p>
                <h3 className="mt-1 mb-0 font-serif text-[1.3rem]">{selected.label}</h3>
                {/* Whose it is, and whether it is finished. A node carried its
                    scope in the database all along and nothing ever showed it,
                    so every entry read as an ownerless fact. `done` is null for
                    knowledge — only a reminder or a follow-up can be over. */}
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <span className="rounded-full bg-soft px-2 py-0.5 text-[0.7rem] text-muted">
                    {selected.owner ?? 'shared library'}
                  </span>
                  {selected.done === true && (
                    <span className="rounded-full bg-soft px-2 py-0.5 text-[0.7rem] text-up">done</span>
                  )}
                  {selected.done === false && (
                    <span className="rounded-full bg-soft px-2 py-0.5 text-[0.7rem] text-accent">still open</span>
                  )}
                </div>
              </div>
              <button
                type="button"
                aria-label="close"
                onClick={() => setSelected(null)}
                className="cursor-pointer border-0 bg-transparent p-1 text-muted hover:text-ink"
              >
                <X className="size-4" />
              </button>
            </div>

            {selected.url && (
              <a
                href={`/app/library.html#${selected.url}`}
                className="mt-3 inline-block text-[0.9rem] text-accent no-underline hover:underline"
              >
                open in the library →
              </a>
            )}

            <p className="mt-4 mb-1 font-mono text-[0.66rem] uppercase tracking-[0.12em] text-muted">connected to</p>
            {selected.links.map((l, i) => (
              <a
                key={`${l.label}-${i}`}
                href={l.url ? `/app/library.html#${l.url}` : undefined}
                className="flex items-center gap-2 border-t border-line-2 py-1.5 text-[0.9rem] text-ink no-underline first:border-t-0 hover:text-accent"
              >
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={{
                    background: `var(${TYPE_VAR[l.type] ?? '--muted'})`
                  }}
                />
                <span className="truncate">{l.label}</span>
              </a>
            ))}
            {!selected.links.length && <p className="text-[0.9rem] text-muted">Nothing yet.</p>}
          </aside>
        )}
      </div>
    </Shell>
  )
}
