import { useEffect, useMemo, useState } from 'react'
import { Pause, Pencil, Play, Plus, Trash2 } from 'lucide-react'
import type { Chat, CronArchived, CronJob } from '@/lib/api'
import { post } from '@/lib/api'
import { CRON_MODE_LABELS, CRON_MODES, CronJobPolicy, CronSchedule, type CronScheduleData } from '@/lib/cron-schedule'
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

function handleNumericInput(raw: string, apply: (value: number) => void) {
  if (!raw.trim()) return
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return
  apply(Math.trunc(parsed))
}

function SchedulePicker({ value, onChange }: { value: CronSchedule; onChange: (s: CronSchedule) => void }) {
  const set = (patch: Partial<CronScheduleData>) => onChange(value.withPatch(patch))
  return (
    <div className="flex flex-wrap items-end gap-3">
      <Field label="how often">
        {/* Five options, which docs/DESIGN.md says is a segmented group and
            not a dropdown: every choice visible, one tap, nothing to open. */}
        <Segmented
          options={CRON_MODES}
          value={value.mode}
          labels={CRON_MODE_LABELS}
          onChange={(m) => set({ mode: m })}
        />
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
            onChange={(e) => handleNumericInput(e.target.value, (dom) => set({ dom }))}
            className="w-24"
          />
        </Field>
      )}

      {(value.mode === 'hours' || value.mode === 'minutes') && (
        <Field label={value.mode === 'hours' ? 'every N hours' : 'every N minutes'}>
          <Input
            type="number"
            min={1}
            max={value.maxInterval()}
            value={value.n}
            onChange={(e) => handleNumericInput(e.target.value, (n) => set({ n }))}
            className="w-24"
          />
        </Field>
      )}

      {(value.mode === 'daily' || value.mode === 'weekly' || value.mode === 'monthly') && (
        <Field label="at">
          <Input type="time" value={value.time} onChange={(e) => set({ time: e.target.value })} className="w-36" />
        </Field>
      )}

      <p className="mb-2.5 text-[0.85rem] text-muted">→ {humanSchedule(value.toCron())}</p>
    </div>
  )
}

function DeliverPicker({
  chats,
  value,
  onChange,
  single
}: {
  chats: Chat[]
  value: string
  onChange: (v: string) => void
  single: boolean
}) {
  const chosen = new Set(
    value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  )
  function toggle(target: string) {
    if (single) {
      onChange(target)
      return
    }
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
            type={single ? 'radio' : 'checkbox'}
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
  const [sched, setSched] = useState<CronSchedule | null>(() =>
    job ? CronSchedule.parse(job.schedule) : CronSchedule.default()
  )
  const [scheduleEdited, setScheduleEdited] = useState(false)
  const [prompt, setPrompt] = useState(
    (job?.prompt ?? job?.prompt_preview ?? '').replace(/^\[AIRA-SCHEDULED v1 kind=job id=site_[a-f0-9]{32}\]\s*/, '')
  )
  const [deliver, setDeliver] = useState(job?.deliver ?? '')
  const [busy, setBusy] = useState(false)

  async function save() {
    if (!job && !deliver) {
      toast('Choose the chat for this routine', false)
      return
    }
    if (!name.trim() || !prompt.trim()) {
      toast('a job needs a name and something to say', false)
      return
    }
    if (!job || scheduleEdited) {
      const scheduleError = sched?.validate()
      if (scheduleError) {
        toast(scheduleError, false)
        return
      }
    }
    setBusy(true)
    try {
      if (job) {
        const body = CronJobPolicy.buildUpdateBody(job, {
          name,
          schedule: sched,
          scheduleEdited,
          prompt,
          deliver
        })
        await post('/api/cron', body)
      } else {
        const body = CronJobPolicy.buildCreateBody({
          name,
          schedule: sched,
          prompt,
          deliver
        })
        await post('/api/cron', body)
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

        {sched ? (
          <SchedulePicker
            value={sched}
            onChange={(next) => {
              setSched(next)
              setScheduleEdited(true)
            }}
          />
        ) : (
          <Field label="Current schedule">
            <code>{job?.schedule}</code>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setSched(CronSchedule.default())
                setScheduleEdited(true)
              }}
            >
              Replace schedule
            </Button>
          </Field>
        )}

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
          <DeliverPicker
            chats={chats}
            value={deliver}
            onChange={setDeliver}
            single={!job || (job.prompt ?? '').includes('id=site_')}
          />
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
  const managed = CronJobPolicy.isCoreManaged(job)

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

  if (editing && !managed)
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

  const runsLeft = CronJobPolicy.runsLabel(job.repeat)

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
          {runsLeft ? <span className="text-[0.82rem] text-muted">{runsLeft}</span> : null}
          {next && job.enabled ? <span className="text-[0.82rem] text-muted">next {until(next)}</span> : null}
        </div>

        {managed ? (
          <Badge>Managed by AIRA</Badge>
        ) : (
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
        )}
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
          : [{ t: jobs.error ? 'Schedule unavailable' : jobs.loading ? 'Loading schedule…' : 'Nothing scheduled' }]
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
        {jobs.error && (
          <p role="alert">
            {jobs.error} <button onClick={jobs.reload}>Retry</button>
          </p>
        )}
        {chatsApi.error && <p role="alert">Chat destinations unavailable. {chatsApi.error}</p>}
        {jobs.loading && !jobs.data ? (
          <div className="flex items-center gap-2 text-muted">
            <Spinner /> loading…
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {(jobs.data?.jobs ?? []).map((j) => (
              <JobRow key={j.job_id} job={j} chats={chats} onChanged={jobs.reload} />
            ))}
            {!jobs.error && !(jobs.data?.jobs ?? []).length && (
              <Empty>Nothing scheduled yet. “New job” starts one.</Empty>
            )}
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
