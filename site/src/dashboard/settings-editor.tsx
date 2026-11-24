import { useState } from 'react'
import type { HostSettingsSnapshot, ConfigField } from '../../../src/config/dashboard-types'
import { Button, Input, Textarea } from '@/components/ui'
import { FormSelect } from './form-select'

export type SaveSettings = (payload: Record<string, unknown>) => Promise<boolean>

export function CredentialEditor({
  name,
  present,
  save,
  disabled,
  revision
}: {
  name: string
  present: boolean
  save: SaveSettings
  disabled: boolean
  revision: string
}) {
  const [editing, edit] = useState('')
  const [value, setValue] = useState('')
  const [removing, remove] = useState(false)
  function close() {
    setValue('')
    remove(false)
    edit('')
  }
  async function submit(replacement: string) {
    if (await save({ credential: name, replacement, revision: editing })) close()
  }
  if (!editing)
    return (
      <Button
        size="sm"
        disabled={disabled}
        aria-label={(present ? 'Replace ' : 'Set ') + name}
        onClick={() => edit(revision)}
      >
        {present ? 'Replace' : 'Set credential'}
      </Button>
    )
  return (
    <form
      className="core-secret-edit"
      onSubmit={(e) => {
        e.preventDefault()
        if (value && !removing) void submit(value)
      }}
    >
      <Input
        autoFocus
        aria-label={'New ' + name}
        name={'new-' + name}
        type="password"
        autoComplete="new-password"
        spellCheck={false}
        value={value}
        placeholder="New value"
        onChange={(e) => setValue(e.target.value)}
        disabled={disabled || removing}
      />
      <div className="core-actions">
        <Button type="submit" disabled={disabled || !value || removing}>
          Save credential
        </Button>
        {present && (
          <Button type="button" disabled={disabled} onClick={() => (removing ? void submit('') : remove(true))}>
            {removing ? 'Confirm removal' : 'Remove'}
          </Button>
        )}
        <Button type="button" disabled={disabled} onClick={close}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

export function GroupEditor({
  name,
  fields,
  save,
  disabled,
  revision
}: {
  name: string
  fields: Record<string, ConfigField>
  save: SaveSettings
  disabled: boolean
  revision: string
}) {
  const [draft, setDraft] = useState<Record<string, string> | null>(null)
  const [base, setBase] = useState(revision)
  const [error, setError] = useState('')
  if (!draft)
    return (
      <Button
        size="sm"
        disabled={disabled}
        onClick={() => {
          setBase(revision)
          setDraft({})
        }}
      >
        Edit configuration
      </Button>
    )
  const set = (key: string, v: string) => setDraft({ ...draft, [key]: v })
  async function submit() {
    const changes: Record<string, unknown> = {}
    for (const [key, v] of Object.entries(draft ?? {})) {
      const kind = fields[key]!.kind
      try {
        if (kind === 'number' && (!v.trim() || !Number.isFinite(Number(v)))) throw Error()
        const parsed =
          kind === 'number' ? Number(v) : kind === 'boolean' ? v === 'true' : kind === 'list' ? JSON.parse(v) : v
        if (kind === 'list' && !Array.isArray(parsed)) throw Error()
        changes[key] = parsed
      } catch {
        setError('Enter a valid ' + (kind === 'list' ? 'JSON array' : kind) + ' for ' + key + '.')
        return
      }
    }
    setError('')
    if (await save({ group: name, changes, revision: base })) setDraft(null)
  }
  return (
    <form
      className="core-edit-form"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      {Object.entries(fields).map(([key, field]) => {
        const value = draft[key] ?? String(field.value ?? '')
        const label = name + '.' + key
        const route = name === 'llm' && ['transport', 'fallbackTransport'].includes(key)
        if (route)
          return (
            <a key={key} href="#models">
              Change {key === 'transport' ? 'primary' : 'fallback'} route in Reply Models
            </a>
          )
        return (
          <label key={key}>
            <span>{key}</span>
            {field.kind === 'list' ? (
              <Textarea
                aria-label={label}
                value={value}
                placeholder={'Replacement JSON array · ' + field.display}
                onChange={(e) => set(key, e.target.value)}
              />
            ) : field.kind === 'boolean' ? (
              <FormSelect
                label={label}
                value={value}
                options={[
                  { value: 'true', label: 'On' },
                  { value: 'false', label: 'Off' }
                ]}
                onChange={(v) => set(key, v)}
              />
            ) : (
              <Input
                aria-label={label}
                type={field.kind === 'number' ? 'number' : 'text'}
                step="any"
                value={value}
                placeholder={field.value === undefined ? 'Enter replacement · ' + field.display : undefined}
                onChange={(e) => set(key, e.target.value)}
              />
            )}
          </label>
        )
      })}
      {error && <p role="alert">{error}</p>}
      <div className="core-actions">
        <Button type="submit" disabled={disabled || !Object.keys(draft).length}>
          Save configuration
        </Button>
        <Button
          type="button"
          disabled={disabled}
          onClick={() => {
            setDraft(null)
            setError('')
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  )
}

export function ModelEditor({
  host,
  save,
  disabled
}: {
  host: HostSettingsSnapshot
  save: SaveSettings
  disabled: boolean
}) {
  const [base, setBase] = useState(host.revision)
  const fields = host.fields.llm!
  const [draft, edit] = useState<Record<string, string> | null>(null)
  const get = (key: string) => draft?.[key] ?? String(fields[key]?.value ?? '')
  const options = [
    { value: 'api', label: 'Model API' },
    { value: 'aira-router', label: 'AIRA router · Claude Code', disabled: !host.router.legacy?.available },
    { value: 'subscription', label: 'Core Claude Code runner', disabled: !host.router.available }
  ]
  return (
    <section className="dashboard-pane core-router">
      <div className="core-model-heading">
        <h2>AIRA router</h2>
        <span data-configured={!!host.router.legacy?.available}>{host.router.legacy?.status ?? 'Unavailable'}</span>
      </div>
      <div className="core-model-heading">
        <h2>Core Claude Code runner</h2>
        <span data-configured={host.router.available}>{host.router.status}</span>
      </div>
      {!draft ? (
        <Button
          disabled={disabled}
          onClick={() => {
            setBase(host.revision)
            edit({})
          }}
        >
          Edit reply routes
        </Button>
      ) : (
        <form
          className="core-edit-form"
          onSubmit={async (e) => {
            e.preventDefault()
            if (await save({ group: 'llm', changes: draft, revision: base })) edit(null)
          }}
        >
          <div className="core-model-grid">
            {(['main', 'fallback'] as const).map((role) => {
              const route = role === 'main' ? 'transport' : 'fallbackTransport'
              const set = (k: string, v: string) => edit({ ...draft, [k]: v })
              const wrapper = get(route) === 'subscription'
              const legacy = !wrapper && get(role + '.provider') === 'aira-router'
              return (
                <fieldset key={role}>
                  <legend>{role === 'main' ? 'Primary' : 'Fallback'} model</legend>
                  <label>
                    Route
                    <FormSelect
                      label={role + ' route'}
                      value={legacy ? 'aira-router' : get(route)}
                      options={options}
                      onChange={(v) => {
                        const next = { ...draft, [route]: v === 'aira-router' ? 'api' : v }
                        if (v === 'aira-router') {
                          next[role + '.provider'] = 'aira-router'
                          next[role + '.model'] = 'aira'
                        } else if (get(role + '.provider') === 'aira-router') {
                          next[role + '.provider'] = 'openai-compatible'
                          next[role + '.model'] = ''
                        }
                        if (v === 'subscription' && fields[route]?.value !== 'subscription') next[role + '.model'] = ''
                        edit(next)
                      }}
                    />
                  </label>
                  {!wrapper && !legacy && (
                    <label>
                      API provider
                      <FormSelect
                        label={role + ' API provider'}
                        value={get(role + '.provider')}
                        options={[
                          { value: 'anthropic', label: 'Anthropic' },
                          { value: 'openai-compatible', label: 'OpenAI-compatible' }
                        ]}
                        onChange={(v) => set(role + '.provider', v)}
                      />
                    </label>
                  )}
                  {(legacy ? [] : ['model', 'effort', 'deepEffort', ...(!wrapper ? ['baseUrl'] : [])]).map((k) => (
                    <label key={k}>
                      {
                        (
                          {
                            model: 'Model ID',
                            effort: 'Normal effort',
                            deepEffort: '/think effort',
                            baseUrl: 'API endpoint'
                          } as Record<string, string>
                        )[k]
                      }
                      <Input
                        aria-label={role + ' ' + k}
                        value={get(role + '.' + k)}
                        placeholder={
                          k === 'baseUrl'
                            ? fields[role + '.baseUrl']?.display
                            : k === 'model' && wrapper
                              ? 'Claude Code default'
                              : undefined
                        }
                        onChange={(e) => set(role + '.' + k, e.target.value)}
                      />
                    </label>
                  ))}
                </fieldset>
              )
            })}
          </div>
          <div className="core-actions">
            <Button
              type="submit"
              disabled={
                disabled ||
                !Object.keys(draft).length ||
                (get('transport') === 'subscription' && get('fallbackTransport') === 'subscription') ||
                (get('transport') === 'api' &&
                  get('fallbackTransport') === 'api' &&
                  get('main.provider') === 'aira-router' &&
                  get('fallback.provider') === 'aira-router')
              }
            >
              Save routes
            </Button>
            <Button type="button" disabled={disabled} onClick={() => edit(null)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </section>
  )
}
