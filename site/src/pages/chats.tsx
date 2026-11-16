import type React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { ChevronRight, Save, Send, Sparkles, ShieldCheck, X } from 'lucide-react'
import type { AllowedNumber, Chat, Settings } from '@/lib/api'
import { post } from '@/lib/api'
import { toast, Toaster, useApi } from '@/lib/hooks'
import { ago, cn, midTrunc } from '@/lib/utils'
import { Shell } from '@/components/shell'
import {
  Badge,
  Button,
  Card,
  Empty,
  Field,
  Input,
  Picker,
  Section,
  Segmented,
  Spinner,
  Textarea,
  Toggle
} from '@/components/ui'

/* Chats is its own page, not a tab inside Settings.
 *
 * It was one of five tabs there, and the odd one out: the other four are a
 * handful of switches each, while this one is the whole per-chat model —
 * every conversation she is in, who she is inside it, whether she starts
 * things, how often, what hours she keeps, what language she answers in, and
 * whether she may touch this machine. That is the surface people actually
 * come here to change, and it was reached by landing on Settings and then
 * finding the right tab. Now it is one click from anywhere.
 *
 * No blurb under the head, per DESIGN.md — the sections say what they are. */

/* ── chats ────────────────────────────────────────────────────────────── */

interface Pro {
  key: string
  enabled?: boolean
  style?: string
  temperament?: string
  /** whether the temperament reaches ORDINARY replies, or only her openings.
   *  Live on at least one chat and, until now, settable only by hand. */
  mood_in_replies?: boolean
  always_chat_voice?: boolean
  ground_citations?: boolean
  median_hours?: number
  interval_minutes?: number
  /** [start, end) local hours she stays silent, wrapping midnight */
  quiet_hours?: number[]
  /** IANA zone those hours are read in; "" follows this machine */
  timezone?: string
  /** unanswered openings before she stops knocking; 0 = never */
  give_up_after?: number
  max_per_day?: number
  /** how much each ignored opening stretches the next gap; 1 = not at all */
  backoff_factor?: number
  min_gap_hours?: number
  /** what is actually in force once the temperament preset and rails apply */
  effective?: {
    median_hours?: number
    min_gap_hours?: number
    backoff_factor?: number
    backoff_cap?: number
    max_per_day?: number
  }
  unanswered?: number
  /** unix seconds of the opening the scheduler has already sampled */
  next_due?: number
}

function Frequency({ hours, onHours }: { hours?: number | null; onHours: (h: number) => void }) {
  const initial = useMemo(() => {
    if (hours == null || Number.isNaN(hours)) return { n: '', unit: 'hours' as const }
    if (hours < 1) return { n: String(+(hours * 60).toFixed(1)), unit: 'minutes' as const }
    if (hours >= 48) return { n: String(+(hours / 24).toFixed(1)), unit: 'days' as const }
    return { n: String(+hours.toFixed(1)), unit: 'hours' as const }
  }, [hours])

  const [n, setN] = useState(initial.n)
  const [unit, setUnit] = useState<'minutes' | 'hours' | 'days'>(initial.unit)
  useEffect(() => {
    setN(initial.n)
    setUnit(initial.unit)
  }, [initial])

  function commit(nextN = n, nextUnit = unit) {
    const v = parseFloat(nextN)
    if (Number.isNaN(v) || v <= 0) return
    onHours(nextUnit === 'minutes' ? v / 60 : nextUnit === 'days' ? v * 24 : v)
  }

  return (
    <div className="flex items-center gap-2">
      <Input
        type="number"
        min={0}
        step="any"
        value={n}
        onChange={(e) => setN(e.target.value)}
        onBlur={() => commit()}
        className="w-24"
      />
      <Segmented
        options={['minutes', 'hours', 'days'] as const}
        value={unit}
        onChange={(u) => {
          setUnit(u as typeof unit)
          commit(n, u as typeof unit)
        }}
      />
    </div>
  )
}

/* A small whole-number cap where 0 means "no cap" — spelled out rather than
   left as a bare 0 nobody can interpret. */
function Counted({
  value,
  unit,
  zeroLabel,
  onChange
}: {
  value?: number | null
  unit: string
  zeroLabel: string
  onChange: (n: number) => void
}) {
  const n = value ?? 0
  // A configured value outside the shortlist must still show as itself. A
  // select with no matching option renders its FIRST one, so a chat capped at
  // 100 would read "her manner decides" — a lie about live config.
  const steps = [1, 2, 3, 4, 5, 6, 8, 10, 15, 20]
  const options = n > 0 && !steps.includes(n) ? [...steps, n].sort((a, b) => a - b) : steps
  return (
    <div className="flex items-center gap-2">
      <select
        value={n}
        onChange={(e) => onChange(Number(e.target.value))}
        className="min-h-11 min-w-44 cursor-pointer rounded-card border border-line bg-sunk px-3 text-ink"
      >
        <option value={0}>{zeroLabel}</option>
        {options.map((v) => (
          <option key={v} value={v}>
            {v} {unit}
          </option>
        ))}
      </select>
    </div>
  )
}

const HOURS = Array.from({ length: 24 }, (_, h) => h)
const hhmm = (h: number) => `${String(h).padStart(2, '0')}:00`

function QuietHours({ value, onChange }: { value?: number[] | null; onChange: (v: [number, number]) => void }) {
  const [start, end] = value?.length === 2 ? value : [23, 9]
  const setHours = (v: [number, number]) => onChange(v)

  return (
    <div className="flex items-center gap-2">
      {/* Twenty-four options each. Too many to lay out as buttons, and a
          native dropdown makes you scroll a day to find 6am — so type "06". */}
      <Picker
        ariaLabel="quiet from"
        className="min-w-32"
        value={String(start)}
        onChange={(v) => setHours([Number(v), end])}
        options={HOURS.map((h) => ({ value: String(h), label: hhmm(h) }))}
      />
      <span className="text-muted">and</span>
      <Picker
        ariaLabel="quiet until"
        className="min-w-32"
        value={String(end)}
        onChange={(v) => setHours([start, Number(v)])}
        options={HOURS.map((h) => ({ value: String(h), label: hhmm(h) }))}
      />
    </div>
  )
}

/* "Is she broken, or just asleep?" — answered in a sentence rather than left
   to be inferred from a cadence that produces nothing. */
function NextOpening({ pro }: { pro: Pro }) {
  const [start, end] = pro.quiet_hours?.length === 2 ? pro.quiet_hours : [23, 9]
  const zone = pro.timezone || undefined
  /* Read in the CHAT's zone, not the browser's. A page open in Kuala Lumpur
     showing a New York box's opinion of "now" is how "it's 4:30am" becomes an
     argument. Both the clock and the printed time follow the same zone. */
  const fmt = (d: Date, opts: Intl.DateTimeFormatOptions) => d.toLocaleString(undefined, { ...opts, timeZone: zone })
  const hour = Number(fmt(new Date(), { hour: '2-digit', hour12: false }))
  const quiet = start === end ? false : start < end ? hour >= start && hour < end : hour >= start || hour < end
  const when = pro.next_due
    ? fmt(new Date(pro.next_due * 1000), {
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit'
      })
    : null
  const zoneNote = zone ? ` ${zone.split('/').pop()!.replace('_', ' ')} time` : ''
  const gaveUp = !!pro.give_up_after && (pro.unanswered ?? 0) >= pro.give_up_after
  /* Backoff is invisible in the numbers: the cadence still reads "5 minutes"
     while she is actually waiting hours, because each unanswered opening
     multiplies the gap. Saying so is the difference between "she is backing
     off" and "she has stopped working". */
  const unanswered = pro.unanswered ?? 0

  return (
    <p className="mt-3 mb-0 text-[0.85rem] text-muted">
      {gaveUp ? (
        <>Stopped — {pro.unanswered} openings unanswered. She starts again the moment they reply.</>
      ) : quiet ? (
        <>
          Quiet hours right now — nothing goes out until {hhmm(end)}
          {zoneNote}
          {when ? `. Next opening ${when}.` : '.'}
        </>
      ) : when ? (
        <>
          Next opening {when}
          {zoneNote}.
          {unanswered > 0 && (
            <>
              {' '}
              Backing off — {unanswered} unanswered, so this gap is much longer than the cadence above. One reply resets
              it.
            </>
          )}
        </>
      ) : (
        <>Working out the next opening. Check back in five minutes.</>
      )}
    </p>
  )
}

/* Reply language is a SET — which of English, Japanese and Chinese appear in
   the reply — so it is checkboxes, not seven buttons. At least one must stay
   ticked: a chat that replies in no language is not a mode. */
