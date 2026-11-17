import { readFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const args = process.argv.slice(2)

function flagValue(flag) {
  const index = args.indexOf(flag)
  return index !== -1 && index + 1 < args.length ? args[index + 1] : undefined
}

const systemPromptFile = flagValue('--system-prompt-file')
const mcpConfigRaw = flagValue('--mcp-config')

const system = systemPromptFile ? readFileSync(systemPromptFile, 'utf8') : ''

const chunks = []
for await (const chunk of process.stdin) {
  chunks.push(chunk)
}
const prompt = Buffer.concat(chunks).toString('utf8')

if (prompt.includes('FAKE_HANG')) {
  await new Promise(() => {})
}

if (prompt.includes('FAKE_EXIT')) {
  process.exit(3)
}

process.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init', model: 'fake-model' })}\n`)

if (prompt.includes('FAKE_NO_RESULT')) {
  process.exit(0)
}

if (prompt.includes('FAKE_RATE_LIMIT')) {
  process.stdout.write(
    `${JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'usage limit reached' })}\n`
  )
  process.exit(0)
}

// As measured with the real program on a spent subscription: an assistant line flagged rate_limit, a result whose
// subtype says success but is_error is true, the HTTP status, and exit code 1.
if (prompt.includes('FAKE_SESSION_LIMIT')) {
  process.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init', model: 'fake-model' })}\n`)
  process.stdout.write(`${JSON.stringify({ type: 'rate_limit_event' })}\n`)
  process.stdout.write(
    `${JSON.stringify({ type: 'assistant', error: 'rate_limit', message: { content: [{ type: 'text', text: 'limit' }] } })}\n`
  )
  process.stdout.write(
    `${JSON.stringify({ type: 'result', subtype: 'success', is_error: true, api_error_status: 429, result: "You've hit your session limit · resets 8:30pm" })}\n`
  )
  process.exit(1)
}

if (prompt.includes('FAKE_LOGIN')) {
  process.stdout.write(
    `${JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'please log in' })}\n`
  )
  process.exit(0)
}

if (prompt.includes('FAKE_EMPTY')) {
  process.stdout.write(
    `${JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      usage: { input_tokens: 1, output_tokens: 0, cache_read_input_tokens: 0 },
      total_cost_usd: 0,
      result: ''
    })}\n`
  )
  process.exit(0)
}

let tools = []
const calls = []

if (mcpConfigRaw) {
  // The real program takes the config as JSON text or as a file path.
  const config = JSON.parse(
    mcpConfigRaw.trimStart().startsWith('{') ? mcpConfigRaw : readFileSync(mcpConfigRaw, 'utf8')
  )
  const aira = config.mcpServers.aira
  const transport = new StreamableHTTPClientTransport(new URL(aira.url), {
    requestInit: { headers: aira.headers }
  })
  const client = new Client({ name: 'fake-claude', version: '1.0.0' })
  await client.connect(transport)
  const listed = await client.listTools()
  tools = listed.tools.map((tool) => tool.name)

  for (const line of prompt.split('\n')) {
    const match = /^CALL\s+(\S+)\s+(.+)$/.exec(line.trim())
    if (!match) continue
    const name = match[1]
    const toolArgs = JSON.parse(match[2])
    const res = await client.callTool({ name, arguments: toolArgs })
    const text = (res.content ?? [])
      .filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join('')
    calls.push({ name, text, isError: Boolean(res.isError) })
  }

  await client.close()
}

process.stdout.write(
  `${JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    usage: { input_tokens: 100, output_tokens: 25, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 },
    total_cost_usd: 0.012,
    result: JSON.stringify({
      args,
      hasRunnerToken: process.env.RUNNER_TOKEN !== undefined,
      cwd: process.cwd(),
      prompt,
      system,
      tools,
      calls
    })
  })}\n`
)
