import { mkdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createStandaloneModelStore } from '../../src/config/standalone-models.js'
import { testConfig } from '../support/core.js'
import { tmpDir } from '../support/tmp.js'

const key = 'synthetic-model-key-canary'
const main = {
  provider: 'openai-compatible',
  model: 'fixture-model',
  baseUrl: 'http://127.0.0.1:12345/v1',
  effort: '',
  deepEffort: '',
  usdPerMTokIn: 0,
  usdPerMTokOut: 0,
  usdPerMTokCached: 0
}
function fixture() {
  const root = tmpDir('aira-model-revisions-')
  mkdirSync(join(root, 'standalone'), { mode: 0o700 })
  const config = testConfig()
  return { root, config, store: createStandaloneModelStore(root, config) }
}

describe('standalone model revision authority', () => {
  it('saves a private candidate, applies only after boot verification and reloads the applied state', () => {
    const { root, config, store } = fixture()
    expect(store.snapshot()).toMatchObject({
      savedRevision: null,
      appliedRevision: null,
      configuration: 'setup_required'
    })
    const saved = store.save({ expectedRevision: null, main: { ...main, apiKey: key }, fallback: null })
    expect(saved.configuration).toBe('pending_activation')
    expect(saved.savedRevision).toBeTruthy()
    expect(saved.appliedRevision).toBeNull()
    expect(saved.saved?.main).toMatchObject({ ...main, credentialConfigured: true })
    expect(JSON.stringify(saved)).not.toContain(key)
    const revision = saved.savedRevision!
    const directory = join(root, 'standalone', 'revisions')
    expect(readFileSync(join(directory, revision + '.json'), 'utf8')).not.toContain(key)
    expect(statSync(join(directory, revision + '.credentials.json')).mode & 0o777).toBe(0o600)
    expect(store.requestActivation({ expectedRevision: revision }).activation).toBe('requested')
    const boot = store.beginBoot()
    expect(boot).toMatchObject({ revision, claimed: true, configured: true })
    expect(boot.env.LLM_API_KEY).toBe(key)
    expect(boot.config.llm.main).toEqual(main)
    expect(store.snapshot().appliedRevision).toBeNull()
    expect(store.snapshot().activation).toBe('starting')
    store.completeActivation(revision)
    const applied = createStandaloneModelStore(root, config)
    expect(applied.snapshot()).toMatchObject({
      appliedRevision: revision,
      configuration: 'configured',
      activation: 'idle'
    })
    expect(applied.beginBoot()).toMatchObject({ revision, configured: true, claimed: false })
  })

  it('keeps the previous applied revision after a failed or interrupted activation', () => {
    const { root, config, store } = fixture()
    const first = store.save({ expectedRevision: null, main: { ...main, apiKey: key }, fallback: null }).savedRevision!
    store.requestActivation({ expectedRevision: first })
    store.beginBoot()
    store.completeActivation(first)
    const second = store.save({
      expectedRevision: first,
      main: { ...main, model: 'next' },
      fallback: null
    }).savedRevision!
    store.requestActivation({ expectedRevision: second })
    expect(store.beginBoot().revision).toBe(second)
    // Process exits before committing the startup claim.
    const recovered = createStandaloneModelStore(root, config)
    const boot = recovered.beginBoot()
    expect(boot).toMatchObject({ revision: first, configured: true, claimed: false })
    expect(recovered.snapshot()).toMatchObject({
      savedRevision: second,
      appliedRevision: first,
      configuration: 'pending_activation',
      lastFailure: 'activation_failed'
    })
    recovered.requestActivation({ expectedRevision: second })
    recovered.beginBoot()
    recovered.failActivation(second)
    expect(recovered.snapshot().appliedRevision).toBe(first)
  })

  it('rejects stale and invalid candidates and preserves the existing revision', () => {
    const { store } = fixture()
    const revision = store.save({
      expectedRevision: null,
      main: { ...main, apiKey: key },
      fallback: null
    }).savedRevision!
    expect(() => store.save({ expectedRevision: null, main, fallback: null })).toThrow()
    expect(() =>
      store.save({ expectedRevision: revision, main: { ...main, baseUrl: 'http://127.0.0.1:9881/v1' }, fallback: null })
    ).toThrow()
    expect(() =>
      store.save({
        expectedRevision: revision,
        main: { ...main, provider: 'anthropic', effort: 'invalid' },
        fallback: null
      })
    ).toThrow()
    expect(store.snapshot().savedRevision).toBe(revision)
  })

  it('retains an empty key on save but explicit clear deactivates the model', () => {
    const { store } = fixture()
    const first = store.save({ expectedRevision: null, main: { ...main, apiKey: key }, fallback: null }).savedRevision!
    const second = store.save({ expectedRevision: first, main: { ...main, apiKey: '' }, fallback: null })
    expect(second.saved?.main?.credentialConfigured).toBe(true)
    const third = store.save({
      expectedRevision: second.savedRevision,
      main: { ...main, apiKey: null },
      fallback: null
    })
    expect(third.saved?.main?.credentialConfigured).toBe(false)
    store.requestActivation({ expectedRevision: third.savedRevision })
    const boot = store.beginBoot()
    expect(boot.configured).toBe(false)
    expect(boot.env.LLM_API_KEY).toBeUndefined()
    store.completeActivation(third.savedRevision!)
    expect(store.snapshot().configuration).toBe('setup_required')
  })
})
