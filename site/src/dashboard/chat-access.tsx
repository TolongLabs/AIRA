import { core } from '@/lib/core'
import { useEffect, useId, useRef, useState } from 'react'
import { Badge, Button, Field, Input } from '@/components/ui'

/* Who may write in this chat (PRD FR-40, docs/trd/dashboard-state.md).
   Standalone preview edit for the authoritative `allowedSenders` core key: the
   Chats tab shows the value read-only, this component adds the gated owner edit.
   The draft lives only in memory until the owner confirms it. Nothing is logged,
   stored or placed in the URL, a refusal or conflict keeps the draft, and cancel
   restores the authoritative value. */

export type ChatAccessValue = 'all' | string[]

export interface ChatAccessProps {
  /** The authoritative value from the core. */
  current: ChatAccessValue
  chatId: string
  chatType: 'dm' | 'group'
  /** True when the value is inherited from above this chat. */
  inherited: boolean
  /** Persist the staged value. Null clears it back to inherited. False, or a
      throw, keeps the draft so the owner can compare and try again. */
  save: (next: ChatAccessValue | null) => Promise<boolean>
}

/** One sender id problem, or null when the candidate can join the staged list. */
function senderIdProblem(candidate: string, listed: readonly string[]): string | null {
  const trimmed = candidate.trim()
  if (trimmed === '') return 'Enter a sender id.'
  if (trimmed.length > 128) return 'At most 128 characters.'
  if (/\s/.test(trimmed)) return 'Sender ids contain no spaces. Matching is exact, including case.'
  if (listed.includes(trimmed)) return 'That sender is already listed.'
  return null
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id))
}

function summaryFor(current: ChatAccessValue, chatType: 'dm' | 'group'): string {
  const where = chatType === 'dm' ? 'this direct chat' : 'this group'
  if (current === 'all') return `Everyone in ${where} may write.`
  if (current.length === 0) return `Nobody in ${where} may write: every sender is refused at admission.`
  const plural = current.length === 1 ? '' : 's'
  return `Only ${current.length} listed sender${plural} in ${where} may write. Anyone else is refused at admission with no reply.`
}

function impactFor(current: ChatAccessValue, next: ChatAccessValue | null): string {
  if (next === null) return 'Clears this chat’s own value. The level above applies again from the next turn.'
  if (next === 'all')
    return current === 'all'
      ? 'Nothing changes: everyone stays allowed.'
      : 'Everyone in this chat will be answered again.'
  if (current === 'all') {
    if (next.length === 0) return 'Nobody will be answered: every sender is refused at admission with no reply.'
    const plural = next.length === 1 ? '' : 's'
    return `Only these ${next.length} sender${plural} will be answered. Every other sender is refused at admission with no reply.`
  }
  const added = next.filter((id) => !current.includes(id))
  const removed = current.filter((id) => !next.includes(id))
  if (added.length === 0 && removed.length === 0) return 'Nothing changes.'
  const parts = []
  if (added.length > 0) parts.push(`${added.length} added`)
  if (removed.length > 0) parts.push(`${removed.length} removed`)
  return `${parts.join(', ')}. Refused senders get no reply; the listed ones are answered.`
}

