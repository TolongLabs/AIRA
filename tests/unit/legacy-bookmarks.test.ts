import { describe, expect, it } from 'vitest'
import { translateLegacyBookmark } from '../../site/src/dashboard/legacy-bookmarks.js'

// Focused unit test for the preview/canonical legacy-fragment translator.
// Synthetic data only: every id below is invented for the test.
const PREVIEW = '/app/preview'

describe('translateLegacyBookmark', () => {
  it('maps a library item hash to its detail route and keeps the query', () => {
    expect(
      translateLegacyBookmark({ pathname: '/app/library.html', search: '?q=lemon', hash: '#song:synth-lemon' }, '')
    ).toEqual({ path: '/library/item/song%3Asynth-lemon', search: '?q=lemon', hash: '' })
  })

  it('decodes a percent-escaped item id once before re-encoding it', () => {
    expect(
      translateLegacyBookmark({ pathname: '/app/library.html', search: '', hash: '#song%3Asynth-lemon' }, '')
    ).toEqual({ path: '/library/item/song%3Asynth-lemon', search: '', hash: '' })
  })

  it('round-trips an opaque unicode item id and a literal percent', () => {
    expect(
      translateLegacyBookmark({ pathname: '/app/library.html', search: '', hash: '#note%3A%E5%90%88%E6%88%90-01' }, '')
    ).toEqual({ path: '/library/item/note%3A%E5%90%88%E6%88%90-01', search: '', hash: '' })
    expect(translateLegacyBookmark({ pathname: '/app/library.html', search: '', hash: '#song%3A100%25' }, '')).toEqual({
      path: '/library/item/song%3A100%25',
      search: '',
      hash: ''
    })
  })

  it('keeps a malformed escape inert instead of throwing', () => {
    expect(
      translateLegacyBookmark({ pathname: '/app/library.html', search: '?q=tea', hash: '#song%3A%E0%A4%A' }, '')
    ).toEqual({ path: '/library', search: '?q=tea', hash: '#song%3A%E0%A4%A' })
  })

  it('maps a plural library category to its type and restarts the pager', () => {
    expect(
      translateLegacyBookmark({ pathname: '/app/library.html', search: '?q=tea&page=2', hash: '#songs' }, '')
    ).toEqual({ path: '/library', search: '?q=tea&type=song', hash: '' })
  })

  it('resolves a legacy library fragment already sitting on the canonical path', () => {
    expect(translateLegacyBookmark({ pathname: '/library', search: '?q=tea', hash: '#vocab' }, '')).toEqual({
      path: '/library',
      search: '?q=tea&type=vocab',
      hash: ''
    })
  })

  it('leaves an already-canonical item with its reader anchor alone', () => {
    expect(
      translateLegacyBookmark({ pathname: '/library/item/song%3Asynth-lemon', search: '', hash: '#reader' }, '')
    ).toBeNull()
  })

  it('routes moved settings fragments to chats and routines', () => {
    expect(translateLegacyBookmark({ pathname: '/app/settings.html', search: '', hash: '#bindings' }, '')).toEqual({
      path: '/chats',
      search: '',
      hash: ''
    })
    expect(translateLegacyBookmark({ pathname: '/app/settings.html', search: '', hash: '#cron' }, '')).toEqual({
      path: '/automations/routines',
      search: '',
      hash: ''
    })
  })

  it('keeps a settings tab on system settings under the preview mount', () => {
    expect(translateLegacyBookmark({ pathname: '/app/settings.html', search: '', hash: '#voice' }, PREVIEW)).toEqual({
      path: '/app/preview/system/settings',
      search: '',
      hash: '#voice'
    })
  })

  it('maps a markets tab fragment and preserves the query', () => {
    expect(translateLegacyBookmark({ pathname: '/app/markets.html', search: '?q=btc', hash: '#alerts' }, '')).toEqual({
      path: '/markets/alerts',
      search: '?q=btc',
      hash: ''
    })
  })

  it('maps a chat bookmark and preserves the directory return state', () => {
    expect(
      translateLegacyBookmark(
        { pathname: '/app/chats.html', search: '?search=ali&status=active&page=2', hash: '#chat-c_synth01' },
        ''
      )
    ).toEqual({ path: '/chats/c_synth01/settings', search: '?search=ali&status=active&page=2', hash: '' })
  })

  it('refuses a chat fragment that fails validation', () => {
    expect(translateLegacyBookmark({ pathname: '/app/chats.html', search: '', hash: '#chat-../../etc' }, '')).toBeNull()
  })

  it('drops the legacy graph marker while keeping the lens query', () => {
    expect(translateLegacyBookmark({ pathname: '/app/graph.html', search: '?lens=ideas', hash: '#graph' }, '')).toEqual(
      { path: '/library/graph', search: '?lens=ideas', hash: '' }
    )
  })

  it('turns a graph item fragment into a focus query', () => {
    expect(
      translateLegacyBookmark({ pathname: '/app/graph.html', search: '', hash: '#song%3Asynth-lemon' }, '')
    ).toEqual({ path: '/library/graph', search: '?focus=song%3Asynth-lemon', hash: '' })
  })

  it('resolves a targetless send bookmark to the file-send picker page', () => {
    expect(translateLegacyBookmark({ pathname: '/app/send.html', search: '', hash: '' }, '')).toEqual({
      path: '/chats/files',
      search: '',
      hash: ''
    })
  })

  it('keeps the notices filter and its machines anchor', () => {
    expect(translateLegacyBookmark({ pathname: '/app/notices.html', search: '?q=box', hash: '#machines' }, '')).toEqual(
      { path: '/automations/notices', search: '?q=box', hash: '#machines' }
    )
  })

  it('ignores unknown paths entirely', () => {
    expect(translateLegacyBookmark({ pathname: '/app/unknown.html', search: '', hash: '' }, '')).toBeNull()
    expect(translateLegacyBookmark({ pathname: '/characters', search: '', hash: '' }, '')).toBeNull()
  })
})
