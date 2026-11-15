import { cpSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkPack, formatPackCheck } from '../../src/character/check.js'
import { loadConfig } from '../../src/config/loader.js'
import { tmpDir } from '../support/tmp.js'

describe('pack check', () => {
  it('passes for the shipped example pack and reports prompt size under the ceiling', () => {
    const config = loadConfig('config.yml')
    const result = checkPack({
      id: 'example',
      repositoryDir: 'characters',
      config
    })
    expect(result.ok).toBe(true)
    expect(result.faults).toEqual([])
    expect(result.promptTokens).toBeGreaterThan(0)
    expect(result.promptTokens).toBeLessThanOrEqual(result.ceiling)
    expect(formatPackCheck(result)).toContain('pack example: ok')
  })

  it('fails for an unknown pack id', () => {
    const config = loadConfig('config.yml')
    const result = checkPack({
      id: 'no-such-pack',
      repositoryDir: 'characters',
      config
    })
    expect(result.ok).toBe(false)
    expect(result.faults[0]).toContain('unknown pack')
  })

  it('reports the loader fault when a pack in the data folder has a broken lines.yml', () => {
    const dataDir = tmpDir('aira-pack-check-')
    const packDir = join(dataDir, 'broken')
    mkdirSync(dataDir, { recursive: true })
    cpSync('characters/example', packDir, { recursive: true })
    writeFileSync(join(packDir, 'lines.yml'), 'not: [valid\n', 'utf8')

    const config = loadConfig('config.yml')
    const result = checkPack({
      id: 'broken',
      repositoryDir: 'characters',
      dataDir,
      config
    })
    expect(result.ok).toBe(false)
    expect(result.faults[0]).toContain('lines.yml')
  })

  it('reports prompt over the ceiling when maxSystemTokens is 10', () => {
    const config = loadConfig('config.yml')
    config.prompt.maxSystemTokens = 10
    const result = checkPack({
      id: 'example',
      repositoryDir: 'characters',
      config
    })
    expect(result.ok).toBe(false)
    expect(result.faults).toContain('prompt over the ceiling')
  })
})
