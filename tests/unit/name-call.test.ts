import { describe, expect, it } from 'vitest'
import { type NameCallPack, matchesName, resolveNames } from '../../src/turn/name-call.js'

const pack: NameCallPack = {
  card: {
    displayName: 'Aira',
    aliases: ['Example', 'AIRA']
  }
}

describe('resolveNames', () => {
  it('falls back to the pack displayName and unique aliases when nameCall.names is unset', () => {
    expect(resolveNames({}, pack)).toEqual(['Aira', 'Example'])
    expect(resolveNames({ 'nameCall.names': { value: undefined } }, { card: { displayName: 'Solo' } })).toEqual([
      'Solo'
    ])
    expect(resolveNames({}, undefined)).toEqual([])
  })

  it('uses chat nameCall.names when set, replacing the pack names', () => {
    expect(resolveNames({ 'nameCall.names': { value: ['Taiga', 'Ah Boy'] } }, pack)).toEqual(['Taiga', 'Ah Boy'])
    expect(resolveNames({ 'nameCall.names': { value: ['Taiga'] } }, undefined)).toEqual(['Taiga'])
  })
})

describe('matchesName', () => {
  it('matches whole words in any case and ignores partial word matches', () => {
    expect(matchesName('aira', ['Aira'])).toBe(true)
    expect(matchesName('AIRA', ['Aira'])).toBe(true)
    expect(matchesName('Hey Aira, are you there?', ['Aira'])).toBe(true)
    expect(matchesName('airasia is flying', ['Aira'])).toBe(false)
    expect(matchesName('myaira', ['Aira'])).toBe(false)
    expect(matchesName('aira2', ['Aira'])).toBe(false)
  })

  it('matches with punctuation next to a name', () => {
    expect(matchesName('aira!', ['Aira'])).toBe(true)
    expect(matchesName('(aira)', ['Aira'])).toBe(true)
    expect(matchesName('@aira?', ['Aira'])).toBe(true)
    expect(matchesName('wait—aira.', ['Aira'])).toBe(true)
  })

  it('supports unicode names, spaces, and regex metacharacters', () => {
    expect(matchesName('Café please', ['café'])).toBe(true)
    expect(matchesName('caféx', ['café'])).toBe(false)
    expect(matchesName('你好 小明！', ['小明'])).toBe(true)
    expect(matchesName('Привет, Аня!', ['аня'])).toBe(true)
    expect(matchesName('Hey ah boy, look here', ['Ah Boy'])).toBe(true)
    expect(matchesName('Hey ah boyz', ['Ah Boy'])).toBe(false)
    expect(matchesName('axb', ['a.b'])).toBe(false)
    expect(matchesName('hey a.b!', ['a.b'])).toBe(true)
  })

  it('ignores empty names', () => {
    expect(matchesName('hello, world!', ['', '   '])).toBe(false)
    expect(matchesName('hello', [])).toBe(false)
  })
})
