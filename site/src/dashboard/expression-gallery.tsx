import { useEffect, useRef, useState, type FormEvent } from 'react'
import { authHeaders, requestToken } from '@/lib/api'
import './expression-gallery.css'

/* Standalone expression gallery. The orchestrator owns routing: this component
 * never links to dashboard paths and never touches shared dashboard files. All
 * reads and writes go through the core's protected prefix
 * (/owner-api/core/…), never the tokenless /api/. */

export interface ExpressionGalleryProps {
  id: string
  writable: boolean
}

interface ExpressionEntry {
  name: string
  description: string
}

interface ListAnswer {
  revision: string
  expressions: ExpressionEntry[]
}

export class GalleryError extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(code)
  }
}

const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp'] as const
const FOUR_MIB = 4 * 1024 * 1024
const LIMIT = 50
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/

function expressionsUrl(id: string, name?: string): string {
  const base = '/owner-api/core/characters/' + encodeURIComponent(id) + '/expressions'
  return name === undefined ? base : base + '/' + encodeURIComponent(name)
}

async function readJson<T>(request: () => Promise<Response>): Promise<T> {
  let response = await request()
  if (response.status === 401) {
    await requestToken()
    response = await request()
  }
  const parsed = (await response.json().catch(() => ({}))) as { error?: string }
  if (!response.ok)
    throw new GalleryError(response.status, typeof parsed.error === 'string' ? parsed.error : 'http_' + response.status)
  return parsed as T
}

function listExpressions(id: string): Promise<ListAnswer> {
  return readJson(() =>
    fetch(expressionsUrl(id), { headers: authHeaders({ accept: 'application/json' }), cache: 'no-store' })
  )
}

function uploadExpression(
  id: string,
  expectedRevision: string,
  name: string,
  description: string,
  mime: string,
  data: string
): Promise<{ revision: string }> {
  return readJson(() =>
    fetch(expressionsUrl(id), {
      method: 'POST',
      headers: authHeaders({ accept: 'application/json', 'content-type': 'application/json' }),
      body: JSON.stringify({ expectedRevision, name, description, mime, data }),
      cache: 'no-store'
    })
  )
}

async function fetchPreview(id: string, name: string, signal: AbortSignal): Promise<Blob> {
  const load = () => fetch(expressionsUrl(id, name), { headers: authHeaders({ accept: 'image/*' }), signal })
  let response = await load()
  if (response.status === 401) {
    await requestToken()
    response = await load()
  }
  if (!response.ok) throw new GalleryError(response.status, 'preview_' + response.status)
  return response.blob()
}

function readAsBase64(file: File): Promise<{ mime: string; data: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('unreadable'))
    reader.onload = () => {
      const url = String(reader.result ?? '')
      const comma = url.indexOf(',')
      if (!url.startsWith('data:') || comma < 0) {
        reject(new Error('unreadable'))
        return
      }
      const mime = url.slice(5, comma).split(';')[0] ?? ''
      resolve({ mime, data: url.slice(comma + 1) })
    }
    reader.readAsDataURL(file)
  })
}

/* Submit-time checks only: typing never validates and never hits the network. */
function validateFields(name: string, description: string, file: File | null, count: number): string[] {
  const faults: string[] = []
  if (!NAME_PATTERN.test(name.trim()))
    faults.push('Name: 1–64 characters — lowercase letters, digits, - or _, starting with one of those.')
  const blurb = description.trim()
  if (blurb.length > 300 || /[\r\n]/.test(blurb)) faults.push('Description: one line, up to 300 characters.')
  if (count >= LIMIT) faults.push('The gallery holds 50 expressions already.')
  if (!file) faults.push('Choose a PNG, JPEG or WebP file.')
  else {
    if (!ACCEPTED.includes(file.type as (typeof ACCEPTED)[number]))
      faults.push('That format is not accepted. Use PNG, JPEG or WebP.')
    if (file.size > FOUR_MIB) faults.push('That file is over 4 MB.')
  }
  return faults
}

/* Safe statuses: the server's raw text never reaches the chat surface. */
function saveFailure(error: unknown): string {
  if (error instanceof GalleryError) {
    if (error.status === 413) return 'That file is over the 4 MB limit.'
    if (error.status === 415) return 'That format is not accepted. Use PNG, JPEG or WebP.'
    if (error.status === 400) return 'The name or description was rejected. Check the format and try again.'
    if (error.status === 403) return 'This pack is read-only.'
    if (error.status === 404) return 'This character was not found.'
  }
  if (error instanceof Error && error.message === 'unreadable') return 'That file could not be read. Pick it again.'
  return 'The upload failed. Nothing was saved.'
}