function LanguagePicker({
  value,
  options,
  labels,
  onChange,
  lessons,
  onLessons
}: {
  value: string
  options: { code: string; name: string }[]
  labels: { value: string; label: string }[]
  onChange: (v: string) => void
  lessons: boolean
  onLessons: (v: boolean) => void
}) {
  const picked = useMemo(() => new Set(value.split('+').filter(Boolean)), [value])
  const order = options.map((o) => o.code)
  const label = labels.find((l) => l.value === value)?.label ?? value
  const shows = (c: string) => picked.has(c)

  function toggle(code: string) {
    const next = new Set(picked)
    if (next.has(code)) {
      if (next.size === 1) return // never leave her mute
      next.delete(code)
    } else {
      next.add(code)
    }
    onChange(order.filter((c) => next.has(c)).join('+'))
  }

  const filed = order.filter((c) => c !== 'en' && !shows(c))

  return (
    <Field
      label="what language she replies in"
      hint={
        lessons
          ? filed.length
            ? `${label} — the ${filed
                .map((c) => options.find((o) => o.code === c)?.name)
                .join(' and ')} still goes to the library, so nothing is lost`
            : label
          : `${label} · lessons off — she talks here, she does not teach, and ` +
            `nothing from this chat goes to the library`
      }
    >
      <div className="flex flex-wrap gap-2">
        {options.map((o) => {
          const on = shows(o.code)
          const only = on && picked.size === 1
          return (
            <button
              key={o.code}
              type="button"
              aria-pressed={on}
              disabled={only}
              title={only ? 'she has to reply in something' : undefined}
              onClick={() => toggle(o.code)}
              className={cn(
                'min-h-11 cursor-pointer rounded-card border px-4 text-[0.92rem] font-medium transition-colors',
                on
                  ? 'border-accent bg-accent-soft text-accent'
                  : 'border-line bg-transparent text-muted hover:text-ink',
                only && 'cursor-default'
              )}
            >
              {o.name}
            </button>
          )
        })}

        {/* The fourth switch, and a different KIND of switch — the three above
            choose which languages the reply is written in, this one chooses
            whether the reply is a LESSON at all: furigana, vocabulary
            breakdowns, grammar notes, the filing marker underneath. Set apart
            by a rule so it does not read as a fourth language. */}
        <span aria-hidden className="mx-1 self-stretch border-l border-line" />
        <button
          type="button"
          aria-pressed={lessons}
          onClick={() => onLessons(!lessons)}
          title={
            lessons
              ? 'She teaches here — furigana, vocabulary, grammar, and everything files to the library'
              : 'She talks here and does not teach. Nothing files.'
          }
          className={cn(
            'min-h-11 cursor-pointer rounded-card border px-4 text-[0.92rem] font-medium transition-colors',
            lessons
              ? 'border-accent bg-accent-soft text-accent'
              : 'border-line bg-transparent text-muted hover:text-ink'
          )}
        >
          Lessons
        </button>
      </div>
    </Field>
  )
}

/* Inside a group, one more level down. Eight proactive controls sat in a
   single wrap and the reader had to work out which knob answered which
   question — how often, when never, and what happens when nobody replies are
   three different questions and the flat row said so nowhere. */
function Cluster({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="m-0 mb-2 text-[0.78rem] font-semibold text-read">{title}</h4>
      <div className="flex flex-wrap items-start gap-x-6 gap-y-4">{children}</div>
    </div>
  )
}

/* The first message, and an editor for it.

   The composed text is a starting point, not a contract: whatever ends up in
   the box is what gets sent, edits and all. That is safe for the same reason
   the preview is — a person reads it before it goes — and the alternative, a
   message you can see but not correct, is worse than no preview at all.

   Opening it used to sit on a spinner for ten seconds, every time, because
   composing consulted a stored "write it in her voice" preference that
   defaulted to on and shelled out to the model before rendering anything —
   including on the openings where you only wanted to reread what was there.
   The fixed text now appears at once and her voice is a button, which is also
   what makes the plain version a real choice rather than a toggle you had to
   find first. */
/* Two things this panel can send, and they are not the same act.

   The endpoint behind it always took arbitrary text and always sent it
   verbatim — it was a general composer wearing an introduction's label, and
   because that was the only label, "send this chat a message" had no home in
   the UI at all and came down to a shell call. The only thing that actually
   made it introduction-shaped was the record it stamps on the way out.

   So: same textarea, same send path, one switch. Introduction keeps every bit
   of its behaviour (composed draft on arrival, her-voice rewrite, stamps the
   record, recomposes after sending). Message starts blank, stamps nothing,
   and leaves what you wrote alone afterwards. */
const SEND_MODES = ['introduction', 'message'] as const
type SendMode = (typeof SEND_MODES)[number]

function SendIntro({ chat, onChanged }: { chat: Chat; onChanged: () => void }) {
  const [mode, setMode] = useState<SendMode>('introduction')
  const [text, setText] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState<false | 'load' | 'voice' | 'send'>(false)
  const [dirty, setDirty] = useState(false)
  const [written, setWritten] = useState(false)
  const sentAt = chat.intro_sent ?? null
  const isIntro = mode === 'introduction'
  const body = isIntro ? (text ?? '') : draft

  async function compose(voice = false) {
    setBusy(voice ? 'voice' : 'load')
    try {
      const r = await post<{ text: string }>('/api/chats/intro', {
        target: chat.target,
        preview: true,
        ...(voice ? { voice: true } : {})
      })
      setText(r.text)
      setDirty(false)
      setWritten(voice)
    } catch (e) {
      toast((e as Error).message, false)
    } finally {
      setBusy(false)
    }
  }

  /* Composed on arrival rather than behind a button. The button was there when
     composing meant a ten-second model call and you might not have wanted to
     pay it; now it is a 50ms read of this chat's own settings, so making
     someone click to see the thing the section exists to show is a step that
     buys nothing. Opening the section IS the request. */
  useEffect(() => {
    void compose()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.target])

  async function send() {
    if (!body.trim()) return
    setBusy('send')
    try {
      await post('/api/chats/intro', {
        target: chat.target,
        text: body,
        // A one-off message must not move "when the introduction was last
        // sent" — that record is what the badge and the button label read.
        ...(isIntro ? {} : { stamp: false })
      })
      if (isIntro) {
        toast('introduction sent ✓')
        setDirty(false)
        setWritten(false)
        onChanged()
        // Recomposed rather than cleared: after sending, the useful thing on
        // screen is what this chat's introduction currently says, not a blank.
        void compose()
      } else {
        toast('message sent ✓')
        setDraft('')
      }
    } catch (e) {
      toast((e as Error).message, false)
    } finally {
      setBusy(false)
    }
  }

  if (isIntro && text === null) {
    return (
      <div className="flex items-center gap-2 text-muted">
        <Spinner /> composing…
      </div>
    )
  }

  return (
    <div>
      <div className="">
        <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
          <Segmented options={SEND_MODES} value={mode} onChange={setMode} />
          <span className="text-[0.82rem] text-faint">
            {isIntro
              ? 'her opening line for a chat she has not spoken in yet'
              : 'sent as written, to this chat, right now'}
          </span>
        </div>

        {/* Her voice costs a model call and about ten seconds, so it is a
              thing you ask for rather than a thing that happens to you. The
              fixed opening below is a perfectly good introduction on its own —
              leaving it alone is a choice, not a fallback. */}
        <div className={cn('mb-2 flex flex-wrap items-center gap-x-3 gap-y-2', !isIntro && 'hidden')}>
          <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void compose(true)}>
            {busy === 'voice' ? <Spinner /> : <Sparkles />}
            {written ? 'Write it again' : 'Write the opening in her voice'}
          </Button>
          <span className="text-[0.82rem] text-faint">
            {dirty
              ? 'recomposes the whole message — your edits below would be lost'
              : written
                ? 'written fresh from her persona file — the shop, her days, her way of putting it'
                : 'takes a few seconds; the rest of the message does not change'}
          </span>
        </div>

        {/* Editable, because "I want to change one line" is the first thing
              anyone thinks on reading a message they are about to send. */}
        <Textarea
          value={body}
          rows={isIntro ? 14 : 6}
          placeholder={isIntro ? undefined : 'what she should send…'}
          aria-label={isIntro ? 'the introduction as it will be sent' : 'the message as it will be sent'}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => {
            if (isIntro) {
              setText(e.target.value)
              setDirty(true)
            } else {
              setDraft(e.target.value)
            }
          }}
          className="w-full max-w-2xl font-mono text-[0.8rem] leading-relaxed"
        />

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button size="sm" variant="primary" disabled={!!busy || !body.trim()} onClick={() => void send()}>
            {busy === 'send' ? <Spinner /> : <Send />}
            {!isIntro ? 'Send Message' : sentAt ? 'Send Introduction Again' : 'Send Introduction'}
          </Button>
          <span className="text-[0.82rem] text-faint">
            {dirty ? 'your edits are what gets sent' : 'goes out exactly as written above'}
            {/* "last sent" is about the INTRODUCTION. A one-off message
                  neither reads nor moves it, so saying "never sent" beside a
                  message box would be answering a question nobody asked. */}
            {isIntro && (sentAt ? ` · last sent ${ago(sentAt)}` : ' · never sent')}
          </span>
        </div>
      </div>
    </div>
  )
}

