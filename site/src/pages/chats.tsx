import { TimeField } from '@/dashboard/form-select'
import { Loading } from '@/dashboard/loading'
import { ChatAccess } from '@/dashboard/chat-access'
import { ChatGlyph, motif, ProfileImage, PortraitUpload } from '@/dashboard/profile-image'
import Composer from '@/dashboard/composer'
import { chatHref, dashboardHref } from '@/dashboard/navigation'
import * as Tooltip from '@radix-ui/react-tooltip'
import { ChevronRight, X } from 'lucide-react'
import { Fragment, type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { Shell } from '@/components/shell'
import { Badge, Button, Card, Empty, Field, Input, Picker, Section, Segmented, Spinner, Toggle } from '@/components/ui'
import { CHAT_FEATURE_DEFINITIONS, ChatSettingsViewModel } from '@/lib/chat-view-model'
import {
  type CoreCharacter,
  type CoreChat,
  CoreError,
  type CoreToolCatalog,
  type CoreToolFeature,
  type FooterKindInfo,
  type SocialCapabilityKey,
  type SourceLevel,
  core,
  reasonText
} from '@/lib/core'
import { toast, Toaster } from '@/lib/hooks'
import { cn, midTrunc } from '@/lib/utils'

/* Chats, rebuilt on the core's settings hierarchy (docs/trd/site.md, PRD FR-40).

   Every value shows where it comes from: set on this chat, inherited from the
   DM or group defaults, from the global level, or the built-in default. A value
   set here can be cleared, and the level above applies again. Writes go one key
   at a time through PUT /api/settings, and on/off through the status route. */

type Load<T> = { data?: T; error?: string; loading: boolean; reload: () => void }

function useCore<T>(fetcher: () => Promise<T>): Load<T> {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true })
  const [tick, setTick] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: tick is the reload signal
  useEffect(() => {
    let live = true
    setState((s) => ({ ...s, loading: true }))
    fetcher().then(
      (data) => live && setState({ data, loading: false }),
      (error: unknown) => live && setState((previous) => ({ ...previous, error: reasonText(error), loading: false }))
    )
    return () => {
      live = false
    }
  }, [tick])
  return { ...state, reload: useCallback(() => setTick((n) => n + 1), []) }
}

const SECTIONS = [
  { key: 'character', label: 'Character' },
  { key: 'reply', label: 'Reply' },
  { key: 'features', label: 'Features' },
  { key: 'quiet', label: 'Quiet hours' },
  { key: 'access', label: 'Access' },
  { key: 'send', label: 'Send Message' }
] as const
type SectionKey = (typeof SECTIONS)[number]['key']

function SocialPlatforms({
  catalog,
  feature,
  vm,
  disabled,
  save,
  clear
}: {
  catalog: Load<CoreToolCatalog>
  feature: SocialCapabilityKey
  vm: ChatSettingsViewModel
  disabled: boolean
  save: (key: string, value: boolean) => void
  clear: (key: string) => void
}) {
  const { chat } = vm
  const platforms = catalog.data?.socialCapabilities?.[feature]
  return (
    <div className="mt-2 text-[0.8rem] text-faint">
      {catalog.loading ? (
        <p className="m-0" role="status">
          Loading platforms…
        </p>
      ) : !platforms ? (
        <div className="flex items-center gap-2">
          <span>Platforms unavailable.</span>
          <Button size="sm" variant="ghost" onClick={catalog.reload}>
            Retry
          </Button>
        </div>
      ) : platforms.length ? (
        <fieldset
          disabled={disabled}
          aria-label={feature === 'features.social' ? 'Social post platforms' : 'Post media platforms'}
          className="m-0 mt-3 min-w-0 border-0 border-l border-line-2 py-0 pr-0 pl-3 text-ink sm:pl-5"
        >
          {platforms.map(({ id, name, operations }) => {
            const key = `${feature === 'features.social' ? 'social' : 'autofetch'}.platforms.${id}`
            const level = chat.settings[key]?.level ?? 'default'
            const hint = [operations.join(', '), sourceText(level, chat.type)]
            if (
              id === 'youtube' &&
              !vm.settingValue('features.social', false) &&
              vm.settingValue('features.media', true)
            ) {
              hint.push('Media watching still uses this setting for YouTube links.')
            }
            return (
              <div
                key={id}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-line-2 py-2 last:border-b-0"
              >
                <Toggle
                  checked={vm.settingValue(key, true)}
                  disabled={disabled}
                  onChange={(on) => save(key, on)}
                  label={name}
                  hint={hint.join(' · ')}
                />
                {vm.canClearSetting(key) && (
                  <Button size="sm" variant="ghost" disabled={disabled} onClick={() => clear(key)}>
                    Use Defaults
                  </Button>
                )}
              </div>
            )
          })}
        </fieldset>
      ) : (
        <p className="m-0">No enabled platforms.</p>
      )}
    </div>
  )
}

function FeatureTools({ tools }: { tools: CoreToolFeature['tools'] }) {
  const implicit = tools.some((tool) => tool.mode !== 'explicit')
  const explicit = tools.some((tool) => tool.mode !== 'implicit')
  if (!implicit && !explicit) return null
  const label = implicit && explicit ? 'Both' : implicit ? 'Implicit' : 'Explicit'
  const description = [
    implicit && 'AIRA calls it on her own when a message needs it.',
    explicit && 'Runs only when a member types the command, such as /remind.'
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <Tooltip.Provider delayDuration={0}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <button type="button" className="min-h-11 shrink-0 cursor-help border-0 bg-transparent p-0">
            <Badge>{label}</Badge>
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side="top"
            sideOffset={4}
            collisionPadding={12}
            className="aira-tooltip z-50 max-w-[min(18rem,calc(100vw-24px))] px-3 py-2 text-[0.82rem] leading-relaxed"
          >
            {description}
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  )
}

function sourceText(level: SourceLevel, type: CoreChat['type']): string {
  switch (level) {
    case 'chat':
      return 'set here'
    case 'type':
      return type === 'dm' ? 'from DM defaults' : 'from group defaults'
    case 'global':
      return 'from global'
    case 'default':
      return 'built-in default'
    default:
      return 'not set'
  }
}

/** One setting: its control, where its value comes from, and a way back to the inherited value. */
function SettingRow({
  vm,
  name,
  label,
  hint,
  children,
  onClear
}: {
  vm: ChatSettingsViewModel
  name: string
  label: string
  hint?: string
  children: ReactNode
  onClear?: (key: string) => void
}) {
  const level = vm.chat.settings[name]?.level ?? 'unset'
  return (
    <div className="flex flex-col gap-2 border-b border-line-2 py-4 last:border-b-0">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono text-[0.68rem] font-medium tracking-[0.14em] text-muted uppercase">{label}</span>
        <span className={cn('text-[0.75rem]', level === 'chat' ? 'text-accent' : 'text-faint')}>
          {sourceText(level, vm.chat.type)}
        </span>
        {vm.canClearSetting(name) && onClear && (
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => onClear(name)}>
            Use Defaults
          </Button>
        )}
      </div>
      {children}
      {hint && <p className="m-0 text-[0.8rem] text-faint">{hint}</p>}
    </div>
  )
}

