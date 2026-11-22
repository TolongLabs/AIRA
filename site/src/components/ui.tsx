import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from '@radix-ui/react-slot'
import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

/* ── button ───────────────────────────────────────────────────────────── */

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-card font-semibold ' +
    'whitespace-nowrap transition-colors cursor-pointer disabled:pointer-events-none ' +
    'disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-accent text-on-accent hover:opacity-90',
        outline: 'border border-line bg-transparent text-ink hover:border-line-strong hover:bg-card-2',
        ghost: 'text-muted hover:bg-card-2 hover:text-ink',
        danger: 'border border-transparent text-down hover:bg-down/10'
      },
      size: {
        // 44px floor: these are touch targets on a phone and the readers are older
        // — and the floor is in PIXELS. The root is 19px (styles.css), so
        // min-h-9 measured 42.75px, not 36: the rem scale quietly moved the
        // one variant used for every row action, including the destructive
        // one, to just under the number this comment promises.
        md: 'min-h-11 px-4 text-[0.9rem]',
        sm: 'min-h-[44px] px-3 text-[0.82rem]',
        lg: 'min-h-12 px-6 text-[0.95rem]',
        icon: 'size-10 p-0'
      }
    },
    defaultVariants: { variant: 'outline', size: 'md' }
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean
  /* React 19 hands `ref` through as an ordinary prop, but the type has to
     admit it — ConfirmAction moves focus to its Cancel so that the safe
     option is what Enter and a screen reader land on. */
  ref?: React.Ref<HTMLButtonElement>
}

export function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : 'button'
  return <Comp className={cn(buttonVariants({ variant, size }), className)} {...props} />
}

/* ── surfaces ─────────────────────────────────────────────────────────── */

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        // Liquid glass, not a flat panel: the lit ground and the pointer
        // trail read faintly THROUGH the pane, which is the whole effect. No
        // border — the glass carries its own edge and specular highlight in
        // one box-shadow, and a border on top of that reads as two outlines.
        'glass min-w-0 rounded-card',
        className
      )}
      {...props}
    />
  )
}

/* ── picking one of many ────────────────────────────────────────────────── */

/**
 * A <select> that survives its own list growing.
 *
 * Every chooser in this app was a bare <select>: fine at fifteen chats and
 * three personalities, unusable at a hundred and broken at ten thousand —
 * there is no way to find "Ma" in a native dropdown except to scroll to it,
 * and no browser filters one for you beyond first-letter jumping.
 *
 * Three behaviours, in order of list size:
 *   - short lists render exactly as before, no filter box, no new weight;
 *   - past `searchAfter` a filter appears and takes focus on open;
 *   - past `MAX_RENDERED` matches only the first slice is put in the DOM,
 *     with a line saying how many more there are. Ten thousand <option>
 *     nodes is a locked-up tab, and nobody scrolls to the ten-thousandth
 *     anyway — the answer to a huge list is typing, not scrolling.
 *
 * The panel expands IN FLOW rather than floating. An absolutely positioned
 * menu inside a card that scrolls gets clipped by its own container, and
 * these live inside cards that scroll.
 */
const MAX_RENDERED = 50

export interface PickerOption {
  value: string
  label: string
  /** Second line — a jid, a last-seen, whatever tells two apart. */
  hint?: string
}

