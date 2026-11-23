import { useCallback, useEffect, useRef, useState } from 'react'
import { ServiceRow } from '@/components/service-row'
import { useApi, Toaster } from '@/lib/hooks'
import type { Dashboard } from '@/lib/api'
import { core, type CoreConfigStatus } from '@/lib/core'

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
      return 'Source cannot be read. Running revision stays applied.'
    case 'memory_only':
      return 'Running from injected config with no source file to check.'
  }
}

export default function Health() {
  const { data, error, loading, reload } = useApi<Dashboard>('/api/dashboard')
  const [config, setConfig] = useState<CoreConfigStatus | 'unavailable' | null>(null)
  const configRead = useRef(0)
  const loadConfig = useCallback(async () => {
    const revision = ++configRead.current
    try {
      const value = await core.config()
      if (revision === configRead.current) setConfig(value)
    } catch {
      if (revision === configRead.current) setConfig('unavailable')
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
  return (
    <section>
      <Toaster />
      <h2>Service Health</h2>
      {error ? (
        <p role="alert">Service status unavailable.</p>
      ) : loading ? (
        <p role="status">Loading…</p>
      ) : (
        <div>
          {Object.entries(data?.services ?? {}).map(([unit, state]) => (
            <ServiceRow key={unit} unit={unit} state={state} onDone={() => void reload()} />
          ))}
        </div>
      )}
      <h3>Deployment configuration</h3>
      {config === null ? (
        <p role="status">Loading deployment revision…</p>
      ) : config === 'unavailable' ? (
        <p role="alert">Deployment revision unavailable.</p>
      ) : (
        <div>
          <p data-config-status={config.status}>{configMessage(config)}</p>
          <dl>
            <dt>Running revision</dt>
            <dd title={config.appliedRevision ?? ''}>{shortRevision(config.appliedRevision)}</dd>
            <dt>File revision</dt>
            <dd title={config.currentRevision ?? ''}>{shortRevision(config.currentRevision)}</dd>
            <dt>Checked</dt>
            <dd>{config.checkedAt}</dd>
            <dt>Applied</dt>
            <dd>{config.appliedAt}</dd>
          </dl>
          <button type="button" onClick={() => void loadConfig()}>
            Recheck file
          </button>
        </div>
      )}
    </section>
  )
}
