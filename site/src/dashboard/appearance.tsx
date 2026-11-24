import { useEffect, useRef, useState } from 'react'
import { toast } from '@/lib/hooks'
import './appearance.css'

export const APPEARANCE_KEY = 'aira-appearance'
const PREVIEW_EVENT = 'aira:appearance-preview'
const APPEARANCE_EVENT = 'aira:appearance-change'

export type AppearanceChoice = 'plain' | 'lattice' | 'stipple' | 'shader-gradient' | 'contours' | 'crosshatch'

export const APPEARANCE_DEFAULT: AppearanceChoice = 'plain'

const CHOICES: { value: AppearanceChoice; label: string; hint: string }[] = [
  { value: 'plain', label: 'Plain', hint: 'Tonal teal base with no pattern.' },
  { value: 'lattice', label: 'Lattice', hint: 'Subdued ASCII lattice over the base.' },
  { value: 'stipple', label: 'Stipple', hint: 'Fine dots over the tonal base.' },
  { value: 'shader-gradient', label: 'Shader Gradient', hint: 'Soft teal light across the workspace.' },
  { value: 'contours', label: 'Contours', hint: 'Soft concentric lines across the canvas.' },
  { value: 'crosshatch', label: 'Crosshatch', hint: 'Fine diagonal lines in both directions.' }
]

function labelOf(value: AppearanceChoice): string {
  return CHOICES.find((choice) => choice.value === value)?.label ?? 'Plain'
}

function normalize(value: unknown): AppearanceChoice {
  return CHOICES.some((choice) => choice.value === value) ? (value as AppearanceChoice) : APPEARANCE_DEFAULT
}

export function readStoredAppearance(): AppearanceChoice {
  try {
    return normalize(localStorage.getItem(APPEARANCE_KEY))
  } catch {
    return APPEARANCE_DEFAULT
  }
}

function storeAppearance(value: AppearanceChoice): boolean {
  try {
    localStorage.setItem(APPEARANCE_KEY, value)
    window.dispatchEvent(new CustomEvent(APPEARANCE_EVENT, { detail: value }))
    return true
  } catch {
    return false
  }
}

function useStoredAppearance(): readonly [AppearanceChoice, (value: AppearanceChoice) => void] {
  const [saved, setSaved] = useState<AppearanceChoice>(() => readStoredAppearance())
  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (event.key === null || event.key === APPEARANCE_KEY) setSaved(normalize(event.newValue))
    }
    function onLocal(event: Event) {
      setSaved(normalize((event as CustomEvent).detail))
    }
    window.addEventListener('storage', onStorage)
    window.addEventListener(APPEARANCE_EVENT, onLocal)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener(APPEARANCE_EVENT, onLocal)
    }
  }, [])
  return [saved, setSaved] as const
}

export function Backdrop() {
  useEffect(() => {
    function sync() {
      for (const key of ['glow', 'surfaces']) {
        try {
          document.documentElement.dataset[key] = localStorage.getItem('aira-' + key) ?? ''
        } catch {}
      }
    }
    sync()
    addEventListener('storage', sync)
    addEventListener('aira:display', sync)
    return () => {
      removeEventListener('storage', sync)
      removeEventListener('aira:display', sync)
    }
  }, [])
  const [saved] = useStoredAppearance()
  const [preview, setPreview] = useState<AppearanceChoice | null>(null)
  useEffect(() => {
    const handle = (event: Event) => {
      const value = (event as CustomEvent).detail
      setPreview(value == null ? null : normalize(value))
    }
    window.addEventListener(PREVIEW_EVENT, handle)
    return () => window.removeEventListener(PREVIEW_EVENT, handle)
  }, [])
  const glow = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const surface = glow.current
    if (!surface) return
    const allowed = matchMedia(
      '(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference) and (forced-colors: none)'
    )
    let frame = 0
    let x = 0,
      y = 0,
      wakeX = 0,
      wakeY = 0,
      targetX = 0,
      targetY = 0,
      previous = 0
    function tick(now: number) {
      if (!surface) return
      const dt = Math.min(48, now - previous)
      previous = now
      const mix = 1 - Math.exp(-dt / 60)
      x += (targetX - x) * mix
      y += (targetY - y) * mix
      const wakeMix = 1 - Math.exp(-dt / 125)
      wakeX += (x - wakeX) * wakeMix
      wakeY += (y - wakeY) * wakeMix
      const lag = Math.hypot(wakeX - x, wakeY - y)
      const reach = lag > 72 ? 72 / lag : 1
      surface.style.setProperty('--glow-head', `${x.toFixed(2)}px ${y.toFixed(2)}px`)
      surface.style.setProperty(
        '--glow-wake',
        `${(x + (wakeX - x) * reach).toFixed(2)}px ${(y + (wakeY - y) * reach).toFixed(2)}px`
      )
      frame = Math.hypot(targetX - x, targetY - y) > 0.25 || lag > 0.25 ? requestAnimationFrame(tick) : 0
    }
    function move(event: PointerEvent) {
      if (
        document.documentElement.dataset.glow === 'off' ||
        !allowed.matches ||
        event.pointerType !== 'mouse' ||
        !surface
      )
        return
      targetX = event.clientX
      targetY = event.clientY
      if (!surface.dataset.visible) {
        x = wakeX = targetX
        y = wakeY = targetY
        surface.style.setProperty('--glow-head', `${x}px ${y}px`)
        surface.style.setProperty('--glow-wake', `${x}px ${y}px`)
        surface.dataset.visible = 'true'
      }
      if (!frame) {
        previous = performance.now()
        frame = requestAnimationFrame(tick)
      }
    }
    function hide() {
      cancelAnimationFrame(frame)
      frame = 0
      if (surface) delete surface.dataset.visible
    }
    window.addEventListener('pointermove', move, { passive: true })
    window.addEventListener('blur', hide)
    document.documentElement.addEventListener('pointerleave', hide)
    allowed.addEventListener('change', hide)
    return () => {
      hide()
      window.removeEventListener('pointermove', move)
      window.removeEventListener('blur', hide)
      document.documentElement.removeEventListener('pointerleave', hide)
      allowed.removeEventListener('change', hide)
    }
  }, [])
  return (
    <div className={'dashboard-backdrop dashboard-backdrop--' + (preview ?? saved)} aria-hidden="true">
      <span ref={glow} className="dashboard-cursor-glow" />
    </div>
  )
}