function QuietHours({ vm, onSave }: { vm: ChatSettingsViewModel; onSave: (value: unknown) => void }) {
  const current = vm.settingValue<{ start: string; end: string; timeZone: string } | undefined>('quietHours', undefined)
  const [start, setStart] = useState(current?.start ?? '23:00')
  const [end, setEnd] = useState(current?.end ?? '07:00')
  const [zone, setZone] = useState(current?.timeZone ?? 'Asia/Kuala_Lumpur')
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="From">
          <TimeField label="From" value={start} onChange={setStart} />
        </Field>
        <Field label="Until">
          <TimeField label="Until" value={end} onChange={setEnd} />
        </Field>
        <Field label="Time zone">
          <Input
            aria-label="Time zone"
            value={zone}
            onChange={(e) => setZone(e.target.value)}
            placeholder="Asia/Kuala_Lumpur"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
      </div>
      <div>
        <Button size="sm" onClick={() => onSave({ start, end, timeZone: zone })}>
          Save quiet hours
        </Button>
      </div>
    </div>
  )
}

function LanguageField({ vm, onSave }: { vm: ChatSettingsViewModel; onSave: (value: unknown) => void }) {
  const [text, setText] = useState(vm.settingValue('language', 'auto'))
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && onSave(text.trim())}
        className="w-40"
        aria-label="language code"
        placeholder="auto"
        autoComplete="off"
        spellCheck={false}
      />
      <Button size="sm" onClick={() => onSave(text.trim())}>
        Save language
      </Button>
    </div>
  )
}

function NumberSettingField({
  value,
  min,
  max,
  unit,
  label,
  busy,
  onSave
}: {
  value: number
  min: number
  max: number
  unit: string
  label: string
  busy: boolean
  onSave: (value: number) => Promise<boolean>
}) {
  const [draft, setDraft] = useState(String(value))
  const [error, setError] = useState<string | null>(null)

  async function commit() {
    const trimmed = draft.trim()
    if (!/^-?\d+$/.test(trimmed)) {
      setError(`Enter a whole number from ${min} to ${max}.`)
      return
    }
    const parsed = Number(trimmed)
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
      setError(`Enter a whole number from ${min} to ${max}.`)
      return
    }
    setError(null)
    await onSave(parsed)
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={1}
          value={draft}
          disabled={busy}
          onChange={(e) => {
            setDraft(e.target.value)
            if (error) setError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void commit()
            }
          }}
          className="tnum w-24 font-mono text-[0.9rem]"
          aria-label={label}
          aria-invalid={error ? true : undefined}
        />
        <span className="text-[0.82rem] text-muted">{unit}</span>
        <Button size="sm" disabled={busy || draft.trim() === ''} onClick={() => void commit()}>
          Save
        </Button>
      </div>
      {error && (
        <p role="alert" className="m-0 text-[0.8rem] text-down">
          {error}
        </p>
      )}
    </div>
  )
}

const FOOTER_EMOJI = ['🛠️', '🧪', '🔬', '🔎', '✨', '🌸', '📎']
const REACTION_CHANCES = ['10', '25', '33', '50', '75', '100'] as const
type ReactionChancePreset = (typeof REACTION_CHANCES)[number]
const REACTION_CHANCE_LABELS: Record<ReactionChancePreset, string> = {
  '10': '10%',
  '25': '25%',
  '33': '33%',
  '50': '50%',
  '75': '75%',
  '100': '100%'
}
const NAME_CALL_PATTERN = /^[\p{L}\p{N} ]{2,24}$/u

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Copied from src/turn/name-call.ts: true when any name appears as a whole word in any case. */
function matchesName(text: string, names: readonly string[]): boolean {
  return names.some((name) => {
    if (name.trim() === '') return false
    return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, 'iu').test(text)
  })
}

function NameCallField({
  vm,
  busy,
  onSave,
  onClear
}: {
  vm: ChatSettingsViewModel
  busy: boolean
  onSave: (key: string, value: unknown) => Promise<boolean>
  onClear: (key: string) => Promise<boolean>
}) {
  const { chat } = vm
  const pack = vm.boundPack
  const characterId = vm.effectiveCharacterId
  const enabled = vm.settingValue('nameCall', false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [sample, setSample] = useState('')

  const namesEntry = chat.settings['nameCall.names']
  const namesLevel = namesEntry?.level ?? 'unset'
  const overridden = vm.canClearSetting('nameCall.names')
  const customNames =
    overridden && Array.isArray(namesEntry?.value)
      ? namesEntry.value.filter((item): item is string => typeof item === 'string')
      : []
  const inheritedNames =
    (namesLevel === 'type' || namesLevel === 'global') && Array.isArray(namesEntry?.value)
      ? namesEntry.value.filter((item): item is string => typeof item === 'string')
      : vm.wakeNames()
  const activeNames = overridden ? customNames : inheritedNames
  const inheritedSource =
    namesLevel === 'type' || namesLevel === 'global'
      ? sourceText(namesLevel, chat.type)
      : `From ${pack?.displayName ?? characterId ?? 'character'}`

  async function addName() {
    const candidate = draft.trim()
    if (draft === '') return
    if (customNames.length >= 5) {
      setError('At most 5 names.')
      return
    }
    const length = [...candidate].length
    if (length < 2 || length > 24) {
      setError('Name must be 2 to 24 characters.')
      return
    }
    if (!NAME_CALL_PATTERN.test(candidate)) {
      setError('Use letters, digits or spaces only.')
      return
    }
    if (customNames.some((item) => item.toLowerCase() === candidate.toLowerCase())) {
      setError('That name is already in the list.')
      return
    }
    setError(null)
    const ok = await onSave('nameCall.names', [...customNames, candidate])
    if (ok) setDraft('')
  }

  async function removeName(index: number) {
    setError(null)
    if (customNames.length <= 1) {
      await onClear('nameCall.names')
      return
    }
    await onSave(
      'nameCall.names',
      customNames.filter((_, i) => i !== index)
    )
  }

  const matchedName = sample.trim() ? activeNames.find((name) => matchesName(sample, [name])) : undefined

  return (
    <div className="flex flex-col gap-4">
      <Toggle
        checked={enabled}
        disabled={busy}
        onChange={(v) => void onSave('nameCall', v)}
        label="Answer a message that says the character's name"
        hint="Off: answers a mention, a reply or a command only."
      />
      {enabled && (
        <div className="flex flex-col gap-4 border-t border-line-2 pt-3">
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="font-mono text-[0.68rem] font-medium tracking-[0.14em] text-muted uppercase">
                  Names
                </span>
                <span className={cn('text-[0.75rem]', overridden ? 'text-accent' : 'text-faint')}>
                  {overridden ? 'set here' : inheritedSource}
                </span>
              </div>
              {overridden && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setError(null)
                    void onClear('nameCall.names')
                  }}
                >
                  Use Defaults
                </Button>
              )}
            </div>

            <div className="flex flex-wrap gap-2">
              {overridden ? (
                customNames.map((name, index) => (
                  <span
                    key={name}
                    className="inline-flex min-h-[44px] max-w-full items-center gap-1 rounded-full border border-line bg-sunk/60 py-1 pr-1 pl-3.5 font-mono text-[0.78rem] text-ink"
                  >
                    <span className="truncate">{name}</span>
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={`Remove ${name}`}
                      onClick={() => void removeName(index)}
                      className="inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent text-muted transition-colors hover:text-down disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <X className="size-3.5" />
                    </button>
                  </span>
                ))
              ) : inheritedNames.length > 0 ? (
                inheritedNames.map((name) => (
                  <span
                    key={name}
                    className="inline-flex max-w-full items-center rounded-full border border-line-2 px-3.5 py-1.5 font-mono text-[0.78rem] text-muted opacity-75"
                  >
                    <span className="truncate">{name}</span>
                  </span>
                ))
              ) : (
                <span className="text-[0.8rem] text-faint">No character names loaded.</span>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={draft}
                disabled={busy}
                onChange={(e) => {
                  setDraft(e.target.value)
                  if (error) setError(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    void addName()
                  }
                }}
                className="min-w-0 flex-1 basis-40"
                aria-label="Add a name"
                aria-invalid={error ? true : undefined}
                placeholder={overridden ? 'Add another name' : 'Override with a name'}
                autoComplete="off"
                spellCheck={false}
              />
              <Button
                size="sm"
                className="shrink-0"
                disabled={busy || draft.length === 0}
                onClick={() => void addName()}
              >
                Add
              </Button>
            </div>
            {error ? (
              <p role="alert" className="m-0 text-[0.8rem] text-down">
                {error}
              </p>
            ) : (
              <p className="m-0 text-[0.78rem] text-faint">1 to 5 names, 2 to 24 letters, digits or spaces.</p>
            )}
          </div>

          <Field label="Try a message">
            <Input
              value={sample}
              onChange={(e) => setSample(e.target.value)}
              placeholder="Type a sample message…"
              autoComplete="off"
              spellCheck={false}
            />
            <p
              aria-live="polite"
              className={cn(
                'm-0 text-[0.8rem]',
                sample.trim() === '' ? 'text-faint' : matchedName ? 'text-up' : 'text-muted'
              )}
            >
              {sample.trim() === ''
                ? 'Shows whether a message would wake the bot.'
                : matchedName
                  ? `Wakes the bot — matched “${matchedName}”.`
                  : 'Would not wake the bot.'}
            </p>
          </Field>
        </div>
      )}
    </div>
  )
}

