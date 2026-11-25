import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { Button, Empty, Field, Input, Section, Spinner, Toggle } from '@/components/ui'
import { toast } from '@/lib/hooks'
import {
  CoreError,
  core,
  reasonText,
  type CoreHealth,
  type StandaloneConfigState,
  type StandaloneConfiguration,
  type StandaloneModelInput,
  type StandaloneModelPair,
  type StandaloneModelTarget
} from '@/lib/core'
import { Loading } from './loading'
import { dashboardHref } from './navigation'

/* Standalone first-run views (docs/trd/site.md#standalone-first-run). They use
   the existing diagnostic pane, status-list and form patterns, and they only
   call protected core routes — never the host owner service. */

function shortRevision(revision: string | null): string {
  if (!revision) return '—'
  return revision.slice(0, 12)
}

function formatTime(value: string | null): string {
  if (!value) return '—'
  const parsed = new Date(value).getTime()
  return Number.isFinite(parsed) ? new Date(value).toLocaleString() : value
}

function useStandaloneSnapshot() {
  const [health, setHealth] = useState<CoreHealth | null>(null)
  const [healthError, setHealthError] = useState(false)
  const [config, setConfig] = useState<StandaloneConfigState | null>(null)
  const [configError, setConfigError] = useState(false)
  const [tick, setTick] = useState(0)
  const generation = useRef(0)
  const reload = useCallback(() => setTick((n) => n + 1), [])
  useEffect(() => {
    let live = true
    const id = ++generation.current
    setHealthError(false)
    setConfigError(false)
    core.health().then(
      (value) => {
        if (live && id === generation.current) setHealth(value)
      },
      () => {
        if (live && id === generation.current) setHealthError(true)
      }
    )
    core.standaloneConfig().then(
      (value) => {
        if (live && id === generation.current) setConfig(value)
      },
      () => {
        if (live && id === generation.current) setConfigError(true)
      }
    )
    return () => {
      live = false
    }
  }, [tick])
  useEffect(() => {
    window.addEventListener('focus', reload)
    return () => window.removeEventListener('focus', reload)
  }, [reload])
  return { health, healthError, config, configError, reload }
}

function serviceLabel(health: CoreHealth | null): string {
  if (!health) return 'Checking…'
  return health.status === 'ready' ? 'Ready' : 'Starting'
}

function configurationLabel(configuration: StandaloneConfiguration | undefined): string {
  switch (configuration) {
    case 'configured':
      return 'Configured'
    case 'pending_activation':
      return 'Saved, waiting to apply'
    case 'invalid':
      return 'Invalid'
    case 'setup_required':
      return 'Setup required'
    default:
      return 'Checking…'
  }
}

function hermesLabel(health: CoreHealth | null): string {
  const hermes = health?.hermes
  if (!hermes) return 'Unknown'
  if (hermes.state === 'invalid') return 'Invalid route receipt'
  if (hermes.state === 'unsupported') return 'Unsupported adapter'
  if (hermes.state !== 'connected') return 'Not connected'
  return hermes.profile ? `Connected · ${hermes.profile}` : 'Connected'
}

function chatbotLabel(health: CoreHealth | null): string {
  if (!health?.chatbot) return 'Checking…'
  switch (health.chatbot) {
    case 'ready':
      return 'Ready'
    case 'degraded':
      return 'Degraded'
    default:
      return 'Inactive'
  }
}

async function copyCommand(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast('Copied.')
  } catch {
    toast('Copy failed. Select the command text instead.', false)
  }
}

/** The exact host commands for Hermes attachment, selectable and copyable.
 *  The dashboard never runs them (docs/trd/system.md#standalone-hermes-transport). */
function HermesCommands({ profile }: { profile: string | null }) {
  const name = profile ?? 'default'
  const commands = [`aira attach-hermes --profile ${name} --dry-run`, `aira attach-hermes --profile ${name} --apply`]
  return (
    <div className="flex flex-col gap-2">
      <p className="m-0 text-[0.8rem] text-faint">
        Run these on the host. The dashboard never runs host commands — recheck here after the operator runs them.
      </p>
      {commands.map((command) => (
        <div key={command} className="flex flex-wrap items-center gap-2">
          <code className="min-w-0 flex-1 basis-64 rounded-card border border-line bg-sunk px-3 py-2 font-mono text-[0.82rem] break-all select-all">
            {command}
          </code>
          <Button size="sm" variant="outline" onClick={() => void copyCommand(command)}>
            Copy
          </Button>
        </div>
      ))}
    </div>
  )
}

