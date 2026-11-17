import { parseArgs } from 'node:util'
import { openChatSession } from '../src/bench/chat.js'
import { loadConfig } from '../src/config/loader.js'
import { formatLiveSummary, loadLiveSet, runLive, writeLiveResult } from '../src/live/run.js'

const { values } = parseArgs({
  options: {
    set: { type: 'string', multiple: true, default: ['tools', 'persona'] },
    out: { type: 'string', default: 'live-results' },
    config: { type: 'string', default: 'config.yml' },
    character: { type: 'string' }
  }
})

const config = loadConfig(values.config ?? 'config.yml')
if (config.llm.main.model === '' || config.llm.main.baseUrl === '' || !process.env['LLM_API_KEY']) {
  process.stderr.write('live requires llm.main.model, llm.main.baseUrl and LLM_API_KEY to be set\n')
  process.exit(2)
}

let failed = 0
for (const name of values.set ?? []) {
  const set = loadLiveSet(name.endsWith('.yml') ? name : `live/${name}.yml`)
  // One session per set, so one set's history never steers another's.
  const session = await openChatSession({ config, env: process.env, character: values.character })
  try {
    const result = await runLive({ set, session, maxChars: config.format.bubbleMaxChars })
    const filePath = writeLiveResult(values.out ?? 'live-results', result)
    process.stdout.write(`${formatLiveSummary(result)}\n${filePath}\n`)
    failed += result.summary.failed
  } finally {
    await session.close()
  }
}
process.exit(failed > 0 ? 1 : 0)