export function Picker({
  options,
  value,
  onChange,
  placeholder = 'pick one…',
  searchAfter = 8,
  searchPlaceholder = 'type to filter…',
  className,
  ariaLabel,
  disabled
}: {
  options: PickerOption[]
  value?: string | null
  onChange: (v: string) => void
  placeholder?: string
  searchAfter?: number
  searchPlaceholder?: string
  className?: string
  ariaLabel?: string
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const searchRef = useRef<HTMLInputElement>(null)
  const chosen = options.find((o) => o.value === value) || null
  const searchable = options.length > searchAfter

  useEffect(() => {
    if (open && searchable) searchRef.current?.focus()
    if (!open) {
      setQ('')
      setActive(0)
    }
  }, [open, searchable])

  const needle = q.trim().toLowerCase()
  const matches = needle
    ? options.filter(
        (o) =>
          o.label.toLowerCase().includes(needle) ||
          o.value.toLowerCase().includes(needle) ||
          (o.hint ?? '').toLowerCase().includes(needle)
      )
    : options
  const shown = matches.slice(0, MAX_RENDERED)
  const hidden = matches.length - shown.length

  function commit(v: string) {
    onChange(v)
    setOpen(false)
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      setOpen(false)
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => {
        const next = e.key === 'ArrowDown' ? i + 1 : i - 1
        return Math.max(0, Math.min(shown.length - 1, next))
      })
      return
    }
    if (e.key === 'Enter' && shown[active]) {
      e.preventDefault()
      commit(shown[active].value)
    }
  }

  return (
    <div className={cn('min-w-56', className)} onKeyDown={onKey}>
      <Button
        variant="outline"
        className="w-full justify-between font-normal"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={cn('truncate', !chosen && 'text-muted')}>{chosen ? chosen.label : placeholder}</span>
        <ChevronDown className={cn('shrink-0 transition-transform', open && 'rotate-180')} />
      </Button>

      {open && (
        <div className="mt-1 rounded-card border border-line bg-sunk p-1">
          {searchable && (
            <Input
              ref={searchRef}
              value={q}
              placeholder={searchPlaceholder}
              aria-label="filter the list"
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                setQ(e.target.value)
                setActive(0)
              }}
              className="mb-1"
            />
          )}
          <div role="listbox" className="max-h-72 overflow-y-auto">
            {shown.map((o, i) => (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={o.value === value}
                onMouseEnter={() => setActive(i)}
                onClick={() => commit(o.value)}
                className={cn(
                  'block w-full cursor-pointer rounded-[7px] border-0 px-3 py-2 text-left',
                  'min-h-11 transition-colors',
                  o.value === value
                    ? 'bg-accent-soft text-accent'
                    : i === active
                      ? 'bg-card-2 text-ink'
                      : 'bg-transparent text-read'
                )}
              >
                <span className="block truncate text-[0.9rem]">{o.label}</span>
                {o.hint && <span className="block truncate text-[0.78rem] text-faint">{o.hint}</span>}
              </button>
            ))}
            {!shown.length && <p className="m-0 px-3 py-2 text-[0.85rem] text-muted">nothing matches “{q}”</p>}
            {hidden > 0 && (
              <p className="m-0 px-3 py-2 text-[0.8rem] text-faint">{hidden} more — keep typing to narrow it</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/* ── destroying something ─────────────────────────────────────────────── */

/**
 * The one way this product asks "are you sure".
 *
 * There were five. A label that swapped to "really remove?" on the same
 * button (cron, library, dashboard, three different timeouts), a native
 * window.confirm() that deletes a persona file, and four destructive actions
 * with no confirmation at all — and which an action got tracked how the
 * component was written rather than how much damage it does.
 *
 * The label-swap was the worst of them, because it fails at the one job a
 * confirm has. The confirming click lands on the SAME pixel as the arming
 * click, and the armed button is WIDER than the unarmed one, so it grows out
 * under the cursor: a double-click, a bouncing mouse switch or an iOS
 * double-tap-to-zoom destroys the thing. Nothing was disabled between the two
 * clicks, nothing was announced to a screen reader (an accessible-name change
 * on an already-focused button is not reliably re-read, so the blind failure
 * mode is "press Enter again because nothing happened" — which deletes), and
 * a three-second timer took the decision away from anyone who reads slowly,
 * on a product whose own stylesheet says the readers are older and zoom to
 * 200%.
 *
 * So: the confirm DISPLACES. Arming swaps the whole row for a strip, and the
 * confirming control sits at the far end of it, nowhere near the pixel that
 * armed it. The strip is role="alert", so it is announced; focus moves to
 * Cancel, so the safe option is what Enter hits and Escape also takes; and it
 * does not expire, because a timer on a decision is a time limit on reading.
 *
 * docs/DESIGN.md asks for the warning sentence by name ("Remove = danger
 * treatment, 'This can't be undone.'"), so it is baked in rather than left to
 * each caller to remember.
 */
export function ConfirmAction({
  label,
  question,
  warning = 'This can’t be undone.',
  confirmLabel,
  icon,
  onConfirm,
  disabled,
  size = 'sm',
  className
}: {
  /** The resting control's text, e.g. "remove". */
  label: string
  /** What is about to happen, naming the thing: 'Remove "goodnight"?' */
  question: string
  /** Overridable for the rare action that genuinely IS reversible. */
  warning?: string
  /** Defaults to `label`, title-cased by the caller if it wants. */
  confirmLabel?: string
  icon?: React.ReactNode
  onConfirm: () => void | Promise<unknown>
  disabled?: boolean
  size?: 'sm' | 'md'
  className?: string
}) {
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const cancelRef = useRef<HTMLButtonElement>(null)

  /* The safe option takes focus, so Enter cancels and a screen reader lands
     on a real control inside the announced region rather than nowhere. */
  useEffect(() => {
    if (armed) cancelRef.current?.focus()
  }, [armed])

  async function go() {
    setBusy(true)
    try {
      await onConfirm()
      setArmed(false)
    } catch {
      /* The caller owns the error toast. Stay armed but idle so the operator
         can see the strip, read the failure and decide again — the old code
         left the bare button hot instead, and a stray third click re-fired a
         completed delete and painted a 404 over an operation that worked. */
    } finally {
      setBusy(false)
    }
  }

  if (!armed)
    return (
      <Button
        size={size}
        variant="ghost"
        disabled={disabled}
        className={cn(
          /* Destructive reads destructive BEFORE it is armed. The old ghost
             was `text-muted hover:text-ink`, so hovering the delete made it
             MORE prominent and MORE neutral — identical to hovering edit.
             NOT text-faint, which is what the other remove controls use and
             what I first wrote here: it measures 2.51:1 light and 2.85:1 dark
             against this card, under even the 3:1 large-text floor. --muted
             is 5.64:1 / 6.23:1 and still recedes behind the label text. */
          'text-muted hover:bg-down/10 hover:text-down',
          className
        )}
        onClick={() => setArmed(true)}
      >
        {icon}
        {label}
      </Button>
    )

  return (
    <div
      role="alert"
      className={cn(
        'flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-card',
        'border border-down/40 bg-down/5 px-3 py-2',
        className
      )}
    >
      <p className="m-0 min-w-0 text-[0.82rem] leading-snug text-ink">
        {question} <span className="text-muted">{warning}</span>
      </p>
      <div className="ml-auto flex shrink-0 gap-1">
        <Button
          ref={cancelRef}
          size={size}
          variant="ghost"
          disabled={busy}
          onClick={() => setArmed(false)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setArmed(false)
          }}
        >
          Cancel
        </Button>
        <Button size={size} variant="danger" disabled={busy} className="font-semibold" onClick={() => void go()}>
          {busy ? <Spinner /> : icon}
          {confirmLabel ?? label}
        </Button>
      </div>
    </div>
  )
}

/** Small uppercase mono label — the house kicker. */
export function Kicker({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      className={cn('m-0 font-mono text-[0.68rem] font-medium uppercase tracking-[0.14em] text-muted', className)}
      {...props}
    />
  )
}

export function CardHead({
  title,
  action,
  className
}: {
  title: string
  action?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex items-baseline justify-between gap-3', className)}>
      <Kicker>{title}</Kicker>
      {action}
    </div>
  )
}

/** A titled page region. Sections are how the dashboard stops being soup. */
export function Section({
  title,
  action,
  children
}: {
  title: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="mt-10 first:mt-0">
      <div className="mb-4 flex items-baseline justify-between gap-3 border-b border-line pb-2.5">
        <h2 className="m-0 font-serif text-[1.45rem] font-medium tracking-[-0.01em]">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  )
}

export function Badge({
  className,
  tone = 'neutral',
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & {
  tone?: 'neutral' | 'on' | 'off' | 'accent'
}) {
  const tones = {
    neutral: 'border-line text-muted',
    on: 'border-transparent bg-up/12 text-up',
    off: 'border-transparent bg-muted/12 text-muted',
    accent: 'border-transparent bg-accent-soft text-accent'
  }
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5',
        'font-mono text-[0.68rem] font-medium uppercase tracking-[0.08em]',
        tones[tone],
        className
      )}
      {...props}
    />
  )
}

