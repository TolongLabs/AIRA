import type { Resolved } from '../settings/settings.js'

// Mute and quiet hours (docs/trd/reliability.md#mute-and-quiet).
// mayDeliver is the only code that answers whether a message may be sent.

export type DeliveryKind =
  /** A reply to a user message. Always allowed. */
  | { kind: 'reply' }
  /** A reminder. `owner` is the subject who set it; `target` is the subject it is for. */
  | { kind: 'reminder'; owner: string; target: string }
  | { kind: 'research'; jobId: string; owner: string }
  | { kind: 'proactive' }
  | { kind: 'routine' }

export interface DeliverySettings {
  /** The resolved `muted` setting: false, or who muted and when. */
  muted: false | { by: string; at: string }
  /** The resolved `quietHours` setting, or undefined when unset. */
  quietHours?: { start: string; end: string; timeZone: string }
}

export function deliverySettings(settings: Record<string, Resolved>): DeliverySettings {
  return {
    muted: (settings['muted']?.value ?? false) as DeliverySettings['muted'],
    quietHours: settings['quietHours']?.value as DeliverySettings['quietHours']
  }
}

export type DeliveryDecision = { allowed: true } | { allowed: false; reason: 'muted' | 'quiet' }

function minutesOfDay(time: string): number {
  const [hours, minutes] = time.split(':').map(Number)
  return (hours ?? 0) * 60 + (minutes ?? 0)
}

/** True when `now` falls inside the quiet window, in the window's own time zone. A window may pass midnight. */
export function inQuietHours(quiet: DeliverySettings['quietHours'], now: Date): boolean {
  if (!quiet) return false
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: quiet.timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(now)
  const part = (type: string) => Number(parts.find((item) => item.type === type)?.value ?? 0)
  const current = part('hour') * 60 + part('minute')
  const start = minutesOfDay(quiet.start)
  const end = minutesOfDay(quiet.end)
  if (start === end) return false
  return start < end ? current >= start && current < end : current >= start || current < end
}

export function mayDeliver(settings: DeliverySettings, delivery: DeliveryKind, now: Date): DeliveryDecision {
  if (delivery.kind === 'reply' || delivery.kind === 'research') return { allowed: true }
  const quiet = inQuietHours(settings.quietHours, now)
  if (delivery.kind === 'reminder' && delivery.owner === delivery.target) {
    // A reminder a member set for themselves fires during quiet hours, but not during a mute they set.
    if (settings.muted !== false && settings.muted.by === delivery.owner) return { allowed: false, reason: 'muted' }
    return { allowed: true }
  }
  if (settings.muted !== false) return { allowed: false, reason: 'muted' }
  if (quiet) return { allowed: false, reason: 'quiet' }
  return { allowed: true }
}
