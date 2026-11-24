import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { stringify } from 'yaml'
import { DashboardSettingsStore } from '../../scripts/dashboard-settings-store.js'
import { testConfig } from '../support/core.js'
import { tmpDir } from '../support/tmp.js'

const down = { available: false, status: 'Runner unavailable' }
function setup() {
  const root = tmpDir('host-settings-')
  const c = testConfig()
  c.gateway.hostDataDir = '/synthetic/data'
  c.llm.main.model = 'synthetic-model'
  c.llm.main.baseUrl = 'https://synthetic.invalid/v1'
  c.llm.main.provider = 'openai-compatible'
  writeFileSync(join(root, 'config.yml'), '# retain this comment\n' + stringify(c))
  writeFileSync(join(root, '.env'), "OTHER='first\nLLM_API_KEY=inside\nlast'\nLLM_API_KEY=fixture-old-key\n")
  return { root, store: new DashboardSettingsStore(root, Buffer.from('synthetic-owner-token')) }
}
describe('host deployment settings', () => {
  it('saves validated values, refuses stale writes and restores the last active files on failed activation', async () => {
    const { root, store } = setup()
    const original = readFileSync(join(root, 'config.yml'), 'utf8')
    const rev = store.snapshot(down).revision
    expect(() => store.save({ revision: rev, group: 'memory', changes: { recallTokenBudget: -1 } }, down)).toThrow(
      /validation/
    )
    store.save({ revision: rev, group: 'memory', changes: { recallTokenBudget: 373 } }, down)
    const saved = store.snapshot(down)
    expect(saved.fields.memory!.recallTokenBudget!.value).toBe(373)
    expect(saved.state).toBe('pending')
    expect(readFileSync(join(root, 'config.yml'), 'utf8')).toContain('# retain this comment')
    expect(() => store.save({ revision: rev, group: 'memory', changes: { enabled: 'off' } }, down)).toThrow(/changed/)
    let calls = 0
    await expect(
      store.apply(saved.revision, async () => {
        if (calls++ === 0) throw Error()
      })
    ).rejects.toThrow(/restored/)
    expect(calls).toBe(2)
    expect(readFileSync(join(root, 'config.yml'), 'utf8')).toBe(original)
    expect(store.snapshot(down).state).toBe('restored')
  })
  it('replaces and clears one credential without echoing values, disturbing a multiline neighbor, or accepting arbitrary names', async () => {
    const { root, store } = setup()
    const first = store.snapshot(down)
    expect(JSON.stringify(first)).not.toContain('fixture-old-key')
    expect(() => store.save({ revision: first.revision, credential: 'UNLISTED', replacement: 'x' }, down)).toThrow()
    const next = 'fictional$two"parts'
    store.save({ revision: first.revision, credential: 'LLM_API_KEY', replacement: next }, down)
    const snap = store.snapshot(down)
    expect(JSON.stringify(snap)).not.toContain(next)
    expect(snap.credentials.find((c) => c.name === 'LLM_API_KEY')?.present).toBe(true)
    expect(readFileSync(join(root, '.env'), 'utf8')).toContain("OTHER='first\nLLM_API_KEY=inside\nlast'")
    expect(statSync(join(root, '.env')).mode & 0o777).toBe(0o600)
    store.save({ revision: snap.revision, credential: 'LLM_API_KEY', replacement: '' }, down)
    const cleared = store.snapshot(down)
    expect(cleared.credentials.find((c) => c.name === 'LLM_API_KEY')?.present).toBe(false)
    await store.apply(cleared.revision, async () => {})
    expect(store.snapshot(down).state).toBe('current')
  })
  it('checks availability for either role on the server and prevents both roles selecting the same wrapper', () => {
    for (const key of ['transport', 'fallbackTransport']) {
      const { store } = setup()
      const revision = store.snapshot(down).revision
      expect(() => store.save({ revision, group: 'llm', changes: { [key]: 'subscription' } }, down)).toThrow(
        /unavailable/
      )
      store.save(
        { revision, group: 'llm', changes: { [key]: 'subscription' } },
        { available: true, status: 'Available' }
      )
      const next = store.snapshot(down)
      expect(next.fields.llm![key]!.value).toBe('subscription')
      expect(() =>
        store.save(
          {
            revision: next.revision,
            group: 'llm',
            changes: { transport: 'subscription', fallbackTransport: 'subscription' }
          },
          { available: true, status: 'Available' }
        )
      ).toThrow()
    }
  })
})