export default function ExpressionGallery({ id, writable }: ExpressionGalleryProps) {
  const [entries, setEntries] = useState<ExpressionEntry[] | null>(null)
  const [revision, setRevision] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [previews, setPreviews] = useState<Record<string, string>>({})
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [faults, setFaults] = useState<string[]>([])
  const [conflict, setConflict] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const nameInputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const urlsRef = useRef<Record<string, string>>({})

  useEffect(() => {
    let live = true
    setLoading(true)
    setLoadError(false)
    setStatus(null)
    listExpressions(id).then(
      (answer) => {
        if (!live) return
        setRevision(answer.revision)
        setEntries(answer.expressions)
        setLoading(false)
      },
      () => {
        if (!live) return
        setLoading(false)
        setLoadError(true)
      }
    )
    return () => {
      live = false
    }
  }, [id])

  const namesKey = (entries ?? []).map((entry) => entry.name).join('\x00')

  useEffect(() => {
    if (!entries) return
    let live = true
    const previous = urlsRef.current
    const controller = new AbortController()
    async function load() {
      const next: Record<string, string> = {}
      for (const entry of entries ?? []) {
        if (!live) return
        try {
          const blob = await fetchPreview(id, entry.name, controller.signal)
          if (!live) return
          next[entry.name] = URL.createObjectURL(blob)
        } catch {
          /* A missing tile never blocks the names that did load. */
        }
      }
      if (!live) return
      urlsRef.current = next
      setPreviews(next)
      for (const url of Object.values(previous)) URL.revokeObjectURL(url)
    }
    void load()
    return () => {
      live = false
      controller.abort()
    }
  }, [id, namesKey])

  useEffect(
    () => () => {
      for (const url of Object.values(urlsRef.current)) URL.revokeObjectURL(url)
      urlsRef.current = {}
    },
    []
  )

  async function reloadList(): Promise<void> {
    const answer = await listExpressions(id)
    setRevision(answer.revision)
    setEntries(answer.expressions)
  }

  function openDialog(): void {
    setFaults([])
    setConflict(null)
    if (!dialogRef.current?.open) dialogRef.current?.showModal()
    requestAnimationFrame(() => nameInputRef.current?.focus())
  }

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault()
    const checked = validateFields(name, description, file, entries?.length ?? 0)
    setFaults(checked)
    if (checked.length > 0 || !file) return
    setSaving(true)
    setConflict(null)
    try {
      const picked = name.trim()
      const { mime, data } = await readAsBase64(file)
      const answer = await uploadExpression(id, revision ?? '', picked, description.trim(), mime, data)
      setRevision(answer.revision)
      setName('')
      setDescription('')
      setFile(null)
      if (fileInputRef.current) fileInputRef.current.value = ''
      dialogRef.current?.close()
      setStatus('Saved ' + picked + '. Converted to 512 by 512.')
      await reloadList()
    } catch (error) {
      if (error instanceof GalleryError && (error.status === 409 || error.code === 'stale_revision')) {
        setConflict('Someone else saved first. Your name, description and file are kept — try again.')
        try {
          await reloadList()
        } catch {
          /* The refresh failed; the kept draft still retries against the old revision. */
        }
      } else {
        setFaults([saveFailure(error)])
      }
    } finally {
      setSaving(false)
    }
  }

  const count = entries?.length ?? 0
  const full = count >= LIMIT

  return (
    <section className="expression-gallery" aria-label="Expression gallery">
      <div className="expression-gallery-head">
        <div>
          <h2 className="expression-gallery-title">Expressions</h2>
          <p className="expression-gallery-count" role="status">
            {loading ? 'Loading…' : count + ' of ' + LIMIT + ' used.'}
          </p>
        </div>
        {writable && (
          <button
            ref={triggerRef}
            type="button"
            className="expression-gallery-button"
            onClick={openDialog}
            disabled={loading || full}
          >
            Upload
          </button>
        )}
      </div>

      {!writable && (
        <p className="expression-gallery-note">This pack is read-only, so expressions cannot be added here.</p>
      )}
      {loadError && (
        <p className="expression-gallery-note" role="alert">
          Expressions unavailable. The core did not answer.
        </p>
      )}
      {status && (
        <p className="expression-gallery-note" role="status">
          {status}
        </p>
      )}
      {!loading && !loadError && count === 0 && <p className="expression-gallery-note">No expressions yet.</p>}

      <ul className="expression-gallery-grid">
        {(entries ?? []).map((entry) => {
          const preview = previews[entry.name]
          return (
            <li key={entry.name} className="expression-gallery-card">
              {preview ? (
                <img className="expression-gallery-thumb" src={preview} alt={'Preview of ' + entry.name} />
              ) : (
                <span className="expression-gallery-thumb" aria-hidden="true">
                  {entry.name.charAt(0).toUpperCase()}
                </span>
              )}
              <span className="expression-gallery-name">{entry.name}</span>
              {entry.description && <span className="expression-gallery-description">{entry.description}</span>}
            </li>
          )
        })}
      </ul>

      <dialog
        ref={dialogRef}
        className="expression-gallery-dialog"
        aria-label="Upload expression"
        onClose={() => triggerRef.current?.focus()}
      >
        <form className="expression-gallery-form" onSubmit={(event) => void onSubmit(event)}>
          <h3 className="expression-gallery-subtitle">Upload Expression</h3>
          <p className="expression-gallery-hint">Static PNG, JPEG or WebP up to 4 MB. Converted to 512 by 512 on save.</p>
          {conflict && (
            <p className="expression-gallery-error" role="alert">
              {conflict}
            </p>
          )}
          {!!faults.length && (
            <ul className="expression-gallery-errors" aria-label="Upload problems">
              {faults.map((fault) => (
                <li key={fault}>{fault}</li>
              ))}
            </ul>
          )}
          <label className="expression-gallery-field">
            <span className="expression-gallery-label">Name</span>
            <input
              ref={nameInputRef}
              value={name}
              placeholder="happy"
              maxLength={64}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="expression-gallery-field">
            <span className="expression-gallery-label">Description</span>
            <input
              value={description}
              placeholder="A bright grin"
              maxLength={300}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <label className="expression-gallery-field">
            <span className="expression-gallery-label">File</span>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
          </label>
          <div className="expression-gallery-actions">
            <button type="button" className="expression-gallery-button" onClick={() => dialogRef.current?.close()}>
              Cancel
            </button>
            <button type="submit" className="expression-gallery-button expression-gallery-primary" disabled={saving}>
              {saving ? 'Uploading…' : 'Upload'}
            </button>
          </div>
        </form>
      </dialog>
    </section>
  )
}
