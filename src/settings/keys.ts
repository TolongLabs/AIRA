import { z } from 'zod'

// Registry of setting keys and their schemas (docs/trd/data.md#setting-keys).

export interface SettingDefinition {
  schema: z.ZodType
  /** The built-in global default. Absent means the key is unset until someone sets it. */
  default?: unknown
}

const CHARACTER_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/
const LANGUAGE_CODE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/
const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/
const MCP_KEY = /^mcp\.[a-z0-9][a-z0-9_-]{0,31}$/

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone })
    return true
  } catch {
    return false
  }
}

const MCP_DEFINITION: SettingDefinition = {
  schema: z.boolean(),
  default: false
}

export const SETTING_KEYS: Record<string, SettingDefinition> = {
  character: {
    schema: z.string().regex(CHARACTER_ID, 'must be a valid character id')
  },
  language: {
    schema: z.union([z.literal('auto'), z.string().regex(LANGUAGE_CODE, 'must be a valid language code')]),
    default: 'auto'
  },
  freeResponse: {
    schema: z.boolean(),
    default: false
  },
  allowedSenders: {
    schema: z.union([z.literal('all'), z.array(z.string().min(1))]),
    default: 'all'
  },
  model: {
    schema: z.union([
      z.literal('inherit'),
      z.strictObject({
        provider: z.string().min(1),
        model: z.string().min(1),
        baseUrl: z.string().optional()
      })
    ]),
    default: 'inherit'
  },
  replyLength: {
    schema: z.enum(['short', 'default', 'long']),
    default: 'default'
  },
  expressions: {
    schema: z.boolean(),
    default: true
  },
  quietHours: {
    schema: z.strictObject({
      start: z.string().regex(HH_MM, 'must be 24-hour HH:MM'),
      end: z.string().regex(HH_MM, 'must be 24-hour HH:MM'),
      timeZone: z.string().min(1).refine(isValidTimeZone, 'must be a valid IANA time zone')
    })
  },
  muted: {
    schema: z.union([
      z.literal(false),
      z.strictObject({
        by: z.string().min(1),
        at: z.iso.datetime()
      })
    ]),
    default: false
  },
  'features.proactive': { schema: z.boolean(), default: false },
  'features.reminders': { schema: z.boolean(), default: true },
  'features.search': { schema: z.boolean(), default: true },
  'features.social': { schema: z.boolean(), default: true },
  'features.photos': { schema: z.boolean(), default: true },
  'features.media': { schema: z.boolean(), default: true },
  'features.voice': { schema: z.boolean(), default: false },
  'features.lessons': { schema: z.boolean(), default: false },
  'features.reports': { schema: z.boolean(), default: true }
}

/** Returns the definition for a static setting key or a dynamic mcp.<id> key, or undefined if unknown. */
export function definitionFor(key: string): SettingDefinition | undefined {
  if (Object.hasOwn(SETTING_KEYS, key)) return SETTING_KEYS[key]
  if (MCP_KEY.test(key)) return MCP_DEFINITION
  return undefined
}
