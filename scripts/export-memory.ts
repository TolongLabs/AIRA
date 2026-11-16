import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { readOldBrain, writeExport } from '../src/migration/readers.js'

// Turns a copy of the old brain folder into the legacy export (docs/trd/memory.md#migration). Prints counts only.
//   bun run export:memory --from <copy of the old brain folder> --out <private folder>

const { values } = parseArgs({ options: { from: { type: 'string' }, out: { type: 'string' } } })
if (!values.from || !values.out) {
  process.stderr.write('usage: export:memory --from <copy of the old brain folder> --out <private folder>\n')
  process.exit(2)
}
const from = resolve(values.from)
const out = resolve(values.out)
if (out === from || out.startsWith(`${from}/`)) {
  process.stderr.write('the export must not be written inside the folder it reads\n')
  process.exit(2)
}
const result = readOldBrain(from)
writeExport(out, result)
process.stdout.write(
  `${JSON.stringify({ chats: result.chats, facts: result.facts.length, lingo: result.lingo.length, skipped: result.skipped, rejects: result.rejects.length })}\n`
)
