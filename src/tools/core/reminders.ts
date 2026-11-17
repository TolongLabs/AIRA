import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import type { Logger } from '../../records/logger.js'
import { isoNow, type Storage } from '../../storage/database.js'
import type { ToolPorts } from '../ports.js'
import type { ToolDefinition } from '../types.js'

/**
 * Rewrites the wanted-jobs file after a committed change. A failure leaves the row as it is: the file is written
 * again at the next change and at start-up.
 */
function syncSchedule(ports: ToolPorts, logger: Logger, turnId: string, reminderId: string): void {
  try {
    ports.schedule?.sync()
  } catch (error) {
    logger.warn('reminder_schedule_sync_failed', { turnId, reminderId, error })
  }
}

const reminderSetSchema = z.strictObject({
  text: z.string().trim().min(1).max(500),
  dueAt: z.iso.datetime({ offset: true }),
  repeat: z.enum(['daily', 'weekly', 'monthly']).optional()
})

const reminderListSchema = z.strictObject({})

const reminderCancelSchema = z.strictObject({
  reminderId: z.string().trim().min(1)
})

interface ReminderRow {
  reminder_id: string
  chat_id: string
  owner_id: string
  target_id: string
  state: 'active' | 'fired' | 'cancelled'
  due_at: string
  repeat: string | null
  text: string
  gateway_job_id: string | null
}

type CancelRow = Pick<ReminderRow, 'chat_id' | 'owner_id' | 'state'>

export function reminderSetTool(
  _storage: Storage,
  ports: ToolPorts,
  logger: Logger
): ToolDefinition<z.infer<typeof reminderSetSchema>> {
  return {
    name: 'reminder_set',
    description: 'Creates one reminder for this chat.',
    schema: reminderSetSchema,
    mode: 'both',
    mutates: true,
    feature: 'features.reminders',
    command: {
      names: ['remind'],
      kind: 'skill',
      usage: '/remind <when and what>'
    },
    async handler(args, context) {
      const dueMs = Date.parse(args.dueAt)
      if (!Number.isFinite(dueMs) || dueMs <= context.now().getTime()) {
        return { ok: false, kind: 'invalid', reason: 'dueAt must be in the future' }
      }
      const dueAt = new Date(dueMs).toISOString()

      const { data } = context.commit((db) => {
        const reminderId = `rem_${randomBytes(6).toString('hex')}`
        const at = isoNow(context.now)
        db.prepare(
          `INSERT INTO reminder (
             reminder_id, chat_id, owner_id, target_id, state, due_at, repeat, text, gateway_job_id, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, NULL, ?, ?)`
        ).run(
          reminderId,
          context.chat.chatId,
          context.senderId,
          context.senderId,
          dueAt,
          args.repeat ?? null,
          args.text,
          at,
          at
        )

        return {
          data: { reminderId, dueAt },
          receipt: {
            kind: 'reminder.created',
            target: reminderId,
            state: { dueAt, repeat: args.repeat ?? null }
          }
        }
      })

      syncSchedule(ports, logger, context.turnId, data.reminderId)

      return { ok: true, data }
    }
  }
}

export function reminderListTool(storage: Storage): ToolDefinition<z.infer<typeof reminderListSchema>> {
  return {
    name: 'reminder_list',
    description: 'Lists the active reminders of this chat.',
    schema: reminderListSchema,
    mode: 'both',
    mutates: false,
    feature: 'features.reminders',
    command: {
      names: ['reminders'],
      kind: 'direct',
      usage: '/reminders',
      directArgs: () => ({})
    },
    handler(_args, context) {
      const rows = storage.read(
        (db) =>
          db
            .prepare(
              `SELECT reminder_id, owner_id, due_at, repeat, text
               FROM reminder
               WHERE chat_id = ? AND state = 'active'
               ORDER BY due_at ASC`
            )
            .all(context.chat.chatId) as Pick<ReminderRow, 'reminder_id' | 'owner_id' | 'due_at' | 'repeat' | 'text'>[]
      )
      const reminders = rows.map((row) => ({
        reminderId: row.reminder_id,
        dueAt: row.due_at,
        repeat: row.repeat,
        text: row.text,
        mine: row.owner_id === context.senderId
      }))
      return { ok: true, data: { reminders } }
    }
  }
}

export function reminderCancelTool(
  storage: Storage,
  ports: ToolPorts,
  logger: Logger
): ToolDefinition<z.infer<typeof reminderCancelSchema>> {
  return {
    name: 'reminder_cancel',
    description: 'Cancels one active reminder owned by the sender in this chat.',
    schema: reminderCancelSchema,
    mode: 'both',
    mutates: true,
    feature: 'features.reminders',
    command: {
      names: ['cancel'],
      kind: 'skill',
      usage: '/cancel <reminder>'
    },
    async handler(args, context) {
      const row = storage.read(
        (db) =>
          db
            .prepare('SELECT chat_id, owner_id, state FROM reminder WHERE reminder_id = ? AND chat_id = ?')
            .get(args.reminderId, context.chat.chatId) as CancelRow | undefined
      )

      // A reminder of another chat is treated as one that does not exist: nothing about it leaves its chat.
      if (!row) {
        return { ok: false, kind: 'refused', reason: 'no such reminder in this chat' }
      }
      if (row.owner_id !== context.senderId) {
        return { ok: false, kind: 'refused', reason: 'reminder belongs to another member' }
      }
      if (row.state !== 'active') {
        return { ok: false, kind: 'refused', reason: `reminder is ${row.state}` }
      }

      const { data } = context.commit((db) => {
        const updated = db
          .prepare(
            `UPDATE reminder SET state = 'cancelled', updated_at = ?
             WHERE reminder_id = ? AND chat_id = ? AND owner_id = ? AND state = 'active'`
          )
          .run(isoNow(context.now), args.reminderId, context.chat.chatId, context.senderId)
        if (updated.changes !== 1) {
          throw new Error('reminder could not be cancelled')
        }
        return {
          data: { reminderId: args.reminderId },
          receipt: { kind: 'reminder.cancelled', target: args.reminderId }
        }
      })

      syncSchedule(ports, logger, context.turnId, args.reminderId)

      return { ok: true, data }
    }
  }
}