function StatusList({
  health,
  config,
  configError
}: {
  health: CoreHealth | null
  config: StandaloneConfigState | null
  configError: boolean
}) {
  return (
    <dl className="system-facts">
      <dt>Service</dt>
      <dd>{serviceLabel(health)}</dd>
      <dt>Models</dt>
      <dd>
        {configurationLabel(config?.configuration)}
        {configError ? ' · readback failed' : ''}
      </dd>
      <dt>Hermes</dt>
      <dd>{hermesLabel(health)}</dd>
      <dt>Chatbot</dt>
      <dd>
        {chatbotLabel(health)}
        {health?.chatbotReason && health.chatbot !== 'ready' ? ` · ${health.chatbotReason}` : ''}
      </dd>
    </dl>
  )
}

export function StandaloneOverview() {
  const { health, healthError, config, configError, reload } = useStandaloneSnapshot()
  const hermes = health?.hermes
  const modelsDone = config?.configuration === 'configured'
  const hermesDone = hermes?.state === 'connected'
  return (
    <div className="system-health">
      <section className="dashboard-pane">
        <h2 className="dashboard-pane-title">Setup</h2>
        {!health && !healthError ? (
          <Loading>Loading setup status…</Loading>
        ) : healthError || !health ? (
          <div role="alert">
            <p>The core did not answer. Nothing below was checked.</p>
            <Button size="sm" onClick={reload}>
              Retry
            </Button>
          </div>
        ) : (
          <>
            <StatusList health={health} config={config} configError={configError} />
            <ol className="m-0 flex flex-col gap-2 p-0">
              <li className="flex flex-wrap items-baseline gap-x-2">
                <span>{modelsDone ? 'Models configured.' : 'Configure the main model.'}</span>
                <a href={dashboardHref('system/settings')}>System Settings</a>
              </li>
              <li className="flex flex-wrap items-baseline gap-x-2">
                <span>{hermesDone ? 'Hermes route verified.' : 'Attach the Hermes profile.'}</span>
                <span className="text-[0.8rem] text-faint">Run the dry-run, then apply, on the host.</span>
              </li>
              <li className="flex flex-wrap items-baseline gap-x-2">
                <span>Choose the example pack and defaults.</span>
                <a href={dashboardHref('characters')}>Character Studio</a>
                <a href={dashboardHref('chats/defaults')}>Chat Defaults</a>
              </li>
              <li className="flex flex-wrap items-baseline gap-x-2">
                <span>Enable each pending chat.</span>
                <a href={dashboardHref('chats')}>Chats</a>
              </li>
            </ol>
          </>
        )}
      </section>
      <section className="dashboard-pane">
        <h2 className="dashboard-pane-title">Hermes</h2>
        {!health && !healthError ? (
          <Loading>Loading Hermes status…</Loading>
        ) : !health || !hermes ? (
          <>
            <p role="status">No verified Hermes route reported.</p>
            <HermesCommands profile={null} />
            <Button size="sm" variant="outline" onClick={reload}>
              Refresh status
            </Button>
          </>
        ) : hermes.state === 'connected' ? (
          <>
            <dl className="system-facts">
              <dt>State</dt>
              <dd>Connected</dd>
              <dt>Profile</dt>
              <dd>{hermes.profile ?? '—'}</dd>
              <dt>Adapter</dt>
              <dd>{hermes.adapterVersion ?? '—'}</dd>
              <dt>Verified</dt>
              <dd>{formatTime(hermes.verifiedAt)}</dd>
            </dl>
            <HermesCommands profile={hermes.profile} />
            <Button size="sm" variant="outline" onClick={reload}>
              Refresh status
            </Button>
          </>
        ) : (
          <>
            <p className="m-0">{hermesLabel(health)}. Verify with the dry-run first.</p>
            <HermesCommands profile={hermes.profile} />
            <Button size="sm" variant="outline" onClick={reload}>
              Refresh status
            </Button>
          </>
        )}
      </section>
    </div>
  )
}

