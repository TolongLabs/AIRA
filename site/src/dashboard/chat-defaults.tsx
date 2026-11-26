import { TimeField } from '@/dashboard/form-select'
import { Loading } from '@/dashboard/loading'
import { useContext, useEffect, useRef, useState } from 'react'
import { Button, Card, Empty, Field, Input, Picker, Section, Segmented, Toggle } from '@/components/ui'
import { dashboardHref } from '@/dashboard/navigation'
import { authHeaders, requestToken } from '@/lib/api'
import { CHAT_FEATURE_DEFINITIONS, personaChoices, standaloneChatFeature } from '@/lib/chat-view-model'
import { CoreError, core, reasonText, type CoreCharacter, type CoreChat, type Resolved } from '@/lib/core'
import { toast, Toaster } from '@/lib/hooks'
import { cn } from '@/lib/utils'
import { InstallationContext } from './context'
import { useReportDocumentCapability } from './report-capability'
import './chat-defaults.css'

/* Shared defaults: one page for the global level and the DM and group type
   levels (docs/trd/data.md#settings-hierarchy, PRD FR-8).
   A save here changes every chat that does not override the key nearer to
   itself; clearing a row restores inheritance. Reads go to
   /owner-api/core/settings with the owner token (same 401 retry as the
   dashboard transport); writes go through core.setSetting, which always
   carries the scope revision the server requires of dashboard callers. */

export type DefaultsScope = 'global' | 'dm' | 'group'

export interface ChatDefaultsProps {
  /** Which level the page opens on. Defaults to the global level. */
  initialScope?: DefaultsScope
}

interface ScopeDesc {
  key: DefaultsScope
  level: 'global' | 'type'
  scope: string
  title: string
  impact: string
}

const SCOPES: ScopeDesc[] = [
  {
    key: 'global',
    level: 'global',
    scope: '',
    title: 'Global',
    impact: 'A value saved here applies to every DM and group that does not override it at the type or chat level.'
  },
  {
    key: 'group',
    level: 'type',
    scope: 'group',
    title: 'Group defaults',
    impact: 'A value saved here applies to every group that does not set its own chat value. It beats the global level.'
  },
  {
    key: 'dm',
    level: 'type',
    scope: 'dm',
    title: 'DM defaults',
    impact: 'A value saved here applies to every DM that does not set its own chat value. It beats the global level.'
  }
]

interface DefaultsSnapshot {
  revision: string
  values: Record<string, unknown>
  effective: Record<string, Resolved>
}

async function loadDefaults(level: string, scope: string): Promise<DefaultsSnapshot> {
  const query = new URLSearchParams({ level, scope })
  const go = () =>
    fetch(`/owner-api/core/settings?${query}`, { headers: { ...authHeaders({ accept: 'application/json' }) } })
  let res = await go()
  if (res.status === 401) {
    await requestToken()
    res = await go()
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) throw new CoreError(res.status, body.error ?? `http_${res.status}`)
  return body as DefaultsSnapshot
}

function useLoad<T>(fetcher: () => Promise<T>): {
  data: T | null
  error: string | null
  loading: boolean
  reload: () => void
} {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({
    data: null,
    error: null,
    loading: true
  })
  const [tick, setTick] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: tick is the reload signal
  useEffect(() => {
    let live = true
    setState((s) => ({ ...s, loading: true }))
    fetcher().then(
      (data) => live && setState({ data, error: null, loading: false }),
      (error: unknown) => live && setState((s) => ({ ...s, error: reasonText(error), loading: false }))
    )
    return () => {
      live = false
    }
  }, [tick])
  return { ...state, reload: () => setTick((n) => n + 1) }
}

/** Server-side defaults for the feature toggles (src/settings/keys.ts). */
const FEATURE_DEFAULTS: Record<string, boolean> = {
  'features.reminders': true,
  'features.search': true,
  'features.social': true,
  'features.photos': true,
  'features.media': true,
  'features.think': true,
  'features.feedback': false,
  'features.identify': false,
  'features.research': true,
  'features.reports': true,
  'features.proactive': false,
  'features.voice': false,
  'features.autofetch': false,
  'features.lessons': false,
  'features.owner': false
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function asInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) ? value : fallback
}

function oneOf<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return options.includes(value as T) ? (value as T) : fallback
}