/* ── forms ────────────────────────────────────────────────────────────── */

export function Field({
  label,
  hint,
  children,
  className
}: {
  label: string
  hint?: string
  children: React.ReactNode
  className?: string
}) {
  /* A <div>, not a <label>. Wrapping the control made the whole row clickable,
     which is right for an input and wrong for a <select>: Firefox re-dispatches
     the label's click to the control and closes the popup in the same tick it
     opened, so the dropdown "does nothing when clicked". Six Fields on the
     settings page hold a select, plus more on Chats and Markets.

     The label text is still bound to its control by htmlFor/id where one is
     given; without an id it is a caption, which is what it was in practice. */
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <span className="text-[0.82rem] font-medium text-muted">{label}</span>
      {children}
      {hint ? <span className="text-[0.78rem] text-faint">{hint}</span> : null}
    </div>
  )
}

const inputBase =
  'w-full min-h-11 rounded-card border border-line bg-sunk px-3 py-2 text-ink ' +
  'placeholder:text-faint focus-visible:border-accent'

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...props },
  ref
) {
  return <input ref={ref} className={cn(inputBase, className)} {...props} />
})

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...props }, ref) {
    return <textarea ref={ref} className={cn(inputBase, 'min-h-24 resize-y leading-relaxed', className)} {...props} />
  }
)

