export const CRON_MODES = ['daily', 'weekly', 'monthly', 'hours', 'minutes'] as const
export type CronMode = (typeof CRON_MODES)[number]

export const CRON_MODE_LABELS: Record<CronMode, string> = {
  daily: 'Every day',
  weekly: 'Every week',
  monthly: 'Every month',
  hours: 'Every N hours',
  minutes: 'Every N minutes'
}

export interface CronScheduleData {
  mode: CronMode
  time: string
  dow: number
  dom: number
  n: number
}

export interface CronJobLike {
  job_id: string
  name?: string
  schedule?: string
  prompt?: string
  prompt_preview?: string
  deliver?: string
}

export interface CronJobUpdateDraft {
  name: string
  schedule: CronSchedule | null
  scheduleEdited: boolean
  prompt: string
  deliver: string
}

export interface CronJobCreateDraft {
  name: string
  schedule: CronSchedule | null
  prompt: string
  deliver: string
}

const DEFAULT_TIME = '08:30'
const DEFAULT_SCHEDULE_DATA: CronScheduleData = {
  mode: 'daily',
  time: DEFAULT_TIME,
  dow: 1,
  dom: 1,
  n: 2
}

const TIME_PATTERN = /^(\d{1,2}):(\d{2})$/
const DAILY_PATTERN = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/
const WEEKLY_PATTERN = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+(\d)$/
const MONTHLY_PATTERN = /^(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})\s+\*\s+\*$/
const HOURS_PATTERN = /^0\s+\*\/(\d+)\s+\*\s+\*\s+\*$/
const MINUTES_PATTERN = /^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/

function parseTimeParts(raw: string): { hour: number; minute: number } | null {
  const match = raw.trim().match(TIME_PATTERN)
  if (!match || match[1] === undefined || match[2] === undefined) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
  return { hour, minute }
}