export function StandaloneHealth() {
  const { health, healthError, config, configError, reload } = useStandaloneSnapshot()
  const roles = health ? Object.entries(health.roles ?? {}) : []
  const breakerCount = roles.filter(([, role]) => role.breakerOpen).length
  const roleLabels: Record<string, string> = {
    main: 'Conversation',
    fallback: 'Fallback',
    judge: 'Judge',
    media: 'Vision'
  }
  return (
    <div className="system-health">
      <section className="dashboard-pane health-diagnostics">
        <h2 className="dashboard-pane-title">Core Diagnostics</h2>
        {!health && !healthError ? (
          <Loading>Loading diagnostics…</Loading>
        ) : healthError || !health ? (
          <div role="alert">
            <p>Core diagnostics unavailable.</p>
            <Button size="sm" onClick={reload}>
              Retry
            </Button>
          </div>
        ) : (
          <>
            <StatusList health={health} config={config} configError={configError} />
            <dl className="system-facts">
              <dt>Active turns</dt>
              <dd>{health.activeTurns}</dd>
              <dt>Model breakers</dt>
              <dd>{breakerCount ? breakerCount + ' open' : 'Closed'}</dd>
              <dt>Applied revision</dt>
              <dd title={health.appliedRevision ?? config?.appliedRevision ?? ''}>
                <code>{shortRevision(health.appliedRevision ?? config?.appliedRevision ?? null)}</code>
              </dd>
            </dl>
            <p className="m-0 text-[0.8rem] text-faint">
              Next: <a href={dashboardHref('system/settings')}>System Settings</a> configures models,{' '}
              <a href={dashboardHref('overview')}>Overview</a> walks the setup tasks.
            </p>
          </>
        )}
      </section>
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
      <section className="dashboard-pane">
        <h2 className="dashboard-pane-title">Hermes Route</h2>
        {!health && !healthError ? (
          <Loading>Loading Hermes status…</Loading>
        ) : !health?.hermes ? (
          <p role="status">No verified Hermes route reported.</p>
        ) : (
          <>
            <dl className="system-facts">
              <dt>State</dt>
              <dd>{hermesLabel(health)}</dd>
              <dt>Profile</dt>
              <dd>{health.hermes.profile ?? '—'}</dd>
              <dt>Adapter</dt>
              <dd>{health.hermes.adapterVersion ?? '—'}</dd>
              <dt>Verified</dt>
              <dd>{formatTime(health.hermes.verifiedAt)}</dd>
            </dl>
            <HermesCommands profile={health.hermes.profile} />
            <Button size="sm" variant="outline" onClick={reload}>
              Refresh status
            </Button>
          </>
        )}
      </section>
    </div>
  )
}

/** A direct link to a host-only destination in standalone: a clear
 *  capability-unavailable message that makes no host request. */
export function CapabilityUnavailable({ label }: { label: string }) {
  return (
    <Section title={label}>
      <Empty>
        {label} is not available on this standalone installation (capability_unavailable). Chats, characters and system
        settings above remain usable.
      </Empty>
      <p className="m-0">
        <a href={dashboardHref('overview')}>Back to Overview</a>
      </p>
    </Section>
  )
}

/* ── standalone system settings: typed model revisions ─────────────────── */

interface RoleDraft {
  enabled: boolean
  provider: string
  model: string
  baseUrl: string
  effort: string
  deepEffort: string
  priceIn: string
  priceOut: string
  priceCached: string
  clearKey: boolean
}

function draftFromTarget(target: StandaloneModelTarget | null, enabled: boolean): RoleDraft {
  return {
    enabled,
    provider: target?.provider ?? '',
    model: target?.model ?? '',
    baseUrl: target?.baseUrl ?? '',
    effort: target?.effort ?? '',
    deepEffort: target?.deepEffort ?? '',
    priceIn: target ? String(target.usdPerMTokIn) : '',
    priceOut: target ? String(target.usdPerMTokOut) : '',
    priceCached: target ? String(target.usdPerMTokCached) : '',
    clearKey: false
  }
}

