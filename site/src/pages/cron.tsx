import { useContext, useEffect, useMemo, useRef, useState } from 'react'
import { Pause, Pencil, Play, Plus, Trash2 } from 'lucide-react'
import type { Chat, CronArchived, CronJob } from '@/lib/api'
import { get, post } from '@/lib/api'
import { DashboardContext } from '@/dashboard/context'
import { dashboardHref } from '@/dashboard/navigation'
import '@/dashboard/automations.css'
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
  Tabs,
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
  const [prompt, setPrompt] = useState(CronJobPolicy.editablePrompt(job ?? undefined))
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
        <p className="mt-3 mb-0 line-clamp-3 text-[0.92rem] leading-relaxed text-read">
          {CronJobPolicy.editablePrompt({ prompt_preview: job.prompt_preview })}
        </p>
      ) : null}

      <p className="mt-3 mb-0 text-[0.82rem] text-muted">
        {targets.length ? `goes to ${targets.join(', ')}` : 'no chat chosen — the result is only saved here'}
      </p>
    </Card>
  )
}

type RoutinesTab = 'scheduled' | 'archive'

/* Dashboard-only helpers. Legacy MPA (cron.html) keeps its inline list; the
 * dashboard (Figma 22:1102) is a master-detail: Scheduled and Archive tabs
 * over an Upcoming Runs list with New Routine on the left and the Routine
 * Detail on the right, stacked on phone. All reads use the same owner models
 * (/api/cron, /api/chats) — no fictional data. Edits reuse JobEditor, so the
 * schedule stays byte-for-byte and the full prompt unless changed, and
 * core-managed aira: jobs stay read-only. */
