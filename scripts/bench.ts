import { parseArgs } from 'node:util'
import { openChatSession } from '../src/bench/chat.js'
import { formatBenchSummary, loadBenchSet, runBench, writeBenchResult } from '../src/bench/run.js'
import { loadConfig } from '../src/config/loader.js'

const { values } = parseArgs({
  options: {
    set: { type: 'string', default: 'casual' },
    out: { type: 'string', default: 'bench-results' }
  }
})

const config = loadConfig('config.yml')
if (config.llm.main.model === '' || config.llm.main.baseUrl === '' || !process.env['LLM_API_KEY']) {
  process.stderr.write('bench requires llm.main.model, llm.main.baseUrl and LLM_API_KEY to be set\n')
  process.exit(2)
}

const setArg = values.set ?? 'casual'
const setPath = setArg === 'casual' ? 'bench/casual.yml' : setArg === 'tool' ? 'bench/tool.yml' : setArg
const set = loadBenchSet(setPath)
const outDir = values.out ?? 'bench-results'

const session = await openChatSession({ config, env: process.env })
try {
  const result = await runBench({ set, session, transport: config.llm.transport })
  const filePath = writeBenchResult(outDir, result)
  process.stdout.write(`${formatBenchSummary(result)}\n${filePath}\n`)
} finally {
  await session.close()
}
