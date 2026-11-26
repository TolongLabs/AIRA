import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createStandaloneModelStore } from '../../src/config/standalone-models.js'
import { testConfig } from '../support/core.js'
import { tmpDir } from '../support/tmp.js'

const key = 'synthetic-model-key-canary'
const mediaKey = 'synthetic-media-key-canary'
const media = { provider: 'gemini', model: 'fixture-gemini-model' }
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

  it('stores the explicit optional media role in separate private files and applies it only with main', () => {
    const { root, config, store } = fixture()
    config.media.watcher.model = 'ambient-fixture-model'
    expect(store.snapshot()).toMatchObject({ optionalRoles: ['media'] })
    expect(store.beginBoot().config.media.watcher.model).toBeNull()
    const saved = store.save({
      expectedRevision: null,
      main: { ...main, apiKey: key },
      fallback: null,
      media: { ...media, apiKey: mediaKey }
    })
    const revision = saved.savedRevision!
    expect(saved).toMatchObject({
      saved: { media: { ...media, credentialConfigured: true } },
      applied: null,
      configuration: 'pending_activation'
    })
    expect(JSON.stringify(saved)).not.toContain(mediaKey)
    const directory = join(root, 'standalone', 'revisions')
    expect(JSON.parse(readFileSync(join(directory, revision + '.json'), 'utf8'))).toEqual({
      schemaVersion: 1,
      main,
      fallback: null
    })
    expect(JSON.parse(readFileSync(join(directory, revision + '.credentials.json'), 'utf8'))).toEqual({
      schemaVersion: 1,
      main: key,
      fallback: null
    })
    const settings = join(directory, revision + '.media.json')
    const credential = join(directory, revision + '.media.credentials.json')
    expect(JSON.parse(readFileSync(settings, 'utf8'))).toEqual({ schemaVersion: 1, media })
    expect(statSync(settings).mode & 0o777).toBe(0o600)
    expect(statSync(credential).mode & 0o777).toBe(0o600)
    expect(readFileSync(settings, 'utf8')).not.toContain(mediaKey)
    expect(store.beginBoot().env.MEDIA_WATCHER_API_KEY).toBeUndefined()
    store.requestActivation({ expectedRevision: revision })
    const boot = store.beginBoot()
    expect(boot.config.media.watcher.model).toBe(media.model)
    expect(boot.env.MEDIA_WATCHER_API_KEY).toBe(mediaKey)
    expect(boot.config.media.gatewayDirs).toEqual([])
    store.completeActivation(revision)
    const loaded = createStandaloneModelStore(root, config)
    expect(loaded.snapshot()).toMatchObject({ applied: { media: { ...media, credentialConfigured: true } } })
    expect(loaded.beginBoot().env.MEDIA_WATCHER_API_KEY).toBe(mediaKey)
  })

  it('preserves omitted/empty media keys, rejects other providers and clears or disables explicitly', () => {
    const { store } = fixture()
    const first = store.save({
      expectedRevision: null,
      main: { ...main, apiKey: key },
      fallback: null,
      media: { ...media, apiKey: mediaKey }
    })
    const retained = store.save({ expectedRevision: first.savedRevision, main, fallback: null })
    expect(retained).toMatchObject({ saved: { media: { ...media, credentialConfigured: true } } })
    const blank = store.save({
      expectedRevision: retained.savedRevision,
      main,
      fallback: null,
      media: { ...media, apiKey: '' }
    })
    expect(blank).toMatchObject({ saved: { media: { ...media, credentialConfigured: true } } })
    for (const invalid of [
      { ...media, provider: 'openai-compatible' },
      { ...media, baseUrl: 'https://fixture.invalid' },
      { ...media, model: '../fixture' }
    ]) {
      expect(() =>
        store.save({ expectedRevision: blank.savedRevision, main, fallback: null, media: invalid })
      ).toThrow()
    }
    expect(store.snapshot().savedRevision).toBe(blank.savedRevision)
    const cleared = store.save({
      expectedRevision: blank.savedRevision,
      main,
      fallback: null,
      media: { ...media, apiKey: null }
    })
    expect(cleared).toMatchObject({ saved: { media: { ...media, credentialConfigured: false } } })
    store.requestActivation({ expectedRevision: cleared.savedRevision })
    expect(store.beginBoot().env.MEDIA_WATCHER_API_KEY).toBeUndefined()
    store.completeActivation(cleared.savedRevision!)
    const disabled = store.save({ expectedRevision: cleared.savedRevision, main, fallback: null, media: null })
    expect(disabled).toMatchObject({ saved: { media: null } })
  })

  it('loads historical revisions with both sidecars absent and refuses partial or invalid new sidecars', () => {
    const { root, store } = fixture()
    const first = store.save({ expectedRevision: null, main: { ...main, apiKey: key }, fallback: null }).savedRevision!
    const directory = join(root, 'standalone', 'revisions')
    rmSync(join(directory, first + '.media.json'))
    rmSync(join(directory, first + '.media.credentials.json'))
    store.requestActivation({ expectedRevision: first })
    expect(store.beginBoot().env.MEDIA_WATCHER_API_KEY).toBeUndefined()
    store.completeActivation(first)
    expect(store.snapshot()).toMatchObject({ applied: { media: null } })
    const next = store.save({
      expectedRevision: first,
      main,
      fallback: null,
      media: { ...media, apiKey: mediaKey }
    }).savedRevision!
    store.requestActivation({ expectedRevision: next })
    const credentials = join(directory, next + '.media.credentials.json')
    rmSync(credentials)
    const recovered = store.beginBoot()
    expect(recovered).toMatchObject({ revision: first, claimed: false, configured: true })
    expect(recovered.env.MEDIA_WATCHER_API_KEY).toBeUndefined()
    expect(store.snapshot()).toMatchObject({
      configuration: 'invalid',
      appliedRevision: first,
      lastFailure: 'activation_failed'
    })
    writeFileSync(credentials, JSON.stringify({ schemaVersion: 1, media: 42 }), { mode: 0o600 })
    expect(store.snapshot().configuration).toBe('invalid')
  })

  it('does not activate a media watcher with a missing main credential', () => {
    const { store } = fixture()
    const saved = store.save({ expectedRevision: null, main, fallback: null, media: { ...media, apiKey: mediaKey } })
    store.requestActivation({ expectedRevision: saved.savedRevision })
    const boot = store.beginBoot()
    expect(boot.configured).toBe(false)
    expect(boot.config.media.watcher.model).toBeNull()
    expect(boot.env.MEDIA_WATCHER_API_KEY).toBeUndefined()
  })

  it('disables media on an older-core revision and fails closed on unsafe or orphaned sidecars', () => {
    const { root, store } = fixture()
    const applied = store.save({
      expectedRevision: null,
      main: { ...main, apiKey: key },
      fallback: null,
      media: { ...media, apiKey: mediaKey }
    }).savedRevision!
    store.requestActivation({ expectedRevision: applied })
    store.beginBoot()
    store.completeActivation(applied)
    const older = store.save({ expectedRevision: applied, main, fallback: null }).savedRevision!
    const path = join(root, 'standalone', 'revisions', older)
    rmSync(path + '.media.json')
    rmSync(path + '.media.credentials.json')
    store.requestActivation({ expectedRevision: older })
    expect(store.beginBoot().env.MEDIA_WATCHER_API_KEY).toBeUndefined()
    store.completeActivation(older)
    expect(store.snapshot()).toMatchObject({ applied: { media: null } })
    writeFileSync(path + '.media.json', JSON.stringify({ schemaVersion: 1, media: null }), { mode: 0o600 })
    writeFileSync(path + '.media.credentials.json', JSON.stringify({ schemaVersion: 1, media: mediaKey }), {
      mode: 0o600
    })
    expect(store.snapshot().configuration).toBe('invalid')
    writeFileSync(path + '.media.credentials.json', JSON.stringify({ schemaVersion: 1, media: null }))
    chmodSync(path + '.media.json', 0o644)
    expect(store.snapshot().configuration).toBe('invalid')
    expect(store.beginBoot().configured).toBe(false)
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
