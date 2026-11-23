import { useEffect, useRef, useState } from 'react'
import { dashboardHref } from './navigation'
import './appearance.css'

export const APPEARANCE_KEY = 'aira-appearance'
const PREVIEW_EVENT = 'aira:appearance-preview'
const APPEARANCE_EVENT = 'aira:appearance-change'

export type AppearanceChoice = 'plain' | 'lattice' | 'stipple' | 'shader-gradient'

export const APPEARANCE_DEFAULT: AppearanceChoice = 'plain'

const CHOICES: { value: AppearanceChoice; label: string; hint: string }[] = [
  { value: 'plain', label: 'Plain', hint: 'Flat quiet base with no pattern.' },
  { value: 'lattice', label: 'Lattice', hint: 'Subdued ASCII lattice over the base.' },
  { value: 'stipple', label: 'Stipple', hint: 'Subdued ASCII stipple over the base.' },
  { value: 'shader-gradient', label: 'ShaderGradient', hint: 'Soft teal gradient drawn with CSS only.' }
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
  return <div className={'dashboard-backdrop dashboard-backdrop--' + (preview ?? saved)} aria-hidden="true" />
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

  function apply() {
    if (!dirty) return
    if (storeAppearance(preview)) {
      setSaved(preview)
      setNotice('')
    } else {
      setNotice('Browser storage is unavailable. The preview applies to this view only.')
    }
  }

  return (
    <section className="appearance">
      <a className="appearance-back" href={dashboardHref('system/settings')}>
        Back to Host Settings
      </a>
      <h2>Appearance</h2>
      <p className="appearance-lede">Choose a background. Apply saves it on this device.</p>
      <fieldset className="appearance-group">
        <legend>Finish</legend>
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
                <span className={'appearance-swatch appearance-swatch--' + choice.value} aria-hidden="true" />
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
      <div className="appearance-actions">
        <button type="button" disabled={preview === APPEARANCE_DEFAULT} onClick={() => setPreview(APPEARANCE_DEFAULT)}>
          Use Default
        </button>
        <button
          type="button"
          disabled={!dirty}
          onClick={() => {
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
      <p className="appearance-state" role="status">
        {dirty ? 'Previewing ' + labelOf(preview) + ' — nothing is saved yet.' : 'Showing ' + labelOf(saved) + '.'}
      </p>
      {notice && (
        <p className="appearance-notice" role="alert">
          {notice}
        </p>
      )}
    </section>
  )
}