function sourceLabel(setHere: boolean, level: Resolved['level']): string {
  if (setHere) return 'Set here'
  if (level === 'global') return 'From global'
  if (level === 'default') return 'Built-in default'
  return 'Not set'
}

/** Chats that would change if this key were saved at this scope. */
function impactFor(chats: CoreChat[], desc: ScopeDesc, key: string): { affected: number; overriding: number } {
  const eligible = desc.key === 'global' ? chats : chats.filter((chat) => chat.type === desc.key)
  let affected = 0
  for (const chat of eligible) {
    const level = chat.settings[key]?.level ?? 'unset'
    if (desc.key === 'global' ? level !== 'chat' && level !== 'type' : level !== 'chat') affected += 1
  }
  return { affected, overriding: eligible.length - affected }
}

const REACTION_CHANCES = ['10', '25', '33', '50', '75', '100'] as const
type ReactionChance = (typeof REACTION_CHANCES)[number]
const REACTION_CHANCE_LABELS: Record<ReactionChance, string> = {
  '10': '10%',
  '25': '25%',
  '33': '33%',
  '50': '50%',
  '75': '75%',
  '100': '100%'
}

const FOOTER_EMOJI = ['🛠️', '🧪', '🔬', '🔎', '✨', '🌸', '📎']

const TIME_FALLBACK = { start: '23:00', end: '07:00', timeZone: 'Asia/Kuala_Lumpur' }

/* ── rows ─────────────────────────────────────────────────────────────── */

function DefaultsRow({
  label,
  hint,
  setHere,
  level,
  affected,
  overriding,
  canClear,
  busy,
  onClear,
  children
}: {
  label: string
  hint?: string
  setHere: boolean
  level: Resolved['level']
  affected: number
  overriding: number
  canClear: boolean
  busy: boolean
  onClear?: () => void
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-2 border-b border-line-2 py-4 last:border-b-0">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono text-[0.68rem] font-medium tracking-[0.14em] text-muted uppercase">{label}</span>
        <span className={cn('text-[0.75rem]', setHere ? 'text-accent' : 'text-faint')}>
          {sourceLabel(setHere, level)}
        </span>
        <span className="text-[0.75rem] text-faint">
          {affected === 0 ? 'No chat uses this yet' : `${affected} chat${affected === 1 ? '' : 's'} use this`}
          {overriding > 0 ? ` · ${overriding} override${overriding === 1 ? 's' : ''} it` : ''}
        </span>
        {canClear && onClear && (
          <Button size="sm" variant="ghost" className="ml-auto" disabled={busy} onClick={onClear}>
            Use Defaults
          </Button>
        )}
      </div>
      {children}
      {hint && <p className="m-0 text-[0.8rem] text-faint">{hint}</p>}
    </div>
  )
}

function ToggleRow({
  current,
  label,
  hint,
  busy,
  onSave
}: {
  current: boolean
  label: string
  hint?: string
  busy: boolean
  onSave: (value: boolean) => void
}) {
  return <Toggle checked={current} disabled={busy} onChange={(v) => onSave(v)} label={label} hint={hint} />
}

function SegmentedRow<T extends string>({
  current,
  options,
  labels,
  busy,
  onSave,
  ariaLabel
}: {
  current: T
  options: readonly T[]
  labels?: Partial<Record<T, string>>
  busy: boolean
  onSave: (value: T) => void
  ariaLabel?: string
}) {
  return (
    <Segmented
      options={options}
      value={current}
      labels={labels}
      disabled={busy}
      onChange={(v) => onSave(v)}
      aria-label={ariaLabel}
    />
  )
}

function NumberRow({
  current,
  min,
  max,
  unit,
  label,
  busy,
  onSave
}: {
  current: number
  min: number
  max: number
  unit: string
  label: string
  busy: boolean
  onSave: (value: number) => Promise<boolean>
}) {
  const [draft, setDraft] = useState(String(current))
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

function LanguageRow({ current, busy, onSave }: { current: string; busy: boolean; onSave: (value: string) => void }) {
  const [text, setText] = useState(current)
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        value={text}
        disabled={busy}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && onSave(text.trim())}
        className="w-40"
        aria-label="language code"
        placeholder="auto"
        autoComplete="off"
        spellCheck={false}
      />
      <Button size="sm" disabled={busy} onClick={() => onSave(text.trim())}>
        Save language
      </Button>
    </div>
  )
}

