import { createRealOps } from './ops.js'
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
  image: process.env['AIRA_IMAGE'] || 'ghcr.io/tolonglabs/aira',
  repository: process.env['AIRA_REPOSITORY'] || 'TolongLabs/AIRA',
  recordFile: process.env['AIRA_DEPLOY_LOG'] || '/var/lib/aira/deploys.jsonl'
})

const result = await runUpdate(ops, {
  waitForIdleMs: Number(process.env['AIRA_WAIT_FOR_IDLE_MS'] || 120000),
  healthTimeoutMs: Number(process.env['AIRA_HEALTH_TIMEOUT_MS'] || 60000)
})

process.stdout.write(JSON.stringify(result) + '\n')
process.exit(result.action === 'rolled_back' ? 1 : 0)
