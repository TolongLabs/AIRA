import { useEffect, useMemo, useState } from 'react'
import { Shell } from '@/components/shell'
import { post } from '@/lib/api'
import { toast, Toaster, useApi } from '@/lib/hooks'
import { Badge, Button, Card, ConfirmAction, Empty, Field, Picker, Section, Segmented, Toggle } from '@/components/ui'

/* Who gets told when a Claude session finishes, and on which machine.
 *
 * Its own page because the delegation is the thing people need to SEE. It was
 * two JSON files and a hostname you had to guess, and a route keyed on the
 * wrong name fails silently — an unrouted machine is indistinguishable from a
 * machine nobody subscribed to. So the machine is picked from what has
 * actually reported, and the recipient from chats she can actually reach.
 * Neither is typed. */

interface Route {
  machine: string
  target: string
  label: string
  enabled: boolean
  /** "summary" — one line of what changed. "full" — the whole reply. */
  mode: 'summary' | 'full'
  /** "every_turn" — a notice each time a reply completes. "session_end" —
      only when the session closes. */
  when: 'every_turn' | 'session_end'
  /** Whether the operator's own words may be quoted into this chat. Served
      by the API specifically so this page can SHOW it — a privacy control
      the admin surface cannot display is one that drifts without anybody
      noticing, which is exactly what happened: it was readable and settable
      only by hand-editing the routes file. */
  quote_prompt?: boolean
  /** Minutes this chat has asked to stay silent, 0 if it has not. A mute is
      set from the CHAT, so without this the page showed a silenced route as
      "on / delivering" and nothing said why nothing was arriving. */
  quiet_for_minutes?: number
  /** The chat said "until I ask": quiet with no end. quiet_for_minutes then
      reads as a day that never runs out, so it is not shown. */
  quiet_held?: boolean
  /** A nightly routine, "00:00-10:00" in the chat's clock, or "". Set from
      the chat ("mute every day from 12am to 10am"); shown so the page and
      the promise agree. */
  quiet_daily?: string
  /** The chat's own "off until I ask" switched this route off. Releasing
      the hold switches it back on; a route paused by hand stays paused. */
  off_by_hold?: boolean
}
/** A chat silenced right now, routed or not. A held chat with no routes
    showed up nowhere on this page, so nothing here could release it. */
interface QuietChat {
  target: string
  /** Her name for the chat, or "" when she does not know one. */
  label: string
  /** "Until I ask": no end time, so `minutes` means nothing. */
  held: boolean
  /** Epoch seconds the hold began, 0 when not held. */
  held_since: number
  /** Minutes left of a timed mute or tonight's window. */
  minutes: number
  /** A nightly routine, "00:00-10:00", or "". Release leaves it in place. */
  daily: string
}
interface Machine {
  machine: string
  last_seen: number
  routed: boolean
  /** Has routes, all of them switched off. Not the same as having none:
      "nobody is told" read identically for both, which hides the entire
      reason a paused route is kept rather than removed. */
  paused?: boolean
}
interface Target {
  jid: string
  label: string
  kind: string
}
interface Session {
  project: string
  branch: string
  model: string
  entrypoint: string
  turns: number
  idle_seconds: number
  active: boolean
  tools: string[]
}
interface Notices {
  sessions: Session[]
  routes: Route[]
  machines: Machine[]
  targets: Target[]
  quiet?: QuietChat[]
}

