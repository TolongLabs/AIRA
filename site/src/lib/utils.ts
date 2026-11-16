import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/* ── formatting ────────────────────────────────────────────────────────── */

const MIN = 60,
  HOUR = 3600,
  DAY = 86400

export function ago(ts?: number | null): string {
  if (!ts) return ''
  const s = Date.now() / 1000 - ts
  if (s < 90) return 'just now'
  if (s < HOUR * 1.5) return `${Math.round(s / MIN)} min ago`
  if (s < DAY * 1.5) return `${Math.round(s / HOUR)} h ago`
  return `${Math.round(s / DAY)} d ago`
}

export function until(ts?: number | null): string {
  if (!ts) return ''
  const s = ts - Date.now() / 1000
  if (s <= 90) return 'any moment now'
  if (s < HOUR * 1.5) return `in ${Math.round(s / MIN)} min`
  if (s < DAY * 1.5) return `in ${Math.round(s / HOUR)} h`
  return `in ${Math.round(s / DAY)} d`
}

/* What the number is denominated in. A Kuala Lumpur bank at 10.58 and the
   S&P at 6,400 are not the same unit, and a bare number defaults to "dollars"
   in the reader's head — which is wrong for every client outside the US. */
const CURRENCY_MARK: Record<string, string> = {
  USD: '$',
  SGD: 'S$',
  MYR: 'RM',
  JPY: '¥',
  HKD: 'HK$',
  GBP: '£',
  AUD: 'A$',
  EUR: '€',
  CNY: 'CN¥', // distinct from JPY's ¥ on sight
  IDR: 'Rp',
  THB: '฿',
  INR: '₹'
}

export function price(p?: number | null, currency?: string | null): string {
  if (p == null || Number.isNaN(p)) return '—'
  const abs = Math.abs(p)
  const opts: Intl.NumberFormatOptions =
    abs >= 10000
      ? { maximumFractionDigits: 0 }
      : abs >= 100
        ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
        : { minimumFractionDigits: 2, maximumFractionDigits: 4 }
  const n = p.toLocaleString('en-US', opts)
  const cur = String(currency || '').trim()
  if (!cur) return n // indices have no currency at all
  // "GBp" is Yahoo's marker for a London line quoted in PENCE, not pounds —
  // 250.5 there means 250.5p (£2.51). Writing it "£250.50" would overstate
  // the price a hundredfold, so pence keeps its own trailing mark.
  if (cur === 'GBp') return `${n}p`
  const mark = CURRENCY_MARK[cur]
  return mark ? `${mark}${n}` : `${n} ${cur}`
}

export function num(n?: number | null): string {
  return (n ?? 0).toLocaleString('en-US')
}

/** Middle-truncate an id so both ends stay recognisable. */
export function midTrunc(s: string, max = 20): string {
  if (!s || s.length <= max) return s
  const k = Math.floor((max - 1) / 2)
  return `${s.slice(0, k)}…${s.slice(-k)}`
}

/* ── cron, in words ───────────────────────────────────────────────────────
   Users never see raw cron syntax in this app. Anything the parser does not
   recognise falls through as typed rather than being mangled. */

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
]
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export function humanSchedule(raw?: string | null): string {
  const s = String(raw ?? '').trim()
  const at = (m: string, h: string) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`

  let m = s.match(/^(\d{1,2}) (\d{1,2}) \* \* \*$/)
  if (m) return `Every day at ${at(m[1], m[2])}`
  m = s.match(/^(\d{1,2}) (\d{1,2}) \* \* (\d)$/)
  if (m) return `Every ${DAYS[+m[3]]} at ${at(m[1], m[2])}`
  m = s.match(/^(\d{1,2}) (\d{1,2}) (\d{1,2}) \* \*$/)
  if (m) return `Monthly on day ${+m[3]} at ${at(m[1], m[2])}`
  /* A specific day of a specific month — the once-a-year shape. Without it
     the annual top-up reminder printed "0 10 1 3 *" on its card. */
  m = s.match(/^(\d{1,2}) (\d{1,2}) (\d{1,2}) (\d{1,2}) \*$/)
  if (m) return `Every ${+m[3]} ${MONTHS[+m[4] - 1] ?? m[4]} at ${at(m[1], m[2])}`
  m = s.match(/^0 \*\/(\d+) \* \* \*$/)
  if (m) return +m[1] === 1 ? 'Every hour' : `Every ${m[1]} hours`
  m = s.match(/^\*\/(\d+) \* \* \* \*$/)
  if (m) return `Every ${m[1]} minutes`
  m = s.match(/^(\d+)m$/)
  if (m) return `Every ${m[1]} minutes`
  m = s.match(/^(\d+)h$/)
  if (m) return +m[1] === 1 ? 'Every hour' : `Every ${m[1]} hours`
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) {
    const d = new Date(s)
    if (!Number.isNaN(d.valueOf()))
      return `Once, ${d.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
      })}`
  }

  /* Everything above is a named shape. Below is the general case, which is
     what "0 6,7,17,18 * * 1-5" is — four hours and a weekday range, matching
     none of the patterns, so the card fell through to `return s` and printed
     the raw crontab line at a family reading their train alerts. */
  const f = s.split(/\s+/)
  if (f.length === 5 && f[2] === '*' && f[3] === '*') {
    const mins = expand(f[0], 0, 59)
    const hrs = expand(f[1], 0, 23)
    const when = weekdays(f[4])
    /* A cross product, so cap it: "every 5 minutes past six hours" is 72
       times and a worse answer than the crontab line it replaced. */
    if (mins && hrs && when && mins.length * hrs.length <= 8) {
      const times: string[] = []
      for (const h of hrs) for (const mi of mins) times.push(at(String(mi), String(h)))
      return `${when} at ${times.join(', ')}`
    }
  }
  return s
}

/* "6,7,17,18" / "1-5" / "9" / "*" → the numbers, or null when this is
   something more exotic than the caller can render. Null means "say nothing",
   never "assume all": guessing wrong here mislabels when a job runs. */
function expand(field: string, lo: number, hi: number): number[] | null {
  if (field === '*') return lo === 0 && hi === 59 ? [0] : null
  const out: number[] = []
  for (const part of field.split(',')) {
    const range = part.match(/^(\d{1,2})-(\d{1,2})$/)
    if (range) {
      const a = +range[1]
      const b = +range[2]
      if (a > b || a < lo || b > hi) return null
      for (let i = a; i <= b; i++) out.push(i)
      continue
    }
    if (!/^\d{1,2}$/.test(part)) return null
    const v = +part
    if (v < lo || v > hi) return null
    out.push(v)
  }
  if (!out.length) return null
  return [...new Set(out)].sort((a, b) => a - b)
}

function weekdays(field: string): string | null {
  if (field === '*') return 'Every day'
  const d = expand(field, 0, 6)
  if (!d) return null
  if (d.length === 7) return 'Every day'
  if (d.join() === '1,2,3,4,5') return 'Weekdays'
  if (d.join() === '0,6') return 'Weekends'
  if (d.length === 1) return `Every ${DAYS[d[0]]}`
  return d.map((n) => DAYS[n].slice(0, 3)).join(', ')
}

export { DAYS }
