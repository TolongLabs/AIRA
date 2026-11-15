import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import { openChatSession } from '../src/bench/chat.js'
import { loadConfig } from '../src/config/loader.js'
import { BUBBLE_BREAK } from '../src/gateway/response.js'

const { values } = parseArgs({
  options: {
    chat: { type: 'string' },
    group: { type: 'boolean', default: false },
    character: { type: 'string' }
  }
})

const config = loadConfig('config.yml')
if (config.llm.main.model === '' || config.llm.main.baseUrl === '' || !process.env['LLM_API_KEY']) {
  process.stderr.write('chat requires llm.main.model, llm.main.baseUrl and LLM_API_KEY to be set\n')
  process.exit(2)
}

function splitBubbles(content: string): string[] {
  const bubbles: string[] = []
  let current: string[] = []
  for (const line of content.split(/\r?\n/)) {
    if (line === BUBBLE_BREAK) {
      const bubble = current.join('\n').trim()
      if (bubble.length > 0) bubbles.push(bubble)
      current = []
    } else {
      current.push(line)
    }
  }
  const tail = current.join('\n').trim()
  if (tail.length > 0) bubbles.push(tail)
  return bubbles
}

function val(v: unknown, fallback = '-'): string {
  return v === null || v === undefined || v === '' ? fallback : String(v)
}

const session = await openChatSession({
  config,
  env: process.env,
  chat: { waId: values.chat ?? 'bench-chat-1', kind: values.group ? 'group' : 'dm' },
  character: values.character
})

const rl = createInterface({ input: process.stdin, output: process.stdout })
try {
  while (true) {
    let line: string
    try {
      line = await rl.question('> ')
    } catch {
      break
    }
    if (line.trim() === '') break

    const { content, ms, turn } = await session.send(line)
    for (const bubble of splitBubbles(content)) {
      process.stdout.write(`${bubble}\n`)
    }
    const state = val(turn?.['state'])
    const mood = val(turn?.['mood'])
    const inTok = val(turn?.['input_tokens'], '0')
    const outTok = val(turn?.['output_tokens'], '0')
    const cost = typeof turn?.['cost_usd'] === 'number' ? turn['cost_usd'].toFixed(4) : '0.0000'
    process.stdout.write(`[state=${state} mood=${mood} ms=${ms} in=${inTok} out=${outTok} cost=$${cost}]\n`)
  }
} finally {
  rl.close()
  await session.close()
}
