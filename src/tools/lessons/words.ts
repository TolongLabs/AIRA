import { z } from 'zod'
import type { Storage } from '../../storage/database.js'
import type { ToolDefinition } from '../types.js'
import { lookupWord, setGloss } from './store.js'

const vocabLookupSchema = z.strictObject({
  word: z.string().trim().min(1).max(120)
})

const glossSetSchema = z.strictObject({
  word: z.string().trim().min(1).max(120),
  language: z.string().trim().min(2).max(16),
  meaning: z.string().trim().min(1).max(500),
  reading: z.string().trim().max(200).optional(),
  kind: z.enum(['word', 'pattern']).optional()
})

export function vocabLookupTool(storage: Storage): ToolDefinition<z.infer<typeof vocabLookupSchema>> {
  return {
    name: 'vocab_lookup',
    description: 'Looks up one word and where it appeared.',
    schema: vocabLookupSchema,
    mode: 'both',
    mutates: false,
    feature: 'features.lessons',
    command: {
      names: ['word'],
      kind: 'skill',
      usage: '/word <word or pattern>'
    },
    handler(args, context) {
      const rawLang = context.settings['language']?.value
      const preferredLanguage = typeof rawLang === 'string' && rawLang !== 'auto' ? rawLang : undefined
      const entries = lookupWord(storage, args.word, preferredLanguage)
      if (entries.length === 0) {
        return { ok: false, kind: 'refused', reason: 'that word is not in the vocabulary' }
      }
      return { ok: true, data: { entries } }
    }
  }
}

export function glossSetTool(): ToolDefinition<z.infer<typeof glossSetSchema>> {
  return {
    name: 'gloss_set',
    description:
      'Fills in what one word or pattern means in one language. The library is shared by every chat with lessons on: write study notes only, never anything about a member.',
    schema: glossSetSchema,
    mode: 'implicit',
    mutates: true,
    feature: 'features.lessons',
    handler(args, context) {
      const { data } = context.commit((db) => {
        const res = setGloss(
          db,
          {
            kind: args.kind ?? 'word',
            word: args.word,
            language: args.language,
            meaning: args.meaning,
            ...(args.reading !== undefined ? { reading: args.reading } : {})
          },
          context.now
        )
        return {
          data: res,
          receipt: {
            kind: 'lesson.gloss_set',
            target: res.wordId,
            state: { created: res.created }
          }
        }
      })
      return { ok: true, data }
    }
  }
}
