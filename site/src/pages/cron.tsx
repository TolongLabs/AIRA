import { useEffect, useMemo, useState } from 'react'
import { Pause, Pencil, Play, Plus, Trash2 } from 'lucide-react'
import type { Chat, CronArchived, CronJob } from '@/lib/api'
import { post } from '@/lib/api'
import { toast, Toaster, useApi } from '@/lib/hooks'
import { DAYS, humanSchedule, midTrunc, until } from '@/lib/utils'
import { Shell } from '@/components/shell'
import {
  Badge,
  Button,
  Card,
  ConfirmAction,
  Empty,
  Field,
  Input,
  Section,
  Segmented,
  Spinner,
  Textarea
} from '@/components/ui'
import { GenerateButton } from '@/components/generate'

/* Nobody writes cron syntax here. The picker composes it and reads it back in
   the same words, so "30 8 * * *" is only ever an implementation detail. */

const MODES = ['daily', 'weekly', 'monthly', 'hours', 'minutes'] as const
type Mode = (typeof MODES)[number]

const MODE_LABEL: Record<Mode, string> = {
  daily: 'Every day',
  weekly: 'Every week',
  monthly: 'Every month',
  hours: 'Every N hours',
  minutes: 'Every N minutes'
}

interface Sched {
  mode: Mode
  time: string
  dow: number
  dom: number
  n: number
}

const DEFAULT_SCHED: Sched = {
  mode: 'daily',
  time: '08:30',
  dow: 1,
  dom: 1,
  n: 2
}

/* How many runs a job has left, from Hermes's own wording: "forever",
   "once", "7 times" or "3/7". The schedule alone read "Every day at 07:00"
   for a reminder asked for "for the next 7 days" — the limit was set, and
   nothing on this page said so. */
function runsLabel(repeat?: string): string {
  const r = (repeat ?? '').trim()
  if (!r || r === 'forever' || r === 'once' || r === '1/1') return ''
  const done = r.match(/^(\d+)\/(\d+)$/)
  if (done) return `${Number(done[2]) - Number(done[1])} of ${done[2]} runs left`
  const total = r.match(/^(\d+) times$/)
  return total ? `${total[1]} runs, then it stops` : r
}

function parseSched(raw?: string | null): Sched {
  const s = String(raw ?? '').trim()
  const hm = (m: string, h: string) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
  let m = s.match(/^(\d{1,2}) (\d{1,2}) \* \* \*$/)
  if (m) return { ...DEFAULT_SCHED, mode: 'daily', time: hm(m[1], m[2]) }
  m = s.match(/^(\d{1,2}) (\d{1,2}) \* \* (\d)$/)
  if (m)
    return {
      ...DEFAULT_SCHED,
      mode: 'weekly',
      time: hm(m[1], m[2]),
      dow: +m[3]
    }
  m = s.match(/^(\d{1,2}) (\d{1,2}) (\d{1,2}) \* \*$/)
  if (m)
    return {
      ...DEFAULT_SCHED,
      mode: 'monthly',
      time: hm(m[1], m[2]),
      dom: +m[3]
    }
  m = s.match(/^0 \*\/(\d+) \* \* \*$/)
  if (m) return { ...DEFAULT_SCHED, mode: 'hours', n: +m[1] }
  m = s.match(/^\*\/(\d+) \* \* \* \*$/)
  if (m) return { ...DEFAULT_SCHED, mode: 'minutes', n: +m[1] }
  return DEFAULT_SCHED
}

function toCron(s: Sched): string {
  const [h, m] = s.time.split(':').map((x) => String(Number(x)))
  switch (s.mode) {
    case 'daily':
      return `${m} ${h} * * *`
    case 'weekly':
      return `${m} ${h} * * ${s.dow}`
    case 'monthly':
      return `${m} ${h} ${s.dom} * *`
    case 'hours':
      return `0 */${s.n} * * *`
    case 'minutes':
      return `*/${s.n} * * * *`
  }
}

