import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import type { CronJob, Dashboard } from '@/lib/api'
import { core, type CoreChat } from '@/lib/core'
import { useApi } from '@/lib/hooks'
import { dashboardHref } from './navigation'

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
  const units = Object.entries(host.data?.services ?? {})
  const active = Array.isArray(chats) ? chats.filter((chat) => chat.status === 'active').length : 0
  const pending = Array.isArray(chats) ? chats.filter((chat) => chat.status === 'pending').length : 0
  const online = units.filter(([, state]) => state === 'active').length
  const jobs = routines.data?.jobs.filter((job) => job.enabled) ?? []
  const next = jobs
    .map((job) => Date.parse(job.next_run_at ?? ''))
    .filter(Number.isFinite)
    .sort((a, b) => a - b)[0]
  const hostStatus = host.error ? 'Unavailable' : host.loading ? 'Loading…' : ''
  return (
    <div className="overview-grid">
      <a className="overview-health" href={dashboardHref('system/health')}>
        <span>
          {hostStatus || (units.length ? online + ' of ' + units.length + ' Online' : 'No services reported')}
        </span>
        {units.length > 0 && (
          <strong>
            {online}/{units.length}
          </strong>
        )}
        <h2>Service Health</h2>
        {!hostStatus && units.length > 0 && (
          <span className="overview-status" data-online={online === units.length}>
            {online === units.length ? 'Healthy' : 'Needs attention'}
          </span>
        )}
        <ul>
          {units.map(([unit, state]) => (
            <li key={unit}>
              <b data-online={state === 'active'}>{unit}</b>
              <span>{state === 'active' ? 'Online' : state}</span>
            </li>
          ))}
        </ul>
      </a>
      <a href={dashboardHref('chats')}>
        <h2>Chats</h2>
        {Array.isArray(chats) ? (
          <>
            <strong>{active} Active</strong>
            <span>{pending} Pending</span>
            {active + pending > 0 && (
              <div className="overview-ratio">
                <small>
                  {active}:{pending} active
                </small>
                <div className="overview-segments" aria-hidden="true">
                  {[0, 1, 2, 3].map((part) => (
                    <span
                      key={part}
                      style={
                        {
                          '--fill': Math.min(100, Math.max(0, ((4 * active) / (active + pending) - part) * 100)) + '%'
                        } as CSSProperties
                      }
                    />
                  ))}
                </div>
              </div>
            )}
          </>
        ) : (
          <span>{chats ? 'Unavailable' : 'Loading…'}</span>
        )}
      </a>
      <a href={dashboardHref('automations/routines')}>
        <h2>Routines</h2>
        <strong>
          {routines.error
            ? 'Unavailable'
            : routines.loading
              ? 'Loading…'
              : next
                ? new Date(next).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
                : 'No upcoming run'}
        </strong>
        {next !== undefined && <span>Next Run</span>}
        {routines.data && <small className="overview-scheduled">{jobs.length} scheduled</small>}
      </a>
      <a className="overview-library" href={dashboardHref('library')}>
        <h2>Library</h2>
        <span>
          {hostStatus || Object.values(host.data?.brain ?? {}).reduce((sum, n) => sum + n, 0) + ' saved items'}
        </span>
      </a>
    </div>
  )
}
