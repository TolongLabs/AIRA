import { createHash } from 'node:crypto'

// Redaction for logs and record tables (docs/trd/records.md#redaction).
// Text, names, phone numbers and WhatsApp ids become stable hashes. Secrets are masked. Tool arguments are
// described by shape, never by value.

const SECRET_MASK = '[secret]'
// A WhatsApp id (digits, optional device suffix, then a known server), or a bare phone-like run of digits.
const WHATSAPP_ID = /\b\d[\d-]{4,}(?::\d+)?@(?:s\.whatsapp\.net|g\.us|lid|c\.us|newsletter)\b/g
const PHONE = /(?<![\w.])\+?\d[\d\s-]{7,}\d(?![\w.])/g
const MIN_SECRET_LENGTH = 6

export interface Redactor {
  /** A stable hash that stands in for message text, a name, a phone number or a WhatsApp id. */
  hash(value: string): string
  /** Masks secrets and hashes any WhatsApp id or phone number found inside free text. */
  scrub(text: string): string
}

export function createRedactor(options: { secrets?: readonly string[]; salt?: string } = {}): Redactor {
  const salt = options.salt ?? ''
  const secrets = [...new Set(options.secrets ?? [])]
    .filter((secret) => secret.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length)

  const hash = (value: string): string =>
    'h:' +
    createHash('sha256')
      .update(salt + '\0' + value)
      .digest('hex')
      .slice(0, 12)

  const scrub = (text: string): string => {
    let out = text
    for (const secret of secrets) out = out.split(secret).join(SECRET_MASK)
    out = out.replace(WHATSAPP_ID, (id) => hash(id))
    out = out.replace(PHONE, (phone) => hash(phone.replace(/[\s-]/g, '')))
    return out
  }

  return { hash, scrub }
}

/** Every value read from .env, for the logger to mask. Reads values, returns them only to the redactor. */
export function secretsFromEnv(names: readonly string[], env: NodeJS.ProcessEnv = process.env): string[] {
  return names.map((name) => env[name]).filter((value): value is string => typeof value === 'string' && value !== '')
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
