import { join } from 'node:path'
import type { Db, Storage } from '../storage/database.js'
import { writeFileAtomic } from '../storage/files.js'

// The reminders the core wants the gateway's schedule to fire (docs/trd/system.md#scheduled-turns). The core
// never calls the gateway: it writes this file, and the host reconciler makes the gateway's jobs match it.

/** A due time as the tag and job name carry it: UTC, `YYYYMMDDTHHMMSSZ`. */
export function compactDue(iso: string): string {
  return new Date(iso)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')
}

/** The text of the gateway job for one firing. It names the reminder and the due time, nothing else. */
export function scheduledTag(reminderId: string, dueAt: string): string {
  return `[AIRA-SCHEDULED v1 kind=reminder id=${reminderId} due=${compactDue(dueAt)}]`
}

export interface ScheduleEntry {
  id: string
  /** The chat's WhatsApp id: where the gateway delivers. */
  chat: string
  due: string
  /** The gateway job's name. The reconciler owns every job whose name starts with `aira:`. */
  name: string
  /** The gateway job's text. */
  text: string
}

export function scheduleEntries(db: Db): ScheduleEntry[] {
  const rows = db
    .prepare(
      `SELECT reminder.reminder_id AS id, chat.wa_id AS chat, reminder.due_at AS due
       FROM reminder JOIN chat ON chat.chat_id = reminder.chat_id
       WHERE reminder.state = 'active' AND reminder.standalone_route_id IS NULL
       ORDER BY reminder.due_at, reminder.reminder_id`
    )
    .all() as { id: string; chat: string; due: string }[]
  const reminders = rows.map((row) => ({
    ...row,
    name: `aira:${row.id}:${compactDue(row.due)}`,
    text: scheduledTag(row.id, row.due)
  }))
  const research = db
    .prepare(
      `SELECT research_job.job_id AS id, chat.wa_id AS chat,
    coalesce(research_job.ended_at, research_job.updated_at) AS due
    FROM research_job JOIN chat ON chat.chat_id = research_job.chat_id
    WHERE research_job.state IN ('done', 'failed') AND research_job.delivered_at IS NULL
    ORDER BY due, research_job.job_id`
    )
    .all() as { id: string; chat: string; due: string }[]
  return [
    ...reminders,
    ...research.map((row) => ({
      ...row,
      name: `aira:${row.id}:${compactDue(row.due)}`,
      text: `[AIRA-SCHEDULED v1 kind=research id=${row.id}]`
    }))
  ]
}

/** Writes the wanted jobs to `<dataDir>/gateway/schedule.json`, atomically. Returns how many it wrote. */
export function writeScheduleFile(storage: Storage, dataDir: string, now: () => Date = () => new Date()): number {
  const reminders = storage.read((db) => scheduleEntries(db))
  const body = { version: 1, writtenAt: now().toISOString(), reminders }
  writeFileAtomic(join(dataDir, 'gateway', 'schedule.json'), `${JSON.stringify(body, null, 2)}\n`)
  return reminders.length
}
