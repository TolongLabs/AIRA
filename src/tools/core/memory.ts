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

class FactNotFoundError extends Error {}

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
        const items = ports.memory.recall(context.chat.chatId, args.query, 8)
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
    handler(args, context) {
      const memory = ports.memory
      if (!memory) {
        return { ok: false, kind: 'unavailable', reason: 'memory is not set up' }
      }
      const { data } = context.commit((db) => {
        const itemId = memory.note(db, {
          chatId: context.chat.chatId,
          subjectId: context.senderId,
          text: args.text,
          callId: context.callId
        })
        return {
          data: { itemId },
          receipt: { kind: 'memory.noted', target: itemId }
        }
      })
      return { ok: true, data }
    }
  }
}

export function forgetTool(ports: ToolPorts): ToolDefinition<z.infer<typeof forgetSchema>> {
  return {
    name: 'forget',
    description: 'Forgets one named fact in this chat.',
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

      let targetId = args.itemId
      if (targetId === undefined) {
        let matches: { itemId: string; text: string }[]
        try {
          matches = memory.recall(context.chat.chatId, args.query ?? '', 8)
        } catch {
          return { ok: false, kind: 'error', reason: 'memory recall failed' }
        }
        if (matches.length === 0) {
          return { ok: false, kind: 'refused', reason: 'nothing matches' }
        }
        if (matches.length > 1) {
          const candidates = matches.map((m) => `${m.itemId}: ${m.text}`).join('; ')
          return {
            ok: false,
            kind: 'invalid',
            reason: `more than one fact matches: ${candidates}`
          }
        }
        const only = matches[0]
        if (!only) {
          return { ok: false, kind: 'refused', reason: 'nothing matches' }
        }
        targetId = only.itemId
      }

      const idToForget = targetId
      try {
        const { data } = context.commit((db) => {
          const removed = memory.forget(db, { chatId: context.chat.chatId, itemId: idToForget })
          if (!removed) throw new FactNotFoundError()
          return {
            data: { itemId: idToForget },
            receipt: { kind: 'memory.forgotten', target: idToForget }
          }
        })
        return { ok: true, data }
      } catch (err) {
        if (err instanceof FactNotFoundError) {
          return { ok: false, kind: 'refused', reason: 'no such fact in this chat' }
        }
        throw err
      }
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
          callId: context.callId
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
