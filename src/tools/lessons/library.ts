import { z } from 'zod'
import type { Storage } from '../../storage/database.js'
import type { ToolDefinition } from '../types.js'
import { libraryGaps, openNode, searchLibrary, writeNode } from './store.js'

const SEARCH_LIMIT = 8
const GAPS_LIMIT = 20

const librarySearchSchema = z.strictObject({
  query: z.string().trim().min(1).max(200)
})

const libraryWriteSchema = z.strictObject({
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(8000)
})

const libraryOpenSchema = z.strictObject({
  title: z.string().trim().min(1).max(120)
})

const libraryGapsSchema = z.strictObject({})

export function librarySearchTool(storage: Storage): ToolDefinition<z.infer<typeof librarySearchSchema>> {
  return {
    name: 'library_search',
    description: 'Searches the library and follows its links.',
    schema: librarySearchSchema,
    mode: 'implicit',
    mutates: false,
    feature: 'features.lessons',
    handler(args, context) {
      const results = searchLibrary(storage, context.chat.chatId, args.query, SEARCH_LIMIT)
      return { ok: true, data: { results } }
    }
  }
}

export function libraryWriteTool(): ToolDefinition<z.infer<typeof libraryWriteSchema>> {
  return {
    name: 'library_write',
    description: 'Files one library node.',
    schema: libraryWriteSchema,
    mode: 'implicit',
    mutates: true,
    feature: 'features.lessons',
    handler(args, context) {
      const { data } = context.commit((db) => {
        const res = writeNode(db, context.chat.chatId, { title: args.title, body: args.body }, context.now)
        return {
          data: res,
          receipt: {
            kind: 'library.written',
            target: res.nodeId,
            state: { replaced: res.replaced, links: res.links.length }
          }
        }
      })
      return { ok: true, data }
    }
  }
}

export function libraryOpenTool(storage: Storage): ToolDefinition<z.infer<typeof libraryOpenSchema>> {
  return {
    name: 'library_open',
    description: 'Reads one library node by title.',
    schema: libraryOpenSchema,
    mode: 'implicit',
    mutates: false,
    feature: 'features.lessons',
    handler(args, context) {
      const node = openNode(storage, context.chat.chatId, args.title)
      if (!node) {
        return { ok: false, kind: 'refused', reason: 'no such note in this chat' }
      }
      return { ok: true, data: node }
    }
  }
}

export function libraryGapsTool(storage: Storage): ToolDefinition<z.infer<typeof libraryGapsSchema>> {
  return {
    name: 'library_gaps',
    description: 'Says what the library still lacks.',
    schema: libraryGapsSchema,
    mode: 'implicit',
    mutates: false,
    feature: 'features.lessons',
    handler(_args, context) {
      const gaps = libraryGaps(storage, context.chat.chatId, GAPS_LIMIT)
      return { ok: true, data: gaps }
    }
  }
}