function parsePrice(text: string): number | null {
  const trimmed = text.trim()
  if (trimmed === '') return 0
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null
  const value = Number(trimmed)
  return Number.isFinite(value) ? value : null
}

function pricesValid(draft: { main: RoleDraft; fallback: RoleDraft }): string | null {
  for (const [name, role] of [
    ['main', draft.main],
    ['fallback', draft.fallback]
  ] as const) {
    if (name === 'fallback' && !role.enabled) continue
    for (const [label, text] of [
      ['input price', role.priceIn],
      ['output price', role.priceOut],
      ['cached price', role.priceCached]
    ] as const) {
      if (parsePrice(text) === null) return `${name} ${label} must be a number at or above 0.`
    }
  }
  return null
}

function toInput(role: RoleDraft, apiKey: string): StandaloneModelInput {
  return {
    provider: role.provider.trim(),
    model: role.model.trim(),
    baseUrl: role.baseUrl.trim(),
    effort: role.effort.trim(),
    deepEffort: role.deepEffort.trim(),
    usdPerMTokIn: parsePrice(role.priceIn) ?? 0,
    usdPerMTokOut: parsePrice(role.priceOut) ?? 0,
    usdPerMTokCached: parsePrice(role.priceCached) ?? 0,
    ...(role.clearKey ? { apiKey: null } : apiKey !== '' ? { apiKey } : {})
  }
}

