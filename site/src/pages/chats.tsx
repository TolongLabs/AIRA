import * as Tooltip from '@radix-ui/react-tooltip'
import { ChevronRight, X } from 'lucide-react'
import { Fragment, type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { Shell } from '@/components/shell'
import { Badge, Button, Card, Empty, Field, Input, Picker, Section, Segmented, Spinner, Toggle } from '@/components/ui'
import {
  type CoreCharacter,
  type CoreChat,
  type CoreToolCatalog,
  type CoreToolFeature,
  type FooterKindInfo,
  type Resolved,
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
      (error: unknown) => live && setState({ error: reasonText(error), loading: false })
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
  { key: 'access', label: 'Access' }
] as const
type SectionKey = (typeof SECTIONS)[number]['key']

const FEATURES: { key: string; label: string; hint: string }[] = [
  { key: 'features.reminders', label: 'Reminders', hint: 'Off: /remind and set-reminder tools are not offered.' },
  { key: 'features.search', label: 'Web search', hint: 'Off: no search or page reading.' },
  { key: 'features.social', label: 'Social posts', hint: 'Off: links to posts are not read.' },
  { key: 'features.photos', label: 'Photos', hint: 'Off: no photo is sent.' },
  { key: 'features.media', label: 'Media watching', hint: 'Off: pictures, audio and video are not read.' },
  {
    key: 'features.think',
    label: 'Deeper thinking',
    hint: 'Off: /think is removed and the turn runs at normal effort.'
  },
  { key: 'features.reports', label: 'Reports', hint: 'Off: /doc is not offered.' },
  { key: 'features.proactive', label: 'Messages first', hint: 'Off: replies only when written to.' },
  { key: 'features.voice', label: 'Voice notes', hint: 'Off: replies are text.' },
  {
    key: 'features.autofetch',
    label: 'Post media',
    hint: "Groups only. On: a post link gets the post's photos or video back, unasked."
  },
  { key: 'features.lessons', label: 'Lessons', hint: 'Off: songs, words and the library are not offered.' },
  {
    key: 'features.owner',
    label: 'Owner tools',
    hint: "Markets and Claude Code sessions. For the owner's own chats."
  }
]

function SocialPlatforms({
  catalog,
  feature,
  chat,
  disabled,
  save,
  clear
}: {
  catalog: Load<CoreToolCatalog>
  feature: SocialCapabilityKey
  chat: CoreChat
  disabled: boolean
  save: (key: string, value: boolean) => void
  clear: (key: string) => void
}) {
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
            if (id === 'youtube' && disabled && valueOf(chat, 'features.media', true)) {
              hint.push('Media watching still uses this setting for YouTube links.')
            }
            return (
              <div
                key={id}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-line-2 py-2 last:border-b-0"
              >
                <Toggle
                  checked={valueOf(chat, key, true)}
                  disabled={disabled}
                  onChange={(on) => save(key, on)}
                  label={name}
                  hint={hint.join(' · ')}
                />
                {level === 'chat' && (
                  <Button size="sm" variant="ghost" disabled={disabled} onClick={() => clear(key)}>
                    Use inherited
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
            className="z-50 max-w-[min(18rem,calc(100vw-24px))] rounded-card border border-line bg-card px-3 py-2 text-[0.82rem] leading-relaxed text-ink shadow-float"
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
  chat,
  name,
  label,
  hint,
  children,
  onClear
}: {
  chat: CoreChat
  name: string
  label: string
  hint?: string
  children: ReactNode
  onClear: (key: string) => void
}) {
  const level = chat.settings[name]?.level ?? 'unset'
  return (
    <div className="flex flex-col gap-2 border-b border-line-2 py-4 last:border-b-0">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono text-[0.68rem] font-medium tracking-[0.14em] text-muted uppercase">{label}</span>
        <span className={cn('text-[0.75rem]', level === 'chat' ? 'text-accent' : 'text-faint')}>
          {sourceText(level, chat.type)}
        </span>
        {level === 'chat' && (
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => onClear(name)}>
            Use inherited
          </Button>
        )}
      </div>
      {children}
      {hint && <p className="m-0 text-[0.8rem] text-faint">{hint}</p>}
    </div>
  )
}

function valueOf<T>(chat: CoreChat, key: string, fallback: T): T {
  const resolved: Resolved | undefined = chat.settings[key]
  return resolved && resolved.value !== undefined ? (resolved.value as T) : fallback
}

function QuietHours({ chat, onSave }: { chat: CoreChat; onSave: (value: unknown) => void }) {
  const current = valueOf<{ start: string; end: string; timeZone: string } | undefined>(chat, 'quietHours', undefined)
  const [start, setStart] = useState(current?.start ?? '23:00')
  const [end, setEnd] = useState(current?.end ?? '07:00')
  const [zone, setZone] = useState(current?.timeZone ?? 'Asia/Kuala_Lumpur')
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="From">
          <Input type="time" value={start} onChange={(e) => setStart(e.target.value)} />
        </Field>
        <Field label="Until">
          <Input type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
        </Field>
        <Field label="Time zone">
          <Input
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

function LanguageField({ chat, onSave }: { chat: CoreChat; onSave: (value: unknown) => void }) {
  const [text, setText] = useState(valueOf(chat, 'language', 'auto'))
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

function characterNames(pack: CoreCharacter | undefined): string[] {
  if (!pack) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const candidate of [pack.displayName, ...(pack.aliases ?? [])]) {
    const key = candidate.toLowerCase()
    if (candidate.trim() === '' || seen.has(key)) continue
    seen.add(key)
    out.push(candidate)
  }
  return out
}

function NameCallField({
  chat,
  pack,
  characterId,
  busy,
  onSave,
  onClear
}: {
  chat: CoreChat
  pack: CoreCharacter | undefined
  characterId: string | undefined
  busy: boolean
  onSave: (key: string, value: unknown) => Promise<boolean>
  onClear: (key: string) => Promise<boolean>
}) {
  const enabled = valueOf(chat, 'nameCall', false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [sample, setSample] = useState('')

  const namesEntry = chat.settings['nameCall.names']
  const namesLevel = namesEntry?.level ?? 'unset'
  const overridden = namesLevel === 'chat'
  const customNames =
    overridden && Array.isArray(namesEntry?.value)
      ? namesEntry.value.filter((item): item is string => typeof item === 'string')
      : []
  const inheritedNames =
    (namesLevel === 'type' || namesLevel === 'global') && Array.isArray(namesEntry?.value)
      ? namesEntry.value.filter((item): item is string => typeof item === 'string')
      : characterNames(pack)
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
                  Use inherited
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

function FooterEmojiField({ chat, onSave }: { chat: CoreChat; onSave: (value: unknown) => void }) {
  const current = valueOf<string | undefined>(chat, 'footerEmoji', undefined)
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

function ChatRow({
  chat,
  characters,
  toolCatalog,
  onChanged,
  open,
  onToggle,
  focusRequest
}: {
  chat: CoreChat
  toolCatalog: Load<CoreToolCatalog>
  characters: CoreCharacter[]
  onChanged: () => void
  /** Kept by the page, so a chat that moves between On and Off stays open. */
  open: boolean
  onToggle: () => void
  focusRequest?: { chatId: string; tab: SectionKey; seq: number } | null
}) {
  const toolFeatures = toolCatalog.data?.features ?? []
  const [tab, setTab] = useState<SectionKey>('character')
  const [busy, setBusy] = useState(false)
  const name = chat.label || midTrunc(chat.waId, 28)
  const character = valueOf<string | undefined>(chat, 'character', undefined)
  const pack = characters.find((c) => c.id === character)

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
    run(() => core.setSetting('chat', chat.chatId, key, value), 'Saved for this chat.')
  const clear = (key: string) =>
    run(() => core.setSetting('chat', chat.chatId, key, null), 'This chat now inherits it.')

  const facts = [
    pack?.displayName ?? (character ? `${character} (not loaded)` : 'no character'),
    valueOf(chat, 'language', 'auto')
  ]

  return (
    <div id={`chat-${chat.chatId}`} className="border-b border-line last:border-b-0">
      <button
        type="button"
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

      {open && (
        <div className="border-t border-line">
          <div className="border-b border-line-2 px-4 py-4">
            <Toggle
              checked={chat.status === 'active'}
              disabled={busy}
              onChange={(on) =>
                run(
                  () => core.setStatus(chat.chatId, on ? 'active' : 'pending'),
                  on ? 'Replies are on for this chat.' : 'Replies are off for this chat.'
                )
              }
              label="Replies in this chat"
              hint="Off: messages are kept, and no reply is sent."
            />
          </div>
          <div className="flex flex-col sm:flex-row">
            <div
              role="tablist"
              aria-label={`configure ${name}`}
              className={cn(
                'flex shrink-0 gap-1 overflow-x-auto border-b border-line p-3',
                'sm:w-[11rem] sm:flex-col sm:overflow-visible sm:border-r sm:border-b-0 sm:py-4'
              )}
            >
              {SECTIONS.map((s) => {
                const on = s.key === tab
                return (
                  <button
                    key={s.key}
                    type="button"
                    role="tab"
                    aria-selected={on}
                    onClick={() => setTab(s.key)}
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
            <div role="tabpanel" className="min-w-0 flex-1 px-4 sm:px-6">
              {tab === 'character' && (
                <>
                  <SettingRow chat={chat} name="character" label="Character" onClear={clear}>
                    {characters.length ? (
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
                    ) : (
                      <Empty>No character pack is loaded.</Empty>
                    )}
                  </SettingRow>
                  <SettingRow
                    chat={chat}
                    name="language"
                    label="Language"
                    hint="auto answers in the language written to. Or a code such as ms, en or zh."
                    onClear={clear}
                  >
                    <LanguageField
                      key={String(valueOf(chat, 'language', 'auto'))}
                      chat={chat}
                      onSave={(v) => save('language', v)}
                    />
                  </SettingRow>
                </>
              )}
              {tab === 'reply' && (
                <>
                  <SettingRow chat={chat} name="replyLength" label="Reply length" onClear={clear}>
                    <Segmented
                      options={['short', 'default', 'long'] as const}
                      value={valueOf(chat, 'replyLength', 'default')}
                      onChange={(v) => save('replyLength', v)}
                      labels={{ short: 'Short', default: 'Default', long: 'Long' }}
                    />
                  </SettingRow>
                  <SettingRow chat={chat} name="expressions" label="Expressions" onClear={clear}>
                    <Toggle
                      checked={valueOf(chat, 'expressions', true)}
                      disabled={busy}
                      onChange={(v) => save('expressions', v)}
                      label="Send a sticker with replies"
                      hint="Off: text only."
                    />
                  </SettingRow>
                  <SettingRow chat={chat} name="features.toolFooter" label="Tool footer" onClear={clear}>
                    <Toggle
                      checked={valueOf(chat, 'features.toolFooter', true)}
                      disabled={busy}
                      onChange={(v) => save('features.toolFooter', v)}
                      label="Say which tools a reply used, and its sources"
                      hint="A small line at the end of a reply that searched, read or saved something."
                    />
                  </SettingRow>
                  {valueOf(chat, 'features.toolFooter', true) && (
                    <SettingRow chat={chat} name="footerEmoji" label="Footer emoji" onClear={clear}>
                      <FooterEmojiField chat={chat} onSave={(v) => save('footerEmoji', v)} />
                    </SettingRow>
                  )}
                  {chat.type === 'group' && (
                    <>
                      <SettingRow chat={chat} name="freeResponse" label="Free response" onClear={clear}>
                        <Toggle
                          checked={valueOf(chat, 'freeResponse', false)}
                          disabled={busy}
                          onChange={(v) => save('freeResponse', v)}
                          label="Answer any message in this group"
                          hint="Off: answers a mention or a reply only."
                        />
                      </SettingRow>
                      <SettingRow chat={chat} name="nameCall" label="Name call" onClear={clear}>
                        <NameCallField
                          chat={chat}
                          pack={pack}
                          characterId={character}
                          busy={busy}
                          onSave={save}
                          onClear={clear}
                        />
                      </SettingRow>
                    </>
                  )}
                  <SettingRow chat={chat} name="features.context" label="Live context" onClear={clear}>
                    <Toggle
                      checked={valueOf(chat, 'features.context', true)}
                      disabled={busy}
                      onChange={(v) => save('features.context', v)}
                      label="Replay earlier messages as context"
                      hint="Off: AIRA sees only the message she is answering. Messages are still logged."
                    />
                  </SettingRow>
                  <SettingRow
                    chat={chat}
                    name="context.maxMessages"
                    label="Context size"
                    hint={
                      valueOf(chat, 'features.context', true)
                        ? 'Recent chat-log messages replayed per turn (0 to 100).'
                        : 'Applies when Live context is on (0 to 100).'
                    }
                    onClear={clear}
                  >
                    <NumberSettingField
                      key={`${chat.settings['context.maxMessages']?.level ?? 'unset'}:${valueOf(chat, 'context.maxMessages', 40)}`}
                      value={valueOf(chat, 'context.maxMessages', 40)}
                      min={0}
                      max={100}
                      unit="messages"
                      label="Context size"
                      busy={busy}
                      onSave={(v) => save('context.maxMessages', v)}
                    />
                  </SettingRow>
                  <SettingRow chat={chat} name="features.memory" label="Memory" onClear={clear}>
                    <Toggle
                      checked={valueOf(chat, 'features.memory', true)}
                      disabled={busy}
                      onChange={(v) => save('features.memory', v)}
                      label="Learn and recall facts in this chat"
                      hint="Off: AIRA learns nothing new and recalls nothing here. Stored facts are kept."
                    />
                  </SettingRow>
                  <SettingRow
                    chat={chat}
                    name="memory.pageMessages"
                    label="Memory page"
                    hint="Messages that close a memory episode (5 to 50)."
                    onClear={clear}
                  >
                    <NumberSettingField
                      key={`${chat.settings['memory.pageMessages']?.level ?? 'unset'}:${valueOf(chat, 'memory.pageMessages', 25)}`}
                      value={valueOf(chat, 'memory.pageMessages', 25)}
                      min={5}
                      max={50}
                      unit="messages"
                      label="Memory page"
                      busy={busy}
                      onSave={(v) => save('memory.pageMessages', v)}
                    />
                  </SettingRow>
                  <SettingRow chat={chat} name="reactions" label="Reactions" onClear={clear}>
                    <Toggle
                      checked={valueOf(chat, 'reactions', false)}
                      disabled={busy}
                      onChange={(v) => save('reactions', v)}
                      label="React to members' messages with an emoji"
                    />
                  </SettingRow>
                  {valueOf(chat, 'reactions', false) &&
                    (() => {
                      const chance = valueOf(chat, 'reactions.chance', 33)
                      const preset = REACTION_CHANCES.includes(String(chance) as ReactionChancePreset)
                        ? (String(chance) as ReactionChancePreset)
                        : null
                      return (
                        <SettingRow
                          chat={chat}
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
                            onChange={(v) => {
                              if (!busy) void save('reactions.chance', Number(v))
                            }}
                            className={cn(
                              'max-w-full [&_button]:min-h-[44px]',
                              busy && 'pointer-events-none opacity-55'
                            )}
                          />
                        </SettingRow>
                      )
                    })()}
                  <SettingRow
                    chat={chat}
                    name="commands.maxPerMessage"
                    label="Commands per message"
                    hint="How many slash commands one message may run."
                    onClear={clear}
                  >
                    <Segmented
                      options={['1', '2', '3', '4', '5'] as const}
                      value={String(valueOf(chat, 'commands.maxPerMessage', 1)) as '1' | '2' | '3' | '4' | '5'}
                      onChange={(v) => save('commands.maxPerMessage', Number(v))}
                    />
                  </SettingRow>
                  <SettingRow
                    chat={chat}
                    name="tools.maxPerMessage"
                    label="Tools per message"
                    hint="Tool calls one reply may make"
                    onClear={clear}
                  >
                    <Segmented
                      options={['1', '2', '3', '4', '5', '6', '7', '8'] as const}
                      value={
                        String(valueOf(chat, 'tools.maxPerMessage', 3)) as '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8'
                      }
                      onChange={(v) => save('tools.maxPerMessage', Number(v))}
                    />
                  </SettingRow>
                </>
              )}
              {tab === 'features' &&
                FEATURES.map((f) => {
                  const groupMedia = f.key === 'features.autofetch'
                  const socialKey = groupMedia || f.key === 'features.social' ? (f.key as SocialCapabilityKey) : null
                  const inapplicable = groupMedia && chat.type === 'dm'
                  return (
                    <Fragment key={f.key}>
                      <SettingRow chat={chat} name={f.key} label={f.label} onClear={clear}>
                        <div className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-1">
                          <div className="min-w-0 flex-1 basis-48">
                            <Toggle
                              checked={valueOf(chat, f.key, false)}
                              disabled={busy || inapplicable}
                              onChange={(v) => save(f.key, v)}
                              label={f.label}
                              hint={inapplicable ? 'Available in groups only.' : f.hint}
                            />
                            {groupMedia && !inapplicable && (
                              <p className="mt-2 mb-0 text-[0.8rem] text-faint">
                                YouTube, including Shorts, is excluded.
                                {chat.status !== 'active'
                                  ? ' This group is off.'
                                  : valueOf(chat, 'muted', false)
                                    ? ' This group is muted.'
                                    : ''}
                              </p>
                            )}
                            {socialKey && !inapplicable && (
                              <SocialPlatforms
                                catalog={toolCatalog}
                                feature={socialKey}
                                chat={chat}
                                disabled={busy || !valueOf(chat, f.key, false)}
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
                          chat={chat}
                          name="report.defaultFormat"
                          label="Default document format"
                          hint="Format for /doc when a message names none."
                          onClear={clear}
                        >
                          <Segmented
                            options={['pdf', 'markdown'] as const}
                            labels={{ pdf: 'PDF', markdown: 'Markdown' }}
                            value={valueOf<'pdf' | 'markdown'>(chat, 'report.defaultFormat', 'pdf')}
                            onChange={(v) => {
                              if (!busy) void save('report.defaultFormat', v)
                            }}
                            className={cn(busy && 'pointer-events-none opacity-55')}
                          />
                        </SettingRow>
                      )}
                    </Fragment>
                  )
                })}
              {tab === 'quiet' && (
                <SettingRow
                  chat={chat}
                  name="quietHours"
                  label="Quiet hours"
                  hint="No scheduled or first message is sent in this window. Replies still go out."
                  onClear={clear}
                >
                  <QuietHours
                    key={JSON.stringify(chat.settings['quietHours']?.value ?? null)}
                    chat={chat}
                    onSave={(v) => save('quietHours', v)}
                  />
                </SettingRow>
              )}
              {tab === 'access' && (
                <>
                  <SettingRow chat={chat} name="allowedSenders" label="Who may write" onClear={clear}>
                    <p className="m-0 text-[0.95rem]">
                      {(() => {
                        const v = valueOf<'all' | string[]>(chat, 'allowedSenders', 'all')
                        return v === 'all' ? 'Everyone in this chat.' : `${v.length} listed senders.`
                      })()}
                    </p>
                  </SettingRow>
                  <SettingRow chat={chat} name="muted" label="Muted" onClear={clear}>
                    <p className="m-0 text-[0.95rem]">
                      {valueOf<unknown>(chat, 'muted', false) === false
                        ? 'Not muted.'
                        : 'Muted by a member with /mute.'}
                    </p>
                  </SettingRow>
                  <SettingRow chat={chat} name="model" label="Model" onClear={clear}>
                    <p className="m-0 text-[0.95rem]">
                      {valueOf<unknown>(chat, 'model', 'inherit') === 'inherit'
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
  const packIcon = pack.toolFooter?.icon
  const [iconDraft, setIconDraft] = useState(packIcon ?? '')

  useEffect(() => {
    setIconDraft(packIcon ?? '')
  }, [packIcon])

  const boundChats = useMemo(
    () => chats.filter((c) => valueOf<string | undefined>(c, 'character', undefined) === pack.id),
    [chats, pack.id]
  )

  const overrideCount = (packIcon !== undefined ? 1 : 0) + Object.keys(pack.toolFooter?.labels ?? {}).length

  async function savePatch(patch: { icon?: string | null; labels?: Record<string, string | null> }, msg: string) {
    setBusy(true)
    try {
      const res = await core.setFooter(pack.id, patch)
      toast(res.changed ? msg : 'Nothing changed.')
      onChanged()
      return true
    } catch (error) {
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
                disabled={readOnly || busy}
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
                disabled={readOnly || busy || packIcon === undefined}
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
                key={entry.kind}
                packId={pack.id}
                kind={entry.kind}
                defaultLabel={entry.defaultLabel}
                packValue={pack.toolFooter?.labels?.[entry.kind]}
                readOnly={readOnly}
                busy={busy}
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

export default function ChatsPage() {
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
    onChanged: chats.reload,
    openId,
    setOpenId,
    focusRequest
  }

  return (
    <Shell
      page="chats"
      title="Chats"
      hero={
        all.length
          ? [{ n: all.length }, { t: all.length === 1 ? ' chat. ' : ' chats. ' }, { n: on.length }, { t: ' on.' }]
          : [{ t: 'No chats yet' }]
      }
    >
      <Section title="Chats">
        {chats.loading && !chats.data ? (
          <div className="flex items-center gap-2 text-muted">
            <Spinner /> loading…
          </div>
        ) : chats.error ? (
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