/** Segmented choice — replaces a native select when the options are few. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  className,
  labels
}: {
  options: readonly T[]
  value?: T | null
  onChange: (v: T) => void
  className?: string
  /* The button text when the raw value is not what a person should read —
     "Every day" for `daily`, "Mon" for `Monday`. Without it every caller with
     nice labels had to fall back to a native <select> to get them, which is
     most of the reason bare selects survived in a codebase whose own spec
     says segmented groups replace them. */
  labels?: Partial<Record<T, string>>
}) {
  return (
    <div className={cn('inline-flex flex-wrap gap-1 rounded-card border border-line p-1', className)} role="group">
      {options.map((o) => {
        const on = o === value
        return (
          <button
            key={o}
            type="button"
            aria-pressed={on}
            onClick={() => {
              if (!on) onChange(o)
            }}
            className={cn(
              'min-h-9 cursor-pointer rounded-[7px] border-0 px-3 text-[0.85rem] font-medium capitalize transition-colors',
              on ? 'bg-accent-soft text-accent' : 'bg-transparent text-muted hover:text-ink'
            )}
          >
            {labels?.[o] ?? o}
          </button>
        )
      })}
    </div>
  )
}

/* ── feedback ─────────────────────────────────────────────────────────── */

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cn('inline-block size-4 animate-spin rounded-full border-2 border-line border-t-accent', className)}
      aria-hidden
    />
  )
}

/* A page with nothing in it yet. One grey line was all this used to be, which
   is why every page that wanted to say something useful hand-rolled its own —
   and why the four that didn't just printed a row of zeroes instead.

   `title` and `action` are optional so the plain one-liner still works
   unchanged at every existing call site. */
