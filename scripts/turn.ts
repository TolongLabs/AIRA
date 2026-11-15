import { join } from 'node:path'
import { loadConfig } from '../src/config/loader.js'
import { formatTurn, readTurn } from '../src/records/turn-view.js'
import { openReader } from '../src/storage/database.js'

const turnId = process.argv[2]
if (!turnId) {
  process.stderr.write('usage: turn <turn_id>\n')
  process.exit(2)
}

const dataDir = process.env['AIRA_DATA_DIR'] || loadConfig('config.yml').storage.path
const db = openReader(join(dataDir, 'aira.db'))
try {
  const view = readTurn(db, turnId)
  if (view === undefined) {
    process.stderr.write(`no turn ${turnId}\n`)
    process.exit(1)
  }
  process.stdout.write(formatTurn(view) + '\n')
} finally {
  db.close()
}
