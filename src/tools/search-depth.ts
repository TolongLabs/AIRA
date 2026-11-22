import { z } from 'zod'
import type { Config } from '../config/schema.js'
import { searchLookup, sourceKey, type TurnSources } from '../turn/sources.js'
import { isForbiddenUrl, type ToolPorts } from './ports.js'
import type { ToolContext } from './types.js'

const subject = z.string().trim().min(1).max(120)
const fieldSchema = z.strictObject({
  kind: z.enum(['list', 'price', 'hours', 'other']),
  subject,
  aliases: z.array(subject).max(5).optional()
})

export const webSearchSchema = z.strictObject({
  query: z.string().trim().min(1).max(200),
  fields: z
    .union([fieldSchema, z.array(fieldSchema).min(1).max(5)])
    .optional()
    .describe('Evidence needed for this search. Use for named lists, prices, hours or specific missing facts.'),
  localQuery: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe('With fields, the same query written in the subject location’s language, for a retry if needed.')
})

type SearchArgs = z.infer<typeof webSearchSchema>
export type SearchField = z.infer<typeof fieldSchema>
type DepthConfig = Config['search']['depth']
type SearchContext = Pick<ToolContext, 'sources' | 'deadline' | 'callDeadline' | 'signal' | 'callId' | 'now'>
type SearchResult = Awaited<ReturnType<NonNullable<ToolPorts['search']>['search']>>[number] & { source?: string }
type Passage = { source: string; url: string; text: string }
type Usage = { searches: number; pages: number }
const DEFAULT_DEPTH: DepthConfig = { maxSearches: 2, maxPages: 2, maxProviderCalls: 3 }

const PRICE =
  /(?:\p{Sc}|(?<![\p{L}\p{N}])(?:RM|USD|SGD|MYR|EUR|GBP|JPY|AUD|CAD|THB|IDR|Rp|TWD|HKD|VND))\s*\d[\d.,]*|\d[\d.,]*\s*(?:\p{Sc}|円|元|บาท|đ|\b(?:USD|SGD|MYR|EUR|GBP|JPY|AUD|CAD|THB|IDR|TWD|HKD|VND)\b)/giu
const TIME =
  /(?:\b(?:[01]?\d|2[0-3]):[0-5]\d\b|\b(?:0?[1-9]|1[0-2])(?:[:.][0-5]\d)?\s*(?:[ap]\.?m\.?)(?![\p{L}\p{N}])|\d{1,2}\s*(?:時|点|點))/giu
/** A size or portion label, such as `Small / Medium / Large`, which names no item of a list. */
const SIZE_LABEL =
  /^(?:(?:extra\s+)?(?:small|medium|large|regular|short|tall|grande|venti|mini|kids?|single|double|half|full)(?:®|サイズ|\s+size)?(?:\s*\(?\d+(?:[.,]\d+)?\s*(?:fl\.?\s*oz\.?|oz\.?|ml\.?|l)(?:\s*[/:-]\s*\d+(?:[.,]\d+)?\s*(?:fl\.?\s*oz\.?|oz\.?|ml\.?|l))?\)?)?[\s/,|〜～-]*)+$/i
const GENERIC_LIST_ENTRY =
  /^(?:menu|food|drinks?|beverages?|coffee|tea|snacks?|breakfast|lunch|dinner|desserts?|home|about|contact|sign in|search|shop|more|price|hours|overview|order now)$/i

function fold(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
}

function words(text: string): string[] {
  return fold(text).match(/[\p{L}\p{N}]+/gu) ?? []
}

function namesOf(field: SearchField): string[] {
  return [field.subject, ...(field.aliases ?? [])].map((name) => words(name).join(' ')).filter(Boolean)
}

function hasName(line: string, names: string[]): boolean {
  const normalized = ` ${words(line).join(' ')} `
  return names.some(
    (name) =>
      normalized.includes(` ${name} `) ||
      (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(name) && normalized.includes(name))
  )
}

