import { ChevronDown, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import type { DeploymentModel, DeploymentSettings } from '../../../src/config/dashboard-types'
import { Button, Input } from '@/components/ui'
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
          <a href="#credentials">{model.credential}</a>
        </dd>
      </dl>
    </section>
  )
}

function ConfigGroups({ groups }: { groups: DeploymentSettings['groups'] }) {
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
          </details>
        ))}
      </div>
    </>
  )
}

export default function CoreSettings({ tab }: { tab: CoreSettingsTab }) {
  const result = useApi<DeploymentSettings>('/api/core/deployment-settings')
  const data = result.data
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
                ? 'Presence in the running core environment. Set or rotate credentials on the deployment host.'
                : 'Values applied at startup from config.yml. Deploy file changes and restart the core to apply them.'}
          </p>
        </div>
        <Button size="sm" disabled={result.loading} onClick={() => void result.reload()}>
          <RefreshCw size={15} /> Refresh
        </Button>
      </div>
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
          {tab === 'core-config' && <ConfigGroups groups={data.groups} />}
          {tab === 'credentials' && (
            <section className="dashboard-pane">
              <h2>Deployment environment</h2>
              <ul className="core-credentials">
                {data.credentials.map((c) => (
                  <li key={c.name}>
                    <div>
                      <strong>{c.purpose}</strong>
                      <code>{c.name}</code>
                    </div>
                    <span data-configured={c.present}>{c.present ? 'Set' : 'Not set'}</span>
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
