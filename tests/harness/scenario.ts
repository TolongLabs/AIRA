import { readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import type { GatewayMessage } from './gateway.js'

const ID_RE = /^[a-z][a-z0-9_-]{0,31}$/
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

const idSchema = z.string().regex(ID_RE, 'must match /^[a-z][a-z0-9_-]{0,31}$/')

const expectSchema = z.strictObject({
  mood: z.string().min(1).optional(),
  maxChars: z.number().int().positive().optional(),
  tools: z.array(z.string()).optional(),
  command: z.string().min(1).optional(),
  receipt: z.string().min(1).optional(),
  outcome: z.enum(['delivered', 'declined', 'muted', 'failed']).optional(),
  bubbles: z.number().int().positive().optional(),
  sticker: z.boolean().optional()
})

const stepSchema = z.strictObject({
  at: z.string().regex(TIME_RE, 'must be a valid 24-hour HH:MM time'),
  from: idSchema,
  text: z.string(),
  expect: expectSchema.optional()
})

const scenarioSchema = z
  .strictObject({
    chat: z.strictObject({
      id: idSchema,
      type: z.enum(['dm', 'group']),
      character: z.string().min(1)
    }),
    members: z.array(idSchema).min(1, 'members must not be empty'),
    steps: z.array(stepSchema).min(1, 'steps must not be empty')
  })
  .superRefine((data, ctx) => {
    const seen = new Set<string>()
    for (let i = 0; i < data.members.length; i++) {
      const member = data.members[i]!
      if (seen.has(member)) {
        ctx.addIssue({
          code: 'custom',
          path: ['members', i],
          message: `duplicate member "${member}"`
        })
      }
      seen.add(member)
    }

    if (data.chat.type === 'dm' && data.members.length !== 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['members'],
        message: 'dm chat must have exactly one member'
      })
    }

    let prevAt = ''
    for (let i = 0; i < data.steps.length; i++) {
      const step = data.steps[i]!
      if (!seen.has(step.from)) {
        ctx.addIssue({
          code: 'custom',
          path: ['steps', i, 'from'],
          message: `unknown member "${step.from}"`
        })
      }
      if (i > 0 && step.at < prevAt) {
        ctx.addIssue({
          code: 'custom',
          path: ['steps', i, 'at'],
          message: `time ${step.at} is earlier than previous step ${prevAt}`
        })
      }
      prevAt = step.at
    }
  })

export interface ScenarioStep {
  at: string
  from: string
  text: string
  expect?: {
    mood?: string
    maxChars?: number
    tools?: string[]
    command?: string
    receipt?: string
    outcome?: 'delivered' | 'declined' | 'muted' | 'failed'
    bubbles?: number
    sticker?: boolean
  }
}

export interface Scenario {
  name: string
  chat: { id: string; type: 'dm' | 'group'; character: string }
  members: string[]
  steps: ScenarioStep[]
}

export class ScenarioError extends Error {
  override name = 'ScenarioError'
}

export function parseScenario(name: string, source: string): Scenario {
  let raw: unknown
  try {
    raw = parseYaml(source)
  } catch (err) {
    throw new ScenarioError(`${name}: invalid YAML: ${(err as Error).message}`, { cause: err })
  }

  const parsed = scenarioSchema.safeParse(raw)
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join('.') : '<root>'
        return `${path}: ${issue.message}`
      })
      .join('; ')
    throw new ScenarioError(`${name}: ${details}`)
  }

  return {
    name,
    chat: parsed.data.chat,
    members: parsed.data.members,
    steps: parsed.data.steps as ScenarioStep[]
  }
}

export function loadScenario(path: string): Scenario {
  const name = basename(path, extname(path))
  const source = readFileSync(path, 'utf8')
  return parseScenario(name, source)
}

/** Invented, stable ids for a scenario's chat and members. Never shaped like a real WhatsApp id. */
export function scenarioIds(scenario: Scenario): { chatWaId: string; members: Record<string, string> } {
  const members: Record<string, string> = {}
  for (const member of scenario.members) {
    members[member] = `test-member-${member}`
  }
  return {
    chatWaId: `test-chat-${scenario.chat.id}`,
    members
  }
}

/** The gateway messages of a scenario, in order, with stable message ids `<name>-<step number>`. */
export function scenarioMessages(scenario: Scenario): GatewayMessage[] {
  const ids = scenarioIds(scenario)
  return scenario.steps.map((step, index) => ({
    chat: { waId: ids.chatWaId, kind: scenario.chat.type },
    sender: ids.members[step.from]!,
    mid: `${scenario.name}-${index + 1}`,
    text: step.text
  }))
}
