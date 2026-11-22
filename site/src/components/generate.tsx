import { useState } from 'react'
import { Sparkles, X } from 'lucide-react'
import { post } from '@/lib/api'
import { toast } from '@/lib/hooks'
import { Button, Input, Spinner } from '@/components/ui'

/* Write-it-for-me. The user types the point of the thing in one line; the
   model writes the prose. It never writes over what is already there without
   asking — the draft lands in a preview and the user decides. */

export type GenKind = 'cron' | 'soul' | 'rules' | 'note'

const PLACEHOLDER: Record<GenKind, string> = {
  cron: 'a warm nudge each morning to stretch before opening the laptop',
  soul: 'a calm, dry-humoured persona who is good at explaining things',
  rules: 'in this mode she answers in two sentences and never uses emoji',
  note: 'what I learned about the graph layout today'
}

export function GenerateButton({
  kind,
  context,
  onAccept,
  label = 'Write it for me'
}: {
  kind: GenKind
  /** Existing text, sent as reference-only so a rewrite keeps the thread. */
  context?: string
  onAccept: (text: string) => void
  label?: string
}) {
  const [open, setOpen] = useState(false)
  const [intent, setIntent] = useState('')
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState<string | null>(null)

  async function run() {
    const said = intent.trim()
    if (!said) return
    setBusy(true)
    setDraft(null)
    try {
      const r = await post<{ text?: unknown }>('/api/generate', {
        kind,
        intent: said,
        ...(context ? { context } : {})
      })
      const text = typeof r?.text === 'string' ? r.text : ''
      if (!text.trim()) {
        toast('the model returned nothing — try again', false)
        return
      }
      setDraft(text)
    } catch (e) {
      toast((e as Error).message, false)
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <Button variant="ghost" size="sm" type="button" onClick={() => setOpen(true)}>
        <Sparkles />
        {label}
      </Button>
    )
  }

  return (
    <div className="mt-2 rounded-card border border-accent/40 bg-accent-soft/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[0.68rem] font-medium uppercase tracking-[0.14em] text-accent">
          Write it for me
        </span>
        <button
          type="button"
          aria-label="close"
          onClick={() => setOpen(false)}
          className="cursor-pointer border-0 bg-transparent p-1 text-muted hover:text-ink"
        >
          <X className="size-4" />
        </button>
      </div>

      <p className="mt-1 mb-2 text-[0.85rem] text-muted">Describe what it should do in one line.</p>

      <div className="flex flex-wrap gap-2">
        <Input
          value={intent}
          autoFocus
          placeholder={PLACEHOLDER[kind]}
          onChange={(e) => setIntent(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !busy) {
              e.preventDefault()
              void run()
            }
          }}
          className="flex-1 basis-64"
        />
        <Button variant="primary" type="button" disabled={busy} onClick={() => void run()}>
          {busy ? <Spinner /> : <Sparkles />}
          {busy ? 'Writing…' : 'Write'}
        </Button>
      </div>

      {typeof draft === 'string' && draft && (
        <div className="mt-3">
          <p className="m-0 mb-1.5 text-[0.78rem] text-muted">Draft — yours to keep or bin:</p>
          <div className="max-h-64 overflow-auto rounded-card border border-line bg-card p-3 text-[0.92rem] leading-relaxed whitespace-pre-wrap">
            {draft}
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              variant="primary"
              size="sm"
              type="button"
              onClick={() => {
                if (typeof draft !== 'string' || !draft.trim()) return
                onAccept(draft)
                setOpen(false)
                setDraft(null)
                setIntent('')
                toast('dropped it in ✓')
              }}
            >
              Use this
            </Button>
            <Button size="sm" type="button" disabled={busy} onClick={() => void run()}>
              Try again
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