const nf = new Intl.NumberFormat()
/* Big token counts are unreadable in full and misleading when rounded to one
   significant figure, so: thousands to one decimal, millions to two. */
function short(n: number) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return nf.format(n)
}
const money = (n: number) => (n >= 1 ? `$${n.toFixed(2)}` : `${(n * 100).toFixed(1)}¢`)

/* What this chat has cost.
 *
 * Nothing is measured to produce it. The router shells out to `claude -p
 * --output-format json` and parses that response for the reply text; the
 * response carries usage.input_tokens, the two cache counters, output_tokens
 * and the CLI's own dollar figure, and the ledger has been writing them —
 * stamped with this chat's scope — on every turn since it existed. So this
 * page is a group-by over a file: no counting call, no tokeniser, no estimate,
 * and no tokens spent to find out how many tokens were spent.
 *
 * Cache reads stay their own row rather than folding into input, because they
 * are billed at a fraction of the price and merging them makes an expensive
 * turn and a cheap one look identical. */
function Usage({ chat }: { chat: Chat }) {
  const all = chat.usage?.all ?? null
  const recent = chat.usage?.recent ?? null

  if (!all || !all.turns) {
    return (
      <p className="mt-0 mb-0 max-w-prose text-[0.9rem] text-muted">
        Nothing billed to this chat yet. A row lands here the first time she answers in it.
      </p>
    )
  }

  const per = all.tokens / all.turns
  /* A 30-day figure identical to the all-time one is not a second fact, it is
     the same number printed twice and it reads as a bug. When the whole ledger
     for this chat falls inside the window, the window is the caption instead. */
  const windowed = !!recent && recent.tokens < all.tokens
  const allRecent = !!recent?.turns && !windowed
  const rows: [string, number, string][] = [
    ['sent to the model', all.input, 'written fresh each turn'],
    ['read from cache', all.cache_read, 'the persona and history, billed at a tenth'],
    ['written to cache', all.cache_create, 'the first turn after anything changes'],
    ['her replies', all.output, 'the only part she actually composes']
  ]

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-baseline gap-x-8 gap-y-3">
        <div>
          <p className="m-0 font-serif text-[2rem] leading-none tnum">{short(all.tokens)}</p>
          <p className="m-0 mt-1 text-[0.8rem] text-muted">
            tokens over {nf.format(all.turns)} turn{all.turns === 1 ? '' : 's'}
            {allRecent ? ', all within 30 days' : ''}
          </p>
        </div>
        <div>
          <p className="m-0 font-serif text-[2rem] leading-none tnum">{money(all.cost_usd)}</p>
          <p className="m-0 mt-1 text-[0.8rem] text-muted">{money(all.cost_usd / all.turns)} a turn</p>
        </div>
        {windowed && (
          <div>
            <p className="m-0 font-serif text-[2rem] leading-none tnum">{short(recent!.tokens)}</p>
            <p className="m-0 mt-1 text-[0.8rem] text-muted">last 30 days · {money(recent!.cost_usd)}</p>
          </div>
        )}
        {!recent?.turns && (
          <div>
            <p className="m-0 font-serif text-[2rem] leading-none text-faint">—</p>
            <p className="m-0 mt-1 text-[0.8rem] text-muted">nothing in 30 days</p>
          </div>
        )}
      </div>

      <div>
        <table className="w-full max-w-xl border-collapse text-[0.88rem]">
          <tbody>
            {rows.map(([label, n, why]) => (
              <tr key={label} className="border-t border-line-2">
                <td className="py-2 pr-4 align-top">
                  {label}
                  <span className="block text-[0.78rem] text-faint">{why}</span>
                </td>
                <td className="tnum py-2 text-right align-top font-mono">{nf.format(n)}</td>
                <td className="tnum w-14 py-2 pl-3 text-right align-top text-muted">
                  {all.tokens ? `${Math.round((n / all.tokens) * 100)}%` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-3 mb-0 max-w-prose text-[0.82rem] text-faint">
          {short(per)} tokens a turn on average. These come off the API response the reply already carried, so counting
          them costs nothing.
        </p>
      </div>
    </div>
  )
}

/* Whether her REPLIES here come back as spoken voice notes.
 *
 * The label this replaces — "she speaks here" — was read as "she talks to this
 * chat unprompted", which is Proactivity, a different tab and a different
 * feature. Nothing in here ever makes her send the first message. That is
 * stated at the top rather than implied, because one user already read it the
 * wrong way and no amount of good option names fixes a wrong frame.
 *
 * Three modes, and the difference between them was previously carried entirely
 * by three words in a segmented pill ("never / only if they sent one / every
 * reply"). "Only if they sent one" is unreadable without knowing that "one"
 * means a voice note — so the options are a list with a sentence each, not a
 * pill. A control whose choices need explaining should be shaped like one that
 * has room to explain. */
function VoiceNotes({
  chat,
  master,
  langFallback,
  langs,
  onChanged
}: {
  chat: Chat
  /** the master switch in Settings; off silences this chat whatever it says */
  master: boolean
  /** the audio language a chat with no choice of its own gets */
  langFallback: string
  /** which languages the server offers, from /api/settings tts.langs */
  langs: string[]
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  const mode = chat.voice_mode ?? null
  /* Both controls here post chat.jid, and the server requires a real WhatsApp
     id — so on a PENDING row (jid = the bare "+60…") every click 400'd, on a
     panel whose own subtitle promises the settings apply the moment they
     write. Say that instead of offering a control that cannot work. */
  const storable = /^\d{5,}@/.test(String(chat.jid ?? ''))

  async function save(next: VoiceMode) {
    setBusy(true)
    try {
      /* `restarted` is not decoration. The gateway loads
          gateway_voice_mode.json once in its constructor and never re-reads
          it, so if the restart failed the page shows the new value while the
          running bot keeps the old one — and the toast used to say it had
          worked. HomeChannelPicker already did this correctly; these four did
          not. */
      const r = await post<{ restarted?: boolean }>('/api/settings/chat_tts', {
        chat: chat.jid,
        mode: next
      })
      toast(
        r.restarted
          ? 'saved ✓ — gateway restarted'
          : 'saved, but the gateway did not restart — it keeps the old setting until it does',
        r.restarted !== false
      )
      onChanged()
    } catch (e) {
      toast((e as Error).message, false)
    } finally {
      setBusy(false)
    }
  }

  // Which language the AUDIO is in. Not the language she replies in: the two
  // are allowed to diverge, and this only chooses the voice's language. The
  // server picks a different reference clip per language, and using the wrong
  // one is roughly a 5x artefact rate, so it is worth setting deliberately.
  const lang = chat.tts_language ?? null

  async function saveLang(next: string) {
    setBusy(true)
    try {
      await post('/api/settings/chat_tts_lang', { chat: chat.jid, lang: next })
      toast('saved \u2713')
      onChanged()
    } catch (e) {
      toast((e as Error).message, false)
    } finally {
      setBusy(false)
    }
  }

  if (!storable) {
    return (
      <div className="flex flex-col gap-3">
        <h4 className="mt-0 mb-0 text-[0.95rem] font-medium text-ink">When her replies come back as a voice note</h4>
        <p className="mt-0 mb-0 max-w-prose text-[0.82rem] text-muted">
          Not yet — this one is keyed on a phone number because they have not written here before. Voice settings are
          stored against the WhatsApp id, which only exists once they do. Send a message, or wait for theirs, and these
          controls appear.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-7">
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h4 className="mt-0 mb-0 text-[0.95rem] font-medium text-ink">When her replies come back as a voice note</h4>
          {/* The sentence that has to be here. Everything below is about
              REPLIES; the feature that makes her message first is Proactivity,
              and saying so once is cheaper than three careful option names. */}
          <p className="mt-0 mb-0 max-w-prose text-[0.82rem] text-muted">
            This only changes how she answers you. It never makes her message first — that's{' '}
            <b className="font-medium text-read">Proactivity</b>. The text of the reply is always sent either way; a
            voice note is sent alongside it.
          </p>
        </div>

        {/* Was a segmented pill. Each option now carries the rule it stands
            for, because "only if they sent one" cannot be understood from the
            words alone — "one" meant "a voice note", and nothing on screen
            said so. */}
        <div className="flex flex-col gap-1.5" role="radiogroup">
          {MODE_CHOICES.map((c) => {
            const on = (mode ?? 'off') === c.value
            return (
              <button
                key={c.value}
                type="button"
                role="radio"
                aria-checked={on}
                disabled={busy}
                onClick={() => void save(c.value)}
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-card border px-3 py-2.5 text-left transition-colors',
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
                  on ? 'border-accent bg-accent-soft' : 'border-line bg-transparent hover:border-line-2'
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    'mt-[3px] size-4 shrink-0 rounded-full border-2 transition-colors',
                    on ? 'border-accent bg-accent' : 'border-line-2'
                  )}
                />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className={cn('text-[0.9rem] font-medium', on ? 'text-accent' : 'text-ink')}>{c.title}</span>
                  <span className="text-[0.8rem] leading-snug text-muted">{c.note}</span>
                </span>
              </button>
            )
          })}
        </div>
        {busy && <span className="text-sm text-muted">saving…</span>}

        {!master && (
          /* Stated once, as a fact about the instance — not by falsifying this
             chat's own controls. The page-level banner says it properly; this
             is the in-context reminder for someone who came straight here. */
          <p className="mt-0 mb-0 text-xs text-muted">
            Muted everywhere right now, so nothing is spoken in any chat. This choice is kept and takes effect when you
            unmute under{' '}
            <a href="/app/settings.html#voice" className="text-accent">
              Settings → Voice
            </a>
            .
          </p>
        )}
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h4 className="mt-0 mb-0 text-[0.95rem] font-medium text-ink">What language the audio is in</h4>
          <p className="mt-0 mb-0 max-w-prose text-[0.82rem] text-muted">
            {/* The counter-intuitive bit: this is not the language she WRITES
                in. She can answer you in English and speak Japanese. */}
            Not the language she writes in — she can write English and speak Japanese.
          </p>
        </div>
        <Segmented
          options={LANG_OPTS(langs)}
          value={lang === null ? 'Default' : LANG_LABEL(lang)}
          onChange={(v) => void saveLang(LANG_VALUE(v))}
        />
        <p className="mt-0 mb-0 max-w-prose text-xs text-muted">
          {lang === null
            ? `Following the default, which is ${LANG_LABEL(langFallback)}.`
            : `The default is ${LANG_LABEL(langFallback)}; this chat overrides it.`}{' '}
          <a href="/app/settings.html#voice" className="text-accent">
            Change the default
          </a>
          .
        </p>
        {(lang ?? langFallback) === 'zh' && (
          /* Honest rather than hidden. Chinese works — the server lists it in
             /health next to ja and en — but it shares English's reference
             clip, so it is her English voice speaking Mandarin. */
          <p className="mt-0 mb-0 max-w-prose text-xs text-muted">
            Chinese uses her English voice, so it will sound less natural than Japanese.
          </p>
        )}
      </div>
    </div>
  )
}

type VoiceMode = 'off' | 'voice_only' | 'all'

/* The gateway's three modes, each with the rule it actually implements.
   Verified against gateway/run.py::_maybe_auto_voice_reply, whose gate is
   `mode == "all" or (mode == "voice_only" and is_voice_input)`.

   "voice_only" does NOT mean "whenever they say something" — it means she
   speaks only when the incoming message WAS a voice note. Two earlier labels
   got this wrong in different ways ("Only when they speak", then "only if they
   sent one", which is right but only if you already know what "one" is), which
   is the argument for carrying the rule next to the name instead of trying to
   compress it into three words.

   No inherit position: there is no global "chats that have not chosen"
   default any more. `voice.auto_tts` was that default — a config key with no
   writer, which this page used to point at ("following the default, which is
   off") and nobody could change. A chat is silent until set, so unset and
   "Never" mean the same thing and it is honest to draw them the same. */
const MODE_CHOICES: { value: VoiceMode; title: string; note: string }[] = [
  {
    value: 'off',
    title: 'Never',
    note: 'Text replies only. This is the default.'
  },
  {
    value: 'voice_only',
    title: 'Only when answering a voice note',
    note: 'Send her a voice note and she replies with one. Type to her and she types back.'
  },
  {
    value: 'all',
    title: 'Every reply',
    note: 'Every reply is also sent as a voice note.'
  }
]

/* The inherit chip is just "Default". It used to print what it resolved to —
   `default · match the reply` — which is the ModelField pattern and is right
   when the default is a NAME ("Default — Sonnet"). It is nonsense when the
   default is itself the word "auto": the strip read
   `default · match the reply | Match the reply | Japanese | ...`, two adjacent
   positions saying the same words, one of them lowercased for no reason.
   What it resolves to is said once, underneath, where it reads as a sentence
   instead of competing with the option beside it. */
const LANG_OPTS = (langs: string[]) => ['Default', ...langs.map(LANG_LABEL)]

/* Compared case-insensitively against the chip's own text, not a lowercase
   prefix. The chip is "Default"; a `startsWith("default")` test misses it and
   falls through to LANG_CODE, whose `?? "auto"` fallback would quietly write
   an EXPLICIT auto instead of clearing the override — the chat would look
   like it was inheriting while actually being pinned. */
const LANG_VALUE = (label: string) => (label.toLowerCase() === 'default' ? 'default' : LANG_CODE(label))

/* Names, not codes. "auto" is the odd one out and needs saying plainly: the
   server decides from the SCRIPT of the text it is handed, so what it really
   means is "whatever she happened to write in". */
const LANG_LABELS: Record<string, string> = {
  auto: 'Match the reply',
  ja: 'Japanese',
  en: 'English',
  zh: 'Chinese'
}

function LANG_LABEL(code: string): string {
  return LANG_LABELS[code] ?? code
}

function LANG_CODE(label: string): string {
  return Object.keys(LANG_LABELS).find((k) => LANG_LABELS[k] === label) ?? 'auto'
}

/* What an expanded chat row is for. Ordered the way you'd set one up: which
   version of her this chat gets, then how she sounds, then what she may touch,
   then whether she starts things herself, then the message that opens it.

   Nouns, because these are set as the house Kicker and a mono uppercase clause
   ("WHO SHE IS", "WHAT SHE CAN DO") reads as a sentence being shouted. Nouns
   of the same weight, each naming a facet of the chat rather than narrating it.

   Voice is its own tab rather than the seventh control down inside Persona.
   It was there because voice notes and reply language "answer the same
   question — what comes back", which is true and was still the wrong call:
   Persona ended up holding identity, two model pickers, reply language,
   lessons, two voice controls and a market selector, and the two voice
   controls are the ones that need the most explaining. Splitting them out is
   what buys the room to explain them. */
const SECTIONS = [
  // personality, mode, models, reply language, market: which character this is
  { key: 'who', label: 'Persona' },
  // whether her replies are spoken, and in what language
  { key: 'voice', label: 'Voice' },
  // its own copy: "what reaches her, or what she is allowed to touch"
  { key: 'can', label: 'Access' },
  // whether she starts things at all, and everything governing when. The name
  // the code has always used for it — Pro, proactive(), /proactive.
  { key: 'opens', label: 'Proactivity' },
  { key: 'intro', label: 'Send' },
  { key: 'spend', label: 'Usage' }
] as const

type SectionKey = (typeof SECTIONS)[number]['key']

/* A model picker whose empty value is a real, named option. "Use the default"
   has to be selectable, not just the state you start in — otherwise trying a
   model once makes it permanent, and the only way back is editing yaml. The
   default's own name is shown beside it so the choice is informed. */
function ModelField({
  label,
  value,
  effective,
  options,
  onChange
}: {
  label: string
  value: string
  effective: string
  options: { id: string; label: string; note?: string; kind: string }[]
  onChange: (v: string) => void
}) {
  const named = options.find((o) => o.id === effective)
  return (
    <Field label={label}>
      <select
        className="min-h-11 rounded-card border border-line bg-sunk px-3 text-ink"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">
          Default
          {named ? ` — ${named.label}` : effective ? ` — ${effective}` : ''}
        </option>
        {/* A chat PINNED to a model the catalogue does not carry (Ollama down,
            or an AIRA_CHAT_MODEL that was never in the list) fell through to
            the "Default" option above and read as inheriting — the opposite of
            what was configured. Show the pin. */}
        {value && !options.some((o) => o.id === value) && (
          <option value={value}>{value} — pinned, not in the catalogue</option>
        )}
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
            {o.note ? ` — ${o.note}` : ''}
          </option>
        ))}
      </select>
    </Field>
  )
}

