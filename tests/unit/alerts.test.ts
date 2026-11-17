import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createLogger } from '../../src/records/logger.js'
import { insertFailure } from '../../src/storage/failures.js'
import { createAlerter } from '../../src/turn/alerts.js'
import { tmpDir, tmpStorage } from '../support/tmp.js'

it('delivers one spend alert and failure row within the minimum gap', () => {
  const storage = tmpStorage()
  const file = join(tmpDir(), 'alerts.jsonl')
  const logs: string[] = []
  const alerter = createAlerter({
    storage,
    deliveryFile: file,
    minGapMs: 900000,
    logger: createLogger({ module: 'alerts', level: 'debug', sink: (line) => logs.push(line) })
  })
  expect(alerter.raise('spend', { threshold: 0.8 })).toBe(true)
  expect(alerter.raise('spend', { threshold: 1 })).toBe(false)
  expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(1)
  expect(storage.read((db) => db.prepare('SELECT kind FROM failure').all())).toEqual([{ kind: 'budget' }])
  expect(logs).toHaveLength(1)
})

it('rejects unknown failure kinds at compile time', () => {
  const storage = tmpStorage()
  const writeUnknownKind = () => {
    // @ts-expect-error Unknown failure kinds are not part of the shared contract.
    storage.tx((db) => insertFailure(db, { stage: 'run', kind: 'unknown', message: 'invalid' }))
  }
  expect(writeUnknownKind).toBeTypeOf('function')
})
