import { describe, expect, it } from 'vitest'
import { inQuietHours, mayDeliver } from '../../src/turn/deliver.js'

const night = { start: '22:00', end: '07:00', timeZone: 'Asia/Kuala_Lumpur' }
// 15:30 UTC is 23:30 in the quiet window's time zone; 04:00 UTC is 12:00 there.
const duringQuiet = new Date('2026-01-01T15:30:00.000Z')
const duringDay = new Date('2026-01-01T04:00:00.000Z')
const mutedByAlice = { by: 's_alice', at: '2026-01-01T00:00:00.000Z' }

describe('mayDeliver', () => {
  it('always allows a reply to a user message', () => {
    expect(mayDeliver({ muted: mutedByAlice, quietHours: night }, { kind: 'reply' }, duringQuiet)).toEqual({
      allowed: true
    })
  })

  it.each([{ kind: 'proactive' as const }, { kind: 'routine' as const }])(
    'blocks a $kind message while muted',
    (kind) => {
      expect(mayDeliver({ muted: mutedByAlice }, kind, duringDay)).toEqual({ allowed: false, reason: 'muted' })
    }
  )

  it.each([{ kind: 'proactive' as const }, { kind: 'routine' as const }])(
    'blocks a $kind message in quiet hours',
    (kind) => {
      expect(mayDeliver({ muted: false, quietHours: night }, kind, duringQuiet)).toEqual({
        allowed: false,
        reason: 'quiet'
      })
      expect(mayDeliver({ muted: false, quietHours: night }, kind, duringDay)).toEqual({ allowed: true })
    }
  )

  it('blocks a reminder set by someone else while muted or quiet', () => {
    const reminder = { kind: 'reminder' as const, owner: 's_bob', target: 's_alice' }
    expect(mayDeliver({ muted: mutedByAlice }, reminder, duringDay)).toEqual({ allowed: false, reason: 'muted' })
    expect(mayDeliver({ muted: false, quietHours: night }, reminder, duringQuiet)).toEqual({
      allowed: false,
      reason: 'quiet'
    })
  })

  it('fires a reminder a member set for themselves in quiet hours, but not during a mute they set', () => {
    const own = { kind: 'reminder' as const, owner: 's_alice', target: 's_alice' }
    expect(mayDeliver({ muted: false, quietHours: night }, own, duringQuiet)).toEqual({ allowed: true })
    expect(mayDeliver({ muted: mutedByAlice, quietHours: night }, own, duringDay)).toEqual({
      allowed: false,
      reason: 'muted'
    })
  })
})

describe('inQuietHours', () => {
  it('handles a window that passes midnight, in the window time zone', () => {
    expect(inQuietHours(night, duringQuiet)).toBe(true)
    expect(inQuietHours(night, new Date('2026-01-01T22:59:00.000Z'))).toBe(true) // 06:59 local
    expect(inQuietHours(night, new Date('2026-01-01T23:00:00.000Z'))).toBe(false) // 07:00 local
    expect(inQuietHours(night, duringDay)).toBe(false)
  })

  it('handles a window inside one day, an empty window and no window', () => {
    const nap = { start: '13:00', end: '15:00', timeZone: 'UTC' }
    expect(inQuietHours(nap, new Date('2026-01-01T14:00:00.000Z'))).toBe(true)
    expect(inQuietHours(nap, new Date('2026-01-01T15:00:00.000Z'))).toBe(false)
    expect(inQuietHours({ ...nap, end: '13:00' }, new Date('2026-01-01T13:00:00.000Z'))).toBe(false)
    expect(inQuietHours(undefined, duringQuiet)).toBe(false)
  })
})
