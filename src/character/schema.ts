import { z } from 'zod'

export const PACK_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/
export const MOOD_KEY = /^[a-z][a-z0-9_]{0,31}$/
export const STICKER_FILE = /^[a-z0-9][a-z0-9_-]*\.webp$/

/** Every line kind the core can send. The validator requires each one in lines.yml. */
export const LINE_KINDS = [
  'error',
  'limit',
  'refusal',
  'busy',
  'slow',
  'unreadableMedia',
  'fallback',
  'unavailable'
] as const
export type LineKind = (typeof LINE_KINDS)[number]

const nonEmpty = z.string().min(1)
const languageTag = z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/)

export const cardSchema = z.strictObject({
  id: z.string().regex(PACK_ID),
  displayName: nonEmpty,
  languages: z.array(languageTag).min(1),
  coreIdentity: nonEmpty,
  speechRules: z.array(nonEmpty).min(1),
  defaultReplyLength: z.enum(['short', 'default', 'long'])
})

const moodSchema = z.strictObject({
  patterns: z.array(z.string().min(1).max(200)),
  tone: nonEmpty,
  openers: z.array(nonEmpty),
  endings: z.array(nonEmpty),
  faces: z.array(nonEmpty),
  stickers: z.array(z.string().regex(STICKER_FILE))
})

export const moodsSchema = z.strictObject({
  default: z.string().regex(MOOD_KEY),
  moods: z.record(z.string().regex(MOOD_KEY), moodSchema).refine((m) => Object.keys(m).length >= 1, {
    message: 'must contain at least one mood'
  })
})

const lineValue = z
  .string()
  .min(1)
  .max(300)
  .refine((s) => !/[\r\n]/.test(s), { message: 'must not contain a line break' })

const lineShape = Object.fromEntries(LINE_KINDS.map((kind) => [kind, lineValue])) as Record<LineKind, typeof lineValue>

export const linesSchema = z.strictObject(lineShape)
