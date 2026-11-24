import { ArrowUpRight, CalendarClock, CircleCheck, CirclePause, LibraryBig, MessagesSquare, Radio } from 'lucide-react'
import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import type { CronJob, Dashboard } from '@/lib/api'
import { core, type CoreChat } from '@/lib/core'
import { useApi } from '@/lib/hooks'
import { dashboardHref } from './navigation'
import { Loading } from './loading'
import './overview.css'

const stamp = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })
const date = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
function Card({
  route,
  kind,
  title,
  icon,
  children
}: {
  route: string
  kind: string
  title: string
  icon: ReactNode
  children: ReactNode
}) {
  return (
    <a className={'insight insight-' + kind} href={dashboardHref(route)}>
      <div className="insight-heading">
        {icon}
        <h2>{title}</h2>
        <ArrowUpRight aria-hidden="true" />
      </div>
      {children}
    </a>
  )
}

export function Overview() {
  const host = useApi<Dashboard>('/api/dashboard')
  const routines = useApi<{ jobs: CronJob[] }>('/api/cron')
  const [chats, setChats] = useState<CoreChat[] | 'unavailable' | null>(null)
  useEffect(() => {
    let current = true
    core.chats().then(
      (value) => {
        if (current) setChats(value.chats)
      },
      () => {
        if (current) setChats('unavailable')
      }
    )
    return () => {
      current = false
    }
  }, [])
  const units = Object.entries(host.data?.services ?? {}).sort(
    ([, a], [, b]) => Number(a === 'active') - Number(b === 'active')
  )
  const online = units.filter(([, state]) => state === 'active').length
  const active = Array.isArray(chats) ? chats.filter((chat) => chat.status === 'active').length : 0
  const groups = Array.isArray(chats) ? chats.filter((chat) => chat.type === 'group').length : 0
  const jobs = routines.data?.jobs.filter((job) => job.enabled) ?? []
  const agenda = jobs
    .flatMap((job) => {
      const time = Date.parse(job.next_run_at ?? '')
      return Number.isFinite(time) ? [{ job, time }] : []
    })
    .sort((a, b) => a.time - b.time)
  const shelves = Object.entries(host.data?.brain ?? {})
    .filter(([, n]) => Number.isFinite(n) && n > 0)
    .sort(([, a], [, b]) => b - a)
  const total = shelves.reduce((sum, [, n]) => sum + n, 0)
  const hostWait = !host.data && (host.error ? 'Unavailable' : <Loading layout="metric" />)
  return (
    <div className="operations-board">
      <Card kind="health" route="system/health" title="Service Health" icon={<Radio aria-hidden="true" />}>
        {hostWait ||
          (units.length ? (
            <>
              <div className="readiness">
                <div className="readiness-ring">
                  <svg viewBox="0 0 96 96" aria-hidden="true">
                    <circle cx="48" cy="48" r="40" />
                    <circle
                      cx="48"
                      cy="48"
                      r="40"
                      pathLength="100"
                      strokeDasharray={`${(100 * online) / units.length} 100`}
                    />
                  </svg>
                  <strong>
                    {online}/{units.length}
                  </strong>
                </div>
                <div>
                  <strong>{online === units.length ? 'Healthy' : 'Needs attention'}</strong>
                  <span>
                    {online} of {units.length} Online
                  </span>
                </div>
              </div>
              <ul className="unit-matrix">
                {units.map(([name, state]) => (
                  <li key={name}>
                    {state === 'active' ? <CircleCheck aria-hidden="true" /> : <CirclePause aria-hidden="true" />}
                    <span>
                      {name}
                      <small>{state === 'active' ? 'Online' : state}</small>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p>No services reported.</p>
          ))}
      </Card>
      <Card kind="chats" route="chats" title="Chats" icon={<MessagesSquare aria-hidden="true" />}>
        {Array.isArray(chats) ? (
          <>
            <div className="insight-count">
              {chats.length}
              <span>total chats</span>
            </div>
            <div className="chat-distribution" aria-hidden="true">
              {Array.from({ length: 32 }, (_, i) => (
                <i key={i} data-filled={chats.length > 0 && (i + 0.5) / 32 <= active / chats.length} />
              ))}
            </div>
            <div className="chat-legend">
              <strong>{active} Active</strong>
              <span>{chats.length - active} Pending</span>
            </div>
            <small>
              {groups} group · {chats.length - groups} direct
            </small>
          </>
        ) : chats === null ? (
          <Loading layout="metric" />
        ) : (
          <p>Chats unavailable.</p>
        )}
      </Card>
      <Card kind="agenda" route="automations/routines" title="Routines" icon={<CalendarClock aria-hidden="true" />}>
        {!routines.data ? (
          routines.error ? (
            <p>Schedule unavailable.</p>
          ) : (
            <Loading />
          )
        ) : (
          <>
            <div className="agenda-summary">
              <strong>{agenda.length ? 'Next runs' : 'No upcoming run'}</strong>
              <span>{jobs.length} scheduled</span>
            </div>
            {agenda.length > 0 && (
              <ol className="run-agenda">
                {agenda.slice(0, 3).map(({ job, time }) => (
                  <li key={job.job_id}>
                    <time dateTime={new Date(time).toISOString()}>{stamp.format(time)}</time>
                    <span>
                      <b>{job.name || 'Unnamed routine'}</b>
                      <small>{date.format(time)}</small>
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </>
        )}
      </Card>
      <Card kind="library" route="library" title="Library" icon={<LibraryBig aria-hidden="true" />}>
        {hostWait || (
          <>
            <strong className="collection-count">{total} saved items</strong>
            {shelves.length > 0 ? (
              <ol className="shelf-chart">
                {shelves.slice(0, 4).map(([name, n]) => (
                  <li key={name}>
                    <span>{name.replaceAll('_', ' ')}</span>
                    <i aria-hidden="true">
                      <i style={{ width: (100 * n) / shelves[0]![1] + '%' }} />
                    </i>
                    <b>{n}</b>
                  </li>
                ))}
              </ol>
            ) : (
              <p>The collection is empty.</p>
            )}
          </>
        )}
      </Card>
    </div>
  )
}
