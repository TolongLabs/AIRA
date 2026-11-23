import ExpressionGallery from './expression-gallery'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { core } from '@/lib/core'
import {
  LINE_KINDS,
  OPTIONAL_LINES,
  PROMPT_CEILING,
  REPLY_LENGTHS,
  SIMULATOR_DRAFT,
  SIMULATOR_READY,
  applyStudioPatch,
  blankDraft,
  buildPromptPreview,
  compareDrafts,
  diffDocs,
  estimateTokens,
  getStudio,
  openStudioSimulator,
  postStudio,
  putStudio,
  rebaseLeaves,
  studioHref,
  studioPaths,
  validateDraft,
  validateId,
  validateCard,
  validateLines,
  validateMoods,
  type ReplyLength,
  type StudioDoc,
  type StudioDraft,
  type StudioMoodEntry,
  StudioError
} from './studio-client'
import './studio.css'

/* ── small controlled field helpers (shadcn field/label/error shape) ── */

function Field({
  label,
  error,
  hint,
  children
}: {
  label: string
  error?: string
  hint?: string
  children: ReactNode
}) {
  return (
    <label className="studio-field">
      <span className="studio-label">{label}</span>
      {children}
      {hint && <small className="studio-hint">{hint}</small>}
      {error && (
        <small className="studio-error" role="alert">
          {error}
        </small>
      )}
    </label>
  )
}

function LinesEditor({
  label,
  values,
  onChange,
  hint,
  error
}: {
  label: string
  values: string[]
  onChange: (next: string[]) => void
  hint?: string
  error?: string
}) {
  return (
    <Field label={label} hint={hint} error={error}>
      <textarea
        value={values.join('\n')}
        rows={Math.max(2, Math.min(8, values.length + 1))}
        onChange={(e) => onChange(e.target.value.split('\n'))}
      />
    </Field>
  )
}

const emptyMood = (): StudioMoodEntry => ({
  patterns: [''],
  tone: '',
  openers: [''],
  endings: [''],
  faces: [''],
  stickers: []
})

function formatLeafValue(value: unknown): string {
  if (value === undefined) return '(removed)'
  const text = JSON.stringify(value) ?? '(unreadable)'
  return text.length > 140 ? text.slice(0, 139) + '…' : text
}

/* ── the editor ── */

export interface StudioEditorProps {
  id?: string
  mode: 'create' | 'import' | 'edit'
}