function ChatCard({
  chat,
  settings,
  pro,
  onChanged
}: {
  chat: Chat
  settings: Settings
  pro?: Pro
  onChanged: () => void
}) {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<SectionKey>('who')
  const [renaming, setRenaming] = useState(false)
  const [label, setLabel] = useState(chat.label ?? chat.name ?? '')
  // An unnamed live chat has nothing but its id, so the id becomes the name
  // rather than the row reading "group" with the id hidden underneath it.
  const name = chat.label || chat.name || midTrunc(chat.jid, 28)
  // Show the number beside the name when they differ: you add someone by
  // number, and the row renames itself to their WhatsApp display name the
  // moment they first write, which is exactly when you go looking for it.
  const number = chat.number && chat.number !== name ? chat.number : ''
  const sub = chat.pending
    ? chat.heard_in?.length
      ? `talks to her in ${chat.heard_in.join(', ')}` + (chat.last_seen ? ` · ${ago(chat.last_seen)}` : '')
      : 'settings apply the moment they write'
    : number
  const agentOn = chat.agent === 'full'

  const proKey =
    pro?.key ??
    (chat.label || chat.name || `${chat.kind}-${chat.jid.slice(0, 6)}`)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24)

  async function bind(patch: Record<string, unknown>) {
    try {
      await post('/api/settings/bindings', {
        action: 'set',
        platform: chat.platform,
        kind: chat.kind,
        /* A pending chat is keyed on its NUMBER, plus and all.
           `sanitised` eats the "+", and the plus is the whole signal: the
           binding matcher reads it as "resolve this number to whoever it
           turns out to be" rather than "compare it to a chat id". Written
           without it, the rule is a literal that nothing ever equals — the
           write returns 200, the page re-reads, and the row is unchanged.
           That was silently true of personality, mode and computer access
           too, not just this, for every chat she has not messaged yet. */
        chat: chat.pending ? chat.jid : (chat.sanitised ?? chat.jid),
        personality: chat.personality,
        mode: chat.mode,
        agent: chat.agent,
        ...patch
      })
      toast('saved ✓')
      onChanged()
    } catch (e) {
      toast((e as Error).message, false)
    }
  }

  async function setModel(role: 'chat' | 'agent', model: string) {
    try {
      await post('/api/settings/chat_model', {
        platform: chat.platform,
        kind: chat.kind,
        chat: chat.pending ? chat.jid : (chat.sanitised ?? chat.jid),
        role,
        model
      })
      toast(model ? 'saved ✓' : 'back to the default ✓')
      onChanged()
    } catch (e) {
      toast((e as Error).message, false)
    }
  }

  async function proactive(patch: Record<string, unknown>) {
    try {
      // A timing change reschedules on the server; saying so is the
      // difference between "did that take?" and watching the new opening
      // appear a second later.
      const r = await post<{ rescheduled?: boolean }>('/api/settings/proactive', {
        key: proKey,
        chat_id: chat.jid,
        deliver: chat.target,
        ...patch
      })
      toast(r.rescheduled ? 'saved — rescheduling now ✓' : 'saved ✓')
      // The tick writes next_due a beat after it starts; re-read once it has.
      onChanged()
      if (r.rescheduled) window.setTimeout(onChanged, 2500)
    } catch (e) {
      toast((e as Error).message, false)
    }
  }

  async function setLanguage(v: string) {
    try {
      await post('/api/settings/language', {
        scope_key: chat.scope_key,
        language: v
      })
      toast('saved ✓')
      onChanged()
    } catch (e) {
      toast((e as Error).message, false)
    }
  }

  async function setLessons(v: boolean) {
    try {
      await post('/api/settings/language', {
        scope_key: chat.scope_key,
        lessons: v
      })
      toast('saved ✓')
      onChanged()
    } catch (e) {
      toast((e as Error).message, false)
    }
  }

  async function setGroupAllow(v: boolean) {
    try {
      const r = await post<{ restarted?: boolean }>('/api/settings/group_allow', { chat: chat.jid, enabled: v })
      const said = v ? 'she can hear this group' : "she'll ignore this group"
      toast(
        r.restarted ? `${said} ✓` : `saved, but the gateway did not restart — ${said} only once it does`,
        r.restarted !== false
      )
      onChanged()
    } catch (e) {
      toast((e as Error).message, false)
    }
  }

  async function setFreeResponse(v: boolean) {
    try {
      /* Unlike the two above, this one is re-read per inbound message, so a
          failed restart costs nothing and the toast does not need to hedge. */
      await post('/api/settings/free_response', { chat: chat.jid, enabled: v })
      toast(v ? "she'll read this group ✓" : 'back to tag-only ✓')
      onChanged()
    } catch (e) {
      toast((e as Error).message, false)
    }
  }

  async function setRegion(v: string) {
    try {
      await post('/api/settings/region', {
        scope_key: chat.scope_key,
        region: v
      })
      toast('saved ✓')
      onChanged()
    } catch (e) {
      toast((e as Error).message, false)
    }
  }

  async function rename() {
    try {
      await post('/api/settings/labels', {
        target: chat.target,
        label: label.trim()
      })
      setRenaming(false)
      toast('renamed ✓')
      onChanged()
    } catch (e) {
      toast((e as Error).message, false)
    }
  }

  /* A ROW, not a card. Eleven identical cards cost 1,300px of scroll to say
     eleven names, most of it dead space and a raw JID given a line of its own
     — and a list of homogeneous things you scan and compare is a list, which
     is the same argument the Markets watchlist rail already won. The whole
     row is the affordance; the states you compare across chats (what she may
     touch, whether she opens conversations, what language) are one scannable
     strip instead of a badge floated to the far right. */
  const facts = [
    agentOn ? 'computer' : null,
    pro?.enabled ? 'opens' : null,
    (chat.language ?? 'en').replace(/\+/g, '·')
  ].filter(Boolean) as string[]

  return (
    <div className={cn('border-t border-line-2 first:border-t-0', open && 'bg-card-2')}>
      <div className="flex items-center gap-3 px-4">
        {renaming ? (
          <span className="flex flex-1 flex-wrap items-center gap-2 py-3">
            <Input
              value={label}
              autoFocus
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void rename()}
              className="w-56"
              placeholder="a name you'll recognise"
            />
            <Button size="sm" variant="primary" onClick={() => void rename()}>
              Save name
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setRenaming(false)}>
              Cancel
            </Button>
          </span>
        ) : (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 border-0 bg-transparent py-3 text-left focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
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
                  {chat.kind}
                </span>
                {/* Allowed on the front door but never seen. Keyed on the
                    number, which is the only handle that exists before
                    WhatsApp assigns a LID — so this row can be set up BEFORE
                    the first message, the one conversation the settings used
                    to get wrong. */}
                {chat.pending && (
                  <span className="shrink-0 text-[0.72rem] text-amber">
                    {chat.heard_in?.length ? 'no DM yet' : 'not messaged yet'}
                  </span>
                )}
              </span>
              {/* A second line ONLY where it says something the name does
                  not. The JID had a line of its own at full prominence on
                  every row — a machine id nobody reads, costing a third of
                  the list's height to repeat what the name already told you.
                  It moved into the panel. A pending row keeps its line,
                  because there the sentence IS the news. */}
              {sub && <span className="mt-0.5 block truncate text-[0.72rem] text-faint">{sub}</span>}
            </span>
            <span className="hidden shrink-0 items-center gap-2 sm:flex">
              {facts.map((f) => (
                <span
                  key={f}
                  className={cn(
                    'rounded-full px-2 py-0.5 font-mono text-[0.66rem] tracking-[0.04em] lowercase',
                    f === 'computer' ? 'bg-accent-soft text-accent' : 'border border-line-2 text-muted'
                  )}
                >
                  {f}
                </span>
              ))}
            </span>
          </button>
        )}
      </div>

      {open && (
        /* One section at a time, because the panel had become the thing it
           replaced. Two columns made twenty controls DENSER, not calmer:
           identity, capabilities, an eight-knob proactive block and a message
           editor were all on screen at once, and configuring a chat is almost
           always one of those.

           A rail rather than the page's underline Tabs: those are 0.95rem ink
           on a full-width hairline, and dropped inside an expanded row they
           read as a SECOND page nav arguing with the row header above them.

           These are the sections of one panel, so they are dressed as panel
           labels and nothing else: the house Kicker — mono, uppercase, .14em —
           which DESIGN.md calls the signature that separates this system from
           generic warm minimalism. The first pass set them in 0.85rem sans,
           which is exactly that generic thing. Active carries the shell nav's
           own mark, an accent-soft fill, rather than a rule invented here; it
           also reads the same at both breakpoints, so the rail lays flat under
           640px with nothing to re-place. */
        <div className="border-t border-line">
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
                      'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
                      on ? 'bg-accent-soft text-accent' : 'bg-transparent text-muted hover:text-read'
                    )}
                  >
                    {s.label}
                  </button>
                )
              })}
            </div>

            <div className="min-w-0 flex-1 px-4 pt-4 pb-6 sm:px-5">
              {tab === 'who' && (
                <div className="flex flex-col gap-5">
                  <div className="flex flex-wrap items-center gap-3">
                    <code className="rounded-card border border-line-2 bg-sunk px-2 py-1 font-mono text-[0.72rem] text-muted">
                      {chat.jid}
                    </code>
                    <Button size="sm" variant="ghost" onClick={() => setRenaming(true)}>
                      Rename this chat
                    </Button>
                  </div>
                  <div className="flex flex-wrap gap-6">
                    <Field label="personality">
                      <Segmented
                        options={(settings.personalities ?? []) as string[]}
                        value={chat.personality}
                        onChange={(v) => void bind({ personality: v })}
                      />
                    </Field>
                    <Field label="how she behaves">
                      <Segmented
                        options={(settings.modes ?? []) as string[]}
                        value={chat.mode}
                        onChange={(v) => void bind({ mode: v })}
                      />
                    </Field>
                  </div>
                  {/* The router decides per turn whether a message is
              conversation or work, and hands over a ~39k-character
              operating manual whenever it guesses work — which in the
              family and stock personas is EVERY turn, by construction.
              That manual is where the character goes. This says: in this
              chat, she is always talking to someone. She keeps her tools;
              she loses the manual. It used to sit under "She messages
              first here", visible only when that was on — it has nothing
              to do with her messaging first, so it lives with who she is.
              Saving it creates a proactive entry for the chat, and an
              entry without `enabled` never fires. */}
                  <div className="mt-4">
                    <Toggle
                      checked={!!pro?.always_chat_voice}
                      label="always answer in her own voice, never in report mode"
                      onChange={(v) => void proactive({ always_chat_voice: v })}
                    />
                  </div>

                  {/* Which model answers HERE. Two roles, because they are two
              questions: conversation is a routing contract a small model can
              lose, and delegated coding is real work on a real machine. Both
              default to the Settings value, and "the default" is a real
              option rather than a blank — a picker with no way back to it
              turns one experiment into a permanent override. */}
                  <div className="flex flex-wrap gap-6">
                    <ModelField
                      label="model"
                      value={chat.chat_model ?? ''}
                      effective={chat.chat_model_effective ?? ''}
                      options={settings.models?.catalogue ?? []}
                      onChange={(v) => void setModel('chat', v)}
                    />
                    <ModelField
                      label="model for delegated work"
                      value={chat.agent_model ?? ''}
                      effective={chat.agent_model_effective ?? ''}
                      options={(settings.models?.catalogue ?? []).filter(
                        (c) => c.kind === 'claude' || c.kind === 'cloud'
                      )}
                      onChange={(v) => void setModel('agent', v)}
                    />
                  </div>

                  <LanguagePicker
                    value={chat.language ?? 'en'}
                    options={settings.language_codes ?? []}
                    labels={settings.languages ?? []}
                    lessons={chat.lessons ?? true}
                    onLessons={(v) => void setLessons(v)}
                    onChange={(v) => void setLanguage(v)}
                  />

                  {settings.regions && settings.regions.length > 0 && (
                    <Field
                      label="which market this chat means"
                      hint={(() => {
                        const r = settings.regions.find((x) => x.value === (chat.region ?? 'global'))
                        return r
                          ? `A bare ticker resolves on this market, headlines come from it, and prices read in ${r.currency}.`
                          : ''
                      })()}
                    >
                      <select
                        value={chat.region ?? 'global'}
                        onChange={(e) => void setRegion(e.target.value)}
                        className="min-h-11 min-w-52 rounded-card border border-line bg-sunk px-3 text-ink"
                      >
                        {settings.regions.map((r) => (
                          <option key={r.value} value={r.value}>
                            {r.label}
                          </option>
                        ))}
                      </select>
                    </Field>
                  )}
                </div>
              )}

              {tab === 'voice' && (
                <VoiceNotes
                  chat={chat}
                  master={settings.tts?.enabled !== false}
                  langFallback={settings.tts?.lang ?? 'auto'}
                  langs={settings.tts?.langs ?? ['auto', 'ja', 'en', 'zh']}
                  onChanged={onChanged}
                />
              )}

              {tab === 'can' && (
                <div className="flex flex-col gap-5">
                  <p className="mt-0 mb-0 max-w-prose text-[0.85rem] text-muted">
                    These control what she can see and do in this chat.
                  </p>
                  {chat.bound === false && (
                    /* Changing anything here posts the chat's persona and mode
                     along with it — and for an unbound chat those are the
                     DEFAULTS showing through, so the write turns them into a
                     rule and detaches this chat from "Everywhere else"
                     permanently. It is a real, invisible consequence of a
                     switch that appears to be about photos, so it is said
                     before it happens rather than discovered later. */
                    <p className="mt-0 mb-0 max-w-prose text-[0.85rem] text-amber">
                      This chat follows the defaults. Changing anything here pins it to {chat.personality} · {chat.mode}
                      , and it stops following them.
                    </p>
                  )}
                  {chat.kind === 'group' && chat.gated && (
                    <div>
                      {/* First, because nothing else on this page does anything until
                  it is on. A group added here used to get a persona, a
                  register and a language and stay completely mute, because the
                  gateway's group gate lives in config.yaml and only the
                  SENDER allowlist was reachable from the UI. Worse than mute:
                  the bridge downloads media before this gate, so photos landed
                  on disk while she truthfully reported an empty inbox. */}
                      <Toggle
                        checked={!!chat.allowed}
                        label="Let her hear this group at all"
                        onChange={(v) => void setGroupAllow(v)}
                        hint={
                          <>
                            Off, the gateway drops every message from this group before she sees it — none of the
                            settings below have any effect. Restarts the gateway, so give it a few seconds.
                          </>
                        }
                      />
                    </div>
                  )}

                  {chat.kind === 'group' && chat.allowed === false && (
                    <p className="mt-0 mb-0 max-w-prose text-[0.82rem] text-muted">
                      These settings are saved but do nothing until you turn the group on above.
                    </p>
                  )}

                  {chat.kind === 'group' && (
                    <div>
                      {/* The gateway has supported this per chat all along; it was
                  only reachable by hand-editing an env var. In a group she is
                  a member of rather than a bystander in, "how's Maybank
                  looking" is addressed to her by everyone's understanding
                  except the mention gate's. */}
                      <Toggle
                        checked={!!chat.free_response}
                        label="Answer here without being tagged"
                        onChange={(v) => void setFreeResponse(v)}
                        hint={
                          <>
                            Off, she only replies when someone @-mentions her or replies to her. On, she reads
                            everything in this group — so give it to the chats she is a member of, not the ones she sits
                            in.
                          </>
                        }
                      />
                    </div>
                  )}

                  <div>
                    <Toggle
                      checked={agentOn}
                      label="Let her use the computer from this chat"
                      onChange={(v) => void bind({ agent: v ? 'full' : 'none' })}
                      hint={
                        <>
                          Off, she can only talk. On, anyone messaging here can have her read files, run commands and
                          edit projects on your machine — so leave it off for group chats and anyone you would not hand
                          a terminal.
                        </>
                      }
                    />
                  </div>

                  {/* Off unless granted, like computer access and for a smaller
              version of the same reason: the tool fetches from an address a
              stranger's search result chose. */}
                  <div>
                    <Toggle
                      checked={chat.photos === 'on'}
                      label="Let her send photos here"
                      onChange={(v) => void bind({ photos: v ? 'on' : 'off' })}
                      hint={
                        <>
                          Off, she answers in words only. On, asking "what does Saizeriya look like" gets a real
                          photograph found on the web and sent to this chat. Nothing is generated, and the download is
                          capped, timed out and checked to be an actual image before it is sent.
                        </>
                      }
                    />
                  </div>

                  {chat.kind === 'group' && (
                    <div>
                      <Toggle
                        checked={chat.autofetch === 'on'}
                        label="Send the media from links posted here"
                        onChange={(v) => void bind({ autofetch: v ? 'on' : 'off' })}
                        hint={
                          <>
                            On, anyone posting an Instagram, X, Facebook, TikTok or Threads link here — tagging her or
                            not — gets the reel or pictures sent straight back, with no message. A private or deleted
                            post is skipped quietly. Messages without a link are ignored as always, and none of it is
                            saved.
                          </>
                        }
                      />
                    </div>
                  )}

                  {/* The introduction lives with the capabilities because it IS one:
              it sends a real message right now, which nothing else on this
              panel does. */}
                </div>
              )}

              {tab === 'opens' && (
                <div className="flex flex-col gap-5">
                  <p className="mt-0 mb-0 max-w-prose text-[0.85rem] text-muted">
                    Unprompted messages. Off, she only ever answers.
                  </p>
                  <div>
                    <Toggle
                      checked={!!pro?.enabled}
                      label="She messages first here"
                      onChange={(v) => void proactive({ enabled: v })}
                    />
                    {pro?.enabled && (
                      <div className="mt-4 flex flex-col gap-6">
                        {/* The answer first. This used to sit at the very bottom,
                    after eight knobs — the one line that says what all of
                    them add up to, placed where you would only find it if you
                    had already read everything above. */}
                        <NextOpening pro={pro} />

                        <Cluster title="How often she opens">
                          <Field
                            label="her manner"
                            hint="the temperament — how long she waits, how she takes
                        being left on read, and how an opening sounds when she
                        has been waiting"
                          >
                            <Segmented
                              options={(settings.temperaments ?? []) as string[]}
                              value={pro.temperament}
                              onChange={(v) => void proactive({ temperament: v })}
                            />
                          </Field>
                          {/* Live on this chat and, until now, invisible: the setting
                    that decides whether the temperament reaches an ORDINARY
                    reply or only her openings. Worth showing next to the
                    manner it governs — a temperament with this off is a
                    timing setting wearing a personality's name. */}
                          <Toggle
                            checked={!!pro?.mood_in_replies}
                            label="let her manner colour ordinary replies too"
                            onChange={(v) => void proactive({ mood_in_replies: v })}
                          />
                          {/* Asked what ISO 22301 and PETRONAS's BCM standards say, she
                    answered from memory in the register of a lookup: a real
                    standard number for the wrong subject, and a framework that
                    does not exist. Nothing was searched, though search was
                    right there. On here, a question naming a standard, clause,
                    law or spec has to be READ before she will cite it. Worth
                    the extra seconds anywhere an answer might be pasted into a
                    compliance document. */}
                          <Toggle
                            checked={!!pro?.ground_citations}
                            label="never cite a standard or clause she has not looked up"
                            onChange={(v) => void proactive({ ground_citations: v })}
                          />
                          <Field
                            label="timing"
                            hint={
                              pro.style === 'fixed'
                                ? 'a strict clock — for market updates'
                                : 'she picks her own moments'
                            }
                          >
                            <Segmented
                              options={['organic', 'fixed'] as const}
                              value={(pro.style ?? 'organic') as 'organic' | 'fixed'}
                              onChange={(v) => void proactive({ style: v })}
                            />
                          </Field>
                          <Field label="reaches out about every">
                            <Frequency
                              hours={
                                pro.style === 'fixed' ? (pro.interval_minutes ?? 0) / 60 || null : pro.median_hours
                              }
                              onHours={(h) =>
                                void proactive(
                                  pro.style === 'fixed'
                                    ? {
                                        interval_minutes: Math.round(h * 600) / 10
                                      }
                                    : { median_hours: h }
                                )
                              }
                            />
                          </Field>
                          <Field label="at most" hint="Openings in any 24 hours.">
                            <Counted
                              value={pro.max_per_day}
                              zeroLabel="her manner decides"
                              unit="a day"
                              onChange={(n) => void proactive({ max_per_day: n })}
                            />
                          </Field>
                        </Cluster>

                        <Cluster title="When she never does">
                          {/* The setting that decides whether she speaks at all, and
                    the one with no control until now: a five-minute cadence
                    produces nothing at 4am and reads as her having given up. */}
                          <Field
                            label="stays quiet between"
                            hint="Overnight silence. Set both to the same hour for none at all."
                          >
                            <QuietHours value={pro.quiet_hours} onChange={(v) => void proactive({ quiet_hours: v })} />
                          </Field>
                          {/* Those hours are on THEIR clock, not this machine's. A box
                    in New York reads a Singaporean's 23:00–09:00 as
                    11:00–21:00 their time: silent all day, chatty at 3am. */}
                          <Field label="their clock" hint="Quiet hours are read in this zone.">
                            {/* Hundreds of zones. This is the list the picker exists
                      for: type "sing" rather than scroll past Africa. */}
                            <Picker
                              ariaLabel="which timezone"
                              className="min-w-52"
                              placeholder="same as this machine"
                              searchPlaceholder="type a city or zone…"
                              value={pro.timezone ?? ''}
                              onChange={(v) => void proactive({ timezone: v })}
                              options={[
                                { value: '', label: 'same as this machine' },
                                ...(settings.timezones ?? []).map((t) => ({
                                  value: t.value,
                                  label: t.label
                                }))
                              ]}
                            />
                          </Field>
                        </Cluster>

                        <Cluster title="When they don't answer">
                          {/* The caps. Backoff only ever stretched the gap, so without
                    a give-up she keeps knocking forever on someone who has
                    stopped answering. The counter resets when they reply. */}
                          <Field
                            label="gives up after"
                            hint={
                              pro.give_up_after
                                ? `${pro.unanswered ?? 0} unanswered right now.`
                                : 'Never stops on her own.'
                            }
                          >
                            <Counted
                              value={pro.give_up_after}
                              zeroLabel="never gives up"
                              unit="unanswered"
                              onChange={(n) => void proactive({ give_up_after: n })}
                            />
                          </Field>
                          {/* The knob that made the cadence above read as a lie. Each
                    ignored opening multiplies the gap, and at the 2.6 this
                    chat carried, four unanswered turned five minutes into
                    nearly four hours — with nothing on this page saying so. */}
                          <Backoff pro={pro} onSave={proactive} />
                        </Cluster>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {tab === 'intro' && <SendIntro chat={chat} onChanged={onChanged} />}

              {tab === 'spend' && <Usage chat={chat} />}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* How much silence costs. Backoff is multiplicative per unanswered opening and
   caps out after a few, so the honest way to present it is the number it
   actually produces — "every 5 min, up to 3 h 48 m when ignored" — rather than
   a bare factor nobody can multiply in their head. */
function Backoff({ pro, onSave }: { pro: Pro; onSave: (p: Record<string, unknown>) => void }) {
  const eff = pro.effective ?? {}
  const factor = pro.backoff_factor ?? eff.backoff_factor ?? 1.8
  const cap = eff.backoff_cap ?? 4
  const base = pro.median_hours ?? eff.median_hours ?? 0
  const stretched = base * Math.pow(factor, cap)

  const say = (h: number) =>
    h < 1 / 60
      ? 'moments'
      : h < 1
        ? `${Math.round(h * 60)} min`
        : h < 48
          ? `${+h.toFixed(1)} h`
          : `${+(h / 24).toFixed(1)} days`

  return (
    <Field
      label="slows down when ignored"
      hint={
        factor <= 1
          ? 'Same cadence however long they stay quiet.'
          : base
            ? `Every ${say(base)} normally, up to ${say(stretched)} after ${cap} unanswered.`
            : `She waits longer after each message that goes unanswered, up to ${cap} times the usual gap.`
      }
    >
      <div className="flex items-center gap-2">
        <Input
          type="number"
          step="0.1"
          min="1"
          max="5"
          value={String(+factor.toFixed(2))}
          onChange={(e) => {
            const n = Number(e.target.value)
            if (Number.isFinite(n) && n >= 1 && n <= 5) onSave({ backoff_factor: n })
          }}
          className="w-24"
        />
        <span className="text-[0.82rem] text-muted">× per unanswered</span>
      </div>
    </Field>
  )
}

/* Which archetype she plays, and how loud. Two axes because they are
   independent: the same character belongs at Maximum in a private chat and at
   Plain in a working group, and "less exaggerated" is its own request. The
   dere types are behavioural — the blurb under each says what she DOES, not
   what she is like. */
/* The front door. A number that is not on this list is dropped by the gateway
   before anything of ours sees it, so this is the one control on the page that
   decides who she is reachable BY, rather than how she behaves once reached.

   Keyed on the phone number because that is the thing a person knows. WhatsApp
   hands us a LID (117…@lid) instead, and a LID cannot be derived from a number
   — the two are joined only after someone messages, which is why a fresh entry
   reads "not met yet" rather than showing a chat id. That is also why the
   per-chat cards above cannot list someone who has never written: there is
   nothing to name them by until they do. */
function Allowlist() {
  const list = useApi<{ numbers: AllowedNumber[] }>('/api/allowlist')
  const [adding, setAdding] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

  async function act(body: Record<string, unknown>, ok: string) {
    setBusy(true)
    try {
      const r = await post<{ restarted?: boolean }>('/api/settings/allowlist', body)
      toast(
        r.restarted ? `${ok} — gateway restarted ✓` : `${ok} — but the gateway did not restart`,
        r.restarted !== false
      )
      setAdding('')
      setEditing(null)
      list.reload()
    } catch (e) {
      toast((e as Error).message, false)
    } finally {
      setBusy(false)
    }
  }

  const rows = list.data?.numbers ?? []
  return (
    <Card className="p-5">
      <p className="mt-0 mb-4 max-w-prose text-[0.92rem] text-muted">
        Only these numbers can message her. Use international format, e.g. +60 12-345 6789. Saving takes a few seconds
        to apply.
      </p>

      {list.loading && !list.data ? (
        <div className="flex items-center gap-2 text-muted">
          <Spinner /> loading…
        </div>
      ) : (
        <div className="flex flex-col">
          {rows.map((n) => (
            <div
              key={n.number}
              className="flex flex-wrap items-center gap-3 border-t border-line-2 py-3 first:border-t-0 first:pt-0"
            >
              {editing === n.number ? (
                <>
                  <Input
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    className="w-52 font-mono"
                    autoFocus
                  />
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={busy}
                    onClick={() =>
                      void act({ action: 'replace', was: n.number, number: draft }, `${n.number} → ${draft}`)
                    }
                  >
                    <Save /> save
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                    cancel
                  </Button>
                </>
              ) : (
                <>
                  <span className="font-mono text-[0.95rem] tracking-[0.02em]">{n.number}</span>
                  {n.name && <span className="min-w-0 truncate text-muted">{n.name}</span>}
                  {/* A DM is not the only kind of contact. Someone who has
                      been answering her in a group for weeks has met her, and
                      calling that "no chat yet" was both wrong and useless. */}
                  {n.met ? (
                    n.kind && <Badge tone="neutral">{n.kind}</Badge>
                  ) : n.groups ? (
                    <Badge tone="neutral">talks in {n.groups === 1 ? 'a group' : `${n.groups} groups`}</Badge>
                  ) : (
                    <Badge tone="neutral">not met yet</Badge>
                  )}
                  {!n.met && !!n.last_seen && <span className="text-[0.82rem] text-faint">{ago(n.last_seen)}</span>}
                  <div className="ml-auto flex gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setEditing(n.number)
                        setDraft(n.number)
                      }}
                    >
                      edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy || rows.length < 2}
                      title={
                        rows.length < 2
                          ? 'the last number cannot be removed — an empty list stops the gateway filtering at all'
                          : undefined
                      }
                      onClick={() => void act({ action: 'remove', number: n.number }, `${n.number} removed`)}
                    >
                      <X /> remove
                    </Button>
                  </div>
                </>
              )}
            </div>
          ))}
          {!rows.length && <Empty>The list is empty, so anyone who finds the number can message her.</Empty>}
        </div>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-line pt-4">
        <Input
          value={adding}
          placeholder="+00 00-000 0000"
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && adding.trim()) void act({ action: 'add', number: adding }, `${adding} added`)
          }}
          className="w-52 font-mono"
        />
        <Button
          variant="primary"
          disabled={busy || !adding.trim()}
          onClick={() => void act({ action: 'add', number: adding }, `${adding} added`)}
        >
          Allow this number
        </Button>
      </div>
    </Card>
  )
}

