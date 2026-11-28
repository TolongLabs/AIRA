import { stringify } from 'yaml'
import { z } from 'zod'
import { LENGTH_CHARS } from '../prompt/shape.js'
import { checkLoadedPack, type PackCheck } from './check.js'
import { type Pack, validatePackDocuments } from './loader.js'
import { cardSchema, linesSchema, moodsSchema, PACK_ID } from './schema.js'

export const MAX_PACK_DOCUMENT_BYTES = 256 * 1024

export const packDraftSchema = z.strictObject({ card: cardSchema, moods: moodsSchema, lines: linesSchema })

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export function checkDraft(
  raw: unknown,
  options: { ceiling: number; harnessRules: string; assets?: Pack }
): { check: PackCheck; pack?: Pack } {
  const documents = record(raw)
  const rawId = record(documents?.card)?.id
  const id = typeof rawId === 'string' && PACK_ID.test(rawId) ? rawId : ''
  const faults: string[] = []
  if (!documents || Object.keys(documents).some((key) => !['card', 'moods', 'lines'].includes(key))) {
    faults.push('root: expected only card, moods and lines documents')
  }
  if (options.assets && options.assets.id !== id) faults.push('card.yml: id: must match the installed pack id')
  for (const name of ['card', 'moods', 'lines'] as const) {
    if (documents?.[name] !== undefined && Buffer.byteLength(stringify(documents[name])) > MAX_PACK_DOCUMENT_BYTES) {
      faults.push(`${name}.yml: exceeds the document size limit`)
    }
  }
  const validated = validatePackDocuments(documents ?? {}, { id, assets: options.assets })
  faults.push(...validated.faults)
  const pack = validated.pack
  const check: PackCheck = pack
    ? checkLoadedPack(pack, options.ceiling, options.harnessRules)
    : { id, ok: false, faults: [], ceiling: options.ceiling, moods: 0, stickers: 0 }
  check.faults.unshift(...faults)
  check.ok = check.faults.length === 0
  return { check, ...(check.ok && pack ? { pack } : {}) }
}

export function generatePackSchema() {
  const schema = z.toJSONSchema(packDraftSchema, { io: 'input' })
  const setupPrompt = [
    'Help me create an original fictional AIRA persona pack for Character Studio. Ask about identity, languages, speech, moods and fallback lines before writing. Return one JSON file matching the schema below.',
    'All card prose may be quoted in character except optional card.privateInstructions, which holds directions the model must never quote. The model sees those directions; never put credentials or secrets there.',
    'Mood patterns are regular expressions of 1–200 characters, compiled with the iu flags, not literal trigger phrases. The default must name a mood. Every face group and beat referenced must exist; beat probabilities are 0–1.',
    'A face (kaomoji) is one round-bracketed group with 1–20 inner characters, no adjacent pair of ASCII letters or digits, no nested parentheses or newline, and at most 4 characters before and after the group. The code guards formatting inside faces.',
    'Fixed lines have 1–300 characters and no line breaks. Keep sticker lists empty in a new JSON draft; installed sticker references must name valid static 512×512 WebP assets within 100,000 bytes.',
    'The optional toolFooter icon must be one emoji. Its labels use 1–40 characters after trimming, no markup markers, angle brackets or control characters.',
    `Code enforces reply lengths short=${LENGTH_CHARS.short}, default=${LENGTH_CHARS.default}, long=${LENGTH_CHARS.long} characters unless a bypass applies. It repairs formatting and lists, removes speaker tags and narrated tool calls, guards faces, replaces harness/private leaks, checks for fourth-wall breaks (internal tools, models or system mechanisms), splits bubbles and adds tool footers. By default it capitalises bubble and paragraph starts; set capitaliseBubbles to false to preserve the original case.`,
    'Use aira pack schema to see the current schema, aira pack check <file.json> to check every fault and prompt size, and aira pack try <id|file.json> "<message>" to see a scripted cleaned reply. Add --live only with approval to send the draft and test message to the configured provider.',
    'Use aira pack import <file.json> --dry-run before publishing with aira pack import <file.json>. For an existing pack, aira pack get <id> returns its revision; use aira pack update <file.json> --expected-revision <revision> --dry-run to inspect the diff before applying. Every command accepts --json.',
    'JSON Schema:',
    JSON.stringify(schema, null, 2)
  ].join('\n\n')
  return { schema, setupPrompt }
}