function PairSummary({ pair, title }: { pair: StandaloneModelPair | null; title: string }) {
  if (!pair || (!pair.main && !pair.fallback)) return null
  const rows = [
    ['Main', pair.main],
    ['Fallback', pair.fallback]
  ] as const
  return (
    <div>
      <p className="m-0 text-[0.82rem] font-medium text-muted">{title}</p>
      <dl className="system-facts">
        {rows.map(([name, target]) => (
          <div key={name} className="contents">
            <dt>{name}</dt>
            <dd>
              {!target
                ? 'Disabled'
                : `${target.provider || '—'} · ${target.model || '—'} · ${target.credentialConfigured ? 'key saved' : 'no key'}`}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

function RoleForm({
  name,
  draft,
  allowDisable,
  disabled,
  keyInput,
  onChange
}: {
  name: string
  draft: RoleDraft
  allowDisable: boolean
  disabled: boolean
  keyInput: RefObject<HTMLInputElement | null>
  onChange: (next: RoleDraft) => void
}) {
  const set = (patch: Partial<RoleDraft>) => onChange({ ...draft, ...patch })
  const id = `standalone-${name}`
  return (
    <Section
      title={name === 'main' ? 'Main model' : 'Fallback model'}
      action={
        allowDisable ? (
          <Toggle
            checked={draft.enabled}
            disabled={disabled}
            onChange={(on) => set({ enabled: on })}
            label="Use a fallback model"
          />
        ) : undefined
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field htmlFor={id + '-provider'} label="Provider" hint="anthropic or openai-compatible">
          <Input
            id={id + '-provider'}
            value={draft.provider}
            disabled={disabled || !draft.enabled}
            onChange={(e) => set({ provider: e.target.value })}
            placeholder="anthropic"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <Field htmlFor={id + '-model'} label="Model">
          <Input
            id={id + '-model'}
            value={draft.model}
            disabled={disabled || !draft.enabled}
            onChange={(e) => set({ model: e.target.value })}
            placeholder="model id"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <Field htmlFor={id + '-base'} label="Base URL" hint="Absolute HTTP(S), no credentials in the URL">
          <Input
            id={id + '-base'}
            value={draft.baseUrl}
            disabled={disabled || !draft.enabled}
            onChange={(e) => set({ baseUrl: e.target.value })}
            placeholder="https://…"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <Field htmlFor={id + '-key'} label="API key" hint="Empty keeps the saved key. Never shown back.">
          <Input
            id={id + '-key'}
            type="password"
            ref={keyInput}
            disabled={disabled || !draft.enabled || draft.clearKey}
            autoComplete="new-password"
          />
        </Field>
        <Field htmlFor={id + '-effort'} label="Effort">
          <Input
            id={id + '-effort'}
            value={draft.effort}
            disabled={disabled || !draft.enabled}
            onChange={(e) => set({ effort: e.target.value })}
            placeholder="empty means the model default"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <Field htmlFor={id + '-deep'} label="Deep effort" hint="Effort on a /think turn">
          <Input
            id={id + '-deep'}
            value={draft.deepEffort}
            disabled={disabled || !draft.enabled}
            onChange={(e) => set({ deepEffort: e.target.value })}
            placeholder="empty means the role default"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <Field htmlFor={id + '-in'} label="Input price" hint="USD per million tokens">
          <Input
            id={id + '-in'}
            value={draft.priceIn}
            disabled={disabled || !draft.enabled}
            inputMode="decimal"
            onChange={(e) => set({ priceIn: e.target.value })}
            placeholder="0"
            autoComplete="off"
          />
        </Field>
        <Field htmlFor={id + '-out'} label="Output price" hint="USD per million tokens">
          <Input
            id={id + '-out'}
            value={draft.priceOut}
            disabled={disabled || !draft.enabled}
            inputMode="decimal"
            onChange={(e) => set({ priceOut: e.target.value })}
            placeholder="0"
            autoComplete="off"
          />
        </Field>
        <Field htmlFor={id + '-cached'} label="Cached price" hint="USD per million tokens">
          <Input
            id={id + '-cached'}
            value={draft.priceCached}
            disabled={disabled || !draft.enabled}
            inputMode="decimal"
            onChange={(e) => set({ priceCached: e.target.value })}
            placeholder="0"
            autoComplete="off"
          />
        </Field>
        <div className="flex items-end">
          <Toggle
            checked={draft.clearKey}
            disabled={disabled || !draft.enabled}
            onChange={(on) => {
              if (on && keyInput.current) keyInput.current.value = ''
              set({ clearKey: on })
            }}
            label="Remove the saved key on save"
          />
        </div>
      </div>
    </Section>
  )
}

export function StandaloneSettings() {
  const [snapshot, setSnapshot] = useState<StandaloneConfigState | null>(null)
  const [offline, setOffline] = useState(false)
  const [tick, setTick] = useState(0)
  const [draft, setDraft] = useState<{ main: RoleDraft; fallback: RoleDraft } | null>(null)
  const draftSeeded = useRef(false)
  const draftRevision = useRef<string | null>(null)
  const mainKey = useRef<HTMLInputElement>(null)
  const fallbackKey = useRef<HTMLInputElement>(null)
  const mounted = useRef(true)
  const clearKeys = useCallback(() => {
    if (mainKey.current) mainKey.current.value = ''
    if (fallbackKey.current) fallbackKey.current.value = ''
  }, [])
  const [saving, setSaving] = useState(false)
  const [activating, setActivating] = useState(false)
  const [stale, setStale] = useState(false)
  const [saveInvalid, setSaveInvalid] = useState<string | null>(null)
  const [priceError, setPriceError] = useState<string | null>(null)
  const [timedOut, setTimedOut] = useState(false)
  const pollTimer = useRef(0)
  const generation = useRef(0)

  const reload = useCallback(() => setTick((n) => n + 1), [])

  useEffect(() => {
    let live = true
    const id = ++generation.current
    core.standaloneConfig().then(
      (value) => {
        if (!live || id !== generation.current) return
        setSnapshot(value)
        setOffline(false)
        if (!draftSeeded.current) {
          draftSeeded.current = true
          draftRevision.current = value.savedRevision
          setDraft({
            main: draftFromTarget(value.saved?.main ?? null, true),
            fallback: draftFromTarget(value.saved?.fallback ?? null, value.saved?.fallback != null)
          })
        } else if (draftRevision.current !== value.savedRevision) {
          setStale(true)
        }
      },
      () => {
        if (!live || id !== generation.current) return
        setOffline(true)
      }
    )
    return () => {
      live = false
    }
  }, [tick])

  useEffect(() => {
    if (activating) return
    window.addEventListener('focus', reload)
    return () => window.removeEventListener('focus', reload)
  }, [reload, activating])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      window.clearTimeout(pollTimer.current)
      clearKeys()
    }
  }, [clearKeys])

  async function pollApplied(target: string, deadline: number) {
    let next: StandaloneConfigState | null = null
    try {
      next = await core.standaloneConfig()
      if (!mounted.current) return
      setSnapshot(next)
      setOffline(false)
      if (next.appliedRevision === target && next.activation === 'idle') {
        setActivating(false)
        if (!next.lastFailure)
          toast(next.configuration === 'configured' ? 'Model revision applied.' : 'Setup still required.')
        return
      }
      if (next.lastFailure && next.activation === 'idle') {
        setActivating(false)
        toast('Activation failed. The previous applied revision is unchanged.', false)
        return
      }
    } catch {
      /* A failed read is not a failed activation. Keep polling until the deadline. */
    }
    if (!mounted.current) return
    if (Date.now() >= deadline) {
      setActivating(false)
      setTimedOut(true)
      return
    }
    pollTimer.current = window.setTimeout(() => void pollApplied(target, deadline), 2000)
  }

  async function save() {
    if (!draft || saving || activating || offline || snapshot?.activation !== 'idle') return
    const problem = pricesValid(draft)
    if (problem) {
      setPriceError(problem)
      return
    }
    setPriceError(null)
    setSaving(true)
    setSaveInvalid(null)
    try {
      const next = await core.saveStandaloneConfig({
        expectedRevision: draftRevision.current,
        main: toInput(draft.main, mainKey.current?.value ?? ''),
        fallback: draft.fallback.enabled ? toInput(draft.fallback, fallbackKey.current?.value ?? '') : null
      })
      setSnapshot(next)
      draftRevision.current = next.savedRevision
      setStale(false)
      clearKeys()
      setDraft((current) =>
        current
          ? {
              main: { ...current.main, clearKey: false },
              fallback: { ...current.fallback, clearKey: false }
            }
          : current
      )
      toast('Saved. Apply to activate it.')
    } catch (error) {
      if (error instanceof CoreError && (error.code === 'stale_revision' || error.code === 'revision_required')) {
        setStale(true)
        reload()
      } else if (error instanceof CoreError && error.code === 'model_config_invalid') {
        setSaveInvalid('The core refused the model setup (model_config_invalid). Check the fields and save again.')
      } else {
        toast(reasonText(error), false)
      }
    } finally {
      setSaving(false)
    }
  }

  async function applyRevision() {
    const target = snapshot?.savedRevision
    if (!target || saving || activating || offline || snapshot?.activation !== 'idle') return
    setActivating(true)
    setTimedOut(false)
    try {
      const next = await core.activateStandaloneConfig(target)
      setSnapshot(next)
      setOffline(false)
      void pollApplied(target, Date.now() + 60_000)
    } catch (error) {
      setActivating(false)
      toast(reasonText(error), false)
    }
  }

  if (!snapshot && !offline) return <Loading>Loading model settings…</Loading>
  if (!snapshot && offline) {
    return (
      <div role="alert">
        <p>The core did not answer. Model settings are offline.</p>
        <Button size="sm" onClick={reload}>
          Retry
        </Button>
      </div>
    )
  }

  const state = snapshot!
  const pending =
    activating ||
    state.activation !== 'idle' ||
    (state.savedRevision !== null && state.savedRevision !== state.appliedRevision)
  const current =
    !activating &&
    state.activation === 'idle' &&
    state.savedRevision !== null &&
    state.savedRevision === state.appliedRevision &&
    !state.lastFailure

  return (
    <div className="flex flex-col gap-6">
      <section className="dashboard-pane">
        <h2 className="dashboard-pane-title">Status</h2>
        {offline && (
          <p role="alert" className="m-0 text-[0.85rem]">
            The readback failed. Showing the last known values.
          </p>
        )}
        <dl className="system-facts">
          <dt>Configuration</dt>
          <dd>{configurationLabel(state.configuration)}</dd>
          <dt>Activation</dt>
          <dd>{activating ? 'Requesting…' : state.activation}</dd>
          <dt>Saved revision</dt>
          <dd title={state.savedRevision ?? ''}>
            <code>{shortRevision(state.savedRevision)}</code>
          </dd>
          <dt>Applied revision</dt>
          <dd title={state.appliedRevision ?? ''}>
            <code>{shortRevision(state.appliedRevision)}</code>
          </dd>
          {state.lastFailure && (
            <>
              <dt>Last failure</dt>
              <dd>{state.lastFailure}</dd>
            </>
          )}
        </dl>
        {pending && !activating && (
          <p className="m-0 text-[0.85rem]" role="status">
            The saved revision is not applied yet. Apply it, then wait for the readback to confirm.
          </p>
        )}
        {activating && (
          <p className="m-0 flex items-center gap-2 text-[0.85rem]" role="status">
            <Spinner /> Activating… rechecking the readback for up to 60 seconds.
          </p>
        )}
        {timedOut && (
          <p className="m-0 text-[0.85rem]" role="alert">
            Activation status unknown after 60 seconds. Recheck before trying again.
          </p>
        )}
        {stale && (
          <div role="alert">
            <p className="m-0 text-[0.85rem]">
              Settings changed in another session. Your draft is kept. Reload the saved values to compare, then save
              again.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={saving || offline || state.activation !== 'idle'}
                onClick={() => {
                  draftRevision.current = state.savedRevision
                  void save()
                }}
              >
                Save my draft over the new revision
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={saving}
                onClick={() => {
                  setStale(false)
                  draftRevision.current = state.savedRevision
                  clearKeys()
                  setDraft({
                    main: draftFromTarget(state.saved?.main ?? null, true),
                    fallback: draftFromTarget(state.saved?.fallback ?? null, state.saved?.fallback != null)
                  })
                }}
              >
                Discard draft
              </Button>
            </div>
          </div>
        )}
        {saveInvalid && (
          <p className="m-0 text-[0.85rem]" role="alert">
            {saveInvalid}
          </p>
        )}
        {current && (
          <p className="m-0 text-[0.85rem]" role="status">
            Running the saved revision.
          </p>
        )}
        <div className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={reload} disabled={saving || activating}>
            Recheck
          </Button>
          {(timedOut || offline) && (
            <Button size="sm" variant="outline" onClick={reload}>
              Retry
            </Button>
          )}
        </div>
        <PairSummary pair={state.applied} title="Applied models (last good)" />
        <PairSummary pair={state.saved} title="Saved models" />
      </section>
      {draft && (
        <>
          <RoleForm
            name="main"
            draft={draft.main}
            allowDisable={false}
            disabled={saving || activating || offline || state.activation !== 'idle'}
            keyInput={mainKey}
            onChange={(main) => setDraft((current) => (current ? { ...current, main } : current))}
          />
          <RoleForm
            name="fallback"
            draft={draft.fallback}
            allowDisable={true}
            disabled={saving || activating || offline || state.activation !== 'idle'}
            keyInput={fallbackKey}
            onChange={(fallback) => setDraft((current) => (current ? { ...current, fallback } : current))}
          />
          {priceError && (
            <p className="m-0 text-[0.85rem]" role="alert">
              {priceError}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={saving || activating || offline || stale || state.activation !== 'idle'}
              onClick={() => void save()}
            >
              {saving && <Spinner />} Save revision
            </Button>
            <Button
              variant="outline"
              disabled={
                saving ||
                activating ||
                offline ||
                state.activation !== 'idle' ||
                !state.savedRevision ||
                state.savedRevision === state.appliedRevision
              }
              onClick={() => void applyRevision()}
            >
              {activating && <Spinner />} Apply saved revision
            </Button>
            <Button
              variant="ghost"
              disabled={saving || activating}
              onClick={() => {
                draftRevision.current = state.savedRevision
                clearKeys()
                setStale(false)
                setDraft({
                  main: draftFromTarget(state.saved?.main ?? null, true),
                  fallback: draftFromTarget(state.saved?.fallback ?? null, state.saved?.fallback != null)
                })
              }}
            >
              Reset to saved
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
