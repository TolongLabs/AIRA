import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { loadConfig } from '../src/config/loader.js'
import { applySettingsPlan, planSettingsMigration } from '../src/migration/settings-import.js'
import { openDatabase } from '../src/storage/database.js'
import { applyMigrations } from '../src/storage/migrate.js'

// The one-time settings and binding migration (docs/trd/data.md#migration-from-the-old-store). Run it with the core
// stopped, before the memory import. Prints counts and reason codes only.
//   bun run migrate:settings --from <private copy> --character <old name>=<pack id> ...             a dry run
//   bun run migrate:settings --from <private copy> --character <old name>=<pack id> ... --confirm   the real run

const { values } = parseArgs({
  options: {
    from: { type: 'string' },
    character: { type: 'string', multiple: true, default: [] },
    confirm: { type: 'boolean', default: false }
  }
})
if (!values.from) {
  process.stderr.write('usage: migrate:settings --from <folder> --character <old>=<pack> ... [--confirm]\n')
  process.exit(2)
}
const characters = new Map<string, string>()
for (const pair of values.character) {
  const [from, to] = pair.split('=')
  if (!from || !to) {
    process.stderr.write(`--character takes <old name>=<pack id>, not "${pair}"\n`)
    process.exit(2)
  }
  characters.set(from, to)
}

const plan = planSettingsMigration(values.from, characters, new Date())
const summary = { chats: plan.chats.length, settings: plan.settings.length, reported: plan.reported }
if (!values.confirm) {
  process.stdout.write(`dry run, nothing written: ${JSON.stringify(summary)}\n`)
  process.exit(0)
}
const dataDir = process.env['AIRA_DATA_DIR'] || loadConfig('config.yml').storage.path
const storage = openDatabase(join(dataDir, 'aira.db'))
try {
  applyMigrations(storage)
  process.stdout.write(`${JSON.stringify({ ...summary, applied: applySettingsPlan(storage, plan) })}\n`)
} finally {
  storage.close()
}
