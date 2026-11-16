import { describe, expect, it } from 'vitest'
import { compactDue, scheduledTag } from '../../src/gateway/schedule.js'
import { nextDue } from '../../src/turn/pipeline.js'

describe('reminder schedule', () => {
  it('writes a due time and a tag the way the gateway job carries them', () => {
    expect(compactDue('2026-11-17T08:00:00.000Z')).toBe('20261117T080000Z')
    expect(compactDue('2026-11-17T16:00:00+08:00')).toBe('20261117T080000Z')
    expect(scheduledTag('rem_ab12', '2026-11-17T08:00:00Z')).toBe(
      '[AIRA-SCHEDULED v1 kind=reminder id=rem_ab12 due=20261117T080000Z]'
    )
  })

  it('moves a repeating reminder past now, skipping the times it missed', () => {
    const now = new Date('2026-11-16T12:00:00.000Z')
    expect(nextDue('2026-11-16T09:00:00.000Z', 'daily', now)).toBe('2026-11-17T09:00:00.000Z')
    expect(nextDue('2026-11-01T09:00:00.000Z', 'daily', now)).toBe('2026-11-17T09:00:00.000Z')
    expect(nextDue('2026-11-16T09:00:00.000Z', 'weekly', now)).toBe('2026-11-23T09:00:00.000Z')
    expect(nextDue('2026-10-16T09:00:00.000Z', 'monthly', now)).toBe('2026-12-16T09:00:00.000Z')
    expect(nextDue('2027-01-31T09:00:00.000Z', 'monthly', new Date('2027-02-01T00:00:00.000Z'))).toBe(
      '2027-02-28T09:00:00.000Z'
    )
    expect(() => nextDue('2026-11-16T09:00:00.000Z', 'hourly', now)).toThrow()
  })
})
