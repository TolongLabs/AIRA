import { describe, expect, it } from 'vitest'
import { describe as describeApp } from '../src/index.js'

describe('smoke', () => {
  it('returns the AIRA scaffold description', () => {
    expect(describeApp()).toContain('AIRA')
  })
})
