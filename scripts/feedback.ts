import { join } from 'node:path'
import { loadConfig } from '../src/config/loader.js'
import { readFeedback } from '../src/feedback/view.js'
import { openReader } from '../src/storage/database.js'

const reportId = process.argv[2]
if (!reportId) {
  process.stderr.write('usage: feedback <report_id>\n')
  process.exit(2)
}
const dataDir = process.env['AIRA_DATA_DIR'] || loadConfig('config.yml').storage.path
const db = openReader(join(dataDir, 'aira.db'))
try {
  const view = readFeedback(db, reportId)
  if (!view) {
    process.stderr.write('feedback report not found\n')
    process.exitCode = 1
  } else process.stdout.write(JSON.stringify(view, null, 2) + '\n')
} finally {
  db.close()
}
