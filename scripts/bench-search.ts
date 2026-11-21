import { loadConfig } from '../src/config/loader.js'
import { createExaSearchPort } from '../src/tools/exa.js'
import { createFetchPagePort } from '../src/tools/ports.js'
import { createSearchDepth } from '../src/tools/search-depth.js'
import { createTurnSources } from '../src/turn/sources.js'
import { plainQueries, type SearchCase, searchCases } from './search-cases.js'

const apiKey = process.env['EXA_API_KEY']
if (!apiKey) throw new Error('Set EXA_API_KEY before measuring.')

const config = loadConfig('config.yml')
const search = createSearchDepth(
  { search: createExaSearchPort({ apiKey }), searchPage: createFetchPagePort({ preserveLines: true }) },
  config.search.depth
)
const plain = process.argv.includes('--plain')
const cases: (Pick<SearchCase, 'id' | 'query'> | SearchCase)[] = plain
  ? plainQueries.map((query, index) => ({ id: String(index + 1), query }))
  : searchCases
const timings: number[] = []

for (const item of cases) {
  const started = Date.now()
  const context = {
    callId: item.id,
    sources: createTurnSources(),
    now: () => new Date(),
    deadline: started + config.llm.turnDeadlineMs,
    callDeadline: started + config.tools.defaultTimeoutMs,
    signal: AbortSignal.timeout(config.llm.turnDeadlineMs)
  }
  const evidence =
    'fields' in item ? (await search.deep(item, context)).brief.passages : await search.plain(item.query, context)
  const ms = Date.now() - started
  timings.push(ms)
  console.log(JSON.stringify({ id: item.id, ms, results: evidence.length }))
}

timings.sort((a, b) => a - b)
const percentile = (p: number) => timings[Math.ceil(p * timings.length) - 1]
console.log(
  JSON.stringify({
    mode: plain ? 'plain' : 'fields',
    count: timings.length,
    p50: percentile(0.5),
    p95: percentile(0.95)
  })
)