function SchedulePicker({ value, onChange }: { value: Sched; onChange: (s: Sched) => void }) {
  const set = (patch: Partial<Sched>) => onChange({ ...value, ...patch })
  return (
    <div className="flex flex-wrap items-end gap-3">
      <Field label="how often">
        {/* Five options, which docs/DESIGN.md says is a segmented group and
            not a dropdown: every choice visible, one tap, nothing to open. */}
        <Segmented options={MODES} value={value.mode} labels={MODE_LABEL} onChange={(m) => set({ mode: m })} />
      </Field>

      {value.mode === 'weekly' && (
        <Field label="on">
          {/* Seven days as seven buttons. A week is the one set everybody
              reads as a row — putting it behind a dropdown hides six of the
              seven answers to "which day". */}
          <Segmented
            options={DAYS}
            value={DAYS[value.dow]}
            labels={Object.fromEntries(DAYS.map((d) => [d, d.slice(0, 3)]))}
            onChange={(d) => set({ dow: DAYS.indexOf(d) })}
          />
        </Field>
      )}

      {value.mode === 'monthly' && (
        <Field label="day of month">
          <Input
            type="number"
            min={1}
            max={28}
            value={value.dom}
            onChange={(e) => set({ dom: +e.target.value })}
            className="w-24"
          />
        </Field>
      )}

      {(value.mode === 'hours' || value.mode === 'minutes') && (
        <Field label={value.mode === 'hours' ? 'every N hours' : 'every N minutes'}>
          <Input
            type="number"
            min={1}
            max={59}
            value={value.n}
            onChange={(e) => set({ n: +e.target.value })}
            className="w-24"
          />
        </Field>
      )}

      {(value.mode === 'daily' || value.mode === 'weekly' || value.mode === 'monthly') && (
        <Field label="at">
          <Input type="time" value={value.time} onChange={(e) => set({ time: e.target.value })} className="w-36" />
        </Field>
      )}

      <p className="mb-2.5 text-[0.85rem] text-muted">→ {humanSchedule(toCron(value))}</p>
    </div>
  )
}

function DeliverPicker({ chats, value, onChange }: { chats: Chat[]; value: string; onChange: (v: string) => void }) {
  const chosen = useMemo(
    () =>
      new Set(
        value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      ),
    [value]
  )
  function toggle(target: string) {
    const next = new Set(chosen)
    if (next.has(target)) next.delete(target)
    else next.add(target)
    onChange([...next].join(','))
  }
  return (
    <div className="flex flex-col gap-1">
      {chats.map((c) => (
        <label key={c.target} className="flex min-h-10 cursor-pointer items-center gap-2.5 text-[0.92rem]">
          <input
            type="checkbox"
            checked={chosen.has(c.target)}
            onChange={() => toggle(c.target)}
            className="size-4 accent-[var(--accent)]"
          />
          <span>{c.label || c.name || c.kind}</span>
          <Badge>{c.kind}</Badge>
          <span className="font-mono text-[0.7rem] text-faint">{midTrunc(c.jid, 26)}</span>
        </label>
      ))}
      {!chats.length && <Empty>No chats known yet.</Empty>}
    </div>
  )
}

