import { describe, expect, it } from 'vitest'
import {
  affectedChanged,
  checkBeforeSave,
  checkReadback,
  fileReceiptValid,
  HOST_WRITE_SPECS,
  isNoop,
  parseSettingsPayload,
  unsupportedBodyKeys
} from '../../site/src/lib/host-settings-conflict.js'

/* Host settings conflict detection (docs/trd/dashboard-state.md, host
   settings rows). The host offers no CAS for these writes, so the dashboard
   compares before save and verifies a masked readback after. Every fixture
   here is synthetic: invented modes, addresses and file names, no real host,
   no network, no credentials. */

const baseSettings = () => ({
  search: { mode: 'exa', exa_key: true },
  learning: { learning: 'on', calls_today: 3 },
  models: {
    chat: 'chat-a',
    agent: 'agent-a',
    effort: 'high',
    ollama: { enabled: false, endpoint: 'http://127.0.0.1:11434', fallback: '' }
  },
  avatar: { model: 'model-a', mirror: false },
  tts: { enabled: true, provider: 'riina', lang: 'auto' },
  home: { ip: '192.0.2.10', token_set: true }
})

describe('compare-before-save', () => {
  it('submits a write-only credential even when the public address is unchanged', () => {
    const base = baseSettings()
    expect(checkBeforeSave(base, base, { 'home.ip': base.home.ip }, ['home.ip'], true)).toEqual({ kind: 'ok' })
    expect(checkBeforeSave(base, {}, { 'home.ip': base.home.ip }, ['home.ip'], true)).toEqual({
      kind: 'unsupported',
      missing: ['home.ip']
    })
  })

  it('two sessions: the second save sees the first as stale and keeps its draft', () => {
    const base = baseSettings()
    // Session A saves search.mode exa -> ddgs against an unchanged host.
    const freshA = baseSettings()
    expect(checkBeforeSave(base, freshA, { 'search.mode': 'ddgs' }, HOST_WRITE_SPECS.search.affected)).toEqual({
      kind: 'ok'
    })
    // The host now holds A's value. Session B still bases on the old snapshot.
    const freshB = { ...baseSettings(), search: { mode: 'ddgs', exa_key: true } }
    const draftB = { 'search.mode': 'both' }
    const verdict = checkBeforeSave(base, freshB, draftB, HOST_WRITE_SPECS.search.affected)
    expect(verdict).toEqual({ kind: 'stale', changed: ['search.mode'] })
    // The draft is untouched: detection never rewrites it.
    expect(draftB).toEqual({ 'search.mode': 'both' })
  })

  it('compares only the affected public keys, ignoring unrelated host movement', () => {
    const base = baseSettings()
    // Lessons counters moved on the host; the search save must still go.
    const fresh = { ...baseSettings(), learning: { learning: 'on', calls_today: 9 } }
    expect(checkBeforeSave(base, fresh, { 'search.mode': 'ddgs' }, HOST_WRITE_SPECS.search.affected)).toEqual({
      kind: 'ok'
    })
    expect(affectedChanged(base, fresh, HOST_WRITE_SPECS.learning.affected)).toEqual([])
  })

  it('scopes the compare to the keys a save writes, not the whole section', () => {
    const base = baseSettings()
    const moved = baseSettings()
    moved.models.ollama = { enabled: true, endpoint: 'http://127.0.0.1:11434', fallback: '' }
    // An effort save compares only models.effort: the Ollama move does not block it.
    expect(checkBeforeSave(base, moved, { 'models.effort': 'low' }, ['models.effort'])).toEqual({ kind: 'ok' })
    // An endpoint save against the moved key goes stale instead.
    expect(checkBeforeSave(base, moved, { 'models.ollama.enabled': false }, ['models.ollama.enabled'])).toEqual({
      kind: 'stale',
      changed: ['models.ollama.enabled']
    })
  })

  it('a no-op draft sends no POST', () => {
    const base = baseSettings()
    const intended = { 'learning.learning': 'on' }
    expect(isNoop(base, intended)).toBe(true)
    expect(checkBeforeSave(base, base, intended, HOST_WRITE_SPECS.learning.affected)).toEqual({ kind: 'noop' })
    let posts = 0
    if (!isNoop(base, intended)) posts++
    expect(posts).toBe(0)
  })
})

describe('masked readback', () => {
  it('accepts the save only when every affected public key reads back as sent', () => {
    const intended = { 'models.effort': 'low', 'models.chat': 'chat-b' }
    const back = { models: { effort: 'low', chat: 'chat-b' } }
    expect(checkReadback(back, intended)).toEqual({ mismatched: [], unsupported: [] })
  })

  it('names a mismatched key instead of clearing the draft', () => {
    const intended = { 'tts.provider': 'isla' }
    const back = { tts: { provider: 'riina' } }
    // A third writer landed between our POST and our readback: last-write-won.
    expect(checkReadback(back, intended)).toEqual({ mismatched: ['tts.provider'], unsupported: [] })
  })

  it('reports a host that does not return the field as unsupported, not failed', () => {
    const intended = { 'search.mode': 'ddgs' }
    expect(checkReadback({ search: {} }, intended)).toEqual({ mismatched: [], unsupported: ['search.mode'] })
  })

  it('never reads a write-only credential back: only the masked flag counts', () => {
    const spec = HOST_WRITE_SPECS.home
    expect(spec.writeOnly).toContain('token')
    expect(spec.readOnly).toContain('home.token_set')
    // The body may carry the token; the readback compares the public key only.
    expect(unsupportedBodyKeys('home', { ip: '192.0.2.10', token: 'write-only-value' })).toEqual([])
    const back = { home: { ip: '192.0.2.10', token_set: true } }
    expect(checkReadback(back, { 'home.ip': '192.0.2.10' })).toEqual({ mismatched: [], unsupported: [] })
  })
})

describe('malformed and unsupported shapes', () => {
  it('rejects malformed responses instead of saving blindly', () => {
    for (const bad of [null, [], 'ok', 42, true]) {
      expect(() => parseSettingsPayload(bad, '/api/settings')).toThrow('Invalid response from /api/settings')
    }
    // A settings object holding an array is still an object — accepted by the
    // shape check; per-key validation happens at the call site.
    expect(() => parseSettingsPayload({ search: [] }, '/api/settings')).not.toThrow()
  })

  it('flags read-only and unknown keys in a body', () => {
    expect(unsupportedBodyKeys('home', { ip: '192.0.2.10', token_set: true })).toEqual(['token_set'])
    expect(unsupportedBodyKeys('models', { chat: 'chat-a', catalogue: [] })).toEqual(['catalogue'])
    expect(unsupportedBodyKeys('tts', { enabled: false, auto_tts: true })).toEqual(['auto_tts'])
    expect(unsupportedBodyKeys('search', { mode: 'ddgs', mystery: 1 })).toEqual(['mystery'])
  })

  it('accepts only an exact file receipt', () => {
    const target = { kind: 'soul', name: 'test-persona' }
    expect(fileReceiptValid({ kind: 'soul', name: 'test-persona', bytes: 12 }, target, 12)).toBe(true)
    expect(fileReceiptValid({ kind: 'soul', name: 'other', bytes: 12 }, target, 12)).toBe(false)
    expect(fileReceiptValid({ kind: 'soul', name: 'test-persona', bytes: 13 }, target, 12)).toBe(false)
    expect(fileReceiptValid(null, target, 12)).toBe(false)
    expect(fileReceiptValid('saved', target, 12)).toBe(false)
  })
})
