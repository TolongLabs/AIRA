import { z } from 'zod'
import type { ToolPorts } from '../ports.js'
import type { ToolDefinition } from '../types.js'

const querySchema = z.strictObject({
  query: z.string().trim().min(1).max(200)
})

const noteSchema = z.strictObject({
  text: z.string().trim().min(1).max(500)
})

const forgetSchema = z
  .strictObject({
    itemId: z.string().trim().min(1).optional(),
    query: z.string().trim().min(1).max(200).optional()
  })
  .refine((v) => v.itemId !== undefined || v.query !== undefined, {
    message: 'provide itemId or query'
  })

const lingoSchema = z.strictObject({
  word: z.string().trim().min(1).max(60),
  meaning: z.string().trim().min(1).max(300)
})

export function recallTool(ports: ToolPorts): ToolDefinition<z.infer<typeof querySchema>> {
  return {
    name: 'recall',
    description: 'Searches what AIRA remembers in this chat.',
    schema: querySchema,
    mode: 'both',
    mutates: false,
    command: {
      names: ['recall'],
      kind: 'skill',
      usage: '/recall <query>'
    },
    handler(args, context) {
      if (!ports.memory) {
        return { ok: false, kind: 'unavailable', reason: 'memory is not set up' }
      }
      try {
        const items = ports.memory.recall(context.chat.chatId, args.query, 8, context.senderId)
        return { ok: true, data: { items } }
      } catch {
        return { ok: false, kind: 'error', reason: 'memory recall failed' }
      }
    }
  }
}

export function noteTool(ports: ToolPorts): ToolDefinition<z.infer<typeof noteSchema>> {
  return {
    name: 'note',
    description: 'Writes one fact into this chat memory.',
    schema: noteSchema,
    mode: 'both',
    mutates: true,
    command: {
      names: ['remember'],
      kind: 'skill',
      usage: '/remember <fact>'
    },
    async handler(args, context) {
      const memory = ports.memory
      if (!memory) {
        return { ok: false, kind: 'unavailable', reason: 'memory is not set up' }
      }
      const checked = await memory.checkNote(
        { chatId: context.chat.chatId, subjectId: context.senderId, text: args.text, turnId: context.turnId },
        context.signal
      )
      if (!checked.ok) {
        return { ok: false, kind: 'refused', reason: checked.reason }
      }
      const { data } = context.commit((db) => {
        const { itemId, effect } = memory.note(db, {
          chatId: context.chat.chatId,
          subjectId: context.senderId,
          text: args.text,
          turnId: context.turnId
        })
        return {
          data: { itemId },
          receipt: { kind: 'memory.noted', target: itemId, state: { effect } }
        }
      })
      return { ok: true, data }
    }
  }
}

export function forgetTool(ports: ToolPorts): ToolDefinition<z.infer<typeof forgetSchema>> {
  return {
    name: 'forget',
    description:
      'Forgets one named fact in this chat. A search removes nothing; to remove a fact, call forget again with the itemId of exactly one candidate, or ask the person which one.',
    schema: forgetSchema,
    mode: 'both',
    mutates: true,
    command: {
      names: ['forget'],
      kind: 'skill',
      usage: '/forget <fact>'
    },
    handler(args, context) {
      const memory = ports.memory
      if (!memory) {
        return { ok: false, kind: 'unavailable', reason: 'memory is not set up' }
      }

      if (args.itemId !== undefined) {
        const targetId = args.itemId
        const { data } = context.commit((db) => {
          const forgotten = memory.forget(db, { chatId: context.chat.chatId, itemId: targetId })
          return {
            data: { forgotten, candidates: [] },
            receipt: forgotten ? { kind: 'memory.forgotten', target: targetId } : { kind: 'memory.forget_barrier' }
          }
        })
        return { ok: true, data }
      }

      let candidates: { itemId: string; text: string }[]
      try {
        candidates = memory.recall(context.chat.chatId, args.query ?? '', 8, context.senderId)
      } catch {
        return { ok: false, kind: 'error', reason: 'memory recall failed' }
      }

      const { data } = context.commit((db) => {
        memory.forgetPending(db, { chatId: context.chat.chatId })
        return {
          data: { forgotten: false, candidates },
          receipt: { kind: 'memory.forget_barrier' }
        }
      })
      return { ok: true, data }
    }
  }
}

export function historySearchTool(ports: ToolPorts): ToolDefinition<z.infer<typeof querySchema>> {
  return {
    name: 'history_search',
    description: 'Searches what was said in this chat before.',
    schema: querySchema,
    mode: 'both',
    mutates: false,
    command: {
      names: ['history'],
      kind: 'skill',
      usage: '/history <query>'
    },
    handler(args, context) {
      if (!ports.memory) {
        return { ok: false, kind: 'unavailable', reason: 'memory is not set up' }
      }
      try {
        const matches = ports.memory.history(context.chat.chatId, args.query, 10)
        return { ok: true, data: { matches } }
      } catch {
        return { ok: false, kind: 'error', reason: 'history search failed' }
      }
    }
  }
}

export function lingoNoteTool(ports: ToolPorts): ToolDefinition<z.infer<typeof lingoSchema>> {
  return {
    name: 'lingo_note',
    description: 'Files what one of this chat words means.',
    schema: lingoSchema,
    mode: 'implicit',
    mutates: true,
    handler(args, context) {
      const memory = ports.memory
      if (!memory) {
        return { ok: false, kind: 'unavailable', reason: 'memory is not set up' }
      }
      const { data } = context.commit((db) => {
        const itemId = memory.lingo(db, {
          chatId: context.chat.chatId,
          word: args.word,
          meaning: args.meaning,
          turnId: context.turnId
        })
        return {
          data: { itemId },
          receipt: { kind: 'lingo.noted', target: itemId }
        }
      })
      return { ok: true, data }
    }
  }
}
