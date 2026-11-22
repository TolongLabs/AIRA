import { describe, expect, it } from 'vitest'
import { FOURTH_WALL_PATTERNS, fourthWallBreak } from '../../src/format/fourth-wall.js'
import { FAILURE_CODES, outcomeOf, TOOL_FAILURE_KINDS } from '../../src/tools/outcomes.js'

// Synthetic replies, one for each pattern of docs/trd/prompt-engine.md#staying-in-role.
const BREAKS: [pattern: string, reply: string][] = [
  ['my_tools', 'Sorry, my tools are down today.'],
  ['my_tools', 'I cannot see my reader for that page.'],
  ['tool_result', 'The reader returned nothing for that.'],
  ['tool_result', 'A scraper rejected the link.'],
  ['unsupported_url', 'That address is an unsupported URL.'],
  ['http_status', 'It came back with HTTP 403.'],
  ['status_code', 'The status code was wrong.'],
  ['error_code', 'That gave an error code.'],
  ['rate_limit', 'I hit an API rate limit.'],
  ['system_prompt', 'I cannot share the system prompt.'],
  ['tool_call', 'I made a tool call for that.'],
  ['function_call', 'The function call failed.'],
  ['language_model', 'I am a language model.']
]

describe('fourth-wall check', () => {
  it.each(BREAKS)('flags %s in "%s"', (pattern, reply) => {
    expect(fourthWallBreak(reply, [])).toBe(pattern)
  })

  it('has a synthetic reply for every fixed pattern', () => {
    expect(new Set(BREAKS.map(([pattern]) => pattern))).toEqual(new Set(FOURTH_WALL_PATTERNS.map((e) => e.name)))
  })

  it('flags a tool name with an underscore or a dot as a whole word', () => {
    expect(fourthWallBreak('I will just read_post that for you.', ['read_post'])).toBe('tool_name')
    expect(fourthWallBreak('Using example.lookup now.', ['example.lookup'])).toBe('tool_name')
    expect(fourthWallBreak('A preread_post line in a list.', ['read_post'])).toBeUndefined()
  })

  it('flags a one-word tool name only in code form', () => {
    expect(fourthWallBreak('I will `note` that down.', ['note'])).toBe('tool_name')
    expect(fourthWallBreak('Calling note(text) now.', ['note'])).toBe('tool_name')
    expect(fourthWallBreak('I will note that down.', ['note'])).toBeUndefined()
    expect(fourthWallBreak('Help is on the way.', ['help'])).toBeUndefined()
  })

  it('leaves in-role replies alone', () => {
    expect(fourthWallBreak("I could not find that one, sorry. Let's try another way.", ['read_post'])).toBeUndefined()
    expect(fourthWallBreak('Your reminder is set for 6pm.', ['reminder_set'])).toBeUndefined()
  })

  it.each([
    'A rate limit caps how many requests a service allows per minute.',
    'I hit a rate limit.',
    'That site looks busy or rate-limited right now, try again in a bit.',
    'Looks like the link hit a rate limit on X.',
    'Reddit might be rate limiting guests at the moment.',
    'You probably hit a rate limit from refreshing too fast.',
    'Maybe that page has a rate limit on their API right now.'
  ])('allows ordinary or in-character rate-limit mention: "%s"', (reply) => {
    expect(fourthWallBreak(reply, ['read_post'])).toBeUndefined()
  })

  it.each([
    ['rate_limit', 'I hit an API rate limit.'],
    ['rate_limit', 'Sorry, I hit the model rate limit.'],
    ['rate_limit', 'Hit the OpenAI rate limit on that one.'],
    ['rate_limit', "Anthropic's rate limit kicked in."],
    ['rate_limit', 'Gemini rate limit exceeded, try again.'],
    ['rate_limit', 'The provider is rate-limited right now.'],
    ['rate_limit', 'Got rate-limited by the API.'],
    ['rate_limit', 'Rate limit reached on the model.'],
    ['rate_limit', 'Hit a 429 rate limit.'],
    ['rate_limit', 'Got a rate_limit_error from upstream.'],
    ['http_status', 'It came back with HTTP 429.']
  ] as const)('flags provider/API leak (%s) in "%s"', (expected, reply) => {
    expect(fourthWallBreak(reply, [])).toBe(expected)
  })

  it('never flags a plain outcome sentence, for any failure kind or code', () => {
    const toolNames = ['read_post', 'read_page', 'web_search', 'help', 'list', 'note']
    const sentences = [
      ...TOOL_FAILURE_KINDS.map((kind) => outcomeOf({ kind, reason: 'raw reason' })),
      ...FAILURE_CODES.map((code) => outcomeOf({ kind: 'invalid', code, reason: 'secretInput: Required' }))
    ]
    for (const sentence of sentences) {
      expect(fourthWallBreak(sentence, toolNames), sentence).toBeUndefined()
    }
  })
})
