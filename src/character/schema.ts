import { z } from 'zod'

export const PACK_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/
export const MOOD_KEY = /^[a-z][a-z0-9_]{0,31}$/
export const STICKER_FILE = /^[a-z0-9][a-z0-9_-]*\.webp$/
export const FOOTER_KEY = /^[a-z][a-z0-9_]{0,63}$/
export const FOOTER_FORBIDDEN_CHARS = /[_*~`<>\r\n\p{Cc}]/u

/** Shared validation for chat `footerEmoji` and pack `toolFooter.icon`. */
export function isFooterEmoji(value: string): boolean {
  return (
    /\p{Extended_Pictographic}/u.test(value) && !/[\p{L}\p{N}\s]/u.test(value) && !FOOTER_FORBIDDEN_CHARS.test(value)
  )
}

export const footerEmojiSchema = z.string().min(1).max(8).refine(isFooterEmoji, 'must be one emoji')

export const footerLabelSchema = z
  .string()
  .refine((value) => !FOOTER_FORBIDDEN_CHARS.test(value), {
    message: 'must not contain _, *, ~, `, <, > or control characters'
  })
  .pipe(z.string().trim().min(1).max(40))

/** The fixed lines required in each character pack. */
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
  /** Other names a member may call the character by in a group (docs/trd/system.md#gateway-contract). */
  aliases: z.array(z.string().min(2).max(40)).optional(),
  languages: z.array(languageTag).min(1),
  coreIdentity: nonEmpty,
  speechRules: z.array(nonEmpty).min(1),
  defaultReplyLength: z.enum(['short', 'default', 'long']),
  /** False leaves each bubble's first letter as the model wrote it (docs/trd/prompt-engine.md#cleaning-chain). */
  capitaliseBubbles: z.boolean().optional(),
  expressionDescriptions: z
    .record(
      z.string().regex(STICKER_FILE),
      z
        .string()
        .max(300)
        .regex(/^[^\r\n]*$/)
    )
    .optional(),
  /** The tool footer's icon and labels, keyed by tool name (docs/trd/prompt-engine.md#tool-footer). */
  toolFooter: z
    .strictObject({
      icon: footerEmojiSchema.optional(),
      labels: z.record(z.string().regex(FOOTER_KEY), footerLabelSchema).optional()
    })
    .optional()
})

/**
 * A kaomoji: one round-bracketed group of at most 20 characters with no two ASCII letters or digits in a row, so
 * code can tell it from a bracketed word, and at most 4 characters outside it (docs/trd/prompt-engine.md#reply-shape).
 */
export function isFace(text: string): boolean {
  const match = /^([^()]{0,4})\(([^()\n]{1,20})\)([^()]{0,4})$/u.exec(text)
  return match !== null && !/[A-Za-z0-9]{2}/.test(match[2]!)
}
const face = z.string().refine(isFace, { message: 'must be one kaomoji in round brackets (see prompt-engine.md)' })
const GROUP_KEY = /^[a-z][a-z0-9_]{0,31}$/

const moodSchema = z.strictObject({
  patterns: z.array(z.string().min(1).max(200)),
  tone: nonEmpty,
  openers: z.array(nonEmpty),
  endings: z.array(nonEmpty),
  faces: z.array(face),
  /** Face groups this mood draws from, beside its own faces. */
  faceGroups: z.array(z.string().regex(GROUP_KEY)).optional(),
  /** Odds of each beat per reply, by beat name. */
  beats: z.record(z.string().regex(GROUP_KEY), z.number().min(0).max(1)).optional(),
  stickers: z.array(z.string().regex(STICKER_FILE))
})

export const moodsSchema = z.strictObject({
  default: z.string().regex(MOOD_KEY),
  faceGroups: z.record(z.string().regex(GROUP_KEY), z.array(face).min(1)).optional(),
  beats: z.array(z.strictObject({ name: z.string().regex(GROUP_KEY), line: z.string().min(1).max(300) })).optional(),
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

export const linesSchema = z.strictObject({
  ...lineShape,
  feedback: lineValue.optional(),
  researchStarted: lineValue.optional(),
  researchTopic: lineValue.optional(),
  researchBusy: lineValue.optional(),
  researchFailed: lineValue.optional(),
  offerPdf: lineValue.optional()
})
