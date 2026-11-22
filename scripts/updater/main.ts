import { dirname } from 'node:path'
import { createRealOps, deployLockPath, resolveSiteUrl } from './ops.js'
import { runUpdate } from './update.js'

const composeFile = process.env['AIRA_COMPOSE_FILE']
if (!composeFile) {
  process.stderr.write('AIRA_COMPOSE_FILE is required\n')
  process.exit(2)
}

const ops = createRealOps({
  composeFile,
  service: 'aira',
  coreUrl: process.env['AIRA_CORE_URL'] || 'http://127.0.0.1:9881',
  siteUrl: await resolveSiteUrl(dirname(composeFile), process.env),
  image: process.env['AIRA_IMAGE'] || 'ghcr.io/tolonglabs/aira',
  repository: process.env['AIRA_REPOSITORY'] || 'TolongLabs/AIRA',
  recordFile: process.env['AIRA_DEPLOY_LOG'] || '/var/lib/aira/deploys.jsonl'
})

const result = await runUpdate(ops, {
  waitForIdleMs: Number(process.env['AIRA_WAIT_FOR_IDLE_MS'] || 120000),
  healthTimeoutMs: Number(process.env['AIRA_HEALTH_TIMEOUT_MS'] || 60000),
  lockPath: deployLockPath(composeFile)
})

process.stdout.write(JSON.stringify(result) + '\n')
// A skipped tick is not a failure. Anything else that is not a deploy fails the unit.
const skipped =
  result.action === 'none' &&
  (result.reason === 'no_release' ||
    result.reason === 'up_to_date' ||
    result.reason === 'manual_release' ||
    result.reason === 'locked')
process.exit(result.action === 'deployed' || skipped ? 0 : 1)