function FooterEmojiField({ vm, onSave }: { vm: ChatSettingsViewModel; onSave: (value: unknown) => void }) {
  const current = vm.settingValue<string | undefined>('footerEmoji', undefined)
  const [text, setText] = useState(current ?? '')
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="footer emoji">
        {FOOTER_EMOJI.map((emoji) => (
          <Button
            key={emoji}
            size="sm"
            variant={current === emoji ? 'primary' : 'outline'}
            aria-pressed={current === emoji}
            onClick={() => onSave(emoji)}
          >
            {emoji}
          </Button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && text.trim() && onSave(text.trim())}
          className="w-24"
          aria-label="custom footer emoji"
          placeholder="Other"
          autoComplete="off"
        />
        <Button size="sm" disabled={!text.trim()} onClick={() => onSave(text.trim())}>
          Use this emoji
        </Button>
      </div>
    </div>
  )
}

function ChatLabelField({
  vm,
  busy,
  onSave
}: {
  vm: ChatSettingsViewModel
  busy: boolean
  onSave: (label: string) => Promise<boolean>
}) {
  const [draft, setDraft] = useState(vm.storedLabel)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setDraft(vm.storedLabel)
    setError(null)
  }, [vm.storedLabel])

  const trimmed = draft.trim()
  const dirty = vm.isLabelDirty(draft)

  async function commit() {
    if (trimmed.length > 120) {
      setError('At most 120 characters.')
      return
    }
    setError(null)
    await onSave(trimmed)
  }

  return (
    <div className="flex flex-col gap-1.5 border-b border-line-2 px-4 py-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono text-[0.68rem] font-medium tracking-[0.14em] text-muted uppercase">Label</span>
        <span className="text-[0.75rem] text-faint">Shown on the dashboard for this chat</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={draft}
          disabled={busy}
          placeholder={vm.labelPlaceholder}
          aria-label={`Label for ${vm.displayLabel}`}
          aria-invalid={error ? true : undefined}
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 basis-52 sm:max-w-xs"
          onChange={(e) => {
            setDraft(e.target.value)
            if (error) setError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              if (dirty && !busy) void commit()
            }
          }}
        />
        <Button size="sm" disabled={busy || !dirty} onClick={() => void commit()}>
          Save
        </Button>
      </div>
      {error && (
        <p role="alert" className="m-0 text-[0.8rem] text-down">
          {error}
        </p>
      )}
    </div>
  )
}

