import { describe, expect, it } from 'vitest'
import { CronJobPolicy, CronSchedule } from '../../site/src/lib/cron-schedule.js'

describe('CronSchedule.default and CronSchedule.parse', () => {
  it('creates expected default schedule data', () => {
    const def = CronSchedule.default()
    expect(def.toData()).toEqual({
      mode: 'daily',
      time: '08:30',
      dow: 1,
      dom: 1,
      n: 2
    })
    expect(def.validate()).toBeNull()
    expect(def.toCron()).toBe('30 8 * * *')
  })

  it('round-trips the five supported cron shapes', () => {
    const cases: Array<{ cron: string; mode: string }> = [
      { cron: '30 8 * * *', mode: 'daily' },
      { cron: '0 9 * * 1', mode: 'weekly' },
      { cron: '15 14 5 * *', mode: 'monthly' },
      { cron: '0 */4 * * *', mode: 'hours' },
      { cron: '*/15 * * * *', mode: 'minutes' },
      { cron: '0 0 * * 0', mode: 'weekly' },
      { cron: '59 23 28 * *', mode: 'monthly' }
    ]
    for (const { cron, mode } of cases) {
      const parsed = CronSchedule.parse(cron)
      expect(parsed).not.toBeNull()
      expect(parsed?.mode).toBe(mode)
      expect(parsed?.validate()).toBeNull()
      expect(parsed?.toCron()).toBe(cron)
    }
  })

  it('returns null for unsupported formats and out-of-range fields', () => {
    const rejected = [
      '2026-11-17T08:00:00Z',
      '30m',
      '0 9 * * 1-5',
      '0 8,18 * * *',
      '0 10 1 3 *',
      '0 */30 * * *',
      '0 */24 * * *',
      '0 */0 * * *',
      '*/0 * * * *',
      '*/60 * * * *',
      '60 8 * * *',
      '0 24 * * *',
      '0 8 * * 7',
      '0 8 0 * *',
      '0 8 29 * *',
      '',
      null,
      undefined
    ]
    for (const raw of rejected) {
      expect(CronSchedule.parse(raw)).toBeNull()
    }
  })
})

describe('CronSchedule.withPatch', () => {
  it('clamps out-of-range values and falls back empty or malformed times', () => {
    const base = CronSchedule.default()

    const tooManyHours = base.withPatch({ mode: 'hours', n: 30 })
    expect(tooManyHours.n).toBe(23)
    expect(tooManyHours.maxInterval()).toBe(23)
    expect(tooManyHours.toCron()).toBe('0 */23 * * *')

    const nonPositiveHours = base.withPatch({ mode: 'hours', n: 0 })
    expect(nonPositiveHours.n).toBe(1)
    expect(nonPositiveHours.toCron()).toBe('0 */1 * * *')

    const negativeMinutes = base.withPatch({ mode: 'minutes', n: -4 })
    expect(negativeMinutes.n).toBe(1)
    expect(negativeMinutes.maxInterval()).toBe(59)
    expect(negativeMinutes.toCron()).toBe('*/1 * * * *')

    const tooManyMinutes = base.withPatch({ mode: 'minutes', n: 90 })
    expect(tooManyMinutes.n).toBe(59)
    expect(tooManyMinutes.toCron()).toBe('*/59 * * * *')

    expect(base.withPatch({ mode: 'monthly', dom: 0 }).dom).toBe(1)
    expect(base.withPatch({ mode: 'monthly', dom: 31 }).dom).toBe(28)
    expect(base.withPatch({ mode: 'weekly', dow: -1 }).dow).toBe(0)
    expect(base.withPatch({ mode: 'weekly', dow: 8 }).dow).toBe(6)

    const emptyTime = base.withPatch({ time: '' })
    expect(emptyTime.time).toBe('08:30')
    expect(emptyTime.toCron()).toBe('30 8 * * *')

    const badTime = base.withPatch({ time: '25:99' })
    expect(badTime.time).toBe('08:30')
    expect(badTime.validate()).toBeNull()

    const switchedToHours = base.withPatch({ mode: 'minutes', n: 45 }).withPatch({ mode: 'hours' })
    expect(switchedToHours.n).toBe(23)
    expect(switchedToHours.toCron()).toBe('0 */23 * * *')

    const nanInterval = base.withPatch({ mode: 'minutes', n: Number.NaN })
    expect(nanInterval.n).toBe(2)
    expect(nanInterval.toCron()).toBe('*/2 * * * *')
    expect(base.mode).toBe('daily')
  })

  it('reports validation errors for manually constructed invalid instances and keeps toCron safe', () => {
    const emptyTime = new CronSchedule({ mode: 'daily', time: '', dow: 1, dom: 1, n: 2 })
    expect(emptyTime.validate()).not.toBeNull()
    expect(emptyTime.toCron()).toBe('30 8 * * *')

    const badHours = new CronSchedule({ mode: 'hours', time: '08:30', dow: 1, dom: 1, n: 30 })
    expect(badHours.validate()).not.toBeNull()
    expect(badHours.toCron()).toBe('0 */23 * * *')

    const zeroMinutes = new CronSchedule({ mode: 'minutes', time: '08:30', dow: 1, dom: 1, n: 0 })
    expect(zeroMinutes.validate()).not.toBeNull()
    expect(zeroMinutes.toCron()).toBe('*/1 * * * *')

    const badMonthly = new CronSchedule({ mode: 'monthly', time: '08:30', dow: 1, dom: 31, n: 2 })
    expect(badMonthly.validate()).not.toBeNull()
    expect(badMonthly.toCron()).toBe('30 8 28 * *')

    const badWeekly = new CronSchedule({ mode: 'weekly', time: '08:30', dow: 9, dom: 1, n: 2 })
    expect(badWeekly.validate()).not.toBeNull()
    expect(badWeekly.toCron()).toBe('30 8 * * 6')

    const hoursIgnoresEmptyTime = new CronSchedule({ mode: 'hours', time: '', dow: 1, dom: 1, n: 4 })
    expect(hoursIgnoresEmptyTime.validate()).toBeNull()
    expect(hoursIgnoresEmptyTime.toCron()).toBe('0 */4 * * *')
  })
})