export default function Appearance() {
  const [saved, setSaved] = useStoredAppearance()
  const [preview, setPreview] = useState<AppearanceChoice>(() => readStoredAppearance())
  const [notice, setNotice] = useState('')
  const lastSaved = useRef(saved)
  const dirty = preview !== saved

  useEffect(() => {
    setPreview((current) => (current === lastSaved.current ? saved : current))
    lastSaved.current = saved
  }, [saved])

  useEffect(() => {
    window.dispatchEvent(new CustomEvent(PREVIEW_EVENT, { detail: preview }))
    return () => {
      window.dispatchEvent(new CustomEvent(PREVIEW_EVENT, { detail: null }))
    }
  }, [preview])

  const choices = useRef<HTMLFieldSetElement>(null)
  function focusChoice(value: AppearanceChoice) {
    choices.current?.querySelector<HTMLInputElement>(`input[value="${value}"]`)?.focus({ preventScroll: true })
  }
  function apply() {
    if (!dirty) return
    if (storeAppearance(preview)) {
      focusChoice(preview)
      setSaved(preview)
      setNotice('')
      toast('Background applied.')
    } else {
      setNotice('Browser storage is unavailable. The preview applies to this view only.')
    }
  }

  return (
    <section className="appearance">
      <div className="dashboard-pane appearance-finishes">
        <h2 className="dashboard-pane-title">Background Finish</h2>
        <p className="appearance-lede">Select a finish to preview it on this device.</p>
        <fieldset ref={choices} className="appearance-group">
          <legend className="sr-only">Finish</legend>
          <div className="appearance-grid">
            {CHOICES.map((choice) => {
              const selected = preview === choice.value
              const badge = selected ? (dirty ? 'Preview' : 'Current') : choice.value === saved ? 'Current' : null
              return (
                <label key={choice.value} className="appearance-card">
                  <input
                    type="radio"
                    name="appearance-finish"
                    value={choice.value}
                    checked={selected}
                    onChange={() => {
                      setPreview(choice.value)
                      setNotice('')
                    }}
                  />
                  <span className={'appearance-swatch appearance-finish--' + choice.value} aria-hidden="true">
                    <i />
                    <i />
                  </span>
                  <span className="appearance-row">
                    <span className="appearance-name">{choice.label}</span>
                    {badge && <span className="appearance-badge">{badge}</span>}
                  </span>
                  <span className="appearance-hint">{choice.hint}</span>
                </label>
              )
            })}
          </div>
        </fieldset>
        <div className="appearance-actions" data-dirty={dirty}>
          <button
            type="button"
            disabled={!dirty}
            onClick={() => {
              focusChoice(saved)
              setPreview(saved)
              setNotice('')
            }}
          >
            Cancel
          </button>
          <button type="button" disabled={!dirty} onClick={apply}>
            Apply
          </button>
        </div>
        <p className="sr-only" role="status">
          {dirty ? 'Previewing ' + labelOf(preview) + ' — nothing is saved yet.' : 'Showing ' + labelOf(saved) + '.'}
        </p>
      </div>
      <div className="dashboard-pane appearance-display">
        <h2 className="dashboard-pane-title">Display</h2>
        <DisplayOption setting="glow" label="Cursor glow" on="on" off="off" defaultOn={true} />
        <DisplayOption setting="surfaces" label="Solid reading surfaces" on="solid" off="glass" defaultOn={false} />
      </div>
      {notice && (
        <p className="appearance-notice" role="alert">
          {notice}
        </p>
      )}
    </section>
  )
}

function DisplayOption({
  setting,
  label,
  on,
  off,
  defaultOn
}: {
  setting: string
  label: string
  on: string
  off: string
  defaultOn: boolean
}) {
  const key = 'aira-' + setting
  function read() {
    try {
      return (localStorage.getItem(key) ?? (defaultOn ? on : off)) === on
    } catch {
      return defaultOn
    }
  }
  const [value, setValue] = useState(read)
  useEffect(() => {
    const change = () => setValue(read())
    addEventListener('storage', change)
    return () => removeEventListener('storage', change)
  }, [key])
  return (
    <label className="appearance-option">
      <span>{label}</span>
      <input
        type="checkbox"
        role="switch"
        checked={value}
        onChange={(e) => {
          const next = e.target.checked
          try {
            localStorage.setItem(key, next ? on : off)
            setValue(next)
            dispatchEvent(new Event('aira:display'))
          } catch {
            toast('Device preferences could not be saved.', false)
          }
        }}
      />
    </label>
  )
}
