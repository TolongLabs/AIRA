import { useEffect, useRef } from 'react'

/* The ground is lit and the pointer lights it.

   A chain of soft cornflower discs behind the cursor, each chasing the one
   AHEAD of it rather than chasing the pointer directly — that is the whole
   trick. Chasing the pointer gives one lagging blob on a rubber band; chasing
   your neighbour bends the chain along the path actually travelled, which is
   what reads as a trail.

   Discs shrink and fade toward the tail so the end dissolves rather than
   stopping. Moved by `transform` only and never through React state: at
   pointer rates, a re-render per move would rebuild a subtree for decoration.

   On `prefers-reduced-motion` this stays: the preference exists to suppress
   motion the interface starts on its own — parallax, autoplay, anything that
   moves while the reader holds still. This moves only where the pointer has
   just been and stops dead when the pointer does, which puts it in the same
   category as a hover highlight. */

const TRAIL = 16
const HEAD_SIZE = 208
const TAIL_SIZE = 36
/* Reads as light on the ground, not as a blob following the cursor. The
   discs overlap heavily near the head and alpha compounds where they do, so
   this sits well below what one disc alone would need — judge it by the
   rendered result, never by the number. */
const HEAD_ALPHA = 0.09
/** How hard each disc chases the one ahead. Lower is a longer, lazier tail. */
const CHASE = 0.3

const sizeAt = (i: number) => HEAD_SIZE - (HEAD_SIZE - TAIL_SIZE) * (i / (TRAIL - 1))
/* The discs overlap heavily near the head and alpha compounds where they do,
   so the head constant sits well below what one disc alone would need. Judge
   this by the rendered result, not by the number. */
const alphaAt = (i: number) => HEAD_ALPHA * Math.pow(1 - i / (TRAIL - 1), 1.9)

export function CursorGlow() {
  const wrap = useRef<HTMLDivElement | null>(null)
  const dots = useRef<(HTMLDivElement | null)[]>([])

  useEffect(() => {
    const el = wrap.current
    if (!el) return
    /* Disable on TOUCH, rather than enabling only on a known-fine pointer.
       The failure this guards against is specific: a touch device has no
       hover, so the trail would park wherever the last tap landed. Asking for
       `pointer: fine` instead also silences it on any environment that
       reports neither — headless browsers, some Linux/Wayland setups — where
       a mouse is in fact present and the effect is wanted. */
    if (window.matchMedia('(pointer: coarse)').matches) return

    const target = { x: innerWidth / 2, y: innerHeight / 2 }
    const points = Array.from({ length: TRAIL }, () => ({ ...target }))
    const radii: number[] = []
    let started = false
    let frame = 0

    for (let i = 0; i < TRAIL; i += 1) {
      const dot = dots.current[i]
      if (!dot) continue
      const size = sizeAt(i)
      radii.push(size / 2)
      dot.style.width = `${size}px`
      dot.style.height = `${size}px`
      dot.style.setProperty('--dot-alpha', alphaAt(i).toFixed(4))
    }

    const onMove = (e: PointerEvent) => {
      target.x = e.clientX
      target.y = e.clientY
      if (!started) {
        started = true
        for (const p of points) {
          p.x = target.x
          p.y = target.y
        }
        el.style.opacity = '1'
      }
    }

    const loop = () => {
      points[0].x += (target.x - points[0].x) * CHASE
      points[0].y += (target.y - points[0].y) * CHASE
      for (let i = 1; i < TRAIL; i += 1) {
        points[i].x += (points[i - 1].x - points[i].x) * CHASE
        points[i].y += (points[i - 1].y - points[i].y) * CHASE
      }
      for (let i = 0; i < TRAIL; i += 1) {
        const dot = dots.current[i]
        if (dot) dot.style.transform = `translate3d(${points[i].x - radii[i]}px, ${points[i].y - radii[i]}px, 0)`
      }
      frame = requestAnimationFrame(loop)
    }

    addEventListener('pointermove', onMove, { passive: true })
    frame = requestAnimationFrame(loop)
    return () => {
      removeEventListener('pointermove', onMove)
      cancelAnimationFrame(frame)
    }
  }, [])

  return (
    <div
      ref={wrap}
      className="cursor-glow"
      style={{ opacity: 0, transition: 'opacity 400ms ease-out' }}
      aria-hidden="true"
    >
      {Array.from({ length: TRAIL }, (_, i) => (
        <div
          key={i}
          ref={(node) => {
            dots.current[i] = node
          }}
          className="cursor-glow-dot"
        />
      ))}
    </div>
  )
}