export default function StudioEditor({ id, mode }: StudioEditorProps) {
  const [packId, setPackId] = useState(id ?? '')
  const [pristine, setPristine] = useState<StudioDoc | null>(null)
  const [draft, setDraft] = useState<StudioDraft>(blankDraft)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(mode === 'edit')
  const [errors, setErrors] = useState<string[]>([])
  const [status, setStatus] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [conflict, setConflict] = useState<StudioDoc | null>(null)
  const [copyId, setCopyId] = useState('')
  const [sourceOptions, setSourceOptions] = useState<{ id: string; displayName: string }[]>([])
  const [sourceId, setSourceId] = useState('')
  const [selectedMood, setSelectedMood] = useState<string | null>(null)
  const [renameKey, setRenameKey] = useState('')
  const [newMoodKey, setNewMoodKey] = useState('')
  const [newGroup, setNewGroup] = useState('')
  const [simError, setSimError] = useState<string | null>(null)
  const [overlap, setOverlap] = useState<{ path: string; mine: unknown; theirs: unknown }[]>([])
  const [readbackStale, setReadbackStale] = useState(false)
  const draftRef = useRef(draft)
  draftRef.current = draft

  useEffect(() => {
    if (mode !== 'edit' || !id) return
    let live = true
    setLoading(true)
    getStudio(id).then(
      (doc) => {
        if (!live) return
        setPristine(doc)
        setDraft({ card: doc.card, moods: doc.moods, lines: doc.lines })
        setPackId(doc.id)
        setSelectedMood(doc.moods.default)
        setRenameKey(doc.moods.default)
        setLoading(false)
      },
      (e) => {
        if (!live) return
        setLoadError(e instanceof StudioError ? `Could not load this pack (${e.code}).` : 'Could not load this pack.')
        setLoading(false)
      }
    )
    return () => {
      live = false
    }
  }, [mode, id])

  useEffect(() => {
    if (mode !== 'import') return
    let live = true
    core
      .characters()
      .then((data) => {
        if (live) setSourceOptions(data.characters.map((c) => ({ id: c.id, displayName: c.displayName })))
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [mode])

  const pristineDocs: StudioDraft | null = pristine
    ? { card: pristine.card, moods: pristine.moods, lines: pristine.lines }
    : null
  const conflictDocs: StudioDraft | null = conflict
    ? { card: conflict.card, moods: conflict.moods, lines: conflict.lines }
    : null
  const conflictSets = pristineDocs && conflictDocs ? compareDrafts(pristineDocs, draft, conflictDocs) : null
  const dirty = pristineDocs !== null && JSON.stringify(pristineDocs) !== JSON.stringify(draft)

  useEffect(() => {
    if (!dirty) return
    const guard = (e: BeforeUnloadEvent) => {
      e.preventDefault()
    }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [dirty])

  const moodKeys = useMemo(() => Object.keys(draft.moods.moods), [draft])
  const activeMood = selectedMood ?? draft.moods.default
  const mood = draft.moods.moods[activeMood]

  useEffect(() => {
    if (!moodKeys.includes(activeMood) && moodKeys.length) setSelectedMood(moodKeys[0] ?? null)
  }, [moodKeys, activeMood])

  function updateMood(key: string, next: StudioMoodEntry) {
    setDraft((d) => ({ ...d, moods: { ...d.moods, moods: { ...d.moods.moods, [key]: next } } }))
  }

  async function saveEdit() {
    if (!id || !pristine || saving) return
    const base = pristine
    const sent = draft
    const faults = validateDraft(id, sent)
    setErrors(faults)
    if (faults.length) return
    const { patch, changed } = diffDocs({ card: base.card, moods: base.moods, lines: base.lines }, sent)
    if (!changed.length) {
      setStatus('No changes to save.')
      return
    }
    setSaving(true)
    try {
      const answer = await putStudio(id, base.revision, patch)
      // Read back the authoritative pack. Edits typed while saving are kept by
      // replaying only their own leaves over what the server stored.
      let fresh: StudioDoc | null = null
      try {
        fresh = await getStudio(id)
      } catch {
        fresh = null
      }
      const ongoing = diffDocs(sent, draftRef.current)
      if (fresh) {
        const authoritative: StudioDraft = { card: fresh.card, moods: fresh.moods, lines: fresh.lines }
        setPristine(fresh)
        setDraft(ongoing.changed.length ? applyStudioPatch(authoritative, ongoing.patch) : authoritative)
        setReadbackStale(false)
        setConflict(null)
        setOverlap([])
        setStatus(
          ongoing.changed.length
            ? `Saved ${changed.join(', ')}. Revision ${fresh.revision}. Your newer edits are kept above.`
            : `Saved ${changed.join(', ')}. Revision ${fresh.revision}.`
        )
      } else {
        const saved: StudioDoc = { ...base, ...sent, revision: answer.revision }
        const savedDocs: StudioDraft = { card: saved.card, moods: saved.moods, lines: saved.lines }
        setPristine(saved)
        setDraft(ongoing.changed.length ? applyStudioPatch(savedDocs, ongoing.patch) : savedDocs)
        setReadbackStale(true)
        setConflict(null)
        setOverlap([])
        setStatus(
          `Saved revision ${answer.revision}, but the fresh pack could not be read back. ` +
            'What you see is your saved text — reload this page before editing further.'
        )
      }
    } catch (e) {
      if (e instanceof StudioError && (e.status === 409 || e.code === 'stale_revision')) {
        try {
          setConflict(await getStudio(id))
        } catch {
          setConflict(base)
        }
        setOverlap([])
        setStatus('Someone else saved first. Your draft is kept — compare below.')
      } else {
        setStatus(e instanceof StudioError ? `Save failed (${e.code}). Your draft is kept.` : 'Save failed.')
      }
    } finally {
      setSaving(false)
    }
  }

  function rebaseOntoLatest() {
    if (!conflict || !pristine || pristine.revision === conflict.revision) return
    const base: StudioDraft = { card: pristine.card, moods: pristine.moods, lines: pristine.lines }
    const latest: StudioDraft = { card: conflict.card, moods: conflict.moods, lines: conflict.lines }
    const sets = compareDrafts(base, draft, latest)
    setPristine(conflict)
    setDraft(rebaseLeaves(latest, sets.localOnly))
    setReadbackStale(false)
    if (!sets.overlapping.length) {
      setConflict(null)
      setOverlap([])
      setStatus('Now on the latest revision. Your edits are re-applied — review and save.')
    } else {
      setOverlap(
        sets.overlapping.map((path) => ({
          path,
          mine: sets.local.find((leaf) => leaf.path === path)?.after,
          theirs: sets.remote.find((leaf) => leaf.path === path)?.after
        }))
      )
      setStatus(
        `${sets.localOnly.length} of your edits moved onto the latest revision. ` +
          `${sets.overlapping.length} need your call below.`
      )
    }
  }

  function resolveOverlap(path: string, keepMine: boolean) {
    const row = overlap.find((entry) => entry.path === path)
    const rest = overlap.filter((entry) => entry.path !== path)
    if (keepMine && row) setDraft((d) => rebaseLeaves(d, [{ path, before: row.theirs, after: row.mine }]))
    setOverlap(rest)
    if (!rest.length) {
      setConflict(null)
      setStatus('All conflicts resolved — review and save.')
    }
  }

  async function saveNew(uploaded?: StudioDraft) {
    const body = uploaded ?? draft
    const faults = [
      ...validateId(packId),
      ...validateCard({ ...body.card, id: packId }),
      ...validateMoods(body.moods),
      ...validateLines(body.lines)
    ]
    setErrors(faults)
    if (faults.length || !packId) return
    setSaving(true)
    try {
      const answer = await postStudio({
        id: packId,
        card: { ...body.card, id: packId },
        moods: body.moods,
        lines: body.lines
      })
      setStatus(`Created ${answer.id}.`)
      location.assign(studioHref(studioPaths.edit(answer.id)))
    } catch (e) {
      setStatus(e instanceof StudioError ? `Create failed (${e.code}).` : 'Create failed.')
    } finally {
      setSaving(false)
    }
  }

  async function saveCopy(fromId: string, newId: string) {
    const faults = validateId(newId)
    setErrors(faults)
    if (faults.length || !fromId || !newId) {
      if (!fromId) setStatus('Pick a pack to copy from.')
      return
    }
    setSaving(true)
    try {
      const answer = await postStudio({ id: newId, sourceId: fromId })
      setStatus(`Copied as ${answer.id}.`)
      location.assign(studioHref(studioPaths.edit(answer.id)))
    } catch (e) {
      setStatus(e instanceof StudioError ? `Copy failed (${e.code}).` : 'Copy failed.')
    } finally {
      setSaving(false)
    }
  }

  function onUploadFile(file: File) {
    // Uploads are parsed as JSON text and shape-checked. They are never evaluated.
    if (file.size > 262144) {
      setErrors(['That file is over 256 KB. Export a single pack document instead.'])
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      let raw: unknown
      try {
        raw = JSON.parse(String(reader.result ?? ''))
      } catch {
        setErrors(['That file is not valid JSON.'])
        return
      }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        setErrors(['That file does not hold a pack document.'])
        return
      }
      const doc = raw as Record<string, unknown>
      const candidate = (doc.card && doc.moods && doc.lines ? doc : doc.pack) as Record<string, unknown> | undefined
      if (
        !candidate ||
        typeof candidate.card !== 'object' ||
        typeof candidate.moods !== 'object' ||
        typeof candidate.lines !== 'object'
      ) {
        setErrors(['That file must hold typed card, moods and lines documents.'])
        return
      }
      const next = candidate as unknown as StudioDraft
      const fileId = typeof doc.id === 'string' && doc.id ? doc.id : file.name.replace(/\.[^.]*$/, '')
      const faults = [
        ...validateId(fileId).map((f) => `id: ${f}`),
        ...validateCard({ ...(next.card as StudioDraft['card']), id: fileId }),
        ...validateMoods(next.moods as StudioDraft['moods']),
        ...validateLines(next.lines as StudioDraft['lines'])
      ]
      setErrors(faults)
      if (faults.length) {
        setStatus('That file failed validation. Nothing was loaded.')
        return
      }
      setDraft(next)
      setPackId(fileId)
      setSelectedMood(next.moods.default)
      setStatus(`Loaded ${file.name} into the form. Review, then create.`)
    }
    reader.readAsText(file)
  }

  const preview = useMemo(() => buildPromptPreview(draft, activeMood), [draft, activeMood])

  if (mode === 'edit' && !id) return <p role="alert">No character id in the route.</p>
  if (loading) return <p role="status">Loading…</p>
  if (loadError) return <p role="alert">{loadError}</p>

  const title =
    mode === 'edit' ? draft.card.displayName || packId : mode === 'create' ? 'New character' : 'Import character'
  const readOnly = mode === 'edit' && pristine !== null && !pristine.writable

  return (
    <div className="studio-editor">
      <nav className="studio-crumb" aria-label="Breadcrumb">
        <a href={studioHref(studioPaths.catalogue)}>Characters</a>
        <span aria-hidden="true"> / </span>
        <span aria-current="page">{title}</span>
      </nav>
      <div className="studio-head">
        <h2 className="studio-title">{title}</h2>
        <div className="studio-actions">
          <button
            type="button"
            className="studio-button"
            onClick={() => {
              setSimError(null)
              openStudioSimulator({ ...draft, moodKey: activeMood }, setSimError)
            }}
          >
            Preview Conversation
          </button>
          <a className="studio-button studio-primary" href="#studio-review">
            Review Changes
          </a>
        </div>
      </div>
      {simError && (
        <p className="studio-banner" role="alert">
          {simError}
        </p>
      )}
      {readOnly && (
        <p className="studio-banner" role="note">
          This is a built-in repository pack and cannot be edited here. Make an editable copy with a distinct id, then
          edit the copy.
        </p>
      )}
      {readOnly ? (
        <section className="studio-section" aria-label="Copy this pack">
          <Field label="New id for the editable copy" hint="Lowercase letters, digits, - or _, up to 64 characters.">
            <input value={copyId} placeholder="my-character" onChange={(e) => setCopyId(e.target.value)} />
          </Field>
          <button
            type="button"
            className="studio-button studio-primary"
            disabled={saving || !copyId}
            onClick={() => {
              if (id) void saveCopy(id, copyId)
            }}
          >
            Copy to editable pack
          </button>
          {status && <p role="status">{status}</p>}
        </section>
      ) : (
        <div className="studio-body">
          <nav className="studio-sections" aria-label="Editor sections">
            {[
              ['studio-identity', 'Identity'],
              ['studio-moods', 'Moods'],
              ['studio-lines', 'Fixed Lines'],
              ['studio-expressions', 'Expressions'],
              ['studio-footer', 'Tool Footer'],
              ['studio-preview', 'Prompt Preview'],
              ['studio-review', 'Review']
            ].map(([href, label]) => (
              <a key={href} href={'#' + href}>
                {label}
              </a>
            ))}
          </nav>
          <div className="studio-form">
            {mode !== 'edit' && (
              <section className="studio-section" aria-label="Pack id">
                <Field label="Pack id" hint="Folder name and card id. Lowercase, up to 64 characters.">
                  <input value={packId} placeholder="my-character" onChange={(e) => setPackId(e.target.value)} />
                </Field>
              </section>
            )}
            {mode === 'import' && (
              <section className="studio-section" aria-label="Import source">
                <h3>Copy from an existing pack</h3>
                <Field label="Source pack">
                  <select value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
                    <option value="">Pick a pack…</option>
                    {sourceOptions.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.displayName} ({c.id})
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="New id for the copy">
                  <input value={copyId} placeholder="my-character" onChange={(e) => setCopyId(e.target.value)} />
                </Field>
                <button
                  type="button"
                  className="studio-button"
                  disabled={saving}
                  onClick={() => void saveCopy(sourceId, copyId || packId)}
                >
                  Copy pack
                </button>
                <h3>Or upload a typed pack document</h3>
                <p className="studio-hint">
                  JSON only, up to 256 KB. The file is parsed as data and validated — never run.
                </p>
                <input
                  aria-label="Upload a typed pack document"
                  type="file"
                  accept="application/json,.json"
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    if (file) onUploadFile(file)
                    e.target.value = ''
                  }}
                />
              </section>
            )}

            <section className="studio-section" id="studio-identity" aria-label="Identity">
              <h3>Identity</h3>
              <Field label="Display name">
                <input
                  value={draft.card.displayName}
                  onChange={(e) => setDraft((d) => ({ ...d, card: { ...d.card, displayName: e.target.value } }))}
                />
              </Field>
              <Field label="Languages" hint="Comma-separated tags, e.g. en, en+ja is two tags.">
                <input
                  value={draft.card.languages.join(', ')}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      card: {
                        ...d.card,
                        languages: e.target.value
                          .split(',')
                          .map((s) => s.trim())
                          .filter(Boolean)
                      }
                    }))
                  }
                />
              </Field>
              <Field label="Aliases" hint="Other names members may call the character. Comma-separated.">
                <input
                  value={(draft.card.aliases ?? []).join(', ')}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      card: {
                        ...d.card,
                        aliases: e.target.value
                          .split(',')
                          .map((s) => s.trim())
                          .filter(Boolean)
                      }
                    }))
                  }
                />
              </Field>
              <Field label="Core identity">
                <textarea
                  rows={4}
                  value={draft.card.coreIdentity}
                  onChange={(e) => setDraft((d) => ({ ...d, card: { ...d.card, coreIdentity: e.target.value } }))}
                />
              </Field>
              <LinesEditor
                label="Speech rules"
                values={draft.card.speechRules}
                onChange={(speechRules) => setDraft((d) => ({ ...d, card: { ...d.card, speechRules } }))}
                hint="One rule per line."
              />
              <Field label="Default reply length">
                <select
                  value={draft.card.defaultReplyLength}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, card: { ...d.card, defaultReplyLength: e.target.value as ReplyLength } }))
                  }
                >
                  <option value="short">Short (≤ {REPLY_LENGTHS.short} chars)</option>
                  <option value="default">Default (≤ {REPLY_LENGTHS.default} chars)</option>
                  <option value="long">Long (≤ {REPLY_LENGTHS.long} chars)</option>
                </select>
              </Field>
            </section>

            <section className="studio-section" id="studio-moods" aria-label="Moods">
              <h3>Moods</h3>
              <Field label="Default mood">
                <select
                  value={draft.moods.default}
                  onChange={(e) => {
                    setDraft((d) => ({ ...d, moods: { ...d.moods, default: e.target.value } }))
                    setSelectedMood(e.target.value)
                  }}
                >
                  {moodKeys.map((key) => (
                    <option key={key} value={key}>
                      {key}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="studio-mood-tabs" role="tablist" aria-label="Moods">
                {moodKeys.map((key) => (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    tabIndex={key === activeMood ? 0 : -1}
                    onKeyDown={(event) => {
                      const index = moodKeys.indexOf(key)
                      const target = {
                        Home: 0,
                        End: moodKeys.length - 1,
                        ArrowLeft: (index + moodKeys.length - 1) % moodKeys.length,
                        ArrowRight: (index + 1) % moodKeys.length
                      }[event.key]
                      if (target === undefined) return
                      event.preventDefault()
                      const next = moodKeys[target]
                      if (!next) return
                      setSelectedMood(next)
                      setRenameKey(next)
                      event.currentTarget.parentElement
                        ?.querySelectorAll<HTMLButtonElement>('[role=tab]')
                        [target]?.focus()
                    }}
                    aria-selected={key === activeMood}
                    className={key === activeMood ? 'studio-tab-on' : undefined}
                    onClick={() => {
                      setSelectedMood(key)
                      setRenameKey(key)
                    }}
                  >
                    {key}
                  </button>
                ))}
              </div>
              {mood ? (
                <>
                  <Field label="Rename this mood key">
                    <span className="studio-row">
                      <input value={renameKey} onChange={(e) => setRenameKey(e.target.value)} />
                      <button
                        type="button"
                        className="studio-button"
                        onClick={() => {
                          const next = renameKey.trim()
                          if (!next || next === activeMood) return
                          setDraft((d) => {
                            const moods = { ...d.moods.moods }
                            moods[next] = moods[activeMood]!
                            delete moods[activeMood]
                            return {
                              ...d,
                              moods: {
                                ...d.moods,
                                default: d.moods.default === activeMood ? next : d.moods.default,
                                moods
                              }
                            }
                          })
                          setSelectedMood(next)
                        }}
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        className="studio-button"
                        disabled={moodKeys.length <= 1}
                        onClick={() => {
                          setDraft((d) => {
                            const moods = { ...d.moods.moods }
                            delete moods[activeMood]
                            const rest = Object.keys(moods)
                            return {
                              ...d,
                              moods: {
                                ...d.moods,
                                default: d.moods.default === activeMood ? (rest[0] ?? '') : d.moods.default,
                                moods
                              }
                            }
                          })
                          setSelectedMood(null)
                        }}
                      >
                        Remove
                      </button>
                    </span>
                  </Field>
                  <LinesEditor
                    label="Detection patterns"
                    hint="One regular expression per line. Rules cost no model call."
                    values={mood.patterns}
                    onChange={(patterns) => updateMood(activeMood, { ...mood, patterns })}
                  />
                  <Field label="Tone guidance">
                    <textarea
                      rows={3}
                      value={mood.tone}
                      onChange={(e) => updateMood(activeMood, { ...mood, tone: e.target.value })}
                    />
                  </Field>
                  <LinesEditor
                    label="Openers"
                    hint="Drawn about 1 reply in 3."
                    values={mood.openers}
                    onChange={(openers) => updateMood(activeMood, { ...mood, openers })}
                  />
                  <LinesEditor
                    label="Endings"
                    hint="Drawn about 1 reply in 4."
                    values={mood.endings}
                    onChange={(endings) => updateMood(activeMood, { ...mood, endings })}
                  />
                  <LinesEditor
                    label="Faces"
                    hint="One kaomoji in round brackets per line."
                    values={mood.faces}
                    onChange={(faces) => updateMood(activeMood, { ...mood, faces })}
                  />
                  <Field label="Face groups" hint="Comma-separated names of shared groups below.">
                    <input
                      value={(mood.faceGroups ?? []).join(', ')}
                      onChange={(e) =>
                        updateMood(activeMood, {
                          ...mood,
                          faceGroups: e.target.value
                            .split(',')
                            .map((s) => s.trim())
                            .filter(Boolean)
                        })
                      }
                    />
                  </Field>
                  <LinesEditor
                    label="Stickers"
                    hint="Filenames under the pack stickers folder, e.g. happy.webp."
                    values={mood.stickers}
                    onChange={(stickers) => updateMood(activeMood, { ...mood, stickers })}
                  />
                  <fieldset className="studio-beats">
                    <legend>Beats for this mood</legend>
                    {(draft.moods.beats ?? []).map((beat) => (
                      <Field key={beat.name} label={`${beat.name} odds (0–1, blank for off)`}>
                        <input
                          type="number"
                          min={0}
                          max={1}
                          step={0.05}
                          value={mood.beats?.[beat.name] ?? ''}
                          onChange={(e) => {
                            const beats = { ...(mood.beats ?? {}) }
                            if (e.target.value === '') delete beats[beat.name]
                            else beats[beat.name] = Number(e.target.value)
                            updateMood(activeMood, { ...mood, beats })
                          }}
                        />
                      </Field>
                    ))}
                    {!draft.moods.beats?.length && <p className="studio-hint">No beats defined yet. Add one below.</p>}
                  </fieldset>
                </>
              ) : (
                <p>No moods yet. Add one below.</p>
              )}
              <Field label="New mood key">
                <span className="studio-row">
                  <input value={newMoodKey} placeholder="calm" onChange={(e) => setNewMoodKey(e.target.value)} />
                  <button
                    type="button"
                    className="studio-button"
                    onClick={() => {
                      const key = newMoodKey.trim()
                      if (!key || moodKeys.includes(key)) return
                      setDraft((d) => ({
                        ...d,
                        moods: { ...d.moods, moods: { ...d.moods.moods, [key]: emptyMood() } }
                      }))
                      setSelectedMood(key)
                      setRenameKey(key)
                      setNewMoodKey('')
                    }}
                  >
                    Add mood
                  </button>
                </span>
              </Field>
              <fieldset className="studio-beats">
                <legend>Beat definitions</legend>
                {(draft.moods.beats ?? []).map((beat, i) => (
                  <span key={beat.name} className="studio-row">
                    <strong>{beat.name}</strong>
                    <input
                      aria-label={`Line for beat ${beat.name}`}
                      value={beat.line}
                      onChange={(e) =>
                        setDraft((d) => {
                          const beats = [...(d.moods.beats ?? [])]
                          beats[i] = { ...beats[i]!, line: e.target.value }
                          return { ...d, moods: { ...d.moods, beats } }
                        })
                      }
                    />
                    <button
                      type="button"
                      className="studio-button"
                      onClick={() =>
                        setDraft((d) => ({
                          ...d,
                          moods: { ...d.moods, beats: (d.moods.beats ?? []).filter((b) => b.name !== beat.name) }
                        }))
                      }
                    >
                      Remove
                    </button>
                  </span>
                ))}
                <BeatAdder
                  onAdd={(name, line) =>
                    setDraft((d) => ({
                      ...d,
                      moods: { ...d.moods, beats: [...(d.moods.beats ?? []), { name, line }] }
                    }))
                  }
                />
              </fieldset>
              <fieldset className="studio-beats">
                <legend>Face groups</legend>
                {Object.entries(draft.moods.faceGroups ?? {}).map(([group, faces]) => (
                  <div key={group}>
                    <span className="studio-row">
                      <strong>{group}</strong>
                      <button
                        type="button"
                        className="studio-button"
                        onClick={() =>
                          setDraft((d) => {
                            const faceGroups = { ...(d.moods.faceGroups ?? {}) }
                            delete faceGroups[group]
                            return { ...d, moods: { ...d.moods, faceGroups } }
                          })
                        }
                      >
                        Remove
                      </button>
                    </span>
                    <textarea
                      aria-label={`Faces in group ${group}`}
                      rows={2}
                      value={faces.join('\n')}
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          moods: {
                            ...d.moods,
                            faceGroups: { ...(d.moods.faceGroups ?? {}), [group]: e.target.value.split('\n') }
                          }
                        }))
                      }
                    />
                  </div>
                ))}
                <span className="studio-row">
                  <input value={newGroup} placeholder="group name" onChange={(e) => setNewGroup(e.target.value)} />
                  <button
                    type="button"
                    className="studio-button"
                    onClick={() => {
                      const group = newGroup.trim()
                      if (!group) return
                      setDraft((d) => ({
                        ...d,
                        moods: { ...d.moods, faceGroups: { ...(d.moods.faceGroups ?? {}), [group]: [''] } }
                      }))
                      setNewGroup('')
                    }}
                  >
                    Add group
                  </button>
                </span>
              </fieldset>
            </section>

            <section className="studio-section" id="studio-lines" aria-label="Fixed lines">
              <h3>Fixed Lines</h3>
              {LINE_KINDS.map((kind) => (
                <Field key={kind} label={kind}>
                  <input
                    value={draft.lines[kind] ?? ''}
                    maxLength={300}
                    onChange={(e) => setDraft((d) => ({ ...d, lines: { ...d.lines, [kind]: e.target.value } }))}
                  />
                </Field>
              ))}
              <h4>Optional lines</h4>
              {OPTIONAL_LINES.map((kind) => (
                <Field key={kind} label={kind}>
                  <input
                    value={draft.lines[kind] ?? ''}
                    maxLength={300}
                    placeholder="Leave blank to use the neutral fallback"
                    onChange={(e) =>
                      setDraft((d) => {
                        const lines = { ...d.lines }
                        if (e.target.value) lines[kind] = e.target.value
                        else delete lines[kind]
                        return { ...d, lines }
                      })
                    }
                  />
                </Field>
              ))}
            </section>

            <section className="studio-section" id="studio-expressions" aria-label="Expressions">
              <h3>Expressions</h3>
              {id && pristine ? (
                <ExpressionGallery id={id} writable={pristine.writable} />
              ) : (
                <p>Save this pack to add expressions.</p>
              )}
              {moodKeys.map((key) => (
                <p key={key}>
                  <strong>{key}:</strong> {draft.moods.moods[key]!.stickers.filter(Boolean).join(', ') || 'text only'}
                </p>
              ))}
              <p>
                <a href={studioHref(studioPaths.simulator)} target="_blank" rel="noreferrer">
                  Open the simulator
                </a>{' '}
                to preview replies with their expressions.
              </p>
            </section>

            <section className="studio-section" id="studio-footer" aria-label="Tool footer">
              <h3>Tool Footer</h3>
              <p className="studio-hint">
                Tool wording is owned by the footer editor so two writers never fight over one file. This section shows
                what the draft carries.
              </p>
              <p>
                Icon: {draft.card.toolFooter?.icon ?? '(code default)'} · Labels:{' '}
                {Object.keys(draft.card.toolFooter?.labels ?? {}).length || 'none set'}
              </p>
              {mode === 'edit' && id && (
                <p>
                  <a href={studioHref(studioPaths.footer(id))}>Edit tool wording</a>
                </p>
              )}
            </section>

            <section className="studio-section" id="studio-preview" aria-label="Prompt preview">
              <h3>Prompt Preview</h3>
              <Field label="Preview mood">
                <select value={activeMood} onChange={(e) => setSelectedMood(e.target.value)}>
                  {moodKeys.map((key) => (
                    <option key={key} value={key}>
                      {key}
                    </option>
                  ))}
                </select>
              </Field>
              <pre className="studio-pre">{preview.text}</pre>
              <p role="status">
                About {preview.tokens} tokens.{' '}
                {preview.tokens > PROMPT_CEILING
                  ? 'Over the ceiling — shorten identity, rules or tone.'
                  : 'Inside the ceiling.'}
              </p>
            </section>

            <section className="studio-section" id="studio-review" aria-label="Review and save">
              <h3>Review Changes</h3>
              {mode === 'edit' ? (
                <>
                  <p>
                    {dirty
                      ? `Changed: ${diffDocs({ card: pristine!.card, moods: pristine!.moods, lines: pristine!.lines }, draft).changed.join(', ') || 'formatting only'}.`
                      : 'No unsaved changes.'}
                  </p>
                  {conflict && conflictDocs && conflictSets && (
                    <div className="studio-banner" role="alert">
                      <p>
                        The server is at revision {conflict.revision}; you saved from {pristine!.revision}. Your draft
                        is untouched.
                      </p>
                      {pristine!.revision !== conflict.revision && (
                        <>
                          <p className="studio-hint">
                            Your changes ({conflictSets.local.length}) against theirs ({conflictSets.remote.length}).
                            Only the edits you listed move across — nothing you did not touch is replayed.
                          </p>
                          {conflictSets.local.length > 0 && (
                            <ul>
                              {conflictSets.local.map((leaf) => (
                                <li key={'yours-' + leaf.path}>
                                  <code>{leaf.path}</code>: {formatLeafValue(leaf.before)} →{' '}
                                  {formatLeafValue(leaf.after)}{' '}
                                  {conflictSets.overlapping.includes(leaf.path) && (
                                    <strong>(also changed by them)</strong>
                                  )}
                                </li>
                              ))}
                            </ul>
                          )}
                          {conflictSets.remote.length > 0 && (
                            <ul>
                              {conflictSets.remote.map((leaf) => (
                                <li key={'theirs-' + leaf.path}>
                                  <code>{leaf.path}</code>: {formatLeafValue(leaf.before)} →{' '}
                                  {formatLeafValue(leaf.after)}{' '}
                                  {conflictSets.overlapping.includes(leaf.path) && (
                                    <strong>(also changed by you)</strong>
                                  )}
                                </li>
                              ))}
                            </ul>
                          )}
                        </>
                      )}
                      {overlap.length > 0 && (
                        <>
                          <p>Changed by both — your call on each:</p>
                          <ul>
                            {overlap.map((row) => (
                              <li key={row.path}>
                                <code>{row.path}</code> — theirs: {formatLeafValue(row.theirs)} · yours:{' '}
                                {formatLeafValue(row.mine)}{' '}
                                <span className="studio-row">
                                  <button
                                    type="button"
                                    className="studio-button"
                                    onClick={() => resolveOverlap(row.path, true)}
                                  >
                                    Use mine
                                  </button>
                                  <button
                                    type="button"
                                    className="studio-button"
                                    onClick={() => resolveOverlap(row.path, false)}
                                  >
                                    Keep theirs
                                  </button>
                                </span>
                              </li>
                            ))}
                          </ul>
                        </>
                      )}
                      <span className="studio-row">
                        {pristine!.revision !== conflict.revision && (
                          <button type="button" className="studio-button" onClick={rebaseOntoLatest}>
                            Rebase my edits onto latest
                          </button>
                        )}
                        <button
                          type="button"
                          className="studio-button"
                          onClick={() => {
                            setDraft({ card: conflict.card, moods: conflict.moods, lines: conflict.lines })
                            setPristine(conflict)
                            setConflict(null)
                            setOverlap([])
                            setErrors([])
                            setStatus('Draft replaced with the latest revision.')
                          }}
                        >
                          Discard my changes
                        </button>
                      </span>
                    </div>
                  )}
                </>
              ) : (
                <p>Creating a new pack runs the full start-up validator on the server before anything is written.</p>
              )}
              {!!errors.length && (
                <ul className="studio-errors" aria-label="Validation errors">
                  {errors.map((fault) => (
                    <li key={fault}>{fault}</li>
                  ))}
                </ul>
              )}
              {readbackStale && (
                <p className="studio-banner" role="status">
                  Saved, but the fresh pack could not be read back. What you see is your saved text — reload this page
                  before editing further.
                </p>
              )}
              {mode === 'edit' ? (
                <button
                  type="button"
                  className="studio-button studio-primary"
                  disabled={saving || !dirty}
                  onClick={saveEdit}
                >
                  {saving ? 'Saving…' : 'Save changes'}
                </button>
              ) : (
                <button
                  type="button"
                  className="studio-button studio-primary"
                  disabled={saving}
                  onClick={() => saveNew()}
                >
                  {saving ? 'Creating…' : 'Create character'}
                </button>
              )}
              {pristine && (
                <p className="studio-hint">
                  Revision {pristine.revision} · {pristine.source === 'data' ? 'Editable pack' : 'Built-in pack'}.
                  {mode === 'edit' && id && (
                    <>
                      {' '}
                      <a href={studioHref(studioPaths.footer(id))}>Tool wording</a>
                    </>
                  )}
                </p>
              )}
              {status && <p role="status">{status}</p>}
            </section>
          </div>
        </div>
      )}
    </div>
  )
}

