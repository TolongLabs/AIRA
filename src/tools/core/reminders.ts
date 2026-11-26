import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { type ReminderScope, sameReminderScope } from '../../gateway/reminder-scope.js'
import type { Logger } from '../../records/logger.js'
import { isoNow, type Storage } from '../../storage/database.js'
import type { TurnContext } from '../../turn/types.js'
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
export type ReminderScopeFor = (context: TurnContext) => ReminderScope | null

const scopeRefused = () => ({ ok: false, kind: 'refused', reason: 'reminder route is unavailable' }) as const

function checkScope(
  scopeFor: ReminderScopeFor | undefined,
  scope: ReminderScope | undefined | null,
  context: TurnContext
): void {
  if (scopeFor && (!scope || !sameReminderScope(scopeFor(context), scope))) throw new Error('reminder route changed')
}

export function reminderSetTool(
  _storage: Storage,
  ports: ToolPorts,
  logger: Logger,
  scopeFor?: ReminderScopeFor
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
      const scope = scopeFor?.(context)
      if (scopeFor && !scope) return scopeRefused()
      const dueMs = Date.parse(args.dueAt)
      if (!Number.isFinite(dueMs) || dueMs <= context.now().getTime()) {
        return { ok: false, kind: 'invalid', reason: 'dueAt must be in the future' }
      }
      const dueAt = new Date(dueMs).toISOString()

      const { data } = context.commit((db) => {
        checkScope(scopeFor, scope, context)
        const reminderId = `rem_${randomBytes(6).toString('hex')}`
        const at = isoNow(context.now)
        db.prepare(
          `INSERT INTO reminder (
             reminder_id, chat_id, owner_id, target_id, state, due_at, repeat, text, gateway_job_id, created_at, updated_at,
             standalone_route_id, standalone_profile
           ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, NULL, ?, ?, ?, ?)`
        ).run(
          reminderId,
          context.chat.chatId,
          context.senderId,
          context.senderId,
          dueAt,
          args.repeat ?? null,
          args.text,
          at,
          at,
          scope?.routeId ?? null,
          scope?.profile ?? null
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

      if (!scopeFor) syncSchedule(ports, logger, context.turnId, data.reminderId)

      return { ok: true, data }
    }
  }
}

export function reminderListTool(
  storage: Storage,
  scopeFor?: ReminderScopeFor
): ToolDefinition<z.infer<typeof reminderListSchema>> {
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
      const scope = scopeFor?.(context)
      if (scopeFor && !scope) return scopeRefused()
      const rows = storage.read(
        (db) =>
          db
            .prepare(
              `SELECT reminder_id, owner_id, due_at, repeat, text
               FROM reminder
               WHERE chat_id = ? AND state = 'active'
                 AND standalone_route_id IS ? AND standalone_profile IS ?
               ORDER BY due_at ASC`
            )
            .all(context.chat.chatId, scope?.routeId ?? null, scope?.profile ?? null) as Pick<
            ReminderRow,
            'reminder_id' | 'owner_id' | 'due_at' | 'repeat' | 'text'
          >[]
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
  logger: Logger,
  scopeFor?: ReminderScopeFor
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
      const scope = scopeFor?.(context)
      if (scopeFor && !scope) return scopeRefused()
      const row = storage.read(
        (db) =>
          db
            .prepare(
              'SELECT chat_id, owner_id, state FROM reminder WHERE reminder_id = ? AND chat_id = ? AND standalone_route_id IS ? AND standalone_profile IS ?'
            )
            .get(args.reminderId, context.chat.chatId, scope?.routeId ?? null, scope?.profile ?? null) as
            CancelRow | undefined
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
        checkScope(scopeFor, scope, context)
        const updated = db
          .prepare(
            `UPDATE reminder SET state = 'cancelled', updated_at = ?
             WHERE reminder_id = ? AND chat_id = ? AND owner_id = ? AND state = 'active'
               AND standalone_route_id IS ? AND standalone_profile IS ?`
          )
          .run(
            isoNow(context.now),
            args.reminderId,
            context.chat.chatId,
            context.senderId,
            scope?.routeId ?? null,
            scope?.profile ?? null
          )
        if (updated.changes !== 1) {
          throw new Error('reminder could not be cancelled')
        }
        return {
          data: { reminderId: args.reminderId },
          receipt: { kind: 'reminder.cancelled', target: args.reminderId }
        }
      })

      if (!scopeFor) syncSchedule(ports, logger, context.turnId, args.reminderId)

      return { ok: true, data }
    }
  }
}