function routinesLocation(): { tab: RoutinesTab; query: string; selectedId: string | null; badId: boolean } {
  if (typeof window === 'undefined') return { tab: 'scheduled', query: '', selectedId: null, badId: false }
  const params = new URLSearchParams(window.location.search)
  const tab: RoutinesTab = params.get('tab') === 'archive' ? 'archive' : 'scheduled'
  const query = params.get('q') ?? ''
  const m = window.location.pathname.match(/automations\/routines\/([^/?#]+)/)
  if (!m || m[1] == null) return { tab, query, selectedId: null, badId: false }
  try {
    return { tab, query, selectedId: decodeURIComponent(m[1]), badId: false }
  } catch {
    return { tab, query, selectedId: null, badId: true }
  }
}

function routinesListHref(tab: RoutinesTab, query: string): string {
  const params = new URLSearchParams()
  if (tab === 'archive') params.set('tab', 'archive')
  if (query) params.set('q', query)
  const qs = params.toString()
  return dashboardHref('automations/routines') + (qs ? `?${qs}` : '')
}

function routineDetailHref(jobId: string, tab: RoutinesTab, query: string): string {
  const params = new URLSearchParams()
  if (tab === 'archive') params.set('tab', 'archive')
  if (query) params.set('q', query)
  const qs = params.toString()
  return dashboardHref(`automations/routines/${encodeURIComponent(jobId)}`) + (qs ? `?${qs}` : '')
}

const ROUTINES_SCROLL_KEY = 'aira-automations-routines-scroll'

function RoutinesDashboard({
  jobsApi,
  chatsApi
}: {
  jobsApi: {
    data: { jobs: CronJob[]; archive?: CronArchived[] } | null
    error: string | null
    loading: boolean
    reload: () => Promise<unknown>
  }
  chatsApi: { data: { chats: Chat[] } | null; error: string | null; loading: boolean; reload: () => void }
}) {
  const initial = useMemo(routinesLocation, [])
  const [tab, setTab] = useState<RoutinesTab>(initial.tab)
  const [query, setQuery] = useState(initial.query)
  const [adding, setAdding] = useState(false)
  /* A selected id missing from the first payload is not yet gone. Mark it
     gone only after a successful complete re-read without it; a failed
     re-read stays a transient failure with its own Retry and never claims
     deletion. One in-flight check at a time, no auto-write loop. */
  const [verifiedGone, setVerifiedGone] = useState(false)
  const [verifyError, setVerifyError] = useState<string | null>(null)
  const [verifying, setVerifying] = useState(false)
  const verifyBusy = useRef(false)
  const selectedId = initial.selectedId
  const badId = initial.badId
  const chats = chatsApi.data?.chats ?? []
  const jobs = useMemo(() => jobsApi.data?.jobs ?? [], [jobsApi.data])
  const archive = useMemo(() => jobsApi.data?.archive ?? [], [jobsApi.data])

  /* Filtered Upcoming Runs: enabled first by next run, then the rest by name.
   * The query stays in the URL (?q=) so a cold link and a return from detail
   * keep the same list. */
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const rows = needle
      ? jobs.filter((j) => `${j.name ?? ''} ${j.job_id} ${j.schedule ?? ''}`.toLowerCase().includes(needle))
      : [...jobs]
    const time = (j: CronJob) => {
      const t = j.next_run_at ? Date.parse(j.next_run_at) : NaN
      return Number.isFinite(t) ? (t as number) : Infinity
    }
    return rows.sort((a, b) => time(a) - time(b) || String(a.name ?? '').localeCompare(String(b.name ?? '')))
  }, [jobs, query])

  const selected = selectedId ? (jobs.find((j) => j.job_id === selectedId) ?? null) : null

  /* A selected id missing from the first payload may be a stale list rather
   * than a deleted job. Re-read once before calling it unknown; if the fresh
   * read has it, refresh the list so detail renders instead of recovery.
   * Gone is decided only by a successful complete read without the id. A
   * failed re-read keeps the transient error and offers Retry. Deps are
   * stable values, never the whole jobsApi object, so this runs once per
   * selected id and never loops. */
  const jobsData = jobsApi.data
  const jobsLoading = jobsApi.loading
  const jobsError = jobsApi.error
  const jobsReload = jobsApi.reload
  useEffect(() => {
    setVerifiedGone(false)
    setVerifyError(null)
    setVerifying(false)
    verifyBusy.current = false
  }, [selectedId])
  useEffect(() => {
    if (!selectedId || badId || selected || jobsLoading || jobsError || !jobsData) return
    if (!Array.isArray(jobsData.jobs)) return
    if (verifiedGone || verifyError || verifying || verifyBusy.current) return
    verifyBusy.current = true
    setVerifying(true)
    let live = true
    void get<{ jobs: CronJob[] }>('/api/cron')
      .then((fresh) => {
        if (!live) return
        if (!fresh || !Array.isArray(fresh.jobs)) {
          setVerifyError('Schedule check did not complete — try again.')
          return
        }
        if (fresh.jobs.some((j) => j.job_id === selectedId)) void jobsReload()
        else setVerifiedGone(true)
      })
      .catch((e) => {
        if (live) setVerifyError(e instanceof Error ? e.message : 'Schedule check failed.')
      })
      .finally(() => {
        verifyBusy.current = false
        if (live) setVerifying(false)
      })
    return () => {
      live = false
    }
  }, [selectedId, badId, selected, jobsData, jobsLoading, jobsError, jobsReload, verifiedGone, verifyError, verifying])

  function retryVerify() {
    setVerifyError(null)
    setVerifiedGone(false)
    setVerifying(false)
    verifyBusy.current = false
  }

  /* Scroll restoration: leaving detail returns to the list position. */
  useEffect(() => {
    if (selectedId) return
    const saved = Number(sessionStorage.getItem(ROUTINES_SCROLL_KEY) ?? '')
    if (Number.isFinite(saved) && saved > 0) window.scrollTo({ top: saved })
  }, [selectedId])

  useEffect(() => {
    if (jobsApi.error) toast(jobsApi.error, false)
  }, [jobsApi.error])

  function syncUrl(nextTab: RoutinesTab, nextQuery: string) {
    const url = new URL(window.location.href)
    if (nextTab === 'archive') url.searchParams.set('tab', 'archive')
    else url.searchParams.delete('tab')
    if (nextQuery) url.searchParams.set('q', nextQuery)
    else url.searchParams.delete('q')
    history.replaceState(null, '', url)
  }

  function changeTab(next: RoutinesTab) {
    setTab(next)
    setAdding(false)
    if (selectedId || badId) {
      window.location.href = routinesListHref(next, query)
      return
    }
    syncUrl(next, query)
  }

  function changeQuery(next: string) {
    setQuery(next)
    syncUrl(tab, next)
  }

  function rememberScroll() {
    try {
      sessionStorage.setItem(ROUTINES_SCROLL_KEY, String(window.scrollY))
    } catch {
      /* private mode: the list simply starts at the top on return */
    }
  }

  const listHref = routinesListHref(tab, query)

  return (
    <div className="automations-wrap">
      <Toaster />
      <Tabs
        label="Routine views"
        value={tab}
        onChange={changeTab}
        tabs={[
          { key: 'scheduled', label: 'Scheduled', count: jobs.length },
          { key: 'archive', label: 'Archive', count: archive.length }
        ]}
      />
      {tab === 'archive' ? (
        <div className="automations-panel">
          {jobsApi.error && !jobsApi.data ? (
            <div className="automations-alert" role="alert">
              <p className="m-0 text-[0.9rem]">Schedule unavailable: {jobsApi.error}</p>
              <div className="automations-actions">
                <Button size="sm" variant="outline" onClick={() => void jobsApi.reload()}>
                  Retry
                </Button>
              </div>
            </div>
          ) : (
            <ArchiveSection rows={archive} />
          )}
        </div>
      ) : (
        <div className="automations-layout">
          <div className="automations-list">
            <div className="automations-list-head">
              <p className="automations-kicker">Upcoming runs</p>
              <Button size="sm" variant="primary" onClick={() => setAdding(true)}>
                <Plus />
                New routine
              </Button>
            </div>
            <Field label="Filter routines">
              <Input
                type="search"
                value={query}
                placeholder="name, id or schedule…"
                aria-label="Filter routines"
                onChange={(e) => changeQuery(e.target.value)}
              />
            </Field>
            {jobsApi.loading && !jobsApi.data ? (
              <p role="status" className="mt-3 mb-0 flex items-center gap-2 text-muted">
                <Spinner /> loading…
              </p>
            ) : jobsApi.error && !jobsApi.data ? (
              <div className="automations-alert mt-3" role="alert">
                <p className="m-0 text-[0.9rem]">Schedule unavailable: {jobsApi.error}</p>
                <div className="automations-actions">
                  <Button size="sm" variant="outline" onClick={() => void jobsApi.reload()}>
                    Retry
                  </Button>
                </div>
              </div>
            ) : !visible.length ? (
              <p className="mt-3 mb-0 text-[0.92rem] text-muted">
                {jobs.length ? 'Nothing matches this filter.' : 'Nothing scheduled yet. “New routine” starts one.'}
              </p>
            ) : (
              <ul className="automations-rows">
                {visible.map((j) => {
                  const on = selectedId === j.job_id
                  const next = j.next_run_at ? Date.parse(j.next_run_at) / 1000 : null
                  return (
                    <li key={j.job_id}>
                      <a
                        className="automations-row"
                        aria-current={on || undefined}
                        href={routineDetailHref(j.job_id, tab, query)}
                        onClick={rememberScroll}
                      >
                        <span className="automations-row-name">{j.name || j.job_id}</span>
                        <span className="automations-row-meta">
                          {humanSchedule(j.schedule)}
                          {next && j.enabled ? ` · next ${until(next)}` : j.enabled ? '' : ' · paused'}
                        </span>
                        <span className="automations-row-id">{j.job_id}</span>
                      </a>
                    </li>
                  )
                })}
              </ul>
            )}
            {chatsApi.error ? (
              <div className="automations-alert mt-3" role="alert">
                <p className="m-0 text-[0.85rem] text-muted">Chat destinations unavailable. {chatsApi.error}</p>
                <div className="automations-actions">
                  <Button size="sm" variant="ghost" onClick={() => chatsApi.reload()}>
                    Retry
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
          <div className="automations-detail">
            {adding ? (
              <JobEditor
                chats={chats}
                onDone={() => {
                  setAdding(false)
                  void jobsApi.reload()
                }}
                onCancel={() => setAdding(false)}
              />
            ) : badId ? (
              <div className="automations-alert" role="alert">
                <p className="m-0 text-[0.9rem]">That routine link is not a valid routine.</p>
                <div className="automations-actions">
                  <a className="automations-row" href={listHref}>
                    Back to routines
                  </a>
                </div>
              </div>
            ) : selectedId && !selected ? (
              jobsApi.error ? (
                <div className="automations-alert" role="alert">
                  <p className="m-0 text-[0.9rem]">Routine unavailable: {jobsApi.error}</p>
                  <div className="automations-actions">
                    <a className="automations-row" href={listHref}>
                      Back to routines
                    </a>
                    <Button size="sm" variant="outline" onClick={() => void jobsApi.reload()}>
                      Retry
                    </Button>
                  </div>
                </div>
              ) : verifyError ? (
                <div className="automations-alert" role="alert">
                  <p className="m-0 text-[0.9rem]">Could not confirm this routine: {verifyError}</p>
                  <div className="automations-actions">
                    <a className="automations-row" href={listHref}>
                      Back to routines
                    </a>
                    <Button size="sm" variant="outline" onClick={retryVerify}>
                      Retry
                    </Button>
                  </div>
                </div>
              ) : verifiedGone ? (
                <div className="automations-alert" role="alert">
                  <p className="m-0 text-[0.9rem]">This routine is gone — it was removed or the link is stale.</p>
                  <div className="automations-actions">
                    <a className="automations-row" href={listHref}>
                      Back to routines
                    </a>
                  </div>
                </div>
              ) : (
                <p role="status" className="m-0 flex items-center gap-2 text-muted">
                  <Spinner /> checking the schedule…
                </p>
              )
            ) : selected ? (
              <>
                {chatsApi.error ? (
                  <div className="automations-alert" role="alert">
                    <p className="m-0 text-[0.85rem] text-muted">Chat destinations unavailable. {chatsApi.error}</p>
                    <div className="automations-actions">
                      <Button size="sm" variant="ghost" onClick={() => chatsApi.reload()}>
                        Retry
                      </Button>
                    </div>
                  </div>
                ) : null}
                <JobRow job={selected} chats={chats} onChanged={() => void jobsApi.reload()} />
                {selected.prompt_preview || selected.prompt ? (
                  <p className="automations-detail-prompt">
                    {CronJobPolicy.editablePrompt({
                      prompt: selected.prompt,
                      prompt_preview: selected.prompt_preview
                    })}
                  </p>
                ) : null}
              </>
            ) : (
              <Empty title="No routine selected">
                Pick a run on the left, or start a new routine. A link straight to a routine opens it here.
              </Empty>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default function CronPage() {
  const jobs = useApi<{ jobs: CronJob[]; archive?: CronArchived[] }>('/api/cron')
  const chatsApi = useApi<{ chats: Chat[] }>('/api/chats')
  const inDashboard = useContext(DashboardContext)
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

  /* Dashboard (Figma 22:1102, editor 35:2377): the same owner models in a
   * master-detail. Shell passes children through in the dashboard, so this
   * keeps the legacy MPA byte-identical below. */
  if (inDashboard)
    return (
      <Shell page="cron" title="Routines">
        <RoutinesDashboard jobsApi={jobs} chatsApi={chatsApi} />
      </Shell>
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