function JobEditor({
  job,
  chats,
  onDone,
  onCancel
}: {
  job?: CronJob
  chats: Chat[]
  onDone: () => void
  onCancel: () => void
}) {
  const [name, setName] = useState(job?.name ?? '')
  const [sched, setSched] = useState<Sched>(parseSched(job?.schedule))
  const [prompt, setPrompt] = useState(job?.prompt ?? job?.prompt_preview ?? '')
  const [deliver, setDeliver] = useState(job?.deliver ?? '')
  const [busy, setBusy] = useState(false)

  async function save() {
    if (!name.trim() || !prompt.trim()) {
      toast('a job needs a name and something to say', false)
      return
    }
    setBusy(true)
    try {
      if (job) {
        const body: Record<string, unknown> = {
          action: 'update',
          job_id: job.job_id
        }
        if (name.trim() !== (job.name ?? '')) body.name = name.trim()
        const cron = toCron(sched)
        if (cron !== (job.schedule ?? '')) body.schedule = cron
        if (prompt !== (job.prompt ?? job.prompt_preview ?? '')) body.prompt = prompt
        if (deliver !== (job.deliver ?? '')) body.deliver = deliver
        await post('/api/cron', body)
      } else {
        await post('/api/cron', {
          action: 'create',
          name: name.trim(),
          schedule: toCron(sched),
          prompt,
          ...(deliver ? { deliver } : {})
        })
      }
      toast(job ? 'saved ✓' : 'created ✓')
      onDone()
    } catch (e) {
      toast((e as Error).message, false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="p-5">
      <div className="flex flex-col gap-4">
        <Field label="what to call it">
          <Input
            value={name}
            autoFocus
            placeholder="morning check-in"
            onChange={(e) => setName(e.target.value)}
            className="max-w-md"
          />
        </Field>

        <SchedulePicker value={sched} onChange={setSched} />

        <div>
          <Field label="what she does when it fires">
            <Textarea
              rows={5}
              value={prompt}
              placeholder="Ask him how he slept, and mention anything he said he'd do today."
              onChange={(e) => setPrompt(e.target.value)}
            />
          </Field>
          <GenerateButton kind="cron" context={prompt} onAccept={setPrompt} />
        </div>

        <Field label="who it goes to">
          <DeliverPicker chats={chats} value={deliver} onChange={setDeliver} />
        </Field>

        <div className="flex flex-wrap gap-2">
          <Button variant="primary" disabled={busy} onClick={() => void save()}>
            {busy ? <Spinner /> : null}
            {job ? 'Save changes' : 'Create job'}
          </Button>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </Card>
  )
}

function JobRow({ job, chats, onChanged }: { job: CronJob; chats: Chat[]; onChanged: () => void }) {
  const [editing, setEditing] = useState(false)

  async function act(body: Record<string, unknown>, said: string) {
    try {
      await post('/api/cron', { ...body, job_id: job.job_id })
      toast(said)
      onChanged()
    } catch (e) {
      toast((e as Error).message, false)
      // Rethrown so a confirm strip stays open on failure instead of closing
      // as though the job had gone. The toast is still the user-facing report.
      throw e
    }
  }

  if (editing)
    return (
      <JobEditor
        job={job}
        chats={chats}
        onDone={() => {
          setEditing(false)
          onChanged()
        }}
        onCancel={() => setEditing(false)}
      />
    )

  const next = job.next_run_at ? Date.parse(job.next_run_at) / 1000 : null
  // "origin" / "all" / "local" are routing INTENTS, not chat ids, so looking
  // them up in the chat list always misses. This used to fall back to
  // `target ${i + 1}`, which turned a job pointed at the family group into
  // "goes to target 1" — and, worse, disguised a genuinely broken value
  // (deliver="chat", which resolves to nothing) as though it were a real
  // destination. An unresolved token now shows itself.
  const targets = (job.deliver ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => {
      const chat = chats.find((c) => c.target === t)
      if (chat) return chat.label || chat.name || chat.kind
      const intent = t.toLowerCase()
      if (intent === 'origin') {
        // origin.chat_name is captured when the job is CREATED, and for a
        // group that was a bare id, so trusting it prints a number forever.
        // Resolve the id against the live directory first.
        const oid = job.origin?.chat_id
        const plat = job.origin?.platform || 'whatsapp'
        const live = oid ? chats.find((c) => c.target === `${plat}:${oid}`) : undefined
        if (live) return live.label || live.name || live.kind
        const stored = job.origin?.chat_name
        const bare = (oid || '').split('@')[0]
        if (stored && stored !== oid && stored !== bare) return stored
        return oid || 'the chat it was created in'
      }
      if (intent === 'all') return 'every connected platform'
      if (intent === 'local') return 'not delivered — saved only'
      return `${t} — unknown, goes nowhere`
    })

  return (
    <Card className={job.enabled ? 'p-5' : 'p-5 opacity-60'}>
      {/* Two groups, not one wrapping row. Everything used to sit in a single
          flex-wrap line with the buttons pushed right by ml-auto, so the
          buttons competed with the name, the badge, the schedule and the
          countdown for the same space — and the moment the metadata got long
          (a schedule reading "Weekdays at 06:00, 07:00, 17:00, 18:00" rather
          than a bare crontab line) they wrapped onto a line of their own with
          a band of empty card above them. The meta now wraps INSIDE its own
          box and the actions hold the top-right corner. */}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-serif text-[1.15rem]">{job.name || job.job_id}</span>
          {/* A job that was stopped by a FAILURE is not "paused" — paused is
            something a person chose. Cron now keeps a failed job instead of
            deleting it (so the error survives to be read), which made that
            distinction load-bearing: without this, the only trace of a
            reminder that blew up read as a deliberate pause. */}
          <Badge tone={job.last_status === 'error' ? 'accent' : job.enabled ? 'on' : 'off'}>
            {job.last_status === 'error' && !job.enabled
              ? 'failed — not deleted'
              : job.enabled
                ? job.state || 'scheduled'
                : 'paused'}
          </Badge>
          <span className="font-mono text-[0.86rem] tabular-nums text-read" title={job.schedule ?? ''}>
            {humanSchedule(job.schedule)}
          </span>
          {runsLabel(job.repeat) ? <span className="text-[0.82rem] text-muted">{runsLabel(job.repeat)}</span> : null}
          {next && job.enabled ? <span className="text-[0.82rem] text-muted">next {until(next)}</span> : null}
        </div>

        <div className="flex shrink-0 gap-1">
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
            <Pencil />
            edit
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              void act({ action: job.enabled ? 'pause' : 'resume' }, job.enabled ? 'paused ✓' : 'resumed ✓')
            }
          >
            {job.enabled ? <Pause /> : <Play />}
            {job.enabled ? 'pause' : 'resume'}
          </Button>
          <ConfirmAction
            label="remove"
            confirmLabel="Remove"
            icon={<Trash2 />}
            question={`Remove ${job.name ? `“${job.name}”` : 'this job'}?`}
            onConfirm={() => act({ action: 'remove' }, 'removed ✓')}
          />
        </div>
      </div>

      {job.prompt_preview ? (
        <p className="mt-3 mb-0 line-clamp-3 text-[0.92rem] leading-relaxed text-read">{job.prompt_preview}</p>
      ) : null}

      <p className="mt-3 mb-0 text-[0.82rem] text-muted">
        {targets.length ? `goes to ${targets.join(', ')}` : 'no chat chosen — the result is only saved here'}
      </p>
    </Card>
  )
}

export default function CronPage() {
  const jobs = useApi<{ jobs: CronJob[]; archive?: CronArchived[] }>('/api/cron')
  const chatsApi = useApi<{ chats: Chat[] }>('/api/chats')
  const [adding, setAdding] = useState(false)
  const chats = chatsApi.data?.chats ?? []

  useEffect(() => {
    if (jobs.error) toast(jobs.error, false)
  }, [jobs.error])

  /* The hero answers the only question this page exists for: what happens
     next, and when. */
  const scheduled = useMemo(() => (jobs.data?.jobs ?? []).filter((j) => j.enabled && j.next_run_at), [jobs.data])
  const soonest = useMemo(
    () => [...scheduled].sort((a, b) => Date.parse(a.next_run_at!) - Date.parse(b.next_run_at!))[0],
    [scheduled]
  )

  return (
    <Shell
      page="cron"
      title="Cron"
      hero={
        soonest
          ? [
              { n: String(scheduled.length) },
              /* The list below renders EVERY job, paused ones included, while
                 this counts only the ones actually due to run — so a page
                 showing six rows could be headed "2 jobs scheduled" with
                 nothing accounting for the other four. Name the difference. */
              {
                t:
                  (scheduled.length === 1 ? ' job scheduled' : ' jobs scheduled') +
                  ((jobs.data?.jobs ?? []).length > scheduled.length
                    ? ` of ${(jobs.data?.jobs ?? []).length} listed`
                    : '') +
                  '. Next: '
              },
              { n: soonest.name ?? 'a job' },
              { t: ' ' },
              { n: until(Date.parse(soonest.next_run_at!) / 1000) }
            ]
          : [{ t: 'Nothing scheduled' }]
      }
      actions={
        <Button variant="primary" onClick={() => setAdding((v) => !v)}>
          <Plus />
          New job
        </Button>
      }
    >
      <Toaster />

      {adding && (
        <Section title="New job">
          <JobEditor
            chats={chats}
            onDone={() => {
              setAdding(false)
              jobs.reload()
            }}
            onCancel={() => setAdding(false)}
          />
        </Section>
      )}

      <Section title="Scheduled">
        {jobs.loading && !jobs.data ? (
          <div className="flex items-center gap-2 text-muted">
            <Spinner /> loading…
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {(jobs.data?.jobs ?? []).map((j) => (
              <JobRow key={j.job_id} job={j} chats={chats} onChanged={jobs.reload} />
            ))}
            {!(jobs.data?.jobs ?? []).length && <Empty>Nothing scheduled yet. “New job” starts one.</Empty>}
          </div>
        )}
      </Section>

      <ArchiveSection rows={jobs.data?.archive ?? []} />
    </Shell>
  )
}

/* Cron pops a job out of jobs.json the moment its last run is claimed, and
   executions.db keeps the run under a job_id alone — so once the job is gone,
   nothing in cron can tell you it ever existed. The mirrored note outlives it,
   which is why it is not deleted, and this is the only place it can be read. */
/* Three of these are OUTCOMES and the fourth is the absence of one.

   "fired" means executions.db has a completed run for this job_id — it went
   off, and we can prove it. "finished" means the archive row carries no
   job_id at all, so executions.db cannot be asked and how it ended is simply
   not recoverable. Labelling that "finished" put an unknown next to a
   confirmed one in the same column and made them read as synonyms; on this
   box every single "finished" row is a job_id-less one. Say what it is.

   The stored value stays "finished": reconcile() keys its "a settled entry
   stays settled" guard on that string, and renaming it on disk would need a
   migration to buy nothing the label does not already buy. */
const OUTCOME: Record<string, { label: string; tone: string; hint: string }> = {
  fired: {
    label: 'fired',
    tone: 'text-up',
    hint: 'ran and completed — there is an execution record for it'
  },
  failed: {
    label: 'failed',
    tone: 'text-down',
    hint: 'ran and did not complete'
  },
  cancelled: {
    label: 'called off',
    tone: 'text-muted',
    hint: 'removed before it ever ran'
  },
  finished: {
    label: 'outcome unknown',
    tone: 'text-faint',
    hint: 'no job id was recorded, so whether this ever ran cannot be recovered'
  }
}

function ArchiveSection({ rows }: { rows: CronArchived[] }) {
  const [open, setOpen] = useState(false)
  if (!rows.length) return null
  const shown = open ? rows : rows.slice(0, 5)
  return (
    /* Not "Finished": that was the section name AND one of the four statuses
       inside it, which is half of why the statuses read as duplicates. */
    <Section title={`Archive · ${rows.length}`}>
      <p className="mt-0 mb-4 max-w-prose text-[0.9rem] text-muted">
        Jobs no longer scheduled. <b>fired</b> ran and completed, <b>failed</b> ran and did not, <b>called off</b> was
        removed before it ran, and <b>outcome unknown</b> means no job id was recorded so there is nothing left to ask.
      </p>
      <div className="flex flex-col gap-2">
        {shown.map((r, i) => {
          const o = OUTCOME[r.status] ?? {
            label: r.status,
            tone: 'text-muted',
            hint: ''
          }
          return (
            <div
              /* reminders.record keys on job_id, not scope/name — so
                 re-creating a job under a former name yields two archive rows
                 with the same React key and one of them is dropped from the
                 DOM. Fall back to the index, which is always unique. */
              key={`${r.scope}/${r.name}/${r.updated ?? ''}/${i}`}
              className="rounded-card border border-line bg-card p-3"
            >
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-medium">{r.name}</span>
                <span className={`font-mono text-[0.72rem] ${o.tone}`} title={o.hint}>
                  {o.label}
                </span>
                <span className="text-[0.78rem] text-faint">
                  {r.when ? new Date(r.when).toLocaleString() : r.updated}
                </span>
              </div>
              {r.summary && <p className="mt-1 mb-0 text-[0.86rem] text-muted">{r.summary}</p>}
            </div>
          )
        })}
      </div>
      {rows.length > 5 && (
        <Button size="sm" variant="ghost" className="mt-3" onClick={() => setOpen((v) => !v)}>
          {open ? 'Show fewer' : `Show all ${rows.length}`}
        </Button>
      )}
    </Section>
  )
}