/* Where hermes sends what nobody addressed: "gateway shutting down", operator
   pings, and any cron job that names a platform but no chat. It lives in
   hermes's own .env, so this rewrites that one line and restarts the gateway —
   which reads the value at startup and never again. */
function HomeChannelPicker({ chats, current, onChanged }: { chats: Chat[]; current: string; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  const known = chats.find((c) => c.jid === current)

  async function save(jid: string) {
    if (jid === current) return
    setBusy(true)
    try {
      const r = await post<{ restarted?: boolean }>('/api/settings/home_channel', { jid })
      toast(r.restarted ? 'saved — gateway restarted ✓' : 'saved ✓')
      onChanged()
    } catch (e) {
      toast((e as Error).message, false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Field
      label="chat that receives shutdown notices and unaddressed cron jobs"
      hint={
        busy
          ? 'restarting the gateway…'
          : current
            ? 'She will be unavailable for a few seconds after you change this.'
            : 'Nothing set: system notices go nowhere.'
      }
    >
      <select
        value={current}
        disabled={busy}
        onChange={(e) => void save(e.target.value)}
        className="h-10 w-full max-w-md cursor-pointer rounded-card border border-line bg-card-2 px-3 text-[0.9rem] text-ink disabled:opacity-50"
      >
        <option value="">— nowhere —</option>
        {/* A jid hermes knows but the directory has not seen yet must still
            show as the current value rather than silently reading "nowhere". */}
        {current && !known && <option value={current}>{current}</option>}
        {chats.map((c) => (
          <option key={c.jid} value={c.jid}>
            {c.label || c.name || c.jid}
          </option>
        ))}
      </select>
    </Field>
  )
}

function ChatsBody({ settings, onChanged }: { settings: Settings; onChanged: () => void }) {
  const chats = useApi<{ chats: Chat[] }>('/api/chats')
  const defaults = settings.bindings?.defaults ?? {}
  const pros = (settings.proactive ?? []) as Pro[]

  const proFor = (c: Chat) =>
    pros.find(
      (p) =>
        (p as unknown as { chat_id?: string }).chat_id === c.jid ||
        (p as unknown as { deliver?: string }).deliver === c.target
    )

  async function setDefault(patch: Record<string, unknown>) {
    try {
      await post('/api/settings/bindings', { action: 'defaults', ...patch })
      toast('saved ✓')
      onChanged()
    } catch (e) {
      toast((e as Error).message, false)
    }
  }

  return (
    <>
      <Section title="Chats">
        {chats.loading && !chats.data ? (
          <div className="flex items-center gap-2 text-muted">
            <Spinner /> loading…
          </div>
        ) : (
          (() => {
            /* The list was already sorted live-then-pending, and nothing said
               so: a number nobody has ever spoken to rendered identically to a
               conversation running for months, same weight, same card. The
               split is the one distinction on this page that changes what the
               settings even mean — a pending row is configured in advance and
               applies the moment they write. */
            const all = chats.data?.chats ?? []
            const live = all.filter((c) => !c.pending)
            const waiting = all.filter((c) => c.pending)
            const render = (c: Chat) => (
              <ChatCard
                key={c.target}
                chat={c}
                settings={settings}
                pro={proFor(c)}
                onChanged={() => {
                  chats.reload()
                  onChanged()
                }}
              />
            )
            if (!all.length) {
              return (
                <Empty>
                  No chats yet — a chat appears here after its first message, because WhatsApp offers no way to list
                  them up front.
                </Empty>
              )
            }
            return (
              <div className="flex flex-col gap-6">
                <Card className="overflow-hidden p-0">{live.map(render)}</Card>

                {waiting.length > 0 && (
                  <div>
                    <div className="mb-2 flex items-baseline gap-3">
                      <h3 className="m-0 font-mono text-[0.68rem] tracking-[0.11em] text-muted uppercase">
                        Waiting to hear from them
                      </h3>
                      <span className="h-px flex-1 bg-line" aria-hidden />
                      <span className="text-[0.78rem] text-faint">{waiting.length} allowed, none has written</span>
                    </div>
                    <Card className="overflow-hidden p-0">{waiting.map(render)}</Card>
                  </div>
                )}
              </div>
            )
          })()
        )}
      </Section>

      <Section title="Who may message her">
        <Allowlist />
      </Section>

      <Section title="System notices">
        <Card className="p-5">
          <HomeChannelPicker
            chats={chats.data?.chats ?? []}
            current={settings.home_channel ?? ''}
            onChanged={onChanged}
          />
        </Card>
      </Section>

      <Section title="Everywhere else">
        <Card className="p-5">
          <p className="mt-0 mb-4 max-w-prose text-[0.92rem] text-muted">
            What she does in a chat you have not configured — including someone brand new messaging her for the first
            time.
          </p>
          <div className="flex flex-wrap gap-6">
            <Field label="who she is">
              <Segmented
                options={(settings.personalities ?? []) as string[]}
                value={defaults.personality}
                onChange={(v) => void setDefault({ personality: v })}
              />
            </Field>
            <Field label="how she behaves">
              <Segmented
                options={(settings.modes ?? []) as string[]}
                value={defaults.mode}
                onChange={(v) => void setDefault({ mode: v })}
              />
            </Field>
          </div>
          {/* There was a toggle here that granted computer access to every
              chat nobody had configured — on WhatsApp, anyone who finds the
              number. It is gone, and not merely hidden: profiles.agent_access
              ignores the defaults block, and the API refuses to write an
              agent key into it at all. Access is granted per named chat. */}
          <p className="mt-6 mb-0 flex max-w-prose items-start gap-2 text-[0.86rem] text-muted">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-up" />
            <span>
              Unconfigured chats can never run commands on this machine. Grant computer access on a named chat above.
            </span>
          </p>
        </Card>
      </Section>
    </>
  )
}

export default function ChatsPage() {
  const settings = useApi<Settings>('/api/settings')
  const chats = useApi<{ chats: Chat[] }>('/api/chats')

  const total = chats.data?.chats?.length ?? 0
  const starts = ((settings.data?.proactive ?? []) as Pro[]).filter((p) => p.enabled).length

  return (
    <Shell
      page="chats"
      title="Chats"
      hero={
        /* "She opens 1 of them herself" said nothing to a reader who had not
           written it: `opens` is not a verb this product uses anywhere else,
           and `herself` restates it. The count is of chats where she messages
           without being messaged, and the toggle that sets it is labelled "She
           messages first here" — so the head says that, in those words. It
           also ran the number straight into the text ("opens1"), and both
           branches of its plural test were identical. */
        total
          ? [
              { n: String(total) },
              { t: total === 1 ? ' chat. ' : ' chats. ' },
              ...(starts
                ? ([{ t: 'She messages first in ' }, { n: String(starts) }, { t: '.' }] as const)
                : ([{ t: 'She never messages first.' }] as const))
            ]
          : [{ t: 'No chats yet' }]
      }
    >
      {settings.loading && !settings.data ? (
        <div className="flex items-center gap-2 text-muted">
          <Spinner /> loading…
        </div>
      ) : settings.error ? (
        <Empty>{settings.error}</Empty>
      ) : settings.data ? (
        <ChatsBody settings={settings.data} onChanged={settings.reload} />
      ) : null}

      <Toaster />
    </Shell>
  )
}