function CharacterRow({
  current,
  characters,
  charactersError,
  busy,
  onSave
}: {
  current: string | undefined
  characters: CoreCharacter[]
  charactersError?: string
  busy: boolean
  onSave: (value: string) => void
}) {
  if (charactersError) return <Empty>Character list unavailable: {charactersError}</Empty>
  if (!characters.length) return <Empty>No character pack is loaded.</Empty>
  return (
    <Picker
      ariaLabel="character"
      options={personaChoices(characters, current).map((c) => ({
        value: c.id,
        label: c.displayName,
        hint: `${c.id} · ${c.source === 'data' ? 'uploaded' : 'built in'}`
      }))}
      value={current ?? null}
      placeholder="No character chosen"
      onChange={(id) => onSave(id)}
      disabled={busy}
    />
  )
}

function QuietHoursRow({
  current,
  busy,
  onSave
}: {
  current: { start: string; end: string; timeZone: string } | undefined
  busy: boolean
  onSave: (value: { start: string; end: string; timeZone: string }) => void
}) {
  const [start, setStart] = useState(current?.start ?? TIME_FALLBACK.start)
  const [end, setEnd] = useState(current?.end ?? TIME_FALLBACK.end)
  const [zone, setZone] = useState(current?.timeZone ?? TIME_FALLBACK.timeZone)
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="From">
          <TimeField label="From" value={start} disabled={busy} onChange={setStart} />
        </Field>
        <Field label="Until">
          <TimeField label="Until" value={end} disabled={busy} onChange={setEnd} />
        </Field>
        <Field label="Time zone">
          <Input
            aria-label="Time zone"
            value={zone}
            disabled={busy}
            onChange={(e) => setZone(e.target.value)}
            placeholder="Asia/Kuala_Lumpur"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
      </div>
      <div>
        <Button size="sm" disabled={busy} onClick={() => onSave({ start, end, timeZone: zone })}>
          Save quiet hours
        </Button>
      </div>
    </div>
  )
}

function FooterEmojiRow({
  current,
  busy,
  onSave
}: {
  current: string | undefined
  busy: boolean
  onSave: (value: string) => void
}) {
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
            disabled={busy}
            onClick={() => onSave(emoji)}
          >
            {emoji}
          </Button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && text.trim() && onSave(text.trim())}
          className="w-24"
          aria-label="custom footer emoji"
          placeholder="Other"
          autoComplete="off"
        />
        <Button size="sm" disabled={busy || !text.trim()} onClick={() => onSave(text.trim())}>
          Use this emoji
        </Button>
      </div>
    </div>
  )
}

/* ── form ─────────────────────────────────────────────────────────────── */

