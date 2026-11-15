import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ConfigError, loadConfig, parseConfig, requireDeployable } from '../../src/config/loader.js'

const source = readFileSync('config.yml', 'utf8')

describe('config.yml', () => {
  it('parses the repository file', () => {
    const config = loadConfig('config.yml')
    expect(config.format.maxBubbles).toBe(3)
    expect(config.gateway.hostDataDir).toBe('')
    expect(config.storage.path).toBe('/data')
  })

  it('fills the defaults the TRD states for keys the file omits', () => {
    const config = parseConfig(source)
    expect(config.judge.timeoutMs).toBe(1500)
    expect(config.media.timeoutMs).toBe(30000)
  })

  it('stops on an unknown key', () => {
    expect(() => parseConfig(source + '\nsurprise:\n  key: 1\n')).toThrow(ConfigError)
    expect(() => parseConfig(source.replace('maxBubbles: 3', 'maxBubbles: 3\n  extra: 1'))).toThrow(/format/)
  })

  it('stops on a wrong type and names the key', () => {
    expect(() => parseConfig(source.replace('maxBubbles: 3', "maxBubbles: 'three'"))).toThrow(/format\.maxBubbles/)
  })

  it('stops when the critical free space is not below the warn level', () => {
    expect(() => parseConfig(source.replace('criticalFreeMb: 512', 'criticalFreeMb: 4096'))).toThrow(/criticalFreeMb/)
  })

  it('stops on text that is not YAML and on a missing file', () => {
    expect(() => parseConfig('a: [1')).toThrow(ConfigError)
    expect(() => loadConfig('no-such-config.yml')).toThrow(ConfigError)
  })

  it('refuses to deploy while gateway.hostDataDir is empty', () => {
    const config = parseConfig(source)
    expect(() => requireDeployable(config)).toThrow(/gateway\.hostDataDir/)
    expect(() => requireDeployable({ ...config, gateway: { hostDataDir: '/srv/aira-data' } })).not.toThrow()
  })
})
