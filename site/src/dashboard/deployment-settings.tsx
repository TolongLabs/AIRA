import { ChevronDown, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { DeploymentModel, DeploymentSettings, HostSettingsSnapshot } from '../../../src/config/dashboard-types'
import { Button, Input } from '@/components/ui'
import { post } from '@/lib/api'
import { CredentialEditor, GroupEditor, ModelEditor, type SaveSettings } from './settings-editor'
import { useApi } from '@/lib/hooks'
import { Loading } from './loading'
import './deployment-settings.css'

export type CoreSettingsTab = 'models' | 'core-config' | 'credentials'
const titles: Record<string, string> = {
  llm: 'Reply models',
  judge: 'Mood and memory judge',
  prompt: 'System prompt',
  turn: 'Turn batching',
  format: 'Reply formatting',
  tools: 'Tool limits',
  owner: 'Owner tools',
  search: 'Web search',
  research: 'Research',
  links: 'Signed links',
  identify: 'Image identification',
  lessons: 'Lessons',
  mcp: 'MCP servers',
  memory: 'Memory',
  embeddings: 'Embeddings',
  media: 'Media processing',
  social: 'Social posts',
  render: 'Report rendering',
  feedback: 'Feedback',
  shutdown: 'Shutdown',
  alerts: 'Alerts',
  records: 'Record retention',
  log: 'Logging',
  gateway: 'WhatsApp gateway',
  storage: 'Storage',
  backup: 'Backups',
  archive: 'Archive',
  site: 'Dashboard server'
}
const states: Record<DeploymentSettings['activation'], string> = {
  current: 'Matches config.yml',
  pending_restart: 'File changes await restart',
  invalid: 'Running previous settings · config.yml is invalid',
  inaccessible: 'Running settings · config.yml is unavailable',
  memory_only: 'Running settings · no source file'
}

function ModelCard({ role, model }: { role: string; model: DeploymentModel }) {
  return (
    <section className="dashboard-pane core-model">
      <div className="core-model-heading">
        <h2>{role}</h2>
        <span data-configured={model.configured}>{model.configured ? 'Configured' : 'Not configured'}</span>
      </div>
      <p className="core-model-id">{model.model}</p>
      <p>{model.connection}</p>
      <dl>
        <dt>Normal effort</dt>
        <dd>{model.effort}</dd>
        <dt>/think effort</dt>
        <dd>{model.deepEffort}</dd>
        <dt>Endpoint origin</dt>
        <dd>{model.endpoint}</dd>
        <dt>Credential</dt>
        <dd>
          {model.credential === 'Host Claude login' ? model.credential : <a href="#credentials">{model.credential}</a>}
        </dd>
      </dl>
    </section>
  )
}

function ConfigGroups({
  groups,
  host,
  save,
  busy
}: {
  groups: DeploymentSettings['groups']
  host: HostSettingsSnapshot | null
  save: SaveSettings
  busy: boolean
}) {
  const [query, setQuery] = useState('')
  const term = query.trim().toLowerCase()
  const matches = Object.entries(groups)
    .map(([group, values]) => {
      const groupMatch = (group + ' ' + titles[group]).toLowerCase().includes(term)
      const rows = Object.entries(values).filter(
        ([name, v]) => groupMatch || (group + '.' + name + ' ' + v).toLowerCase().includes(term)
      )
      return { group, rows }
    })
    .filter(({ rows }) => rows.length)
  return (
    <>
      <Input
        type="search"
        aria-label="Filter core configuration"
        placeholder="Filter by setting, group or value"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {matches.length === 0 && <p role="status">No matching settings.</p>}
      <div className="core-groups">
        {matches.map(({ group, rows }) => (
          <details className="dashboard-pane" key={group + (term ? ' search' : '')} open={term ? true : undefined}>
            <summary>
              <span>{titles[group] ?? group}</span>
              <small>{group}</small>
              <ChevronDown size={16} />
            </summary>
            <dl>
              {rows.map(([name, v]) => (
                <div key={name}>
                  <dt>{name}</dt>
                  <dd>{String(v)}</dd>
                </div>
              ))}
            </dl>
            {host?.fields[group] && (
              <GroupEditor
                revision={host.revision}
                name={group}
                fields={host.fields[group]}
                save={save}
                disabled={busy}
              />
            )}
          </details>
        ))}
      </div>
    </>
  )
}

export default function CoreSettings({ tab }: { tab: CoreSettingsTab }) {
  const result = useApi<DeploymentSettings>('/api/core/deployment-settings')
  const file = useApi<HostSettingsSnapshot>('/api/settings/core_config')
  const host = file.data
  const [saving, setSaving] = useState(false)
  const [applying, setApplying] = useState(false)
  const [notice, setNotice] = useState('')
  const [failure, setFailure] = useState('')
  const data = result.data
  const busy = saving || applying || host?.state === 'applying'
  useEffect(() => {
    if (!applying && host?.state !== 'applying') return
    let live = true
    let timer: ReturnType<typeof setTimeout>
    async function poll() {
      const next = await file.reload()
      if (!live) return
      if (next && ['current', 'restored', 'failed'].includes(next.state)) {
        setApplying(false)
        setNotice(next.state === 'current' ? 'Changes are active.' : '')
        if (next.state !== 'current')
          setFailure(
            next.state === 'restored'
              ? 'Previous settings restored after a failed health check.'
              : 'Recovery needs attention on the host.'
          )
        void result.reload()
      } else timer = setTimeout(() => void poll(), 2000)
    }
    timer = setTimeout(() => void poll(), 1500)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [applying, host?.state, file.reload, result.reload])
  const save: SaveSettings = async (payload) => {
    if (!host || busy) return false
    setSaving(true)
    setFailure('')
    setNotice('')
    try {
      await post('/api/settings/core_save', { revision: host.revision, ...payload })
      await file.reload()
      setNotice('Saved on the host.')
      return true
    } catch (e) {
      setFailure(e instanceof Error ? e.message : 'Save failed')
      return false
    } finally {
      setSaving(false)
    }
  }
  async function apply() {
    if (!host || busy) return
    setSaving(true)
    setFailure('')
    setNotice('')
    try {
      await post('/api/settings/core_apply', { revision: host.revision })
      setApplying(true)
    } catch (e) {
      setFailure(e instanceof Error ? e.message : 'Could not apply settings')
    } finally {
      setSaving(false)
    }
  }
  const groups = host
    ? Object.fromEntries(
        Object.entries(host.fields).map(([group, fields]) => [
          group,
          Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.display]))
        ])
      )
    : data?.groups
  return (
    <div className="core-settings">
      <div className="core-settings-head">
        <div>
          <h2>
            {tab === 'models' ? 'Reply Models' : tab === 'credentials' ? 'Core Credentials' : 'Core Configuration'}
          </h2>
          <p>
            {tab === 'models'
              ? 'The primary route handles WhatsApp replies. The fallback takes eligible failures.'
              : tab === 'credentials'
                ? 'Set or replace a credential. Existing values stay private.'
                : 'Edit the installed config.yml, then apply saved changes to the core.'}
          </p>
        </div>
        <Button
          size="sm"
          disabled={result.loading || busy}
          onClick={() => {
            void result.reload()
            void file.reload()
          }}
        >
          <RefreshCw size={15} /> Refresh
        </Button>
      </div>
      {host && (host.state === 'pending' || (busy && (applying || host.state === 'applying'))) && (
        <div className="core-apply">
          <span role="status">
            {busy && (applying || host.state === 'applying')
              ? 'Applying changes. Reconnecting to the core…'
              : 'Saved changes are waiting. Applying restarts the core.'}
          </span>
          <Button disabled={busy} onClick={() => void apply()}>
            Apply saved changes
          </Button>
        </div>
      )}
      {file.error && !applying && (
        <p role="alert">The host settings middleware is unavailable. Refresh to reconnect.</p>
      )}
      {notice && <p role="status">{notice}</p>}
      {failure && <p role="alert">{failure}</p>}
      {host?.state === 'restored' && !failure && (
        <p role="status">The previous settings were restored after a failed health check.</p>
      )}
      {host?.state === 'failed' && !failure && <p role="alert">Recovery needs attention on the host.</p>}
      {result.error && <p role="alert">Could not read the running core settings. Use Refresh to retry.</p>}
      {!data && !result.error && <Loading layout="metric" />}
      {data && (
        <>
          <p className="core-activation" role="status">
            {states[data.activation]} · Applied {new Date(data.appliedAt).toLocaleString()}
          </p>
          {tab === 'models' && (
            <>
              <div className="core-model-grid">
                <ModelCard role="Primary model" model={data.models.main} />
                <ModelCard role="Fallback model" model={data.models.fallback} />
              </div>
              {host && <ModelEditor host={host} save={save} disabled={busy} />}
              <section className="dashboard-pane">
                <h2>Routing Limits</h2>
                <dl className="core-limits">
                  {[
                    ['Turn deadline', data.groups.llm?.turnDeadlineMs + ' ms'],
                    ['Retries', data.groups.llm?.maxRetries],
                    ['Breaker cooldown', data.groups.llm?.breakerMs + ' ms'],
                    ['Monthly budget', 'US$' + data.groups.llm?.monthlyBudgetUsd]
                  ].map(([label, value]) => (
                    <div key={String(label)}>
                      <dt>{label}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
                <a href="#core-config">View core configuration</a>
              </section>
            </>
          )}
          {tab === 'core-config' && groups && <ConfigGroups groups={groups} host={host} save={save} busy={busy} />}
          {tab === 'credentials' && (
            <section className="dashboard-pane">
              <h2>Deployment environment</h2>
              <ul className="core-credentials">
                {(host?.credentials ?? data.credentials).map((c) => (
                  <li key={c.name}>
                    <div>
                      <strong>{c.purpose}</strong>
                      <code>{c.name}</code>
                    </div>
                    <span data-configured={c.present}>{c.present ? 'Set' : 'Not set'}</span>
                    {host && (
                      <CredentialEditor
                        revision={host.revision}
                        name={c.name}
                        present={c.present}
                        save={save}
                        disabled={busy}
                      />
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  )
}
