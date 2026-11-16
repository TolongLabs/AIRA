import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

// The gateway's helper modules and patch script are Python, run by the gateway on the host
// (docs/trd/system.md#gateway-helper-modules). Their tests are Python unittests, run here so `bun run test` covers
// them.
describe('gateway helper modules', () => {
  it('pass their Python tests', () => {
    const run = spawnSync('python3', ['-m', 'unittest', 'discover', '-s', 'deploy/gateway/tests'], {
      encoding: 'utf8',
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
    })
    expect(run.error).toBeUndefined()
    expect(run.status, run.stderr).toBe(0)
  })
})