function DefaultsForm({
  desc,
  snapshot,
  characters,
  charactersError,
  chats,
  onSnapshot,
  onDiscard
}: {
  desc: ScopeDesc
  snapshot: DefaultsSnapshot
  characters: CoreCharacter[]
  charactersError?: string
  chats: CoreChat[]
  onSnapshot: (next: DefaultsSnapshot) => void
  onDiscard: () => void
}) {
  const standalone = useContext(InstallationContext) === 'standalone'
  const reportDocuments = useReportDocumentCapability(standalone)
  const [busy, setBusy] = useState(false)
  const [conflict, setConflict] = useState<{ key: string; value: unknown; revision: string } | null>(null)

  const effective = (key: string): Resolved | undefined => snapshot.effective[key]
  const valueOf = (key: string): unknown => effective(key)?.value
  const draftKey = (key: string) => JSON.stringify([effective(key)?.level, valueOf(key)])
  const setHere = (key: string): boolean => Object.hasOwn(snapshot.values, key)

  async function refresh(): Promise<DefaultsSnapshot> {
    const next = await loadDefaults(desc.level, desc.scope)
    onSnapshot(next)
    return next
  }

  const save = (key: string, value: unknown) => async (): Promise<boolean> => {
    setBusy(true)
    try {
      const result = await core.setSetting(desc.level, desc.scope, key, value, snapshot.revision)
      toast(
        value === null
          ? 'Cleared. The level above applies again.'
          : result.changed
            ? 'Saved for all eligible chats.'
            : 'Nothing changed.'
      )
      setConflict(null)
      await refresh()
      return true
    } catch (error) {
      if (error instanceof CoreError && error.code === 'stale_revision') {
        setConflict({ key, value, revision: snapshot.revision })
      }
      toast(reasonText(error), false)
      return false
    } finally {
      setBusy(false)
    }
  }
  const clear = (key: string) => () => save(key, null)()

  function row(key: string) {
    const entry = effective(key)
    const { affected, overriding } = impactFor(chats, desc, key)
    return {
      setHere: setHere(key),
      level: entry?.level ?? 'unset',
      affected,
      overriding,
      canClear: setHere(key)
    }
  }

  const replyLength = oneOf(valueOf('replyLength'), ['short', 'default', 'long'] as const, 'default')
  const reportFormat = oneOf(valueOf('report.defaultFormat'), ['pdf', 'markdown'] as const, 'pdf')
  const commandsMax = oneOf(
    String(asInt(valueOf('commands.maxPerMessage'), 1)) as '1' | '2' | '3' | '4' | '5',
    ['1', '2', '3', '4', '5'] as const,
    '1'
  )
  const toolsMax = oneOf(
    String(asInt(valueOf('tools.maxPerMessage'), 3)) as '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8',
    ['1', '2', '3', '4', '5', '6', '7', '8'] as const,
    '3'
  )
  const reactionsChance = asInt(valueOf('reactions.chance'), 33)
  const chancePreset = (REACTION_CHANCES as readonly string[]).includes(String(reactionsChance))
    ? (String(reactionsChance) as ReactionChance)
    : null
  const characterId = typeof valueOf('character') === 'string' ? (valueOf('character') as string) : undefined
  const footerEmoji = typeof valueOf('footerEmoji') === 'string' ? (valueOf('footerEmoji') as string) : undefined
  const quietHours = (valueOf('quietHours') ?? undefined) as
    { start: string; end: string; timeZone: string } | undefined
  const reactionsOn = asBool(valueOf('reactions'), false)
  const toolFooterOn = asBool(valueOf('features.toolFooter'), true)
  const groupScope = desc.key !== 'dm'

  return (
    <div>
      {conflict && (
        <Card role="alert" className="chat-defaults-conflict">
          <b>Settings changed in another session</b>
          <p>
            Your draft for <span className="font-mono">{conflict.key}</span>:{' '}
            {conflict.value === null ? 'Use Defaults' : JSON.stringify(conflict.value)}
          </p>
          {conflict.revision === snapshot.revision ? (
            <div className="chat-defaults-conflict-actions">
              <Button size="sm" disabled={busy} onClick={() => void refresh()}>
                Reload to compare
              </Button>
            </div>
          ) : (
            <p>
              Current value:{' '}
              {snapshot.effective[conflict.key]?.value === undefined
                ? 'not set'
                : JSON.stringify(snapshot.effective[conflict.key]?.value)}
            </p>
          )}
          <div className="chat-defaults-conflict-actions">
            {conflict.revision !== snapshot.revision && (
              <Button size="sm" disabled={busy} onClick={() => void save(conflict.key, conflict.value)()}>
                Apply my draft
              </Button>
            )}
            <Button size="sm" variant="ghost" disabled={busy} onClick={onDiscard}>
              Discard draft
            </Button>
          </div>
        </Card>
      )}

      <Section title="Character">
        <DefaultsRow
          label="Character"
          hint="The voice every eligible chat answers in."
          {...row('character')}
          busy={busy}
          onClear={clear('character')}
        >
          <CharacterRow
            current={characterId}
            characters={characters}
            charactersError={charactersError}
            busy={busy}
            onSave={(v) => void save('character', v)()}
          />
        </DefaultsRow>
        <DefaultsRow
          label="Language"
          hint="auto answers in the language written to. Or a code such as ms, en or zh."
          {...row('language')}
          busy={busy}
          onClear={clear('language')}
        >
          <LanguageRow
            key={draftKey('language')}
            current={typeof valueOf('language') === 'string' ? (valueOf('language') as string) : 'auto'}
            busy={busy}
            onSave={(v) => void save('language', v)()}
          />
        </DefaultsRow>
      </Section>

      <Section title="Reply">
        {standalone && (
          <p>
            {reportDocuments
              ? 'Standalone supports text and report documents.'
              : 'Standalone supports text replies only.'}{' '}
            Hermes owns group admission; stickers, reactions and scheduled messages are unavailable.
          </p>
        )}
        <DefaultsRow label="Reply length" {...row('replyLength')} busy={busy} onClear={clear('replyLength')}>
          <SegmentedRow
            current={replyLength}
            options={['short', 'default', 'long'] as const}
            labels={{ short: 'Short', default: 'Default', long: 'Long' }}
            busy={busy}
            onSave={(v) => void save('replyLength', v)()}
          />
        </DefaultsRow>
        {!standalone && (
          <DefaultsRow label="Expressions" {...row('expressions')} busy={busy} onClear={clear('expressions')}>
            <ToggleRow
              current={asBool(valueOf('expressions'), true)}
              label="Send a sticker with replies"
              hint="Off: text only."
              busy={busy}
              onSave={(v) => void save('expressions', v)()}
            />
          </DefaultsRow>
        )}
        <DefaultsRow
          label="Tool footer"
          {...row('features.toolFooter')}
          busy={busy}
          onClear={clear('features.toolFooter')}
        >
          <ToggleRow
            current={toolFooterOn}
            label="Say which tools a reply used, and its sources"
            hint="A small line at the end of a reply that searched, read or saved something."
            busy={busy}
            onSave={(v) => void save('features.toolFooter', v)()}
          />
        </DefaultsRow>
        {toolFooterOn && (
          <DefaultsRow label="Footer emoji" {...row('footerEmoji')} busy={busy} onClear={clear('footerEmoji')}>
            <FooterEmojiRow
              key={draftKey('footerEmoji')}
              current={footerEmoji}
              busy={busy}
              onSave={(v) => void save('footerEmoji', v)()}
            />
          </DefaultsRow>
        )}
        {!standalone && groupScope && (
          <>
            <DefaultsRow
              label="Free response"
              hint="Groups only: answer any message. Off: answers a mention or a reply only."
              {...row('freeResponse')}
              busy={busy}
              onClear={clear('freeResponse')}
            >
              <ToggleRow
                current={asBool(valueOf('freeResponse'), false)}
                label="Answer any message in the group"
                busy={busy}
                onSave={(v) => void save('freeResponse', v)()}
              />
            </DefaultsRow>
            <DefaultsRow
              label="Name call"
              hint="Groups only: answer a message that says the character's name. The names themselves stay on per-chat settings."
              {...row('nameCall')}
              busy={busy}
              onClear={clear('nameCall')}
            >
              <ToggleRow
                current={asBool(valueOf('nameCall'), false)}
                label="Answer a message that says the character's name"
                hint="Off: answers a mention, a reply or a command only."
                busy={busy}
                onSave={(v) => void save('nameCall', v)()}
              />
            </DefaultsRow>
          </>
        )}
      </Section>

      <Section title="Context and memory">
        <DefaultsRow label="Live context" {...row('features.context')} busy={busy} onClear={clear('features.context')}>
          <ToggleRow
            current={asBool(valueOf('features.context'), true)}
            label="Replay earlier messages as context"
            hint="Off: AIRA sees only the message she is answering. Messages are still logged."
            busy={busy}
            onSave={(v) => void save('features.context', v)()}
          />
        </DefaultsRow>
        <DefaultsRow
          label="Context size"
          hint="Recent chat-log messages replayed per turn (0 to 100)."
          {...row('context.maxMessages')}
          busy={busy}
          onClear={clear('context.maxMessages')}
        >
          <NumberRow
            key={draftKey('context.maxMessages')}
            current={asInt(valueOf('context.maxMessages'), 40)}
            min={0}
            max={100}
            unit="messages"
            label="Context size"
            busy={busy}
            onSave={(v) => save('context.maxMessages', v)()}
          />
        </DefaultsRow>
        <DefaultsRow label="Memory" {...row('features.memory')} busy={busy} onClear={clear('features.memory')}>
          <ToggleRow
            current={asBool(valueOf('features.memory'), true)}
            label={standalone ? 'Recall and save facts in this chat' : 'Learn and recall facts in this chat'}
            hint={
              standalone
                ? 'Automatic learning is unavailable. Explicit memory tools still work.'
                : 'Off: AIRA learns nothing new and recalls nothing here. Stored facts are kept.'
            }
            busy={busy}
            onSave={(v) => void save('features.memory', v)()}
          />
        </DefaultsRow>
        {!standalone && (
          <DefaultsRow
            label="Memory page"
            hint="Messages that close a memory episode (5 to 50)."
            {...row('memory.pageMessages')}
            busy={busy}
            onClear={clear('memory.pageMessages')}
          >
            <NumberRow
              key={draftKey('memory.pageMessages')}
              current={asInt(valueOf('memory.pageMessages'), 25)}
              min={5}
              max={50}
              unit="messages"
              label="Memory page"
              busy={busy}
              onSave={(v) => save('memory.pageMessages', v)()}
            />
          </DefaultsRow>
        )}
      </Section>

      <Section title="Limits">
        <DefaultsRow
          label="Commands per message"
          hint="How many slash commands one message may run."
          {...row('commands.maxPerMessage')}
          busy={busy}
          onClear={clear('commands.maxPerMessage')}
        >
          <SegmentedRow
            current={commandsMax}
            options={['1', '2', '3', '4', '5'] as const}
            busy={busy}
            onSave={(v) => void save('commands.maxPerMessage', Number(v))()}
          />
        </DefaultsRow>
        <DefaultsRow
          label="Tools per message"
          hint="Tool calls one reply may make."
          {...row('tools.maxPerMessage')}
          busy={busy}
          onClear={clear('tools.maxPerMessage')}
        >
          <SegmentedRow
            current={toolsMax}
            options={['1', '2', '3', '4', '5', '6', '7', '8'] as const}
            busy={busy}
            onSave={(v) => void save('tools.maxPerMessage', Number(v))()}
          />
        </DefaultsRow>
        {!standalone && (
          <DefaultsRow
            label="Default document format"
            hint="Format for /doc when a message names none."
            {...row('report.defaultFormat')}
            busy={busy}
            onClear={clear('report.defaultFormat')}
          >
            <SegmentedRow
              current={reportFormat}
              options={['pdf', 'markdown'] as const}
              labels={{ pdf: 'PDF', markdown: 'Markdown' }}
              busy={busy}
              onSave={(v) => void save('report.defaultFormat', v)()}
            />
          </DefaultsRow>
        )}
      </Section>

      {!standalone && (
        <Section title="Quiet hours">
          <DefaultsRow
            label="Quiet hours"
            hint="No scheduled or first message is sent in this window. Replies still go out."
            {...row('quietHours')}
            busy={busy}
            onClear={clear('quietHours')}
          >
            <QuietHoursRow
              key={draftKey('quietHours')}
              current={quietHours}
              busy={busy}
              onSave={(v) => void save('quietHours', v)()}
            />
          </DefaultsRow>
        </Section>
      )}

      {!standalone && (
        <Section title="Reactions">
          <DefaultsRow label="Reactions" {...row('reactions')} busy={busy} onClear={clear('reactions')}>
            <ToggleRow
              current={reactionsOn}
              label="React to members' messages with an emoji"
              busy={busy}
              onSave={(v) => void save('reactions', v)()}
            />
          </DefaultsRow>
          {reactionsOn && (
            <DefaultsRow
              label="Chance"
              hint={
                chancePreset === null
                  ? `Current value: ${reactionsChance}%. Pick a preset to change.`
                  : 'How often a matching message gets a reaction.'
              }
              {...row('reactions.chance')}
              busy={busy}
              onClear={clear('reactions.chance')}
            >
              <SegmentedRow
                current={chancePreset ?? '33'}
                options={REACTION_CHANCES}
                labels={REACTION_CHANCE_LABELS}
                busy={busy}
                onSave={(v) => void save('reactions.chance', Number(v))()}
              />
            </DefaultsRow>
          )}
        </Section>
      )}

      <Section title="Features">
        {CHAT_FEATURE_DEFINITIONS.filter((f) => !standalone || standaloneChatFeature(f.key, reportDocuments)).map(
          (f) => (
            <DefaultsRow key={f.key} label={f.label} {...row(f.key)} busy={busy} onClear={clear(f.key)}>
              <ToggleRow
                current={asBool(valueOf(f.key), FEATURE_DEFAULTS[f.key] ?? false)}
                label={f.label}
                hint={f.hint}
                busy={busy}
                onSave={(v) => void save(f.key, v)()}
              />
            </DefaultsRow>
          )
        )}
      </Section>
    </div>
  )
}

