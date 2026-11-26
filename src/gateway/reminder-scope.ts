import { getChat } from '../settings/chats.js'
import { resolveSetting, resolveSettings } from '../settings/settings.js'
import { isoNow, type Storage } from '../storage/database.js'
import { deliverySettings, mayDeliver } from '../turn/deliver.js'

export interface ReminderScope {
  routeId: string
  profile: string
}

export interface ReminderOccurrence extends ReminderScope {
  reminderId: string
  dueAt: string
}

export const PORTABLE_REMINDER_PREFIX = 'portable-reminder-'
export const portableReminderMid = (reminderId: string, dueAt: string): string =>
  PORTABLE_REMINDER_PREFIX + reminderId + '-' + dueAt

/** Shared session-message read policy (queries alias the row as message). Only answered
 * portable occurrences can appear in ordinary history, never abandoned/declined input. */
export const PORTABLE_HISTORY_VISIBLE = `(?=0 OR message.mid IS NULL OR substr(message.mid,1,?)<>?
  OR EXISTS (SELECT 1 FROM inbound_message i WHERE i.chat_id=message.chat_id
    AND i.mid=message.mid AND i.state='answered'))`
export const portableHistoryArgs = (enabled: boolean) =>
  [Number(enabled), PORTABLE_REMINDER_PREFIX.length, PORTABLE_REMINDER_PREFIX] as const

/** At standalone startup all received reserved occurrences were abandoned by the prior process. */
export function discardInterruptedReminders(storage: Storage, now: () => Date): void {
  storage.tx((db) =>
    db
      .prepare("UPDATE inbound_message SET state='dropped', closed_at=? WHERE state='received' AND substr(mid,1,?)=?")
      .run(isoNow(now), PORTABLE_REMINDER_PREFIX.length, PORTABLE_REMINDER_PREFIX)
  )
}

export const sameReminderScope = (a: ReminderScope | null, b: ReminderScope): boolean =>
  a?.routeId === b.routeId && a.profile === b.profile

export function reminderChatEnabled(storage: Storage, chatId: string): boolean {
  const chat = getChat(storage, chatId)
  return chat?.status === 'active' && resolveSetting(storage, chat, 'features.reminders').value === true
}

/** The same quiet/mute policy as legacy scheduled delivery, checked again before a native claim. */
export function reminderMayDeliver(
  storage: Storage,
  chatId: string,
  owner: string,
  target: string,
  now: Date
): boolean {
  const chat = getChat(storage, chatId)
  if (chat?.status !== 'active') return false
  const settings = resolveSettings(storage, chat)
  if (settings['features.reminders']?.value !== true) return false
  return mayDeliver(deliverySettings(settings), { kind: 'reminder', owner, target }, now).allowed
}