function BeatAdder({ onAdd }: { onAdd: (name: string, line: string) => void }) {
  const [name, setName] = useState('')
  const [line, setLine] = useState('')
  return (
    <span className="studio-row">
      <input
        aria-label="New beat name"
        value={name}
        placeholder="beat name"
        onChange={(e) => setName(e.target.value)}
      />
      <input
        aria-label="New beat line"
        value={line}
        placeholder="one line of guidance"
        onChange={(e) => setLine(e.target.value)}
      />
      <button
        type="button"
        className="studio-button"
        onClick={() => {
          if (!name.trim() || !line.trim()) return
          onAdd(name.trim(), line.trim())
          setName('')
          setLine('')
        }}
      >
        Add beat
      </button>
    </span>
  )
}

/* ── WhatsApp simulator: same-origin tab, draft arrives only via opener handshake ── */

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const parts = text.split(/(`[^`]+`)/g)
  return parts.map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2)
      return <code key={keyPrefix + i}>{part.slice(1, -1)}</code>
    const bolded = part.split(/(\*\*[^*]+\*\*|__[^_]+__)/g).map((chunk, j) => {
      const bold = /^(\*\*|__)(.+)\1$/.exec(chunk)
      if (bold) return <strong key={keyPrefix + i + 'b' + j}>{bold[2]}</strong>
      const italic = /^(_[^_]+_|~[^~]+~|\*[^*]+\*)$/.exec(chunk)
      if (italic) {
        const inner = italic[1]!.slice(1, -1)
        return chunk.startsWith('~') ? (
          <del key={keyPrefix + i + 'i' + j}>{inner}</del>
        ) : (
          <em key={keyPrefix + i + 'i' + j}>{inner}</em>
        )
      }
      return <span key={keyPrefix + i + 't' + j}>{chunk}</span>
    })
    return <span key={keyPrefix + i}>{bolded}</span>
  })
}

function scoreMood(moods: StudioDraft['moods'], text: string): { key: string; offline: boolean } {
  for (const [key, entry] of Object.entries(moods.moods)) {
    for (const pattern of entry.patterns) {
      if (!pattern.trim()) continue
      try {
        if (new RegExp(pattern, 'iu').test(text)) return { key, offline: true }
      } catch {
        continue
      }
    }
  }
  return { key: moods.default, offline: true }
}

export function StudioSimulator() {
  const [draft, setDraft] = useState<(StudioDraft & { moodKey?: string }) | null>(null)
  const [probe, setProbe] = useState('')
  const [waiting, setWaiting] = useState(true)

  useEffect(() => {
    // Explicit opener handshake: announce readiness, accept the draft only from
    // the same-origin opener. A tab opened directly keeps its empty state.
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== location.origin) return
      if (event.source !== window.opener) return
      const data = event.data as { type?: string; draft?: StudioDraft & { moodKey?: string } } | null
      if (data?.type !== SIMULATOR_DRAFT || !data.draft) return
      window.removeEventListener('message', onMessage)
      window.clearTimeout(timer)
      setDraft(data.draft)
      setWaiting(false)
    }
    const timer = window.setTimeout(() => {
      window.removeEventListener('message', onMessage)
      setWaiting(false)
    }, 15000)
    window.addEventListener('message', onMessage)
    try {
      if (window.opener && window.opener !== window)
        window.opener.postMessage({ type: SIMULATOR_READY }, location.origin)
      else {
        window.clearTimeout(timer)
        setWaiting(false)
      }
    } catch {
      window.clearTimeout(timer)
      setWaiting(false)
    }
    return () => {
      window.removeEventListener('message', onMessage)
      window.clearTimeout(timer)
    }
  }, [])

  if (waiting) return <p role="status">Waiting for the editor tab…</p>
  if (!draft)
    return (
      <section className="studio-sim">
        <h2>Simulator</h2>
        <p>
          No draft arrived. Open this tab with Preview Conversation from the studio editor — the draft travels tab to
          tab, never through a link or storage.
        </p>
      </section>
    )

  const match = probe.trim() ? scoreMood(draft.moods, probe.trim()) : null
  const shown = match ? draft.moods.moods[match.key] : draft.moods.moods[draft.moodKey ?? draft.moods.default]
  const tokens = estimateTokens(buildPromptPreview(draft, match?.key ?? draft.moodKey ?? draft.moods.default).text)

  return (
    <section className="studio-sim" aria-label="WhatsApp simulator">
      <h2>{draft.card.displayName || 'Untitled character'}</h2>
      <p className="studio-hint">
        Synthetic preview — no model call, no delivery. Mood rules run locally; the judge override is unavailable
        offline.
      </p>
      <div className="studio-phone" aria-label="Phone preview">
        <div className="studio-bubble studio-bubble-them">
          {(Object.entries(draft.lines) as [string, string][])
            .filter(([, v]) => v)
            .slice(0, 3)
            .map(([kind, value]) => (
              <p key={kind}>
                <small>{kind}</small>
                {renderInline(value, kind)}
              </p>
            ))}
        </div>
        {shown && (
          <div className="studio-bubble studio-bubble-me">
            <p>{renderInline(shown.openers.find((s) => s.trim()) ?? '(no opener yet)', 'opener')}</p>
            <p className="studio-hint">
              Length ≤ {REPLY_LENGTHS[draft.card.defaultReplyLength]} chars · {shown.faces.filter(Boolean).length} faces
              · {Object.keys(shown.beats ?? {}).length} beats · prompt ≈ {tokens} tokens
            </p>
          </div>
        )}
      </div>
      <Field label="Try a message" hint="Scores the draft mood patterns against this text.">
        <input value={probe} placeholder="Type what a member might send" onChange={(e) => setProbe(e.target.value)} />
      </Field>
      {match && shown && (
        <p role="status">
          Rules pick <strong>{match.key}</strong>: {shown.tone || '(no tone written yet)'}
        </p>
      )}
    </section>
  )
}
