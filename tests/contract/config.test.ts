import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
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

  it('reads an external tool server entry, and refuses one with an unknown key', () => {
    const server = `mcp:
  servers:
    - id: example
      transport: stdio
      command: ['example-server']
      tools: ['lookup']
      chats: []
`
    const withServer = source.replace(/mcp:\n {2}servers: \[\][^\n]*\n/, server)
    expect(parseConfig(withServer).mcp.servers).toEqual([
      { id: 'example', transport: 'stdio', command: ['example-server'], tools: ['lookup'], chats: [], timeoutMs: 10000 }
    ])
    expect(() => parseConfig(withServer.replace('chats: []', 'chats: []\n      shell: true'))).toThrow(/mcp/)
  })

  it('refuses to deploy while gateway.hostDataDir is empty', () => {
    const config = parseConfig(source)
    expect(() => requireDeployable(config)).toThrow(/gateway\.hostDataDir/)
    const placed = { ...config, gateway: { hostDataDir: '/srv/aira-data' } }
    // config.yml carries the launch models, so a placed install is deployable.
    expect(() => requireDeployable(placed)).not.toThrow()
    const unset = { ...config.llm.main, provider: '' }
    expect(() => requireDeployable({ ...placed, llm: { ...config.llm, main: unset } })).toThrow(/llm\.main\.provider/)
  })
})

describe('deploy/compose.yml', () => {
  it('gives the container a stop grace period longer than shutdown.graceMs', () => {
    const compose = parse(readFileSync('deploy/compose.yml', 'utf8')) as {
      services: { aira: { stop_grace_period: string } }
    }
    const match = /^(\d+)s$/.exec(compose.services.aira.stop_grace_period)
    expect(match).not.toBeNull()
    expect(Number(match?.[1]) * 1000).toBeGreaterThan(loadConfig('config.yml').shutdown.graceMs)
  })
})
