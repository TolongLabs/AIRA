import { join } from 'node:path'
import { checkPack, formatPackCheck } from '../src/character/check.js'
import { loadConfig } from '../src/config/loader.js'

const id = process.argv[2]
if (!id) {
  process.stderr.write('usage: pack:check <id>\n')
  process.exit(2)
}

const config = loadConfig('config.yml')
const result = checkPack({
  id,
  repositoryDir: 'characters',
  dataDir: join(config.storage.path, 'characters'),
  config
})
process.stdout.write(`${formatPackCheck(result)}\n`)
process.exit(result.ok ? 0 : 1)
