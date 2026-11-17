import { createHash } from 'node:crypto'

// Redaction for logs and record tables (docs/trd/records.md#redaction).
// Text, names, phone numbers and WhatsApp ids become stable hashes. Secrets are masked. Tool arguments are
// described by shape, never by value.

const SECRET_MASK = '[secret]'
// A WhatsApp id (digits, optional device suffix, then a known server), or a bare phone-like run of digits.
const WHATSAPP_ID = /\b\d[\d-]{4,}(?::\d+)?@(?:s\.whatsapp\.net|g\.us|lid|c\.us|newsletter)\b/g
const PHONE = /(?<![\w.])\+?\d[\d\s-]{7,}\d(?![\w.])/g
const MIN_SECRET_LENGTH = 4

export type RedactorSecrets = readonly string[] | Readonly<Record<string, string | undefined>>

export interface Redactor {
  /** A stable hash that stands in for message text, a name, a phone number or a WhatsApp id. */
  hash(value: string): string
  /** Masks secrets and hashes any WhatsApp id or phone number found inside free text. */
  scrub(text: string): string
  /** Key names of non-empty secrets shorter than the masking minimum (never their values). */
  weak: string[]
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function createRedactor(options: { secrets?: RedactorSecrets; salt?: string } = {}): Redactor {
  const salt = options.salt ?? ''
  const rawSecrets: string[] = []
  const weakKeys = new Set<string>()

  if (Array.isArray(options.secrets)) {
    for (const secret of options.secrets) {
      if (secret.length >= MIN_SECRET_LENGTH) rawSecrets.push(secret)
    }
  } else if (options.secrets !== undefined) {
    for (const [key, secret] of Object.entries(options.secrets)) {
      if (typeof secret !== 'string' || secret === '') continue
      if (secret.length >= MIN_SECRET_LENGTH) rawSecrets.push(secret)
      else weakKeys.add(key)
    }
  }

  const secrets = [...new Set(rawSecrets)].sort((a, b) => b.length - a.length)
  const secretPattern = secrets.length > 0 ? new RegExp(secrets.map(escapeRegExp).join('|'), 'g') : undefined
  const weak = [...weakKeys]

  const hash = (value: string): string =>
    'h:' +
    createHash('sha256')
      .update(salt + '\0' + value)
      .digest('hex')
      .slice(0, 12)

  const scrub = (text: string): string => {
    let out = secretPattern ? text.replace(secretPattern, () => SECRET_MASK) : text
    out = out.replace(WHATSAPP_ID, (id) => hash(id))
    out = out.replace(PHONE, (phone) => hash(phone.replace(/[\s-]/g, '')))
    return out
  }

  return { hash, scrub, weak }
}

/** Non-empty values read from .env, keyed by name, for the redactor to mask. */
export function secretsFromEnv(names: readonly string[], env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of names) {
    const value = env[name]
    if (typeof value === 'string' && value !== '') out[name] = value
  }
  return out
}

/** Describes a value by keys and types, for logging tool arguments without their values. */
export function shapeOf(value: unknown, depth = 0): unknown {
  if (value === null) return 'null'
  if (Array.isArray(value)) return depth >= 4 ? 'array' : value.length === 0 ? [] : [shapeOf(value[0], depth + 1)]
  if (typeof value === 'object') {
    if (depth >= 4) return 'object'
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, shapeOf(inner, depth + 1)]))
  }
  return typeof value
}