export function ChatAccess({ current, chatId, chatType, inherited, save }: ChatAccessProps) {
  const groupName = useId()
  const [editing, setEditing] = useState(false)
  const [mode, setMode] = useState<'all' | 'list'>(current === 'all' ? 'all' : 'list')
  const [listed, setListed] = useState<string[]>(current === 'all' ? [] : [...current])
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [reviewing, setReviewing] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [observed, setObserved] = useState<{ id: string; label: string | null }[]>([])
  useEffect(() => {
    if (!editing || mode !== 'list') return
    let live = true
    core.senders(chatId).then(
      (r) => {
        if (live) setObserved(r.senders)
      },
      () => {
        if (live) setObserved([])
      }
    )
    return () => {
      live = false
    }
  }, [chatId, editing, mode])
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (reviewing) cancelRef.current?.focus()
  }, [reviewing])

  function restore(value: ChatAccessValue) {
    setMode(value === 'all' ? 'all' : 'list')
    setListed(value === 'all' ? [] : [...value])
    setText('')
    setError(null)
    setNotice(null)
    setReviewing(false)
    setClearing(false)
  }

  function startEdit() {
    restore(current)
    setEditing(true)
  }

  function cancel() {
    restore(current)
    setEditing(false)
  }

  function add() {
    const candidates = text
      .split(/[,;\n]+/)
      .map((id) => id.trim())
      .filter(Boolean)
    const next = [...listed]
    for (const candidate of candidates) {
      const problem = senderIdProblem(candidate, next)
      if (problem) {
        setError(problem)
        return
      }
      next.push(candidate)
    }
    if (!candidates.length) {
      setError('Enter a sender id.')
      return
    }
    setListed(next)
    setText('')
    setError(null)
  }

  function remove(index: number) {
    setListed((prev) => prev.filter((_, i) => i !== index))
    setError(null)
  }

  const pending: ChatAccessValue | null = clearing ? null : mode === 'all' ? 'all' : [...listed]
  const unchanged =
    !clearing &&
    ((current === 'all' && pending === 'all') ||
      (current !== 'all' && pending !== 'all' && pending !== null && sameList(current, pending)))

  async function confirm() {
    setBusy(true)
    setNotice(null)
    try {
      const ok = await save(pending)
      if (ok) {
        setEditing(false)
        setReviewing(false)
        setClearing(false)
      } else {
        setNotice('The core refused it. Your draft is kept: compare, edit, and confirm again, or cancel.')
      }
    } catch {
      setNotice('The save failed and nothing changed. Your draft is kept: try again, or cancel to restore.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono text-[0.68rem] font-medium tracking-[0.14em] text-muted uppercase">
          Who may write
        </span>
        <Badge tone={inherited ? 'neutral' : 'accent'}>{inherited ? 'Inherited' : 'Set here'}</Badge>
      </div>
      <p className="m-0 text-[0.95rem]" aria-live="polite">
        {summaryFor(current, chatType)}
      </p>
      {!editing ? (
        <div>
          <Button size="sm" onClick={startEdit}>
            Edit who may write
          </Button>
        </div>
      ) : reviewing ? (
        <div
          role="alert"
          onKeyDown={(e) => {
            if (e.key === 'Escape') cancel()
          }}
          className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-card border border-accent/40 bg-accent-soft/40 px-3 py-2"
        >
          <p className="m-0 min-w-0 flex-1 basis-56 text-[0.85rem] leading-snug text-ink">
            {impactFor(current, pending)}
          </p>
          {notice && <p className="m-0 min-w-0 flex-1 basis-56 text-[0.82rem] text-down">{notice}</p>}
          <div className="ml-auto flex shrink-0 gap-1">
            <Button ref={cancelRef} size="sm" variant="ghost" disabled={busy} onClick={cancel}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" disabled={busy} onClick={() => void confirm()}>
              {clearing ? 'Clear to inherited' : 'Confirm save'}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
            <legend className="px-0 text-[0.82rem] font-medium text-muted">Who may write in this chat</legend>
            <label className="flex min-h-[44px] cursor-pointer items-center gap-2 text-[0.92rem]">
              <input
                type="radio"
                name={groupName}
                checked={mode === 'all'}
                disabled={busy}
                onChange={() => {
                  setMode('all')
                  setError(null)
                }}
              />
              Allow everyone
            </label>
            <label className="flex min-h-[44px] cursor-pointer items-center gap-2 text-[0.92rem]">
              <input
                type="radio"
                name={groupName}
                checked={mode === 'list'}
                disabled={busy}
                onChange={() => {
                  setMode('list')
                  setError(null)
                }}
              />
              Only listed senders
            </label>
          </fieldset>
          {mode === 'list' && observed.some((sender) => !listed.includes(sender.id)) && (
            <div className="access-observed">
              <strong>Recent senders</strong>
              <div>
                {observed
                  .filter((sender) => !listed.includes(sender.id))
                  .map((sender) => (
                    <Button
                      key={sender.id}
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        setListed([...listed, sender.id])
                        setError(null)
                      }}
                    >
                      {sender.label || sender.id} +
                    </Button>
                  ))}
              </div>
            </div>
          )}
          {mode === 'list' && (
            <Field
              label="Sender ids"
              hint="Paste one sender ID or a comma-separated list. Only listed senders can start a turn."
            >
              {listed.length > 0 && (
                <div className="flex flex-wrap gap-2" aria-label="Listed senders">
                  {listed.map((id, index) => (
                    <span
                      key={id}
                      className="inline-flex min-h-[44px] max-w-full items-center gap-1 rounded-full border border-line bg-sunk/60 py-1 pr-1 pl-3.5 font-mono text-[0.78rem] text-ink"
                    >
                      <span className="truncate">{id}</span>
                      <button
                        type="button"
                        disabled={busy}
                        aria-label={`Remove ${id}`}
                        onClick={() => remove(index)}
                        className="inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent text-muted transition-colors hover:text-down disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  id="chat-access-add"
                  value={text}
                  disabled={busy}
                  onChange={(e) => {
                    setText(e.target.value)
                    if (error) setError(null)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      add()
                    }
                  }}
                  className="min-w-0 flex-1 basis-40 font-mono text-[0.85rem]"
                  aria-label="Add a sender id"
                  aria-invalid={error ? true : undefined}
                  placeholder="Sender IDs, separated by commas"
                  autoComplete="off"
                  spellCheck={false}
                />
                <Button size="sm" className="shrink-0" disabled={busy || text.length === 0} onClick={add}>
                  Add
                </Button>
              </div>
            </Field>
          )}
          {error && (
            <p role="alert" className="m-0 text-[0.8rem] text-down">
              {error}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={busy || unchanged || (mode === 'list' && !!text.trim())}
              onClick={() => {
                setNotice(null)
                setClearing(false)
                setReviewing(true)
              }}
            >
              Review
            </Button>
            {!inherited && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setNotice(null)
                  setClearing(true)
                  setReviewing(true)
                }}
              >
                Use Defaults
              </Button>
            )}
            <Button size="sm" variant="ghost" disabled={busy} onClick={cancel}>
              Cancel
            </Button>
          </div>
          <p className="m-0 text-[0.78rem] text-faint">
            {inherited
              ? 'Inherited from above this chat. Saving sets it for this chat only.'
              : 'Set for this chat. Clearing restores the inherited value.'}
          </p>
        </div>
      )}
    </div>
  )
}
