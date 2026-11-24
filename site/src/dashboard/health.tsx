import { Loading } from '@/dashboard/loading'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ServiceRow } from '@/components/service-row'
import { Button } from '@/components/ui'
import { useApi, Toaster } from '@/lib/hooks'
import type { Dashboard } from '@/lib/api'
import { core, type CoreConfigStatus, type CoreHealth } from '@/lib/core'

function shortRevision(revision: string | null): string {
  if (!revision) return '—'
  return revision.slice(0, 12)
}

function configMessage(status: CoreConfigStatus): string {
  switch (status.status) {
    case 'current':
      return 'Running revision matches the file. No restart needed.'
    case 'pending_restart':
      return 'File has a newer valid revision. Restart to apply it.'
    case 'invalid':
      return 'File is invalid. Running revision stays applied; fix the file, then restart.'
    case 'inaccessible':
      return 'Source unavailable. Check the file and its permissions. If the mounted file was replaced, recreate the container.'
    case 'memory_only':
      return 'Running from injected config with no source file to check.'
  }
}

export default function Health() {
  const { data, error, loading, reload } = useApi<Dashboard>('/api/dashboard')
  const [config, setConfig] = useState<CoreConfigStatus | 'unavailable' | null>(null)
  const [selectedUnit, setSelectedUnit] = useState<string>()
  const [health, setHealth] = useState<CoreHealth | 'unavailable' | null>(null)
  const configRead = useRef(0)
  const loadConfig = useCallback(async () => {
    const revision = ++configRead.current
    const [configResult, healthResult] = await Promise.allSettled([core.config(), core.health()])
    if (revision === configRead.current) {
      setConfig(configResult.status === 'fulfilled' ? configResult.value : 'unavailable')
      setHealth(healthResult.status === 'fulfilled' ? healthResult.value : 'unavailable')
    }
  }, [])
  useEffect(() => {
    void loadConfig()
    window.addEventListener('focus', loadConfig)
    return () => {
      configRead.current++
      window.removeEventListener('focus', loadConfig)
    }
  }, [loadConfig])
  const services = Object.entries(data?.services ?? {})
  const selected = services.find(([unit]) => unit === selectedUnit) ?? services[0]
  const roles = health && health !== 'unavailable' ? Object.entries(health.roles ?? {}) : []
  const breakerCount = roles.filter(([, role]) => role.breakerOpen).length
  const roleLabels: Record<string, string> = {
    main: 'Conversation',
    fallback: 'Fallback',
    judge: 'Judge',
    media: 'Vision'
  }

  return (
    <div className="system-health">
      <Toaster />
      <>
        <section className="dashboard-pane health-services">
          <h2 className="dashboard-pane-title">Service Health</h2>
          {error ? (
            <p role="alert">Service status unavailable.</p>
          ) : loading ? (
            <Loading>Loading…</Loading>
          ) : services.length ? (
            <ul className="system-services">
              {services.map(([unit, state]) => (
                <li key={unit}>
                  <button type="button" aria-pressed={selected?.[0] === unit} onClick={() => setSelectedUnit(unit)}>
                    <span>{unit}</span>
                    <span data-online={state === 'active'}>{state}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p>No services reported.</p>
          )}
          {selected && (
            <div className="service-actions" role="group" aria-labelledby="service-action-title">
              <h3 id="service-action-title">{selected[0]} actions</h3>
              <ServiceRow
                key={selected[0]}
                unit={selected[0]}
                state={selected[1]}
                onDone={() => void reload()}
                controlsOnly
              />
            </div>
          )}
        </section>
        <section className="dashboard-pane health-diagnostics">
          <h2 className="dashboard-pane-title">Core Diagnostics</h2>
          {health === null ? (
            <Loading>Loading diagnostics…</Loading>
          ) : health === 'unavailable' ? (
            <p role="alert">Core diagnostics unavailable.</p>
          ) : (
            <dl className="system-facts">
              <dt>Readiness</dt>
              <dd>{health.status === 'ready' ? 'Ready' : 'Starting'}</dd>
              <dt>Active turns</dt>
              <dd>{health.activeTurns}</dd>
              <dt>Model breakers</dt>
              <dd>{breakerCount ? breakerCount + ' open' : 'Closed'}</dd>
            </dl>
          )}
        </section>
      </>
      {roles.length > 0 && (
        <section className="dashboard-pane health-roles">
          <h2 className="dashboard-pane-title">Model Roles</h2>
          <ul className="system-roles">
            {roles.map(([name, role]) => (
              <li key={name}>
                <div>{roleLabels[name] ?? name}</div>
                <span>{role.breakerOpen ? 'Breaker open' : role.configured ? 'Configured' : 'Disabled'}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="dashboard-pane health-config">
        <h2 className="dashboard-pane-title">Deployment Configuration</h2>
        {config === null ? (
          <Loading>Loading deployment revision…</Loading>
        ) : config === 'unavailable' ? (
          <p role="alert">Deployment revision unavailable.</p>
        ) : (
          <>
            <p data-config-status={config.status}>{configMessage(config)}</p>
            <dl className="system-facts">
              <dt>Running revision</dt>
              <dd title={config.appliedRevision ?? ''}>
                <code>{shortRevision(config.appliedRevision)}</code>
              </dd>
              <dt>File revision</dt>
              <dd title={config.currentRevision ?? ''}>
                <code>{shortRevision(config.currentRevision)}</code>
              </dd>
              <dt>Checked</dt>
              <dd>{config.checkedAt}</dd>
              <dt>Applied</dt>
              <dd>{config.appliedAt}</dd>
            </dl>
          </>
        )}
        <Button type="button" onClick={() => void loadConfig()}>
          Recheck file
        </Button>
      </section>
    </div>
  )
}