function ChatRow({
  chat,
  characters,
  charactersError,
  toolCatalog,
  onChanged,
  open,
  onToggle,
  focusRequest
}: {
  chat: CoreChat
  toolCatalog: Load<CoreToolCatalog>
  characters: CoreCharacter[]
  charactersError?: string
  onChanged: () => void
  /** Kept by the page, so a chat that moves between On and Off stays open. */
  open: boolean
  onToggle?: () => void
  focusRequest?: { chatId: string; tab: SectionKey; seq: number } | null
}) {
  const vm = useMemo(() => new ChatSettingsViewModel(chat, characters), [chat, characters])
  const toolFeatures = toolCatalog.data?.features ?? []
  const sections = onToggle ? SECTIONS.filter((s) => s.key !== 'send') : SECTIONS
  const resolveTab = () =>
    !onToggle && location.pathname.endsWith('/send')
      ? 'send'
      : (sections.find((s) => '#' + s.key === location.hash)?.key ?? 'character')
  const [tab, setTab] = useState<SectionKey>(resolveTab)
  useEffect(() => {
    if (onToggle) return
    const change = () => setTab(SECTIONS.find((s) => '#' + s.key === location.hash)?.key ?? 'character')
    addEventListener('hashchange', change)
    return () => removeEventListener('hashchange', change)
  }, [onToggle])
  function chooseTab(next: SectionKey) {
    setTab(next)
    if (!onToggle)
      history.replaceState(
        history.state,
        '',
        chatHref('chats/' + encodeURIComponent(chat.chatId) + '/settings') + '#' + next
      )
  }
  const [busy, setBusy] = useState(false)
  const [conflict, setConflict] = useState<{ key: string; value: unknown; revision?: string } | null>(null)
  const name = chat.label || (onToggle ? midTrunc(chat.waId, 28) : 'Unnamed Chat')
  const character = vm.effectiveCharacterId
  const pack = vm.boundPack

  useEffect(() => {
    if (focusRequest && focusRequest.chatId === chat.chatId) {
      setTab(focusRequest.tab)
      document.getElementById(`chat-${chat.chatId}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [focusRequest, chat.chatId])

  const run = async (work: () => Promise<{ changed: boolean }>, done: string): Promise<boolean> => {
    setBusy(true)
    try {
      const result = await work()
      toast(result.changed ? done : 'Nothing changed.')
      onChanged()
      return true
    } catch (error) {
      toast(reasonText(error), false)
      return false
    } finally {
      setBusy(false)
    }
  }
  const save = (key: string, value: unknown) =>
    run(
      async () => {
        try {
          const result = await core.setSetting('chat', chat.chatId, key, value, chat.settingsRevision)
          setConflict(null)
          return result
        } catch (error) {
          if (error instanceof CoreError && error.code === 'stale_revision')
            setConflict({ key, value, revision: chat.settingsRevision })
          throw error
        }
      },
      value === null ? 'This chat now inherits it.' : 'Saved for this chat.'
    )
  const clear = (key: string) => save(key, null)

  const facts = [
    pack?.displayName ?? (character ? `${character} (not loaded)` : 'no character'),
    vm.settingValue('language', 'auto')
  ]

  const accessControls = (
    <>
      <div className="border-b border-line-2 px-4 py-4">
        <Toggle
          checked={chat.status === 'active'}
          disabled={!vm.canToggleReplies(busy)}
          onChange={(on) =>
            run(
              () => core.setStatus(chat.chatId, on ? 'active' : 'pending'),
              on ? 'Replies are on for this chat.' : 'Replies are off for this chat.'
            )
          }
          label="Replies in this chat"
          hint={
            pack
              ? 'Off: messages are kept, and no reply is sent.'
              : 'Replies require a loaded character. Choose one in the Character tab.'
          }
        />
      </div>
      <ChatLabelField
        vm={vm}
        busy={busy}
        onSave={(label) =>
          run(
            () => core.setLabel(chat.chatId, label),
            label === '' ? 'Cleared label for this chat.' : 'Saved label for this chat.'
          )
        }
      />
    </>
  )

  return (
    <div id={`chat-${chat.chatId}`} className="border-b border-line last:border-b-0">
      {conflict && (
        <section role="alert">
          <h3>Settings changed in another session</h3>
          <p>
            Your draft for {conflict.key}: {conflict.value === null ? 'Inherit' : JSON.stringify(conflict.value)}
          </p>
          {conflict.revision === chat.settingsRevision ? (
            <Button disabled={busy} onClick={onChanged}>
              Reload to compare
            </Button>
          ) : (
            <>
              <p>Current value: {JSON.stringify(chat.settings[conflict.key]?.value ?? null)}</p>
              <Button disabled={busy} onClick={() => void save(conflict.key, conflict.value)}>
                Apply my draft
              </Button>
            </>
          )}
          <Button
            onClick={() => {
              setConflict(null)
              onChanged()
            }}
          >
            Discard draft
          </Button>
        </section>
      )}
      {onToggle ? (
        <button
          type="button"
          disabled={!onToggle}
          aria-expanded={open}
          onClick={onToggle}
          className="flex w-full min-w-0 cursor-pointer items-center gap-3 border-0 bg-transparent px-4 py-3 text-left focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
        >
          <ChevronRight
            aria-hidden
            className={cn(
              'size-4 shrink-0 text-faint transition-transform duration-150',
              open && 'rotate-90 text-accent'
            )}
          />
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline gap-2">
              <b className="truncate font-serif text-[1.05rem] font-medium">{name}</b>
              <span className="shrink-0 font-mono text-[0.66rem] tracking-[0.08em] text-faint uppercase">
                {chat.type === 'dm' ? 'DM' : 'group'}
              </span>
              {chat.status === 'pending' && <span className="shrink-0 text-[0.72rem] text-amber">off</span>}
            </span>
            {chat.type === 'dm' && (
              <span className="block text-xs text-faint">
                {chat.lastInboundAt
                  ? 'Last message received ' + new Date(chat.lastInboundAt).toLocaleString()
                  : 'No recorded incoming messages'}
              </span>
            )}
            {chat.label && <span className="mt-0.5 block truncate text-[0.72rem] text-faint">{chat.waId}</span>}
          </span>
          <span className="hidden shrink-0 items-center gap-2 sm:flex">
            {facts.map((fact) => (
              <span
                key={fact}
                className="max-w-[12rem] truncate rounded-full border border-line-2 px-2 py-0.5 font-mono text-[0.66rem] tracking-[0.04em] text-muted lowercase"
              >
                {fact}
              </span>
            ))}
          </span>
        </button>
      ) : (
        <div className="chat-context">
          <ChatGlyph chat={chat} />
          <div>
            <strong>{name}</strong>
            <small>
              {chat.type === 'dm' ? 'Direct Chat' : 'Group Chat'} · Replies {chat.status === 'active' ? 'On' : 'Off'}
            </small>
          </div>
          <span>Changes Apply to This Chat</span>
        </div>
      )}

      {open && (
        <div className="border-t border-line">
          {onToggle && accessControls}
          <div className="flex flex-col sm:flex-row">
            <div
              role="tablist"
              aria-label={`configure ${name}`}
              className={cn(
                'flex shrink-0 gap-1 overflow-x-auto border-b border-line p-3',
                'sm:w-[11rem] sm:flex-col sm:overflow-visible sm:border-r sm:border-b-0 sm:py-4'
              )}
            >
              {sections.map((s, index) => {
                const on = s.key === tab
                return (
                  <button
                    key={s.key}
                    type="button"
                    role="tab"
                    id={chat.chatId + '-tab-' + s.key}
                    aria-controls={chat.chatId + '-panel'}
                    tabIndex={on ? 0 : -1}
                    onKeyDown={(event) => {
                      const offsets: Record<string, number> = {
                        ArrowDown: 1,
                        ArrowRight: 1,
                        ArrowUp: -1,
                        ArrowLeft: -1
                      }
                      const idx =
                        event.key === 'Home'
                          ? 0
                          : event.key === 'End'
                            ? sections.length - 1
                            : event.key in offsets
                              ? (index + offsets[event.key] + sections.length) % sections.length
                              : undefined
                      if (idx === undefined) return
                      event.preventDefault()
                      const next = sections[idx]!.key
                      chooseTab(next)
                      document.getElementById(chat.chatId + '-tab-' + next)?.focus()
                    }}
                    aria-selected={on}
                    onClick={() => chooseTab(s.key)}
                    className={cn(
                      'flex min-h-11 shrink-0 cursor-pointer items-center border-0 px-3 text-left',
                      'rounded-[var(--radius-control)] transition-colors',
                      'font-mono text-[0.68rem] font-medium tracking-[0.14em] whitespace-nowrap uppercase',
                      on ? 'bg-accent-soft text-ink' : 'bg-transparent text-muted hover:text-read'
                    )}
                  >
                    {s.label}
                  </button>
                )
              })}
            </div>
            <div
              id={chat.chatId + '-panel'}
              aria-labelledby={chat.chatId + '-tab-' + tab}
              role="tabpanel"
              className="min-w-0 flex-1 px-4 sm:px-6"
            >
              {!onToggle && tab !== 'send' && (
                <h2 className="chat-section-title">{SECTIONS.find((section) => section.key === tab)?.label}</h2>
              )}
              {tab === 'send' && <Composer key={chat.chatId} chat={chat} />}
              {!onToggle && pack && (tab === 'character' || tab === 'reply') && (
                <div className="chat-footer-link">
                  <strong>Persona Tool Footer</strong>
                  <span>{pack.displayName}</span>
                  <a
                    className="workspace-tool"
                    href={dashboardHref('characters/' + encodeURIComponent(pack.id) + '/footer')}
                  >
                    Open Persona Tool Footer
                  </a>
                </div>
              )}
              {tab === 'character' && (
                <>
                  <SettingRow
                    vm={vm}
                    name="character"
                    label={onToggle ? 'Character' : 'Character Persona'}
                    onClear={clear}
                  >
                    {characters.length && !onToggle ? (
                      <div className="persona-choices" role="group" aria-label="Choose a character">
                        {characters.map((persona, index) => (
                          <label key={persona.id}>
                            <input
                              type="radio"
                              name={'persona-' + chat.chatId}
                              value={persona.id}
                              checked={character === persona.id}
                              disabled={busy}
                              onChange={() => void save('character', persona.id)}
                            />
                            <ProfileImage
                              kind="characters"
                              id={persona.id}
                              configured={persona.hasPortrait}
                              className="persona-portrait"
                              fallback={<img className="persona-portrait" alt="" src={motif(persona.id, index)} />}
                            />
                            <strong>{persona.displayName}</strong>
                            <small>{persona.id}</small>
                          </label>
                        ))}
                        <a href={dashboardHref('characters')}>Add More</a>
                      </div>
                    ) : characters.length ? (
                      <Picker
                        ariaLabel="character"
                        options={characters.map((c) => ({
                          value: c.id,
                          label: c.displayName,
                          hint: `${c.id} · ${c.source === 'data' ? 'uploaded' : 'built in'}`
                        }))}
                        value={character ?? null}
                        onChange={(id) => save('character', id)}
                        disabled={busy}
                      />
                    ) : charactersError ? (
                      <Empty>Character list unavailable: {charactersError}</Empty>
                    ) : (
                      <Empty>No character pack is loaded.</Empty>
                    )}
                  </SettingRow>
                  <SettingRow
                    vm={vm}
                    name="language"
                    label="Language"
                    hint="auto answers in the language written to. Or a code such as ms, en or zh."
                    onClear={clear}
                  >
                    <LanguageField
                      key={String(vm.settingValue('language', 'auto'))}
                      vm={vm}
                      onSave={(v) => save('language', v)}
                    />
                  </SettingRow>
                </>
              )}
              {tab === 'reply' && (
                <>
                  <SettingRow vm={vm} name="replyLength" label="Reply length" onClear={clear}>
                    <Segmented
                      options={['short', 'default', 'long'] as const}
                      value={vm.settingValue('replyLength', 'default')}
                      disabled={busy}
                      onChange={(v) => void save('replyLength', v)}
                      labels={{ short: 'Short', default: 'Default', long: 'Long' }}
                    />
                  </SettingRow>
                  <SettingRow vm={vm} name="expressions" label="Expressions" onClear={clear}>
                    <Toggle
                      checked={vm.settingValue('expressions', true)}
                      disabled={busy}
                      onChange={(v) => save('expressions', v)}
                      label="Send a sticker with replies"
                      hint="Off: text only."
                    />
                  </SettingRow>
                  <SettingRow vm={vm} name="features.toolFooter" label="Tool footer" onClear={clear}>
                    <Toggle
                      checked={vm.settingValue('features.toolFooter', true)}
                      disabled={busy}
                      onChange={(v) => save('features.toolFooter', v)}
                      label="Say which tools a reply used, and its sources"
                      hint="A small line at the end of a reply that searched, read or saved something."
                    />
                  </SettingRow>
                  {vm.settingValue('features.toolFooter', true) && (
                    <SettingRow vm={vm} name="footerEmoji" label="Footer emoji" onClear={clear}>
                      <FooterEmojiField vm={vm} onSave={(v) => save('footerEmoji', v)} />
                    </SettingRow>
                  )}
                  {chat.type === 'group' && (
                    <>
                      <SettingRow vm={vm} name="freeResponse" label="Free response" onClear={clear}>
                        <Toggle
                          checked={vm.settingValue('freeResponse', false)}
                          disabled={busy}
                          onChange={(v) => save('freeResponse', v)}
                          label="Answer any message in this group"
                          hint="Off: answers a mention or a reply only."
                        />
                      </SettingRow>
                      <SettingRow vm={vm} name="nameCall" label="Name call" onClear={clear}>
                        <NameCallField vm={vm} busy={busy} onSave={save} onClear={clear} />
                      </SettingRow>
                    </>
                  )}
                  <SettingRow vm={vm} name="features.context" label="Live context" onClear={clear}>
                    <Toggle
                      checked={vm.settingValue('features.context', true)}
                      disabled={busy}
                      onChange={(v) => save('features.context', v)}
                      label="Replay earlier messages as context"
                      hint="Off: AIRA sees only the message she is answering. Messages are still logged."
                    />
                  </SettingRow>
                  <SettingRow
                    vm={vm}
                    name="context.maxMessages"
                    label="Context size"
                    hint={
                      vm.settingValue('features.context', true)
                        ? 'Recent chat-log messages replayed per turn (0 to 100).'
                        : 'Applies when Live context is on (0 to 100).'
                    }
                    onClear={clear}
                  >
                    <NumberSettingField
                      key={`${chat.settings['context.maxMessages']?.level ?? 'unset'}:${vm.settingValue('context.maxMessages', 40)}`}
                      value={vm.settingValue('context.maxMessages', 40)}
                      min={0}
                      max={100}
                      unit="messages"
                      label="Context size"
                      busy={busy}
                      onSave={(v) => save('context.maxMessages', v)}
                    />
                  </SettingRow>
                  <SettingRow vm={vm} name="features.memory" label="Memory" onClear={clear}>
                    <Toggle
                      checked={vm.settingValue('features.memory', true)}
                      disabled={busy}
                      onChange={(v) => save('features.memory', v)}
                      label="Learn and recall facts in this chat"
                      hint="Off: AIRA learns nothing new and recalls nothing here. Stored facts are kept."
                    />
                  </SettingRow>
                  <SettingRow
                    vm={vm}
                    name="memory.pageMessages"
                    label="Memory page"
                    hint="Messages that close a memory episode (5 to 50)."
                    onClear={clear}
                  >
                    <NumberSettingField
                      key={`${chat.settings['memory.pageMessages']?.level ?? 'unset'}:${vm.settingValue('memory.pageMessages', 25)}`}
                      value={vm.settingValue('memory.pageMessages', 25)}
                      min={5}
                      max={50}
                      unit="messages"
                      label="Memory page"
                      busy={busy}
                      onSave={(v) => save('memory.pageMessages', v)}
                    />
                  </SettingRow>
                  <SettingRow vm={vm} name="reactions" label="Reactions" onClear={clear}>
                    <Toggle
                      checked={vm.settingValue('reactions', false)}
                      disabled={busy}
                      onChange={(v) => save('reactions', v)}
                      label="React to members' messages with an emoji"
                    />
                  </SettingRow>
                  {vm.settingValue('reactions', false) &&
                    (() => {
                      const chance = vm.settingValue('reactions.chance', 33)
                      const preset = REACTION_CHANCES.includes(String(chance) as ReactionChancePreset)
                        ? (String(chance) as ReactionChancePreset)
                        : null
                      return (
                        <SettingRow
                          vm={vm}
                          name="reactions.chance"
                          label="Chance"
                          hint={
                            preset === null
                              ? `Current value: ${chance}%. Pick a preset to change.`
                              : 'How often a matching message gets a reaction.'
                          }
                          onClear={clear}
                        >
                          <Segmented
                            options={REACTION_CHANCES}
                            labels={REACTION_CHANCE_LABELS}
                            value={preset}
                            disabled={busy}
                            onChange={(v) => void save('reactions.chance', Number(v))}
                            className="max-w-full [&_button]:min-h-[44px]"
                          />
                        </SettingRow>
                      )
                    })()}
                  <SettingRow
                    vm={vm}
                    name="commands.maxPerMessage"
                    label="Commands per message"
                    hint="How many slash commands one message may run."
                    onClear={clear}
                  >
                    <Segmented
                      options={['1', '2', '3', '4', '5'] as const}
                      value={String(vm.settingValue('commands.maxPerMessage', 1)) as '1' | '2' | '3' | '4' | '5'}
                      disabled={busy}
                      onChange={(v) => void save('commands.maxPerMessage', Number(v))}
                    />
                  </SettingRow>
                  <SettingRow
                    vm={vm}
                    name="tools.maxPerMessage"
                    label="Tools per message"
                    hint="Tool calls one reply may make"
                    onClear={clear}
                  >
                    <Segmented
                      options={['1', '2', '3', '4', '5', '6', '7', '8'] as const}
                      value={
                        String(vm.settingValue('tools.maxPerMessage', 3)) as
                          '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8'
                      }
                      disabled={busy}
                      onChange={(v) => void save('tools.maxPerMessage', Number(v))}
                    />
                  </SettingRow>
                </>
              )}
              {tab === 'features' &&
                CHAT_FEATURE_DEFINITIONS.map((f) => {
                  const postMedia = f.key === 'features.autofetch'
                  const socialKey = postMedia || f.key === 'features.social' ? (f.key as SocialCapabilityKey) : null
                  return (
                    <Fragment key={f.key}>
                      <SettingRow vm={vm} name={f.key} label={f.label} onClear={clear}>
                        <div className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-1">
                          <div className="min-w-0 flex-1 basis-48">
                            <Toggle
                              checked={vm.settingValue(f.key, false)}
                              disabled={busy}
                              onChange={(v) => save(f.key, v)}
                              label={f.label}
                              hint={f.hint}
                            />
                            {postMedia && (
                              <p className="mt-2 mb-0 text-[0.8rem] text-faint">
                                YouTube delivery is limited to verified Shorts.
                                {chat.status !== 'active'
                                  ? ' This chat is off.'
                                  : vm.settingValue('muted', false)
                                    ? ' This chat is muted.'
                                    : ''}
                              </p>
                            )}
                            {socialKey && (
                              <SocialPlatforms
                                catalog={toolCatalog}
                                feature={socialKey}
                                vm={vm}
                                disabled={busy || !vm.settingValue(f.key, false)}
                                save={save}
                                clear={clear}
                              />
                            )}
                          </div>
                          <FeatureTools tools={toolFeatures.find((feature) => feature.key === f.key)?.tools ?? []} />
                        </div>
                      </SettingRow>
                      {f.key === 'features.reports' && (
                        <SettingRow
                          vm={vm}
                          name="report.defaultFormat"
                          label="Default document format"
                          hint="Format for /doc when a message names none."
                          onClear={clear}
                        >
                          <Segmented
                            options={['pdf', 'markdown'] as const}
                            labels={{ pdf: 'PDF', markdown: 'Markdown' }}
                            value={vm.settingValue<'pdf' | 'markdown'>('report.defaultFormat', 'pdf')}
                            disabled={busy}
                            onChange={(v) => void save('report.defaultFormat', v)}
                          />
                        </SettingRow>
                      )}
                    </Fragment>
                  )
                })}
              {tab === 'quiet' && (
                <SettingRow
                  vm={vm}
                  name="quietHours"
                  label={onToggle ? 'Quiet hours' : 'Quiet period'}
                  hint="No scheduled or first message is sent in this window. Replies still go out."
                  onClear={clear}
                >
                  <QuietHours
                    key={JSON.stringify(chat.settings['quietHours']?.value ?? null)}
                    vm={vm}
                    onSave={(v) => save('quietHours', v)}
                  />
                </SettingRow>
              )}
              {tab === 'access' && (
                <>
                  {!onToggle && (
                    <>
                      <PortraitUpload kind="chats" id={chat.chatId} onSaved={onChanged} />
                      {accessControls}
                    </>
                  )}
                  <SettingRow vm={vm} name="allowedSenders" label="Who may write">
                    {!onToggle ? (
                      <ChatAccess
                        chatId={chat.chatId}
                        current={vm.settingValue<'all' | string[]>('allowedSenders', 'all')}
                        chatType={chat.type}
                        inherited={chat.settings.allowedSenders?.level !== 'chat'}
                        save={(value) => save('allowedSenders', value)}
                      />
                    ) : (
                      <p className="m-0 text-[0.95rem]">
                        {(() => {
                          const v = vm.settingValue<'all' | string[]>('allowedSenders', 'all')
                          return v === 'all' ? 'Everyone in this chat.' : `${v.length} listed senders.`
                        })()}
                      </p>
                    )}
                  </SettingRow>
                  <SettingRow vm={vm} name="muted" label="Muted">
                    <p className="m-0 text-[0.95rem]">
                      {vm.settingValue<unknown>('muted', false) === false
                        ? 'Not muted.'
                        : 'Muted by a member with /mute.'}
                    </p>
                  </SettingRow>
                  <SettingRow vm={vm} name="model" label="Model">
                    <p className="m-0 text-[0.95rem]">
                      {vm.settingValue<unknown>('model', 'inherit') === 'inherit'
                        ? 'The deployment’s main model.'
                        : 'A model set for this chat.'}
                    </p>
                  </SettingRow>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Group({
  title,
  note,
  chats,
  openId,
  setOpenId,
  ...rest
}: {
  title: string
  note: string
  chats: CoreChat[]
  toolCatalog: Load<CoreToolCatalog>
  characters: CoreCharacter[]
  charactersError?: string
  onChanged: () => void
  openId: string | null
  setOpenId: (id: string | null) => void
  focusRequest: { chatId: string; tab: SectionKey; seq: number } | null
}) {
  if (!chats.length) return null
  return (
    <div>
      <div className="mb-2 flex items-baseline gap-3">
        <h3 className="m-0 font-mono text-[0.68rem] tracking-[0.11em] text-muted uppercase">{title}</h3>
        <span className="h-px flex-1 bg-line" aria-hidden />
        <span className="text-[0.78rem] text-faint">{note}</span>
      </div>
      <Card className="overflow-hidden p-0">
        {chats.map((chat) => (
          <ChatRow
            key={chat.chatId}
            chat={chat}
            open={openId === chat.chatId}
            onToggle={() => setOpenId(openId === chat.chatId ? null : chat.chatId)}
            {...rest}
          />
        ))}
      </Card>
    </div>
  )
}

const FOOTER_FORBIDDEN = /[_*~`<>\r\n\p{Cc}]/u

function footerLabelProblem(value: string): string | null {
  if (FOOTER_FORBIDDEN.test(value)) return 'Must not contain _, *, ~, `, <, > or control characters.'
  const trimmed = value.trim()
  if (trimmed.length === 0) return 'Enter 1 to 40 characters.'
  if (trimmed.length > 40) return 'At most 40 characters.'
  return null
}

function FooterLabelRow({
  packId,
  kind,
  defaultLabel,
  packValue,
  readOnly,
  busy,
  onSave
}: {
  packId: string
  kind: string
  defaultLabel: string
  packValue?: string
  readOnly: boolean
  busy: boolean
  onSave: (kind: string, value: string | null) => Promise<boolean>
}) {
  const [draft, setDraft] = useState(packValue ?? '')
  const [error, setError] = useState<string | null>(null)
  const isSet = packValue !== undefined

  useEffect(() => {
    setDraft(packValue ?? '')
    setError(null)
  }, [packValue])

  const trimmed = draft.trim()
  const dirty = trimmed !== (packValue ?? '')

  async function submit() {
    const problem = footerLabelProblem(draft)
    if (problem) {
      setError(problem)
      return
    }
    setError(null)
    await onSave(kind, trimmed)
  }

  return (
    <div className="flex flex-col gap-2 border-b border-line-2 py-3 last:border-b-0">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono text-[0.74rem] text-ink">{kind}</span>
        <span className={cn('text-[0.75rem]', isSet ? 'text-accent' : 'text-faint')}>
          {isSet ? 'set in pack' : 'default'}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={draft}
          readOnly={readOnly}
          disabled={readOnly || busy}
          placeholder={defaultLabel}
          aria-label={`${packId} ${kind} label`}
          aria-invalid={error ? true : undefined}
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 basis-52"
          onChange={(e) => {
            setDraft(e.target.value)
            if (error) setError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !readOnly) {
              e.preventDefault()
              void submit()
            }
          }}
        />
        {!readOnly && (
          <Button size="sm" disabled={busy || !dirty || trimmed === ''} onClick={() => void submit()}>
            Save
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={readOnly || busy || !isSet}
          onClick={() => {
            setError(null)
            void onSave(kind, null)
          }}
        >
          Clear
        </Button>
      </div>
      {error && (
        <p role="alert" className="m-0 text-[0.8rem] text-down">
          {error}
        </p>
      )}
    </div>
  )
}

function PackFooterPanel({
  pack,
  footerKinds,
  chats,
  onChanged,
  onOpenChat
}: {
  pack: CoreCharacter
  footerKinds: FooterKindInfo[]
  chats: CoreChat[]
  onChanged: () => void
  onOpenChat: (chatId: string) => void
}) {
  const readOnly = pack.source !== 'data'
  const [open, setOpen] = useState(!readOnly)
  const [busy, setBusy] = useState(false)
  const [current, setCurrent] = useState<Awaited<ReturnType<typeof core.getFooter>> | null>(null)
  const [issue, setIssue] = useState('')
  const [reload, setReload] = useState(0)
  const shownFooter = current?.toolFooter ?? pack.toolFooter
  const packIcon = shownFooter?.icon
  const [iconDraft, setIconDraft] = useState(packIcon ?? '')
  const locked = busy || (!readOnly && (!current || Boolean(issue)))

  useEffect(() => {
    let live = true
    setCurrent(null)
    setIssue('')
    if (!readOnly) {
      core.getFooter(pack.id).then(
        (state) => {
          if (!live) return
          setCurrent(state)
          setIconDraft(state.toolFooter.icon ?? '')
        },
        () => {
          if (live) setIssue('The current footer could not be read.')
        }
      )
    }
    return () => {
      live = false
    }
  }, [pack.id, readOnly, reload])

  const boundChats = useMemo(
    () => chats.filter((c) => new ChatSettingsViewModel(c, [pack]).effectiveCharacterId === pack.id),
    [chats, pack]
  )

  const overrideCount = (packIcon !== undefined ? 1 : 0) + Object.keys(shownFooter?.labels ?? {}).length

  async function savePatch(patch: { icon?: string | null; labels?: Record<string, string | null> }, msg: string) {
    if (!current || locked) return false
    setBusy(true)
    try {
      const res = await core.setFooter(pack.id, patch, current.revision)
      if (!res.revision) throw new Error('Footer readback unavailable')
      setCurrent({ id: pack.id, revision: res.revision, toolFooter: res.toolFooter })
      if ('icon' in patch) setIconDraft(res.toolFooter.icon ?? '')
      toast(res.changed ? msg : 'Nothing changed.')
      onChanged()
      return true
    } catch (error) {
      if (error instanceof CoreError && (error.code === 'stale_revision' || error.code === 'revision_required')) {
        setIssue('The pack changed. Your draft is still here. Reload the saved footer to review the current values.')
      }
      toast(reasonText(error), false)
      return false
    } finally {
      setBusy(false)
    }
  }

  const trimmedIcon = iconDraft.trim()
  const iconDirty = trimmedIcon !== (packIcon ?? '')

  return (
    <Card className="overflow-hidden p-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full min-w-0 cursor-pointer items-center gap-3 border-0 bg-transparent px-4 py-3 text-left focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
      >
        <ChevronRight
          aria-hidden
          className={cn(
            'size-4 shrink-0 text-faint transition-transform duration-150',
            open && 'rotate-90 text-accent'
          )}
        />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-2">
            <b className="truncate font-serif text-[1.05rem] font-medium">{pack.displayName}</b>
            <span className="shrink-0 font-mono text-[0.68rem] text-muted">{pack.id}</span>
            <Badge tone={readOnly ? 'off' : 'accent'}>{readOnly ? 'built in · read only' : 'data pack'}</Badge>
          </span>
        </span>
        <span className="hidden shrink-0 font-mono text-[0.68rem] text-faint sm:inline">
          {overrideCount === 0 ? 'all defaults' : `${overrideCount} set in pack`}
        </span>
      </button>

      {open && (
        <div className="border-t border-line">
          {issue && (
            <div role="alert">
              <p>{issue}</p>
              <Button variant="outline" size="sm" onClick={() => setReload((n) => n + 1)}>
                Reload footer and discard draft
              </Button>
            </div>
          )}
          <div className="flex flex-col gap-2 border-b border-line-2 px-4 py-4">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="font-mono text-[0.68rem] font-medium tracking-[0.14em] text-muted uppercase">
                Footer icon
              </span>
              <span className={cn('text-[0.75rem]', packIcon !== undefined ? 'text-accent' : 'text-faint')}>
                {packIcon !== undefined ? 'set in pack' : 'default'}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={iconDraft}
                readOnly={readOnly}
                disabled={readOnly || locked}
                placeholder="🛠️"
                aria-label={`${pack.id} footer icon`}
                autoComplete="off"
                className="w-24"
                onChange={(e) => setIconDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !readOnly && iconDirty && trimmedIcon !== '') {
                    e.preventDefault()
                    void savePatch({ icon: trimmedIcon }, 'Saved footer icon.')
                  }
                }}
              />
              {!readOnly && (
                <Button
                  size="sm"
                  disabled={busy || !iconDirty || trimmedIcon === ''}
                  onClick={() => void savePatch({ icon: trimmedIcon }, 'Saved footer icon.')}
                >
                  Save
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                disabled={readOnly || locked || packIcon === undefined}
                onClick={() => void savePatch({ icon: null }, 'Cleared footer icon.')}
              >
                Clear
              </Button>
              <p className="m-0 min-w-0 flex-1 basis-56 text-[0.8rem] text-faint">
                A chat’s <span className="font-mono text-[0.74rem] text-muted">footerEmoji</span> wins over this icon.
                {boundChats.length > 0 ? ' Chats using this pack: ' : ' No chats use this pack yet.'}
                {boundChats.map((chat, index) => {
                  const chatName = chat.label || midTrunc(chat.waId, 24)
                  const override = chat.settings['footerEmoji']?.value
                  return (
                    <span key={chat.chatId}>
                      {index > 0 ? ', ' : ''}
                      <a
                        href={`#chat-${chat.chatId}`}
                        onClick={(e) => {
                          e.preventDefault()
                          onOpenChat(chat.chatId)
                        }}
                        className="text-accent underline underline-offset-2 hover:no-underline"
                      >
                        {chatName}
                        {typeof override === 'string' ? ` (${override})` : ''}
                      </a>
                    </span>
                  )
                })}
                {boundChats.length > 0 ? '.' : ''}
              </p>
            </div>
          </div>

          <div className="px-4 py-2">
            {footerKinds.map((entry) => (
              <FooterLabelRow
                key={pack.id + reload + entry.kind}
                packId={pack.id}
                kind={entry.kind}
                defaultLabel={entry.defaultLabel}
                packValue={shownFooter?.labels?.[entry.kind]}
                readOnly={readOnly}
                busy={locked}
                onSave={(kind, value) =>
                  savePatch(
                    { labels: { [kind]: value } },
                    value === null ? 'Cleared footer label.' : 'Saved footer label.'
                  )
                }
              />
            ))}
          </div>
        </div>
      )}
    </Card>
  )
}

function PersonaFooter({
  characters,
  footerKinds,
  chats,
  loading,
  error,
  onChanged,
  onOpenChat
}: {
  characters: CoreCharacter[]
  footerKinds: FooterKindInfo[]
  chats: CoreChat[]
  loading: boolean
  error?: string
  onChanged: () => void
  onOpenChat: (chatId: string) => void
}) {
  const ordered = useMemo(
    () =>
      [...characters].sort((a, b) => (a.source === b.source ? a.id.localeCompare(b.id) : a.source === 'data' ? -1 : 1)),
    [characters]
  )

  return (
    <Section title="Tool footer">
      {loading && characters.length === 0 ? (
        <div className="flex items-center gap-2 text-muted">
          <Spinner /> loading…
        </div>
      ) : error ? (
        <Empty>{error}</Empty>
      ) : ordered.length === 0 ? (
        <Empty>No character pack is loaded.</Empty>
      ) : (
        <div className="flex flex-col gap-4">
          {ordered.map((pack) => (
            <PackFooterPanel
              key={pack.id}
              pack={pack}
              footerKinds={footerKinds}
              chats={chats}
              onChanged={onChanged}
              onOpenChat={onOpenChat}
            />
          ))}
        </div>
      )}
    </Section>
  )
}

export default function ChatsPage({
  selectedId,

  footerId
}: { selectedId?: string; footerId?: string } = {}) {
  const chats = useCore(core.chats)
  const packs = useCore(core.characters)
  const tools = useCore(core.tools)
  const all = chats.data?.chats ?? []
  const on = useMemo(() => all.filter((c) => c.status === 'active'), [all])
  const off = useMemo(() => all.filter((c) => c.status === 'pending'), [all])
  const characters = packs.data?.characters ?? []
  const footerKinds = packs.data?.footerKinds ?? []
  const [openId, setOpenId] = useState<string | null>(null)
  const [focusRequest, setFocusRequest] = useState<{ chatId: string; tab: SectionKey; seq: number } | null>(null)
  const openChatFooter = useCallback((chatId: string) => {
    setOpenId(chatId)
    setFocusRequest((prev) => ({ chatId, tab: 'reply', seq: (prev?.seq ?? 0) + 1 }))
  }, [])
  const shared = {
    toolCatalog: tools,
    characters,
    charactersError: packs.error,
    onChanged: chats.reload,
    openId,
    setOpenId,
    focusRequest
  }

  if (footerId) {
    const pack = characters.find((row) => row.id === footerId)
    if (!pack && packs.loading) return <Loading>Loading character…</Loading>
    if (!pack)
      return (
        <p role="status">
          {packs.loading ? 'Loading…' : packs.error ? 'Character unavailable.' : 'Character no longer exists.'}
        </p>
      )
    return (
      <>
        <a href={dashboardHref('characters')}>Character Studio</a>
        <h2>{pack.displayName} tool footer</h2>
        <PackFooterPanel
          pack={pack}
          footerKinds={footerKinds}
          chats={all}
          onChanged={packs.reload}
          onOpenChat={(id) => {
            location.href = dashboardHref('chats/' + encodeURIComponent(id) + '/settings')
          }}
        />
        <Toaster />
      </>
    )
  }
  if (selectedId) {
    const chat = all.find((row) => row.chatId === selectedId)
    if (!chat && chats.loading) return <Loading>Loading chat settings…</Loading>
    if (!chat)
      return (
        <p role="status">
          {chats.loading ? 'Loading…' : chats.error ? 'Chat settings unavailable.' : 'Chat no longer exists.'}
        </p>
      )

    return (
      <section className="chat-detail">
        <nav aria-label="Breadcrumb" className="studio-crumb">
          <a href={chatHref('chats')}>Chat Directory</a>
          <span aria-hidden="true"> · </span>
          <span>{chat.label || 'Unnamed Chat'}</span>
        </nav>
        <div className="workspace-heading">
          <h1>Chat Settings</h1>
        </div>
        <ChatRow
          chat={chat}
          characters={characters}
          charactersError={packs.error}
          toolCatalog={tools}
          onChanged={chats.reload}
          open={true}
        />
        <Toaster />
      </section>
    )
  }
  return (
    <Shell
      page="chats"
      title="Chats"
      hero={
        all.length
          ? [{ n: all.length }, { t: all.length === 1 ? ' chat. ' : ' chats. ' }, { n: on.length }, { t: ' on.' }]
          : [{ t: chats.error ? 'Chat list unavailable' : chats.loading ? 'Loading chats…' : 'No chats yet' }]
      }
    >
      <Section title="Chats">
        {chats.error && chats.data && (
          <p role="alert">Could not refresh the chat list. Showing the last loaded values.</p>
        )}
        {chats.loading && !chats.data ? (
          <div className="flex items-center gap-2 text-muted">
            <Spinner /> loading…
          </div>
        ) : chats.error && !chats.data ? (
          <Empty>{chats.error}</Empty>
        ) : !all.length ? (
          <Empty>A chat appears here after its first message. It starts off until it is switched on here.</Empty>
        ) : (
          <div className="flex flex-col gap-6">
            <Group title="On" note={`${on.length} answered`} chats={on} {...shared} />
            <Group title="Off" note={`${off.length} not answered until switched on`} chats={off} {...shared} />
          </div>
        )}
        {tools.error && <p className="mt-4 text-[0.8rem] text-down">Tool call modes unavailable: {tools.error}</p>}
        {packs.data?.faults.length ? (
          <p className="mt-4 text-[0.8rem] text-down">
            {packs.data.faults.length} character pack{packs.data.faults.length === 1 ? '' : 's'} did not load:{' '}
            {packs.data.faults.map((f) => f.id).join(', ')}.
          </p>
        ) : null}
      </Section>
      <PersonaFooter
        characters={characters}
        footerKinds={footerKinds}
        chats={all}
        loading={packs.loading}
        error={packs.error}
        onChanged={packs.reload}
        onOpenChat={openChatFooter}
      />
      <Toaster />
    </Shell>
  )
}
