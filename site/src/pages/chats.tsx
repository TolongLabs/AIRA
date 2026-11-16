import { ChevronRight } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { Shell } from '@/components/shell'
import { Button, Card, Empty, Field, Input, Picker, Section, Segmented, Spinner, Toggle } from '@/components/ui'
import { type CoreCharacter, type CoreChat, type Resolved, type SourceLevel, core, reasonText } from '@/lib/core'
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
  { key: 'features.reports', label: 'Reports', hint: 'Off: /report is not offered.' },
  { key: 'features.proactive', label: 'Messages first', hint: 'Off: replies only when written to.' },
  { key: 'features.voice', label: 'Voice notes', hint: 'Off: replies are text.' },
  { key: 'features.lessons', label: 'Lessons', hint: 'Off: songs, words and the library are not offered.' }
]

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

function ChatRow({
  chat,
  characters,
  onChanged,
  open,
  onToggle
}: {
  chat: CoreChat
  characters: CoreCharacter[]
  onChanged: () => void
  /** Kept by the page, so a chat that moves between On and Off stays open. */
  open: boolean
  onToggle: () => void
}) {
  const [tab, setTab] = useState<SectionKey>('character')
  const [busy, setBusy] = useState(false)
  const name = chat.label || midTrunc(chat.waId, 28)
  const character = valueOf<string | undefined>(chat, 'character', undefined)
  const pack = characters.find((c) => c.id === character)

  const run = async (work: () => Promise<{ changed: boolean }>, done: string) => {
    setBusy(true)
    try {
      const result = await work()
      toast(result.changed ? done : 'Nothing changed.')
      onChanged()
    } catch (error) {
      toast(reasonText(error), false)
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
    <div className="border-b border-line last:border-b-0">
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
                  {chat.type === 'group' && (
                    <SettingRow chat={chat} name="freeResponse" label="Free response" onClear={clear}>
                      <Toggle
                        checked={valueOf(chat, 'freeResponse', false)}
                        disabled={busy}
                        onChange={(v) => save('freeResponse', v)}
                        label="Answer any message in this group"
                        hint="Off: answers a mention or a reply only."
                      />
                    </SettingRow>
                  )}
                </>
              )}
              {tab === 'features' &&
                FEATURES.map((f) => (
                  <SettingRow key={f.key} chat={chat} name={f.key} label={f.label} onClear={clear}>
                    <Toggle
                      checked={valueOf(chat, f.key, false)}
                      disabled={busy}
                      onChange={(v) => save(f.key, v)}
                      label={f.label}
                      hint={f.hint}
                    />
                  </SettingRow>
                ))}
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
  characters: CoreCharacter[]
  onChanged: () => void
  openId: string | null
  setOpenId: (id: string | null) => void
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

export default function ChatsPage() {
  const chats = useCore(core.chats)
  const packs = useCore(core.characters)
  const all = chats.data?.chats ?? []
  const on = useMemo(() => all.filter((c) => c.status === 'active'), [all])
  const off = useMemo(() => all.filter((c) => c.status === 'pending'), [all])
  const characters = packs.data?.characters ?? []
  const [openId, setOpenId] = useState<string | null>(null)
  const shared = { characters, onChanged: chats.reload, openId, setOpenId }

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
        {packs.data?.faults.length ? (
          <p className="mt-4 text-[0.8rem] text-down">
            {packs.data.faults.length} character pack{packs.data.faults.length === 1 ? '' : 's'} did not load:{' '}
            {packs.data.faults.map((f) => f.id).join(', ')}.
          </p>
        ) : null}
      </Section>
      <Toaster />
    </Shell>
  )
}