function ago(unix: number): string {
  if (!unix) return 'never'
  const s = Math.max(0, Math.floor(Date.now() / 1000) - unix)
  if (s < 90) return 'just now'
  if (s < 5400) return `${Math.round(s / 60)} min ago`
  if (s < 172800) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} d ago`
}

export default function NoticesPage() {
  const api = useApi<Notices>('/api/notices')
  const data = api.data
  const [busy, setBusy] = useState('')
  /* Sessions come off transcripts on disk, so this is live without a hook or a
     subscription — it just has to be asked again. Ten seconds is under the
     time it takes to notice something changed and long enough not to matter. */
  useEffect(() => {
    const t = setInterval(() => void api.reload(), 10_000)
    return () => clearInterval(t)
  }, [api])
  const [machine, setMachine] = useState('')
  const [target, setTarget] = useState('')

  const sessions = data?.sessions ?? []
  const routes = data?.routes ?? []
  const machines = data?.machines ?? []
  const targets = data?.targets ?? []
  const quiet = data?.quiet ?? []
  const live = useMemo(() => routes.filter((r: Route) => r.enabled).length, [routes])

  /* A route stores "whatsapp:<jid>"; targets are keyed on the bare jid. Passing
     the whole thing in missed every lookup and fell through to printing the
     raw id — which is why every row read as a number ending in @lid. */
  const nameOf = (target: string) => {
    const jid = target.includes(':') ? target.slice(target.indexOf(':') + 1) : target
    return targets.find((t: Target) => t.jid === jid)?.label ?? jid
  }

  async function save(r: Partial<Route> & { remove?: boolean }) {
    const key = `${r.machine}|${r.target}`
    setBusy(key)
    try {
      await post('/api/settings/notice_route', r)
      await api.reload()
      toast(r.remove ? 'route removed ✓' : 'saved ✓')
    } catch (e) {
      toast((e as Error).message, false)
    } finally {
      setBusy('')
    }
  }

  /* Throws on failure so ConfirmAction stays armed and the operator can read
     the toast before deciding again. */
  async function release(q: QuietChat) {
    setBusy(`quiet|${q.target}`)
    try {
      const r = await post<{ routes_restored?: string[] }>('/api/settings/quiet_release', { target: q.target })
      await api.reload()
      const back = r?.routes_restored ?? []
      toast(back.length ? `released, ${back.join(', ')} on ✓` : 'released ✓')
    } catch (e) {
      toast((e as Error).message, false)
      throw e
    } finally {
      setBusy('')
    }
  }

  return (
    <Shell
      page="notices"
      title="Notices"
      hero={
        routes.length
          ? [
              { n: String(live) },
              {
                t: live === 1 ? ' route delivering, ' : ' routes delivering, '
              },
              { n: String(routes.length - live) },
              { t: ' paused' }
            ]
          : [{ t: 'Nothing is being announced' }]
      }
    >
      <Toaster />

      <Section title="Running now">
        {!sessions.length ? (
          <Empty>No Claude session has touched this machine recently.</Empty>
        ) : (
          <Card className="p-5">
            {sessions.map((x: Session, i: number) => (
              <div
                key={`${x.project}-${i}`}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-line-2 py-2 first:border-t-0 first:pt-0"
              >
                <span className={x.active ? 'text-accent' : 'text-faint'} aria-hidden>
                  {x.active ? '\u25cf' : '\u25cb'}
                </span>
                <b className="font-semibold">{x.project}</b>
                {x.branch && <span className="font-mono text-[0.78rem] text-muted">{x.branch}</span>}
                <span className="text-[0.85rem] text-muted">{x.turns.toLocaleString()} turns</span>
                <span className="text-[0.85rem] text-muted">
                  {x.active
                    ? `active ${ago(Math.floor(Date.now() / 1000) - x.idle_seconds)}`
                    : `idle ${ago(Math.floor(Date.now() / 1000) - x.idle_seconds)}`}
                </span>
                {x.tools.length > 0 && (
                  <span className="ml-auto font-mono text-[0.72rem] text-faint">{x.tools.join(' · ')}</span>
                )}
              </div>
            ))}
          </Card>
        )}
      </Section>

      <Section title="Routes">
        {api.error && (
          <Card className="p-5">
            <p className="m-0 text-[0.9rem] text-down">Could not load routes: {String(api.error)}</p>
          </Card>
        )}

        {!api.error && api.loading && !routes.length && (
          <Card className="p-5">
            <p className="m-0 text-[0.9rem] text-muted">Loading routes…</p>
          </Card>
        )}

        {!api.error && !api.loading && !routes.length && (
          <Empty
            title="No routes yet"
            action={
              machines.length ? undefined : (
                <span className="text-[0.85rem] text-faint">
                  No machine has reported yet either — install the hook first.
                </span>
              )
            }
          >
            When a Claude session finishes on one of your machines, whoever is routed to it gets a message. Nothing is
            routed yet, so nothing is sent.
          </Empty>
        )}

        {routes.map((r: Route, i: number) => {
          // The controls are keyed on machine+target on purpose — the writer
          // addresses every row for that pair in one locked pass, which is
          // what makes the toggle honest. The React key cannot be: two rows
          // for one pair collided, which is an unstable list.
          const key = `${r.machine}|${r.target}`
          const rowKey = `${key}|${i}`
          const twin = routes.filter((o: Route) => o.machine === r.machine && o.target === r.target).length
          const known = machines.some((m: Machine) => m.machine === r.machine)
          return (
            <Card key={rowKey} className="mb-3 p-4">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
                <span className="text-[0.92rem] text-muted">When</span>
                <code className="rounded-card border border-line-2 bg-sunk px-2 py-1 font-mono text-[0.78rem]">
                  {r.machine}
                </code>
                <span className="text-[0.92rem] text-muted">finishes a session, tell</span>
                <b className="font-semibold">{nameOf(r.target)}</b>
                {r.label ? (
                  /* Stored, served, and until now never shown — the one field
                     that tells two otherwise identical rows apart. */
                  <span className="text-[0.82rem] text-faint">“{r.label}”</span>
                ) : null}
                <Badge>{r.enabled ? 'on' : 'paused'}</Badge>
                {r.quiet_held ? (
                  <Badge>held until they ask</Badge>
                ) : (r.quiet_for_minutes ?? 0) > 0 ? (
                  <Badge>quiet {r.quiet_for_minutes}m</Badge>
                ) : null}
                {r.quiet_daily ? <Badge>nightly {r.quiet_daily}</Badge> : null}
                <div className="ml-auto flex items-center gap-2">
                  <Toggle
                    checked={r.enabled}
                    disabled={busy === key}
                    onChange={(v) => void save({ ...r, enabled: v })}
                    label={r.enabled ? 'on' : 'off'}
                  />
                  {/* Deleting sat one unconfirmed click from the reversible
                      toggle beside it, and a removed route cannot be turned
                      back on from the chat — the chat tool refuses to
                      recreate one. Same treatment the other four destructive
                      actions on this site already got. */}
                  <ConfirmAction
                    label="remove"
                    confirmLabel="Remove"
                    question={`Remove the route telling ${nameOf(r.target)} about ${r.machine}?`}
                    onConfirm={() => void save({ ...r, remove: true })}
                  />
                </div>
              </div>
              {/* How much they get. Two people watching the same machine do
                  not want the same volume, so it is per route. */}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className="text-[0.82rem] text-muted">sends</span>
                <Segmented
                  options={['a summary', 'the whole reply'] as const}
                  value={r.mode === 'full' ? 'the whole reply' : 'a summary'}
                  onChange={(v) =>
                    void save({
                      ...r,
                      mode: v === 'the whole reply' ? 'full' : 'summary'
                    })
                  }
                />
                <span className="text-[0.8rem] text-faint">
                  {r.mode === 'full'
                    ? 'every reply in full, up to ~3,500 characters'
                    : 'files touched, tools run, and the first line'}
                </span>
              </div>
              {/* Every hook fires on a COMPLETION — nothing fires mid-work —
                  so this is not "progress vs done", it is how often you are
                  told something finished. */}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="text-[0.82rem] text-muted">tell them</span>
                <Segmented
                  options={['after every reply', 'only when it closes'] as const}
                  value={r.when === 'session_end' ? 'only when it closes' : 'after every reply'}
                  onChange={(v) =>
                    void save({
                      ...r,
                      when: v === 'only when it closes' ? 'session_end' : 'every_turn'
                    })
                  }
                />
                <span className="text-[0.8rem] text-faint">
                  {r.when === 'session_end'
                    ? 'one message when the session ends, nothing during it'
                    : 'one message each time a reply finishes'}
                </span>
              </div>
              {twin > 1 && (
                <p className="mt-2 mb-0 text-[0.82rem] text-muted">
                  This machine has <b>{twin}</b> rows pointing at the same chat. They deliver one message between them,
                  and these controls change all of them together.
                </p>
              )}
              {r.quiet_held ? (
                <p className="mt-2 mb-0 text-[0.82rem] text-muted">
                  This chat asked for quiet until they say otherwise: no notices and none of her own messages, with no
                  end time. Reminders they set still arrive. It lifts when they ask her to turn notifications back on,
                  or when you release it under Quiet chats.
                </p>
              ) : null}
              {r.off_by_hold && !r.enabled ? (
                <p className="mt-2 mb-0 text-[0.82rem] text-muted">
                  The chat's hold switched this route off. It comes back on when the hold is lifted.
                </p>
              ) : null}
              {!r.quiet_held && (r.quiet_for_minutes ?? 0) > 0 && (
                /* The route is on and nothing is arriving. Without this the
                   page and the truth disagree for up to a day. */
                <p className="mt-2 mb-0 text-[0.82rem] text-muted">
                  This chat asked to be left alone and is quiet for another <b>{r.quiet_for_minutes} minute(s)</b>. The
                  route is untouched and resumes by itself.
                </p>
              )}
              {r.quiet_daily ? (
                <p className="mt-2 mb-0 text-[0.82rem] text-muted">
                  Quiet every day <b>{r.quiet_daily}</b> (their clock), by the chat's own request. Nothing runs at
                  midnight: the window is re-derived on every delivery.
                </p>
              ) : null}
              {/* The one control that decides whether the operator's own
                  typed words are quoted into somebody else's chat. */}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Toggle
                  checked={!!r.quote_prompt}
                  disabled={busy === key || r.mode === 'full'}
                  onChange={(v) => void save({ ...r, quote_prompt: v })}
                  label="quote what was asked"
                />
                <span className="text-[0.8rem] text-faint">
                  {r.mode === 'full'
                    ? 'a full route sends the whole reply, which usually restates the request — this cannot be honoured there'
                    : r.quote_prompt
                      ? 'the line that started the session is included'
                      : 'off — only what finished, never what was asked'}
                </span>
              </div>
              {!known && (
                /* The silent-failure case, made loud. A route whose machine has
                   never reported will never fire, and looks identical to one
                   that simply has not fired yet. */
                <p className="mt-2 mb-0 text-[0.82rem] text-down">
                  No machine calling itself <b>{r.machine}</b> has ever reported here, so this route will never fire.
                  Check the name against the list below.
                </p>
              )}
            </Card>
          )
        })}
      </Section>

      <Section title="Quiet chats">
        {/* Every chat silenced right now, with or without routes. A hold has
            no end time, so without this row the only way out was that chat
            saying "on". */}
        {!quiet.length ? (
          <Empty>No chat has asked for quiet.</Empty>
        ) : (
          <Card className="p-5">
            {quiet.map((q: QuietChat) => {
              const jid = q.target.slice(q.target.indexOf(':') + 1)
              const name = q.label || jid
              return (
                <div
                  key={q.target}
                  className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line-2 py-3 first:border-t-0 first:pt-0 last:pb-0"
                >
                  <b className="font-semibold">{name}</b>
                  {q.label && q.label !== jid ? (
                    <span className="font-mono text-[0.78rem] text-muted">{jid.split('@')[0]}</span>
                  ) : null}
                  {q.held ? <Badge>held until they ask</Badge> : <Badge>quiet {q.minutes}m</Badge>}
                  {q.daily ? <Badge>nightly {q.daily}</Badge> : null}
                  <span className="text-[0.82rem] text-muted">
                    {q.held
                      ? q.held_since
                        ? `since ${ago(q.held_since)}, no end time`
                        : 'no end time'
                      : 'lifts by itself'}
                  </span>
                  <div className="ml-auto">
                    <ConfirmAction
                      label="release"
                      confirmLabel="Release"
                      disabled={busy !== ''}
                      question={`Release ${name}?`}
                      warning={
                        q.held
                          ? 'Her own messages and the notices this hold switched off can reach them again.'
                          : `Notices and her own messages can reach them again now.${q.daily ? ' The nightly routine stays.' : ''}`
                      }
                      onConfirm={() => release(q)}
                    />
                  </div>
                </div>
              )
            })}
          </Card>
        )}
      </Section>

      <Section title="Add a route">
        <Card className="p-5">
          {/* A grid, because two Fields where only one carries a hint do not
              line up under flex-wrap + items-end: the hint adds a line and
              shoves that column's control up relative to its neighbour. */}
          <div className="grid items-start gap-4 sm:grid-cols-[1fr_1fr_auto]">
            <Field
              label="when this machine finishes"
              hint={
                machines.length
                  ? 'listed once a machine has reported at least one session'
                  : 'none yet — install the hook on a machine and finish a session'
              }
            >
              <Picker
                ariaLabel="which machine"
                placeholder="pick a machine…"
                searchPlaceholder="type a machine name…"
                value={machine}
                onChange={setMachine}
                options={machines.map((m: Machine) => ({
                  value: m.machine,
                  label: m.machine,
                  hint: `last reported ${ago(m.last_seen)}`
                }))}
              />
            </Field>

            <Field label="tell this chat">
              {/* A PENDING row's jid is the bare number ("+60…"), and
                  _set_notice_route requires a real WhatsApp id — so every one
                  of these was offered here and 400'd on save. Offer only what
                  can actually be stored. */}
              <Picker
                ariaLabel="which chat"
                placeholder="pick a chat…"
                searchPlaceholder="type a name or number…"
                value={target}
                onChange={setTarget}
                options={targets
                  .filter((t: Target) => /^\d{5,}@/.test(String(t.jid ?? '')))
                  .map((t: Target) => ({
                    value: `whatsapp:${t.jid}`,
                    label: t.label,
                    hint: `${t.kind} · ${String(t.jid).split('@')[0]}`
                  }))}
              />
            </Field>

            <Button
              className="sm:mt-6"
              disabled={!machine || !target || busy !== ''}
              onClick={() =>
                void save({ machine, target, enabled: false }).then(() => {
                  setMachine('')
                  setTarget('')
                })
              }
            >
              Add
            </Button>
          </div>
          <p className="mt-3 mb-0 max-w-prose text-[0.82rem] text-muted">
            {/* Stated because it is a deliberate refusal to be convenient:
                filling in a form should not start messaging a person. */}
            A new route is added paused. Turn it on when you mean it.
          </p>
        </Card>
      </Section>

      <Section title="Machines that have reported">
        {!machines.length ? (
          <Empty title="Nothing has reported yet">
            A machine appears here the first time a session finishes on it with the hook installed. The name shown is
            what to route on.
          </Empty>
        ) : (
          <Card className="p-5">
            <table className="w-full border-collapse text-[0.9rem]">
              <thead>
                <tr className="text-left text-muted">
                  <th className="py-1 font-medium">machine</th>
                  <th className="py-1 font-medium">last reported</th>
                  <th className="py-1 font-medium">routed</th>
                </tr>
              </thead>
              <tbody>
                {machines.map((m: Machine) => (
                  <tr key={m.machine} className="border-t border-line-2">
                    <td className="py-2 font-mono text-[0.82rem]">{m.machine}</td>
                    <td className="py-2 text-muted">{ago(m.last_seen)}</td>
                    <td className="py-2">
                      {m.routed ? (
                        <span className="text-accent">yes</span>
                      ) : (
                        <span className="text-faint">{m.paused ? 'routed, but paused' : 'nobody is told'}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </Section>
    </Shell>
  )
}