describe('CronJobPolicy', () => {
  it('detects core-managed jobs from name, job_id, or prompt', () => {
    expect(CronJobPolicy.isCoreManaged({ job_id: 'j1', name: 'aira:rem_1:20261117T080000Z' })).toBe(true)
    expect(CronJobPolicy.isCoreManaged({ job_id: 'aira:abc', name: 'water plants' })).toBe(true)
    expect(
      CronJobPolicy.isCoreManaged({
        job_id: 'j2',
        name: 'check in',
        prompt: '  [AIRA-SCHEDULED v1 kind=reminder] hello'
      })
    ).toBe(true)
    expect(
      CronJobPolicy.isCoreManaged({
        job_id: 'j3',
        name: 'check in',
        prompt_preview: '[AIRA-SCHEDULED v1 kind=reminder] hi'
      })
    ).toBe(true)

    expect(
      CronJobPolicy.isCoreManaged({
        job_id: 'user-1',
        name: 'morning check-in',
        prompt: 'Ask how he slept',
        prompt_preview: 'Ask how he slept'
      })
    ).toBe(false)
  })

  it('diffs update payloads and preserves unedited custom schedules', () => {
    const customJob = {
      job_id: 'job-custom',
      name: 'weekdays train',
      schedule: '0 9 * * 1-5',
      prompt: 'Check train delays',
      deliver: 'whatsapp:123'
    }

    expect(CronSchedule.parse(customJob.schedule)).toBeNull()

    const preserved = CronJobPolicy.buildUpdateBody(customJob, {
      name: '  weekdays train updated  ',
      schedule: null,
      scheduleEdited: false,
      prompt: 'Check train delays',
      deliver: 'whatsapp:123'
    })
    expect(preserved).toEqual({
      action: 'update',
      job_id: 'job-custom',
      name: 'weekdays train updated'
    })
    expect('schedule' in preserved).toBe(false)

    const uneditedParsed = CronJobPolicy.buildUpdateBody(
      { ...customJob, schedule: '30 8 * * *' },
      {
        name: 'weekdays train',
        schedule: CronSchedule.parse('30 8 * * *'),
        scheduleEdited: false,
        prompt: 'Check train delays',
        deliver: 'whatsapp:123'
      }
    )
    expect(uneditedParsed).toEqual({ action: 'update', job_id: 'job-custom' })

    const unchangedEdited = CronJobPolicy.buildUpdateBody(
      { ...customJob, schedule: '30 8 * * *' },
      {
        name: 'weekdays train',
        schedule: CronSchedule.default(),
        scheduleEdited: true,
        prompt: 'Check train delays',
        deliver: 'whatsapp:123'
      }
    )
    expect(unchangedEdited).toEqual({ action: 'update', job_id: 'job-custom' })

    const replaced = CronJobPolicy.buildUpdateBody(customJob, {
      name: 'weekdays train',
      schedule: CronSchedule.default(),
      scheduleEdited: true,
      prompt: 'Check bus delays',
      deliver: 'whatsapp:456'
    })
    expect(replaced).toEqual({
      action: 'update',
      job_id: 'job-custom',
      schedule: '30 8 * * *',
      prompt: 'Check bus delays',
      deliver: 'whatsapp:456'
    })
  })

  it('builds create payloads and formats run-limit labels', () => {
    expect(
      CronJobPolicy.buildCreateBody({
        name: '  tea time  ',
        schedule: null,
        prompt: 'Make tea',
        deliver: ''
      })
    ).toEqual({
      action: 'create',
      name: 'tea time',
      schedule: '30 8 * * *',
      prompt: 'Make tea'
    })

    expect(
      CronJobPolicy.buildCreateBody({
        name: 'hourly check',
        schedule: CronSchedule.parse('0 */3 * * *'),
        prompt: 'Check status',
        deliver: 'whatsapp:123'
      })
    ).toEqual({
      action: 'create',
      name: 'hourly check',
      schedule: '0 */3 * * *',
      prompt: 'Check status',
      deliver: 'whatsapp:123'
    })

    expect(CronJobPolicy.runsLabel(undefined)).toBe('')
    expect(CronJobPolicy.runsLabel('forever')).toBe('')
    expect(CronJobPolicy.runsLabel('once')).toBe('')
    expect(CronJobPolicy.runsLabel('1/1')).toBe('')
    expect(CronJobPolicy.runsLabel('3/7')).toBe('4 of 7 runs left')
    expect(CronJobPolicy.runsLabel('7 times')).toBe('7 runs, then it stops')
  })
})

it('omits preview text from a routine rename', () => {
  const job = {
    job_id: 'fixture',
    name: 'before',
    prompt_preview: '[AIRA-SCHEDULED v1 kind=job id=site_' + 'a'.repeat(32) + ']\npreview only…'
  }
  const prompt = CronJobPolicy.editablePrompt(job)
  expect(prompt).toBe('preview only…')
  expect(
    CronJobPolicy.buildUpdateBody(job, { name: 'after', prompt, schedule: null, scheduleEdited: false, deliver: '' })
  ).toEqual({
    action: 'update',
    job_id: 'fixture',
    name: 'after'
  })
})
