import { useEffect, useState } from 'react'
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
        <ul>
          {units.map(([unit, state]) => (
            <li key={unit}>
              <b>{unit}</b>
              <span>{state}</span>
            </li>
          ))}
        </ul>
      </a>
      <a href={dashboardHref('chats')}>
        <h2>Chats</h2>
        {Array.isArray(chats) ? (
          <>
            <strong>{chats.filter((chat) => chat.status === 'active').length} Active</strong>
            <span>{chats.filter((chat) => chat.status === 'pending').length} Pending</span>
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
                ? new Date(next).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                : 'No upcoming run'}
        </strong>
        {next !== undefined && <span>Next Run</span>}
        {routines.data && <span>{jobs.length} scheduled</span>}
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
