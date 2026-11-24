import { useEffect, useState } from 'react'
import { stringify, parse } from 'yaml'
import { core, type CoreCharacter } from '@/lib/core'
import { toast } from '@/lib/hooks'
import { Button, Textarea } from '@/components/ui'
import { FormSelect } from './form-select'
import {
  getStudio,
  putStudio,
  diffDocs,
  StudioError,
  studioHref,
  studioPaths,
  type StudioDoc,
  type StudioDraft
} from './studio-client'
import { Loading } from './loading'

const files = [
  { value: 'card', label: 'card.yml' },
  { value: 'moods', label: 'moods.yml' },
  { value: 'lines', label: 'lines.yml' }
] as const
export default function ProfileFiles({ active }: { active: boolean }) {
  const [packs, setPacks] = useState<CoreCharacter[] | null>(null)
  const [id, setId] = useState('')
  const [file, setFile] = useState<keyof StudioDraft>('card')
  const [doc, setDoc] = useState<StudioDoc | null>(null)
  const [text, setText] = useState('')
  const [base, setBase] = useState('')
  const [issue, setIssue] = useState('')
  const [busy, setBusy] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const dirty = text !== base
  useEffect(() => {
    if (!active || packs) return
    let live = true
    core.characters().then(
      (r) => {
        if (live) {
          setPacks(r.characters)
          setId(r.characters[0]?.id ?? '')
          setIssue('')
        }
      },
      () => {
        if (live) setIssue('Could not load the core persona catalogue.')
      }
    )
    return () => {
      live = false
    }
  }, [active, packs, attempt])
  useEffect(() => {
    if (!id) return
    let live = true
    setDoc(null)
    setIssue('')
    getStudio(id, 'documents').then(
      (d) => {
        if (live) {
          const src = stringify(d[file])
          setDoc(d)
          setText(src)
          setBase(src)
        }
      },
      () => {
        if (live) setIssue('Could not read this pack. Retry to reload it.')
      }
    )
    return () => {
      live = false
    }
  }, [id, file, attempt])
  useEffect(() => {
    if (!dirty) return
    const guard = (e: BeforeUnloadEvent) => e.preventDefault()
    addEventListener('beforeunload', guard)
    return () => removeEventListener('beforeunload', guard)
  }, [dirty])
  async function save() {
    if (!doc || !doc.writable || !dirty || busy) return
    setBusy(true)
    setIssue('')
    try {
      const parsed: unknown = parse(text, { maxAliasCount: 0 })
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error('mapping')
      const patch = diffDocs(doc, { ...doc, [file]: parsed }).patch
      const receipt = await putStudio(id, doc.revision, patch)
      const fresh = await getStudio(id, 'documents')
      if (fresh.revision !== receipt.revision) throw new StudioError(409, 'stale_revision')
      const normalized = stringify(fresh[file])
      setDoc(fresh)
      setText(normalized)
      setBase(normalized)
      toast('Profile file saved.')
    } catch (e) {
      setIssue(
        e instanceof StudioError && e.status === 409
          ? 'This pack changed in another session. Your draft is here to copy or compare. Revert and reload to edit the current revision.'
          : 'Could not save this document. Check its YAML and required fields. Your draft is preserved.'
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="profile-files-grid">
      <div className="dashboard-pane profile-file-picker">
        <h2>Profile Files</h2>
        <p>Choose a loaded character pack and its configuration document.</p>
        {packs?.length ? (
          <>
            <fieldset disabled={busy || dirty}>
              <legend>Character pack</legend>
              <FormSelect
                label="Character pack"
                value={id}
                options={packs.map((p) => ({ value: p.id, label: p.displayName + ' · ' + p.id }))}
                onChange={setId}
              />
            </fieldset>
            <fieldset disabled={busy || dirty}>
              <legend>Document</legend>
              {files.map((f) => (
                <button key={f.value} type="button" aria-pressed={file === f.value} onClick={() => setFile(f.value)}>
                  {f.label}
                </button>
              ))}
            </fieldset>
            <a href={studioHref(studioPaths.edit(id))}>Open in Character Studio</a>
          </>
        ) : packs ? (
          <p>No character packs loaded.</p>
        ) : (
          !issue && <Loading />
        )}
      </div>
      <div className="dashboard-pane profile-file-editor">
        <h2>{file}.yml</h2>
        {issue && (
          <p role="alert">
            {issue} {!dirty && <Button onClick={() => setAttempt((n) => n + 1)}>Retry</Button>}
          </p>
        )}
        {doc ? (
          <>
            <p>
              {doc.writable
                ? 'Editable data pack'
                : doc.source === 'repository'
                  ? 'Read-only built-in pack'
                  : 'Read-only data pack · Studio cannot replace the full pack safely'}{' '}
              · {doc.card.displayName}
            </p>
            <Textarea
              aria-label={file + '.yml content'}
              spellCheck={false}
              readOnly={!doc.writable || busy}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            {dirty && (
              <div className="compose-actions">
                <span>Unsaved changes</span>
                <Button
                  disabled={busy}
                  onClick={() => {
                    setText(base)
                    setAttempt((n) => n + 1)
                  }}
                >
                  Revert and Reload
                </Button>
                <Button disabled={busy} onClick={() => void save()}>
                  Save Changes
                </Button>
              </div>
            )}
          </>
        ) : (
          id && !issue && <Loading />
        )}
      </div>
    </section>
  )
}