export function Empty({
  title,
  action,
  children
}: {
  title?: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  if (!title && !action) {
    return <p className="m-0 text-[0.92rem] text-muted">{children}</p>
  }
  return (
    <div className="rounded-card border border-line bg-sunk/40 px-5 py-6">
      {title && <b className="mb-1.5 block font-serif text-[1.15rem] leading-tight font-normal">{title}</b>}
      <p className="m-0 max-w-prose text-[0.92rem] text-muted">{children}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

/* ── metric card ──────────────────────────────────────────────────────────
   Micro label top-left, a filled icon chip top-right, the figure at display
   size, a caption under it. The old tile was a coloured rule over a number
   and a word — legible, but it gave the reader nothing to grab: no sense of
   what the number is OF beyond one word, and no way in. */
export function MetricCard({
  label,
  value,
  caption,
  icon: Icon,
  tint = 'var(--accent)',
  href
}: {
  label: string
  value: React.ReactNode
  caption?: string
  icon?: React.ComponentType<{ className?: string }>
  tint?: string
  href?: string
}) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <p className="m-0 min-w-0 truncate font-mono text-[0.68rem] font-medium tracking-[0.1em] text-muted uppercase">
          {label}
        </p>
        {Icon ? (
          <span
            className="grid size-8 shrink-0 place-items-center rounded-[10px]"
            style={{
              background: `color-mix(in srgb, ${tint} 16%, transparent)`,
              color: tint
            }}
          >
            <Icon className="size-4" />
          </span>
        ) : null}
      </div>
      <p className="tnum m-0 mt-3 font-serif text-[2.4rem] leading-none tracking-[-0.02em]" style={{ color: tint }}>
        {value}
      </p>
      {caption ? <p className="m-0 mt-1.5 text-[0.8rem] text-faint">{caption}</p> : null}
    </>
  )

  if (href)
    return (
      <a href={href} className="glass block rounded-card p-4 no-underline transition-shadow hover:shadow-float sm:p-5">
        {body}
      </a>
    )
  return <Card className="p-5">{body}</Card>
}

/* ── where to go next ─────────────────────────────────────────────────────
   The narrow column beside a first screen. A dashboard that only reports is a
   dead end; this is the part that answers "so what do I do now". */
export function NextCard({
  label,
  detail,
  href,
  icon: Icon,
  count
}: {
  label: string
  detail: string
  href: string
  icon?: React.ComponentType<{ className?: string }>
  count?: number
}) {
  return (
    <a
      href={href}
      className="glass group flex items-center gap-3 rounded-card p-4 no-underline transition-shadow hover:shadow-float"
    >
      {Icon ? (
        <span className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-accent-soft text-accent">
          <Icon className="size-[18px]" />
        </span>
      ) : null}
      <span className="min-w-0 flex-1">
        <span className="block font-medium text-ink">{label}</span>
        <span className="block truncate text-[0.82rem] text-muted">{detail}</span>
      </span>
      {count != null && count > 0 ? (
        <span className="tnum grid h-6 min-w-6 shrink-0 place-items-center rounded-full bg-accent-soft px-1.5 text-[0.72rem] font-semibold text-accent">
          {count}
        </span>
      ) : null}
      <span className="shrink-0 text-muted transition-transform group-hover:translate-x-0.5">→</span>
    </a>
  )
}

/* ── underline tabs ───────────────────────────────────────────────────────
   Layak's newspaper pattern, which is the house one: a full-width hairline,
   generous spacing, the label in ink when active and dropped back when not,
   the count inline in tabular figures, and a 2px accent rule under the active
   tab sitting ON the hairline. No pill, no fill, no floating capsule — a
   capsule of five options reads as a segmented CONTROL, something you toggle,
   when this is navigation between views. */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
  className
}: {
  tabs: { key: T; label: string; count?: number }[]
  value: T
  onChange: (key: T) => void
  label: string
  className?: string
}) {
  return (
    <div role="tablist" aria-label={label} className={cn('border-b border-line', className)}>
      <div className="flex flex-wrap gap-x-7 gap-y-1">
        {tabs.map((t) => {
          const on = t.key === value
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => onChange(t.key)}
              className={cn(
                'relative inline-flex cursor-pointer items-center gap-2 border-0 bg-transparent',
                'py-2.5 text-[0.95rem] font-medium transition-colors',
                on ? 'text-ink' : 'text-muted hover:text-read'
              )}
            >
              <span>{t.label}</span>
              {t.count != null && (
                <span className={cn('tnum font-mono text-[0.7rem]', on ? 'text-muted' : 'text-faint')}>{t.count}</span>
              )}
              {on && <span aria-hidden className="absolute -bottom-px right-0 left-0 h-[2px] rounded-full bg-accent" />}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/* ── switch ───────────────────────────────────────────────────────────── */

export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  /** The sentence that says what OFF means. Aligned under the label, not the
      switch: every caller used to hand-roll this as a sibling <p>, which
      started at the row's left edge and so sat under the track rather than
      under the words it explains. */
  hint?: React.ReactNode
  disabled?: boolean
}) {
  return (
    <label className={cn('flex items-start gap-3', disabled ? 'cursor-not-allowed opacity-55' : 'cursor-pointer')}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
        className={cn(
          // flex-centred rather than absolutely positioned: the knob was
          // 2px high on a 24px track and read as off-centre when on
          'flex h-7 w-12 shrink-0 items-center rounded-full',
          'border p-0.5 transition-colors',
          // A switch is reachable by keyboard and had no visible focus state.
          'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2',
          'focus-visible:ring-offset-card focus-visible:outline-none',
          disabled ? 'cursor-not-allowed' : 'cursor-pointer',
          checked
            ? 'border-accent bg-accent'
            : // On AMOLED, --sunk is #08080a against a #0d0d10 card: an off
              // switch was invisible. A lifted track and a real border is what
              // makes "off" a state you can see rather than an absence.
              'border-line-strong bg-card-2'
        )}
      >
        <span
          className={cn(
            'block size-5 rounded-full transition-transform',
            checked ? 'translate-x-5 bg-on-accent' : 'translate-x-0 bg-faint'
          )}
        />
      </button>
      <span className="min-w-0 flex-1">
        <span className="block text-[0.92rem] leading-7">{label}</span>
        {hint ? (
          <span className="mt-0.5 block max-w-prose text-[0.82rem] leading-relaxed text-muted">{hint}</span>
        ) : null}
      </span>
    </label>
  )
}