function namedList(text: string): boolean {
  const bullets = text.split(/\n/).flatMap((line) => line.match(/^\s*(?:[-*•]|\d+[.)])\s+(?!#)(.+)/)?.[1] ?? [])
  const enumeration = text.match(/\b(?:include|includes|including|serves|offers|featuring|such as)\s+([^.!?\n]+)/i)?.[1]
  if (bullets.length === 0 && /^\s*[-*]\s+#{1,6}\s/m.test(text)) return false
  const entries = bullets.length
    ? bullets
    : (enumeration ?? text)
        .replace(/\s+\b(?:and|or)\b\s+(?=[^,;\n]+[.!?]?$)/i, ', ')
        .split(enumeration || text.length <= 120 ? /[•·;、,，\n]|\s+\|\s+/ : /\n|[•·;、]|\s+\|\s+/)
  const names = new Set<string>()
  for (const item of entries) {
    const name = item
      .replace(PRICE, '')
      .trim()
      .replace(/[.!?:]+$/, '')
    const tokens = words(name)
    if (name.length > 75 || tokens.length === 0 || tokens.length > 8 || !/\p{L}/u.test(name)) continue
    if (
      name.includes('#') ||
      GENERIC_LIST_ENTRY.test(name) ||
      /\b(?:calories|ounces?|website|hours|location|opens?|closes?|selection|welcome|click)\b/i.test(name) ||
      SIZE_LABEL.test(name)
    )
      continue
    names.add(tokens.join(' '))
    if (names.size >= 3) return true
  }
  return false
}

/** A passage supplies the evidence on its own. Titles help rank pages and never satisfy a field. */
export function passageMatches(field: SearchField, passage: string): boolean {
  const names = namesOf(field)
  switch (field.kind) {
    case 'list':
      return (!field.aliases?.length || hasName(passage, names)) && namedList(passage)
    case 'price':
      return [...passage.matchAll(PRICE)].some((price, index, matches) => {
        const start = Math.max(
          0,
          price.index - 64,
          index === 0 ? 0 : matches[index - 1]!.index + matches[index - 1]![0].length
        )
        const end = Math.min(passage.length, price.index + price[0].length + 40, matches[index + 1]?.index ?? Infinity)
        return hasName(passage.slice(start, end), names)
      })
    case 'hours':
      return [...passage.matchAll(TIME)].some((time) =>
        hasName(passage.slice(Math.max(0, time.index - 90), time.index + time[0].length + 90), names)
      )
    case 'other': {
      const available = new Set(words(passage))
      return names.some((name) => name.split(' ').every((word) => available.has(word)))
    }
  }
}

const LIST_LINE = /^\s*(?:[-*•]|\d+[.)])\s/

/**
 * Lines split into sentences. A list line stays whole. Prose ends a sentence at CJK end punctuation, or at `.`, `!`
 * or `?` before a space and a capital, a caseless letter or an opening quote, so `8 fl. oz.` and `e.g. latte` stay
 * whole.
 */
function sentencesOf(paragraph: string): string[] {
  return paragraph.split('\n').flatMap((line) =>
    LIST_LINE.test(line) || SIZE_LABEL.test(line.trim().replace(/[.!?:]+$/, ''))
      ? [line]
      : line
          .replace(/([.!?]+)\s+(?=[\p{Lu}\p{Lt}\p{Lo}"“‘'([])/gu, '$1\n')
          .replace(/([。！？]+)/gu, '$1\n')
          .split('\n')
  )
}

function candidatePassages(text: string): string[] {
  const hasList = /(?:^|\n)\s*(?:[-*•]|\d+[.)])\s/.test(text)
  const blocks = hasList ? text.split(/\n(?=#{1,2}\s)/) : text.split(/\n\s*\n/)
  return blocks.flatMap((paragraph) => {
    const units = sentencesOf(paragraph)
    const passages: string[] = []
    let current = ''
    for (const unit of units) {
      const sentence = unit.trim()
      if (!sentence) continue
      if (current.length + sentence.length > 650) {
        if (current) passages.push(current)
        current = ''
      }
      if (sentence.length > 650) {
        for (let i = 0; i < sentence.length; i += 500) passages.push(sentence.slice(i, i + 650))
      } else {
        current = current ? `${current}\n${sentence}` : sentence
      }
    }
    if (current) passages.push(current)
    return passages
  })
}

/** Words that mark a page as a list of items, so a list field ranks it a little higher. */
const LIST_WORDS = ['menu', 'list', 'items', 'lineup', 'catalog', 'range', 'options']

function rankResult(result: SearchResult, fields: readonly SearchField[]): number {
  const text = new Set(words(`${result.title} ${result.snippet} ${result.url}`))
  return fields.reduce((score, field) => {
    const match = Math.max(0, ...namesOf(field).map((name) => name.split(' ').filter((word) => text.has(word)).length))
    const labels = field.kind === 'list' ? LIST_WORDS : [field.kind]
    return score + match * 3 + (labels.some((label) => text.has(label)) ? 1 : 0)
  }, 0)
}

function retryQuery(args: SearchArgs, fields: readonly SearchField[]): string {
  if (args.localQuery && args.localQuery !== args.query) return args.localQuery
  const terms = fields.map((field) => field.aliases?.[0] ?? field.subject)
  return [args.query, ...terms.filter((term) => !fold(args.query).includes(fold(term))), 'official']
    .join(' ')
    .slice(0, 200)
}

async function untilAbort<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T | undefined> {
  if (signal.aborted) return undefined
  let stop = () => {}
  const deadline = new Promise<undefined>((resolve) => {
    stop = () => resolve(undefined)
    signal.addEventListener('abort', stop, { once: true })
  })
  try {
    return await Promise.race([deadline, operation().catch(() => undefined)])
  } finally {
    signal.removeEventListener('abort', stop)
  }
}

export function createSearchDepth(ports: Pick<ToolPorts, 'search' | 'searchPage' | 'page'>, config = DEFAULT_DEPTH) {
  const byTurn = new WeakMap<TurnSources, Usage>()

  const useOf = (turn: TurnSources): Usage => {
    const existing = byTurn.get(turn)
    if (existing) return existing
    const usage = { searches: 0, pages: 0 }
    byTurn.set(turn, usage)
    return usage
  }

  const search = async (
    query: string,
    context: SearchContext,
    signal: AbortSignal,
    suffix = '',
    deeper = false
  ): Promise<SearchResult[]> => {
    useOf(context.sources).searches++
    const provider = ports.search!
    const results = await (deeper && provider.depthSearch
      ? provider.depthSearch(query, signal)
      : provider.search(query, signal))
    signal.throwIfAborted()
    const lookup = searchLookup(context.callId + suffix)
    return results.slice(0, 8).map((result) => ({
      ...result,
      source: context.sources.add(result.url, lookup)?.id
    }))
  }

  const deep = async (args: SearchArgs, context: SearchContext) => {
    const missing = new Set(Array.isArray(args.fields) ? args.fields : args.fields ? [args.fields] : [])
    const passages: Passage[] = []
    const candidates = new Map<string, SearchResult>()
    const usage = useOf(context.sources)
    const abort = new AbortController()
    const signal = AbortSignal.any([context.signal, abort.signal])
    const stopAt = Math.min(context.deadline - 4000, (context.callDeadline ?? Infinity) - 1500)
    const remaining = stopAt - context.now().getTime()
    const timer = remaining > 0 ? setTimeout(() => abort.abort(), remaining) : undefined
    const hasTime = () => !signal.aborted && context.now().getTime() < stopAt
    const canSpend = () => hasTime() && usage.searches + usage.pages < config.maxProviderCalls

    const addEvidence = (result: SearchResult, text: string) => {
      if (!result.source) return
      for (const passage of candidatePassages(text)) {
        const covered = [...missing].filter((field) => passageMatches(field, passage))
        if (covered.length === 0) continue
        for (const field of covered) missing.delete(field)
        passages.push({ source: result.source, url: result.url, text: passage })
      }
    }

    let failure: unknown
    const look = async (query: string, suffix?: string) => {
      if (!canSpend() || usage.searches >= config.maxSearches) return
      const found = await untilAbort(signal, () =>
        search(query, context, signal, suffix, true).catch((error: unknown) => {
          failure = error
          throw error
        })
      )
      for (const result of found ?? []) {
        const key = sourceKey(result.url)
        if (key === undefined || isForbiddenUrl(result.url)) continue
        if (!candidates.has(key)) candidates.set(key, result)
        addEvidence(result, result.snippet)
      }
    }

    try {
      await look(args.query)
      // A provider that fails the first search fails the call, as a plain search does.
      if (failure !== undefined && !signal.aborted) throw failure
      if (missing.size > 0) await look(retryQuery(args, [...missing]), ':local')
      const page = ports.searchPage ?? ports.page
      if (page && missing.size > 0) {
        const fields = [...missing]
        const ranked = [...candidates.values()].sort((a, b) => rankResult(b, fields) - rankResult(a, fields))
        for (const result of ranked) {
          if (missing.size === 0 || !canSpend() || usage.pages >= config.maxPages) break
          if (!result.source || context.sources.find({ source: result.source }) === undefined) continue
          usage.pages++
          const read = await untilAbort(signal, () => page.read(result.url, signal))
          if (read && !signal.aborted) {
            context.sources.markRead()
            addEvidence(result, read.text)
          }
        }
      }
    } finally {
      clearTimeout(timer)
    }

    const labels = [...missing].map((field) => `${field.subject} (${field.kind})`)
    return {
      brief: {
        passages,
        stillMissing: labels.length > 0 ? `Still missing: ${labels.join(', ')}.` : 'Still missing: none.'
      }
    }
  }

  return {
    plain: (query: string, context: SearchContext) => search(query, context, context.signal),
    deep
  }
}