/* ── page ─────────────────────────────────────────────────────────────── */

export default function ChatDefaults({ initialScope = 'global' }: ChatDefaultsProps = {}) {
  const [scope, setScope] = useState<DefaultsScope>(initialScope)
  const scopeVersion = useRef(0)
  const currentVersion = scopeVersion.current
  const desc = SCOPES.find((s) => s.key === scope) ?? SCOPES[0]
  const [snapshot, setSnapshot] = useState<DefaultsSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [reloadTick, setReloadTick] = useState(0)
  const [formKey, setFormKey] = useState(0)
  const packs = useLoad(core.characters)
  const chats = useLoad(core.chats)

  useEffect(() => {
    let live = true
    setLoading(true)
    setError(null)
    loadDefaults(desc.level, desc.scope).then(
      (data) => {
        if (!live || scopeVersion.current !== currentVersion) return
        setSnapshot(data)
        setLoading(false)
      },
      (e: unknown) => {
        if (!live || scopeVersion.current !== currentVersion) return
        setSnapshot(null)
        setError(reasonText(e))
        setLoading(false)
      }
    )
    return () => {
      live = false
    }
  }, [desc, reloadTick, currentVersion])

  const all = chats.data?.chats ?? []
  const dms = all.filter((c) => c.type === 'dm').length
  const groups = all.filter((c) => c.type === 'group').length

  return (
    <section className="chat-defaults" aria-label="Chat defaults">
      <p className="chat-defaults-lede">
        {desc.impact} A nearer level keeps winning: group and DM defaults beat this global level, and a chat's own value
        beats them all.
      </p>
      <div className="chat-defaults-layout">
        <aside className="chat-defaults-scopes dashboard-pane" aria-label="Defaults level">
          <h2>Settings Hierarchy</h2>
          <Segmented
            options={['global', 'group', 'dm'] as const}
            labels={{ global: 'Global', group: 'Group defaults', dm: 'DM defaults' }}
            value={scope}
            onChange={(next) => {
              if (next === scope) return
              scopeVersion.current++
              setSnapshot(null)
              setError(null)
              setLoading(true)
              setScope(next)
            }}
          />
          {!chats.loading && !chats.error && (
            <p className="chat-defaults-counts">
              {all.length === 0
                ? 'No chats on record yet.'
                : desc.key === 'global'
                  ? `${dms} DM${dms === 1 ? '' : 's'} · ${groups} group${groups === 1 ? '' : 's'} on record`
                  : desc.key === 'dm'
                    ? `${dms} DM${dms === 1 ? '' : 's'} on record`
                    : `${groups} group${groups === 1 ? '' : 's'} on record`}
            </p>
          )}
        </aside>
        <div className="chat-defaults-editor dashboard-pane">
          <h2>{desc.title}</h2>
          {loading && !snapshot ? (
            <Loading>Loading {desc.title.toLowerCase()}…</Loading>
          ) : error && !snapshot ? (
            <Empty
              title="Defaults unavailable"
              action={
                <Button size="sm" onClick={() => setReloadTick((n) => n + 1)}>
                  Retry
                </Button>
              }
            >
              {error}
            </Empty>
          ) : snapshot ? (
            <>
              {error && (
                <p role="alert" className="chat-defaults-state">
                  Could not refresh. Showing the last loaded values.
                </p>
              )}
              <DefaultsForm
                key={`${desc.key}:${formKey}`}
                desc={desc}
                snapshot={snapshot}
                characters={packs.data?.characters ?? []}
                charactersError={packs.error ?? undefined}
                chats={all}
                onSnapshot={(next) => {
                  if (scopeVersion.current === currentVersion) setSnapshot(next)
                }}
                onDiscard={() => {
                  setFormKey((n) => n + 1)
                  setReloadTick((n) => n + 1)
                }}
              />
              {chats.error && <p className="chat-defaults-state">Chat counts unavailable: {chats.error}</p>}
              {packs.data && packs.data.faults.length > 0 && (
                <p className="chat-defaults-state">
                  {packs.data.faults.length} character pack{packs.data.faults.length === 1 ? '' : 's'} did not load:{' '}
                  {packs.data.faults.map((f) => f.id).join(', ')}.
                </p>
              )}
              <p className="chat-defaults-note">
                Name-call names, per-platform switches, sender access, mute and model stay on{' '}
                <a href={dashboardHref('chats')}>per-chat settings</a>.
              </p>
            </>
          ) : null}
        </div>
      </div>
      <Toaster />
    </section>
  )
}
