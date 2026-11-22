import { describe, expect, it } from 'vitest'
import { createTurnSources, SOURCE_ID, searchLookup, sourceKey } from '../../src/turn/sources.js'

describe('sourceKey', () => {
  it('keeps separate registrations for different YouTube start-time fragments', () => {
    expect(sourceKey('https://youtu.be/demo#t=30')).not.toBe(sourceKey('https://youtu.be/demo#t=900'))
  })

  it('names one page by its lower-case host, without the fragment or tracking parameters', () => {
    expect(sourceKey('https://Example.COM/a?utm_source=x&id=7&fbclid=abc&si=q#top')).toBe('https://example.com/a?id=7')
    expect(sourceKey('https://example.com/a?si=1')).toBe('https://example.com/a')
  })

  it('keeps the path and the other parameters, so different pages stay apart', () => {
    expect(sourceKey('https://example.com/a?id=7')).not.toBe(sourceKey('https://example.com/a?id=8'))
    expect(sourceKey('https://example.com/a')).not.toBe(sourceKey('https://example.com/b'))
  })

  it('has no key for another scheme or an address that does not parse', () => {
    expect(sourceKey('file:///etc/passwd')).toBeUndefined()
    expect(sourceKey('not a link')).toBeUndefined()
  })
})

describe('createTurnSources', () => {
  it('gives ids in order of arrival, and keeps the first entry when a page arrives again', () => {
    const sources = createTurnSources()
    const search1 = searchLookup('c1')
    const search2 = searchLookup('c2')
    expect(search1).not.toBe(search2)
    expect(sources.add('https://example.com/a', 'message')).toEqual({
      id: 's1',
      url: 'https://example.com/a',
      lookup: 'message'
    })
    expect(sources.add('https://example.com/b?utm_medium=x', search1)).toEqual({
      id: 's2',
      url: 'https://example.com/b?utm_medium=x',
      lookup: 'search:c1'
    })
    expect(sources.add('https://EXAMPLE.com/a?fbclid=1', search2)).toEqual({
      id: 's1',
      url: 'https://example.com/a',
      lookup: 'message'
    })
    expect(sources.add('https://example.com/b', search2)).toEqual({
      id: 's2',
      url: 'https://example.com/b?utm_medium=x',
      lookup: 'search:c1'
    })
    expect(sources.add('https://example.com/c', search2)).toEqual({
      id: 's3',
      url: 'https://example.com/c',
      lookup: 'search:c2'
    })
  })

  it('registers each link in a text, without the punctuation or format marks around it', () => {
    const sources = createTurnSources()
    sources.addText('see *https://example.com/a*, and (https://example.com/b).', 'message')
    expect(sources.find({ source: 's1' })?.url).toBe('https://example.com/a')
    expect(sources.find({ source: 's2' })?.url).toBe('https://example.com/b')
    expect(sources.find({ source: 's3' })).toBeUndefined()
  })

  it('finds an entry by any form of its URL, and by its source id', () => {
    const sources = createTurnSources()
    sources.add('https://example.com/a?utm_source=feed', 'intake')
    expect(sources.find({ url: 'https://example.com/a' })).toMatchObject({ id: 's1', lookup: 'intake' })
    expect(sources.find({ source: 's1' })).toMatchObject({ url: 'https://example.com/a?utm_source=feed' })
    expect(sources.find({ source: ' s1 ' })).toMatchObject({ url: 'https://example.com/a?utm_source=feed' })
    expect(sources.find({ url: 'https://example.com/other' })).toBeUndefined()
    expect(sources.find({ url: 'file:///etc/passwd' })).toBeUndefined()
    expect(sources.find({ source: 's9' })).toBeUndefined()
  })

  it('records a read, and reports it from then on', () => {
    const sources = createTurnSources()
    expect(sources.readThisTurn()).toBe(false)
    sources.markRead()
    expect(sources.readThisTurn()).toBe(true)
  })

  it('settles only after every tracked call has settled, including one that fails', async () => {
    const sources = createTurnSources()
    const order: string[] = []
    sources.track(
      new Promise<void>((resolve) =>
        setTimeout(() => {
          order.push('read')
          resolve()
        }, 10)
      )
    )
    sources.track(Promise.reject(new Error('failed read')))
    await sources.settled()
    expect(order).toEqual(['read'])
  })
})

describe('SOURCE_ID', () => {
  it('accepts s and a positive number, and nothing else', () => {
    expect(SOURCE_ID.test('s1')).toBe(true)
    expect(SOURCE_ID.test('s120')).toBe(true)
    expect(SOURCE_ID.test('s0')).toBe(false)
    expect(SOURCE_ID.test('s01')).toBe(false)
    expect(SOURCE_ID.test('1')).toBe(false)
    expect(SOURCE_ID.test('https://example.com')).toBe(false)
  })
})
