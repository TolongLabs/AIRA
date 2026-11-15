import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { loadConfig } from '../src/config/loader.js'
import { formatReport, runMigration } from '../src/migration/memory-import.js'

// The one-time memory migration (docs/trd/memory.md#migration). Run it with the core stopped.
//   bun run migrate:memory --from <legacy export folder> [--out <private folder>]             a dry run
//   bun run migrate:memory --from <legacy export folder> [--out <private folder>] --confirm   the real run

const { values } = parseArgs({
  options: { from: { type: 'string' }, out: { type: 'string' }, confirm: { type: 'boolean', default: false } }
})
if (!values.from) {
  process.stderr.write('usage: migrate:memory --from <folder> [--out <folder>] [--confirm]\n')
  process.exit(2)
}

const dataDir = process.env['AIRA_DATA_DIR'] || loadConfig('config.yml').storage.path
try {
  const report = await runMigration({
    from: values.from,
    out: values.out ?? join(dataDir, 'migration'),
    databaseFile: join(dataDir, 'aira.db'),
    confirm: values.confirm
  })
  process.stdout.write(`${formatReport(report)}\n`)
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`)
  process.exit(1)
}
