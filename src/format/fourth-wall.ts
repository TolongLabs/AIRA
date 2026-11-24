// The fourth-wall check (docs/trd/prompt-engine.md#staying-in-role). A reply that names a tool, an error or a mechanism
// has stepped out of its role. The check is pure: it returns the name of the pattern that matched, never the text.

const SELF_AS_MACHINE =
  /(?:\b(?:i am|i['’]m|im)\s+|(?:^|[.!?\n]\s*)as\s+)(?:(?:(?:just|only)\s+)?an?\s+)?(?:ai|a\.i\.|artificial intelligence|(?:large\s+)?language model|llm|bot|chatbot|virtual assistant|assistant)\b/iu
const SELF_AS_HUMAN = /\b(?:i am|i['’]m|im)\s+(?:a\s+)?(?:real\s+)?(?:human|real person)\b/iu

export function identityClaim(text: string): 'names-itself-ai' | 'claims-human' | undefined {
  if (SELF_AS_MACHINE.test(text)) return 'names-itself-ai'
  if (SELF_AS_HUMAN.test(text)) return 'claims-human'
  return undefined
}

export interface FourthWallPattern {
  name: string
  pattern: RegExp
}

const RATE_LIMIT_SOURCES = [
  'api',
  'model',
  'llm',
  'ai',
  'provider',
  'upstream',
  'gateway',
  'openai',
  'anthropic',
  'gemini(?:\\s+(?:pro|flash|ultra))?',
  'claude(?:\\s+(?:opus|sonnet|haiku))?',
  'vertex(?:\\s+ai)?',
  'chatgpt',
  'gpt(?:-\\d[\\w.-]*)?',
  'reader',
  'scraper',
  'parser',
  'system',
  'tool'
].join('|')

const RATE_LIMIT_VERB =
  '(?:(?:is|was|are|were|got|has\\s+been|seems)\\s+(?:currently\\s+|temporarily\\s+)?|(?:hit|hits|hitting|reached|exceeded)\\s+(?:a\\s+|the\\s+|its\\s+)?)'

const RATE_LIMIT_PATTERN = new RegExp(
  [
    `\\b(?:${RATE_LIMIT_SOURCES})(?:['’]s)?\\s+rate[- ]limit(?:s|ed|ing|er)?\\b`,
    `\\b(?:${RATE_LIMIT_SOURCES})\\s+${RATE_LIMIT_VERB}rate[- ]limit(?:s|ed|ing)?\\b`,
    `\\brate[- ]limit(?:s|ed|ing)?(?:\\s+(?:exceeded|reached|hit|error))?\\s+(?:from|on|for|by|of|at)\\s+(?:the\\s+|my\\s+|our\\s+|an?\\s+|this\\s+|its\\s+)?(?:${RATE_LIMIT_SOURCES})\\b`,
    '\\brate_limit(?:_error|_exceeded)?\\b',
    '\\b429\\b(?:\\s*[:,-]?\\s*(?:too\\s+many\\s+requests|error|status))?\\W+rate[- ]limit(?:s|ed|ing)?\\b',
    '\\brate[- ]limit(?:s|ed|ing)?\\b(?:\\W+(?:error|status|code|exceeded))?\\W+429\\b',
    '\\b(?:http|status|error)\\s+429\\b'
  ].join('|'),
  'iu'
)

export const FOURTH_WALL_PATTERNS: readonly FourthWallPattern[] = [
  { name: 'my_tools', pattern: /\bmy (?:tools?|reader|scraper|parser|api|system|prompt|instructions)\b/iu },
  {
    name: 'tool_result',
    pattern: /\b(?:the|a) (?:tool|reader|scraper|parser|api|endpoint) (?:returned|rejected|failed|says|gave)\b/iu
  },
  { name: 'unsupported_url', pattern: /\bunsupported url\b/iu },
  { name: 'http_status', pattern: /\bhttp \d{3}\b/iu },
  { name: 'status_code', pattern: /\bstatus code\b/iu },
  { name: 'error_code', pattern: /\berror code\b/iu },
  { name: 'rate_limit', pattern: RATE_LIMIT_PATTERN },
  { name: 'system_prompt', pattern: /\bsystem prompt\b/iu },
  { name: 'tool_call', pattern: /\btool call/iu },
  { name: 'function_call', pattern: /\bfunction call/iu },
  { name: 'language_model', pattern: /\blanguage model\b/iu }
]

/** The name a tool-name match reports. The matched name itself is never returned. */
export const TOOL_NAME_PATTERN = 'tool_name'

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** A name with `_` or `.` is distinctive, so it matches as a whole word anywhere. */
function distinctiveNameMatcher(name: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(name)}(?![\\p{L}\\p{N}_])`, 'iu')
}

/** A one-word name, such as `note`, is a tool only in code form: in backticks, or followed by `(`. */
function codeFormMatcher(name: string): RegExp {
  const escaped = escapeRegExp(name)
  return new RegExp(`\`${escaped}(?:\\([^\`\\n]*\\))?\`|\\b${escaped}\\(`, 'iu')
}

/** The name of the first pattern the reply matches, or undefined when it stays in role. */
export function fourthWallBreak(text: string, toolNames: readonly string[]): string | undefined {
  for (const { name, pattern } of FOURTH_WALL_PATTERNS) {
    if (pattern.test(text)) return name
  }
  for (const name of toolNames) {
    if (name.length === 0) continue
    const matcher = /[_.]/.test(name) ? distinctiveNameMatcher(name) : codeFormMatcher(name)
    if (matcher.test(text)) return TOOL_NAME_PATTERN
  }
  return identityClaim(text)
}
