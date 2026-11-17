import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type ChatSession, openChatSession } from '../../src/bench/chat.js'
import { loadLiveSet, personaFailures, runLive, writeLiveResult } from '../../src/live/run.js'
import { queueModel } from '../support/app.js'
import { testConfig } from '../support/core.js'
import { tmpDir } from '../support/tmp.js'

function fakeSession(replies: { content: string; state?: string; tools?: string[] }[]): ChatSession {
  let n = 0
  return {
    async send() {
      const reply = replies[n++] ?? { content: '' }
      const tools = reply.tools ?? []
      return {
        content: reply.content,
        ms: 10,
        turn: { state: reply.state ?? 'delivered' },
        toolCalls: tools.length,
        tools
      }
    },
    async close() {}
  }
}

describe('live checks', () => {
  it('loads both shipped sets, with no digit runs of 7+ digits and no @', () => {
    expect(loadLiveSet('live/tools.yml').cases.length).toBeGreaterThan(0)
    expect(loadLiveSet('live/persona.yml').cases.length).toBeGreaterThan(0)
    for (const file of ['live/tools.yml', 'live/persona.yml']) {
      const raw = readFileSync(file, 'utf8')
      expect(raw).not.toMatch(/\d{7,}/)
      expect(raw).not.toContain('@')
    }
  })

  it('refuses a case with both tools and noTools, an empty prompt, or no cases', () => {
    const dir = tmpDir('aira-live-set-')
    const bad = {
      both: 'name: b\ndescription: b\ncases:\n  - prompt: hi\n    expect: { tools: [web_search], noTools: true }\n',
      blank: 'name: b\ndescription: b\ncases:\n  - prompt: "  "\n',
      none: 'name: b\ndescription: b\ncases: []\n'
    }
    for (const [name, body] of Object.entries(bad)) {
      const path = join(dir, `${name}.yml`)
      writeFileSync(path, body, 'utf8')
      expect(() => loadLiveSet(path)).toThrow()
    }
  })

  it('persona checks name each failure', () => {
    expect(personaFailures('Morning! Coffee first, then science.', 3800)).toEqual([])
    expect(personaFailures("I'm a lab assistant at heart.", 3800)).toEqual([])
    expect(personaFailures('', 3800)).toEqual(['empty'])
    expect(personaFailures('NO_REPLY', 3800)).toEqual(['empty'])
    expect(personaFailures('As an AI, I cannot feel.', 3800)).toEqual(['names-itself-ai'])
    expect(personaFailures("I'm just a language model.", 3800)).toEqual(['names-itself-ai'])
    expect(personaFailures("Don't worry, I'm a real person.", 3800)).toEqual(['claims-human'])
    expect(personaFailures('## Cats\nThey nap.', 3800)).toEqual(['heading'])
    expect(personaFailures('| a | b |\n| - | - |', 3800)).toEqual(['table'])
    expect(personaFailures('See [my site](https://example.com).', 3800)).toEqual(['link-text'])
    expect(personaFailures('x'.repeat(11), 10)).toEqual(['too-long'])
  })

  it('checks tool expectations, records only check names and fails a turn that was not delivered', async () => {
    const set = {
      name: 'mini',
      description: 'four cases',
      cases: [
        { prompt: 'secret prompt one', expect: { tools: ['web_search'] } },
        { prompt: 'secret prompt two', expect: { tools: ['web_search'] } },
        { prompt: 'secret prompt three', expect: { noTools: true as const } },
        { prompt: 'secret prompt four' }
      ]
    }
    const session = fakeSession([
      { content: 'secret reply one', tools: ['web_search'] },
      { content: 'secret reply two' },
      { content: 'As an AI I looked it up.', tools: ['web_search'] },
      { content: '', state: 'failed' }
    ])
    const result = await runLive({ set, session, maxChars: 3800, now: () => new Date('2026-01-02T03:04:05.000Z') })

    expect(result.rows.map((row) => row.failed)).toEqual([
      [],
      ['tool-not-called'],
      ['tool-called', 'names-itself-ai'],
      ['not-delivered']
    ])
    expect(result.summary).toEqual({ count: 4, passed: 1, failed: 3 })

    const raw = readFileSync(writeLiveResult(tmpDir('aira-live-out-'), result), 'utf8')
    const lines = raw.trimEnd().split('\n')
    expect(lines).toHaveLength(5)
    expect(JSON.parse(lines[4]!)).toMatchObject({ summary: true, passed: 1, failed: 3 })
    for (const forbidden of ['secret prompt', 'secret reply', 'As an AI']) expect(raw).not.toContain(forbidden)
  })

  it('reads the tools a real turn called from its tool_call rows', async () => {
    const config = testConfig((c) => {
      c.storage.minFreeMb = 2
      c.storage.criticalFreeMb = 1
      c.gateway.hostDataDir = '/host/aira-data'
      c.llm.main = {
        ...c.llm.main,
        provider: 'openai-compatible',
        model: 'main-model',
        baseUrl: 'https://main.invalid/v1'
      }
      c.llm.maxRetries = 0
    })
    const model = queueModel([
      { toolCalls: [{ id: 'call-1', name: 'reminder_list', args: {} }] },
      { text: 'Nothing on your list yet.' }
    ])
    const session = await openChatSession({ config, env: {}, clients: { main: model } })
    try {
      const result = await runLive({
        set: {
          name: 'one',
          description: 'one',
          cases: [{ prompt: 'what reminders do I have?', expect: { tools: ['reminder_list'] } }]
        },
        session,
        maxChars: config.format.bubbleMaxChars
      })
      expect(result.rows[0]).toMatchObject({ state: 'delivered', tools: ['reminder_list'], passed: true })
    } finally {
      await session.close()
    }
  })
})
