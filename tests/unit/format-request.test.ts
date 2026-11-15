import { describe, expect, it } from 'vitest'
import { detectFormatRequest } from '../../src/format/request.js'

describe('detectFormatRequest', () => {
  it.each([
    ['put that in a table please', 'table'],
    ['explain it step by step', 'steps'],
    ['give me the options as a list', 'list'],
    ['can you do that in bullet points', 'list'],
    ['show me the code', 'code'],
    ['tell me in detail how it works', 'detail'],
    ['explain fully', 'detail'],
    ["don't summarise, I want everything", 'detail']
  ])('"%s" asks for %s', (text, reason) => {
    expect(detectFormatRequest(text)).toBe(reason)
  })

  it.each(['what is on the list for tonight?', 'ok thanks', 'the table is booked for six', 'I wrote some code today'])(
    '"%s" asks for no form',
    (text) => {
      expect(detectFormatRequest(text)).toBeUndefined()
    }
  )
})
