import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { checkPack } from '../../src/character/check.js'
import { checkDraft, generatePackSchema } from '../../src/character/draft.js'
import { loadConfig } from '../../src/config/loader.js'
import { loadHarnessRules } from '../../src/prompt/builder.js'

const config = loadConfig('config.yml')
const harnessRules = loadHarnessRules()
const draft = () => ({
  card: parse(readFileSync('characters/example/card.yml', 'utf8')),
  moods: parse(readFileSync('characters/example/moods.yml', 'utf8')),
  lines: parse(readFileSync('characters/example/lines.yml', 'utf8'))
})

describe('JSON draft validation', () => {
  it('matches the folder check and counts the same prompt tokens', () => {
    const { check, pack } = checkDraft(draft(), { ceiling: config.prompt.maxSystemTokens, harnessRules })
    expect(check).toEqual(checkPack({ id: 'example', repositoryDir: 'characters', config }))
    expect(pack?.moods.get('neutral')?.patterns[0]?.flags).toBe('iu')
  })

  it('collects schema, unknown root, regex, mood, beat, face group and asset faults', () => {
    const value = draft()
    value.card.displayName = ''
    value.moods.default = 'not_defined'
    value.moods.moods.neutral.patterns = ['[']
    value.moods.moods.neutral.faceGroups = ['missing']
    value.moods.moods.neutral.beats = { missing: 0.5 }
    value.moods.moods.neutral.stickers = ['missing.webp']
    value.lines.fallback = 'a'.repeat(301)
    const { check } = checkDraft({ ...value, extra: true }, { ceiling: 8000, harnessRules })
    expect(check.ok).toBe(false)
    for (const path of [
      'card.yml: displayName',
      'moods.yml: default',
      'patterns.0',
      'faceGroups',
      'beats',
      'stickers',
      'lines.yml: fallback',
      'root'
    ]) {
      expect(
        check.faults.some((fault) => fault.includes(path)),
        path
      ).toBe(true)
    }
  })

  it('counts private directions against the configured prompt cap', () => {
    const value = draft()
    value.card.privateInstructions = 'a'.repeat(30_000)
    const { check } = checkDraft(value, { ceiling: 8000, harnessRules })
    expect(check.ok).toBe(false)
    expect(check.faults).toContain('prompt over the ceiling')
  })

  it('enforces actual document size and does not echo private prose', () => {
    const value = draft()
    value.card.coreIdentity = 'fictional-private-prose'.repeat(30_000)
    const { check } = checkDraft(value, { ceiling: 8000, harnessRules })
    expect(check.ok).toBe(false)
    expect(check.faults.join(' ')).toContain('size limit')
    expect(check.faults.join(' ')).not.toContain('fictional-private-prose')
  })
})

describe('schema-generated setup prompt', () => {
  it('includes the complete schema and runtime rules that cannot be expressed as JSON schema', () => {
    const { schema, setupPrompt } = generatePackSchema()
    expect(schema).toMatchObject({
      type: 'object',
      required: ['card', 'moods', 'lines'],
      additionalProperties: false,
      properties: {
        card: {
          required: ['id', 'displayName', 'languages', 'coreIdentity', 'speechRules', 'defaultReplyLength'],
          properties: { privateInstructions: { minLength: 1 }, capitaliseBubbles: { type: 'boolean' } }
        },
        lines: { properties: { fallback: { minLength: 1, maxLength: 300 } } },
        moods: {
          properties: {
            moods: {
              additionalProperties: {
                properties: {
                  patterns: { items: { minLength: 1, maxLength: 200 } }
                }
              }
            }
          }
        }
      }
    })
    for (const phrase of [
      'privateInstructions',
      'capitaliseBubbles',
      'expressionDescriptions',
      'faceGroups',
      'toolFooter',
      'researchStarted',
      'offerPdf',
      '300',
      '200',
      'iu',
      'kaomoji',
      'fourth-wall',
      'short=280',
      '1–40 characters',
      'aira pack check',
      'aira pack import',
      'aira pack try',
      '--live',
      '--dry-run',
      '--expected-revision'
    ])
      expect(setupPrompt).toContain(phrase)
  })
})