function formatTime(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

function normalizeTime(raw: string): string {
  const parts = parseTimeParts(raw)
  return parts ? formatTime(parts.hour, parts.minute) : DEFAULT_TIME
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/** Immutable value object for the five cron shapes supported by the site picker. */
export class CronSchedule {
  readonly mode: CronMode
  readonly time: string
  readonly dow: number
  readonly dom: number
  readonly n: number

  constructor(data: CronScheduleData) {
    this.mode = data.mode
    this.time = data.time
    this.dow = data.dow
    this.dom = data.dom
    this.n = data.n
  }

  static default(): CronSchedule {
    return new CronSchedule(DEFAULT_SCHEDULE_DATA)
  }

  static parse(raw?: string | null): CronSchedule | null {
    const s = String(raw ?? '').trim()
    if (!s) return null

    const daily = s.match(DAILY_PATTERN)
    if (daily && daily[1] !== undefined && daily[2] !== undefined) {
      const minute = Number(daily[1])
      const hour = Number(daily[2])
      if (minute < 0 || minute > 59 || hour < 0 || hour > 23) return null
      return new CronSchedule({ ...DEFAULT_SCHEDULE_DATA, mode: 'daily', time: formatTime(hour, minute) })
    }

    const weekly = s.match(WEEKLY_PATTERN)
    if (weekly && weekly[1] !== undefined && weekly[2] !== undefined && weekly[3] !== undefined) {
      const minute = Number(weekly[1])
      const hour = Number(weekly[2])
      const dow = Number(weekly[3])
      if (minute < 0 || minute > 59 || hour < 0 || hour > 23 || dow < 0 || dow > 6) return null
      return new CronSchedule({ ...DEFAULT_SCHEDULE_DATA, mode: 'weekly', time: formatTime(hour, minute), dow })
    }

    const monthly = s.match(MONTHLY_PATTERN)
    if (monthly && monthly[1] !== undefined && monthly[2] !== undefined && monthly[3] !== undefined) {
      const minute = Number(monthly[1])
      const hour = Number(monthly[2])
      const dom = Number(monthly[3])
      if (minute < 0 || minute > 59 || hour < 0 || hour > 23 || dom < 1 || dom > 28) return null
      return new CronSchedule({ ...DEFAULT_SCHEDULE_DATA, mode: 'monthly', time: formatTime(hour, minute), dom })
    }

    const hours = s.match(HOURS_PATTERN)
    if (hours && hours[1] !== undefined) {
      const n = Number(hours[1])
      if (n < 1 || n > 23) return null
      return new CronSchedule({ ...DEFAULT_SCHEDULE_DATA, mode: 'hours', n })
    }

    const minutes = s.match(MINUTES_PATTERN)
    if (minutes && minutes[1] !== undefined) {
      const n = Number(minutes[1])
      if (n < 1 || n > 59) return null
      return new CronSchedule({ ...DEFAULT_SCHEDULE_DATA, mode: 'minutes', n })
    }

    return null
  }

  withPatch(patch: Partial<CronScheduleData>): CronSchedule {
    const candidateMode = patch.mode ?? this.mode
    const mode = CRON_MODES.includes(candidateMode) ? candidateMode : this.mode
    const maxN = mode === 'hours' ? 23 : 59
    const time = normalizeTime(patch.time ?? this.time)
    const dow = clampInt(patch.dow ?? this.dow, 0, 6, clampInt(this.dow, 0, 6, DEFAULT_SCHEDULE_DATA.dow))
    const dom = clampInt(patch.dom ?? this.dom, 1, 28, clampInt(this.dom, 1, 28, DEFAULT_SCHEDULE_DATA.dom))
    const n = clampInt(patch.n ?? this.n, 1, maxN, clampInt(this.n, 1, maxN, DEFAULT_SCHEDULE_DATA.n))
    return new CronSchedule({ mode, time, dow, dom, n })
  }

  maxInterval(): number {
    return this.mode === 'hours' ? 23 : 59
  }

  validate(): string | null {
    if (!CRON_MODES.includes(this.mode)) return 'Select a valid schedule frequency'
    if (this.mode === 'daily' || this.mode === 'weekly' || this.mode === 'monthly') {
      if (!parseTimeParts(this.time)) return 'Enter a valid time (HH:MM)'
    }
    if (this.mode === 'weekly' && (!Number.isInteger(this.dow) || this.dow < 0 || this.dow > 6)) {
      return 'Day of week must be between 0 and 6'
    }
    if (this.mode === 'monthly' && (!Number.isInteger(this.dom) || this.dom < 1 || this.dom > 28)) {
      return 'Day of month must be between 1 and 28'
    }
    if (this.mode === 'hours' && (!Number.isInteger(this.n) || this.n < 1 || this.n > 23)) {
      return 'Hour interval must be between 1 and 23'
    }
    if (this.mode === 'minutes' && (!Number.isInteger(this.n) || this.n < 1 || this.n > 59)) {
      return 'Minute interval must be between 1 and 59'
    }
    return null
  }

  toCron(): string {
    const parts = parseTimeParts(this.time) ?? { hour: 8, minute: 30 }
    const dow = clampInt(this.dow, 0, 6, DEFAULT_SCHEDULE_DATA.dow)
    const dom = clampInt(this.dom, 1, 28, DEFAULT_SCHEDULE_DATA.dom)
    switch (this.mode) {
      case 'daily':
        return `${parts.minute} ${parts.hour} * * *`
      case 'weekly':
        return `${parts.minute} ${parts.hour} * * ${dow}`
      case 'monthly':
        return `${parts.minute} ${parts.hour} ${dom} * *`
      case 'hours':
        return `0 */${clampInt(this.n, 1, 23, DEFAULT_SCHEDULE_DATA.n)} * * *`
      case 'minutes':
        return `*/${clampInt(this.n, 1, 59, DEFAULT_SCHEDULE_DATA.n)} * * * *`
    }
  }

  toData(): CronScheduleData {
    return {
      mode: this.mode,
      time: this.time,
      dow: this.dow,
      dom: this.dom,
      n: this.n
    }
  }
}

/** Policy helpers for AIRA-managed protection, payload diffing, and run-limit display. */
export class CronJobPolicy {
  static isCoreManaged(job: Partial<Pick<CronJobLike, 'job_id' | 'name' | 'prompt' | 'prompt_preview'>>): boolean {
    if (job.name?.startsWith('aira:')) return true
    if (job.job_id?.startsWith('aira:')) return true
    const prompt = (job.prompt ?? job.prompt_preview ?? '').trimStart()
    return (
      prompt.startsWith('[AIRA-SCHEDULED v1') && !/^\[AIRA-SCHEDULED v1 kind=job id=site_[a-f0-9]{32}\]/.test(prompt)
    )
  }

  static editablePrompt(job?: Pick<CronJobLike, 'prompt' | 'prompt_preview'>): string {
    return (job?.prompt ?? job?.prompt_preview ?? '').replace(
      /^\[(?:AIRA-SCHEDULED v1 kind=job id=site_[a-f0-9]{32}|HERMES-SCOPE [^\]\r\n]+)\]\s*/,
      ''
    )
  }

  static buildUpdateBody(job: CronJobLike, draft: CronJobUpdateDraft): Record<string, unknown> {
    const body: Record<string, unknown> = {
      action: 'update',
      job_id: job.job_id
    }
    const trimmedName = draft.name.trim()
    if (trimmedName !== (job.name ?? '')) body.name = trimmedName
    if (draft.scheduleEdited && draft.schedule !== null) {
      const cron = draft.schedule.toCron()
      if (cron !== job.schedule) body.schedule = cron
    }
    if (draft.prompt !== CronJobPolicy.editablePrompt(job)) body.prompt = draft.prompt
    if (draft.deliver !== (job.deliver ?? '')) body.deliver = draft.deliver
    return body
  }

  static buildCreateBody(draft: CronJobCreateDraft): Record<string, unknown> {
    return {
      action: 'create',
      name: draft.name.trim(),
      schedule: (draft.schedule ?? CronSchedule.default()).toCron(),
      prompt: draft.prompt,
      ...(draft.deliver ? { deliver: draft.deliver } : {})
    }
  }

  /* How many runs a job has left, from Hermes's own wording: "forever",
     "once", "7 times" or "3/7". */
  static runsLabel(repeat?: string): string {
    const r = (repeat ?? '').trim()
    if (!r || r === 'forever' || r === 'once' || r === '1/1') return ''
    const done = r.match(/^(\d+)\/(\d+)$/)
    if (done && done[1] !== undefined && done[2] !== undefined) {
      return `${Number(done[2]) - Number(done[1])} of ${done[2]} runs left`
    }
    const total = r.match(/^(\d+) times$/)
    return total && total[1] !== undefined ? `${total[1]} runs, then it stops` : r
  }
}
