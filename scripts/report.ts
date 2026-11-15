import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { loadConfig } from '../src/config/loader.js'
import { buildReport, formatReport, newestSnapshotFile } from '../src/records/report.js'

const { values } = parseArgs({
  options: { from: { type: 'string' }, to: { type: 'string' } }
})

const now = Date.now()
const from = values.from ?? new Date(now - 30 * 86_400_000).toISOString().slice(0, 10)
const to = values.to ?? new Date(now + 86_400_000).toISOString().slice(0, 10)

const dataDir = process.env['AIRA_DATA_DIR'] || loadConfig('config.yml').storage.path
// The newest snapshot that passes an integrity check. The live database file is never opened.
const snap = newestSnapshotFile(join(dataDir, 'snapshots'))

if (!snap) {
  process.stderr.write('no verified snapshot\n')
  process.exit(1)
}

const report = await buildReport({
  snapshotFile: snap,
  archiveDir: join(dataDir, 'archive'),
  from,
  to
})
process.stdout.write(`${formatReport(report)}\n`)
