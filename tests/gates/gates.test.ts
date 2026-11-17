import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadPacks } from '../../src/character/loader.js'
import { liveCalls } from '../support/no-live-calls.js'

// The fixed gates of docs/trd/harness.md#fixed-gates that are not owned by another suite.

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
}

describe('Persona Purity', () => {
  it('no character name or phrase of any pack is written in src/', () => {
    const { packs } = loadPacks({ repositoryDir: 'characters' })
    const phrases = new Set<string>()
    for (const pack of packs.values()) {
      // The shipped example pack is named after the word "example", which code may use. Any other name may not appear.
      if (pack.id !== 'example') phrases.add(pack.card.displayName)
      for (const line of Object.values(pack.lines)) phrases.add(line)
      for (const mood of pack.moods.values()) {
        for (const phrase of [...mood.openers, ...mood.endings]) if (phrase.length >= 12) phrases.add(phrase)
      }
    }
    expect(phrases.size).toBeGreaterThan(5)
    for (const file of walk('src').filter((path) => path.endsWith('.ts'))) {
      const source = readFileSync(file, 'utf8')
      for (const phrase of phrases)
        expect(source.includes(phrase), `${file} holds a pack phrase: ${phrase}`).toBe(false)
    }
  })
})

describe('Privacy Scan', () => {
  // What a machine can find: a WhatsApp id, and a phone number. A real name cannot be found by a pattern; the
  // rule for names is that every fixture uses an invented one, and review checks it.
  const WHATSAPP_ID = /(\d{5,})(?:[:-]\d+)*@(?:s\.whatsapp\.net|g\.us|c\.us|lid|broadcast)/
  const PHONE = /(?<![\w.+-])\+(\d[\d -]{8,16}\d)(?![\w-])/
  /** A fixture may hold a number nobody could own: all zeros, or the digits counted up from 1. */
  const fake = (digits: string): boolean => /^0+$/.test(digits) || '1234567890123456789'.startsWith(digits)
  const hit = (line: string): boolean =>
    [WHATSAPP_ID, PHONE].some((pattern) => {
      const match = pattern.exec(line)
      return match !== null && !fake((match[1] as string).replace(/\D/g, ''))
    })
  const SKIP = /^(bun\.lock|graphify-out\/|docs\/diagrams\/|.*\.(png|jpg|webp|svg|parquet|db|ico)$)/

  it('no tracked file holds a WhatsApp id or a phone number', () => {
    const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
      .split('\n')
      .filter((file) => file !== '' && !SKIP.test(file))
    expect(files.length).toBeGreaterThan(100)
    const found: string[] = []
    for (const file of files) {
      let text: string
      try {
        text = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      text.split('\n').forEach((line, index) => {
        if (hit(line)) found.push(`${file}:${index + 1}`)
      })
    }
    expect(found).toEqual([])
  })

  it('finds what it is meant to find, and passes over numbers nobody could own', () => {
    const number = ['6012345', '6789'].join('')
    expect(hit(`${number}@s.whatsapp${'.net'}`)).toBe(true)
    expect(hit(`${number}:12@s.whatsapp${'.net'}`)).toBe(true)
    expect(hit(`${['120363', '0123456789'].join('')}@g${'.us'}`)).toBe(true)
    expect(hit(`call +${['60', '12', '345', '6789'].join(' ')} now`)).toBe(true)
    expect(hit('version 1.2.3+20260101')).toBe(false)
    expect(hit('2026-11-16T10:00:00.000+08:00')).toBe(false)
    expect(hit(`${'0'.repeat(12)}@g${'.us'}`)).toBe(false)
    expect(hit(`12345@${'lid'}`)).toBe(false)
  })
})

describe('Zero Live Calls', () => {
  it('a request to any host but this machine throws, in every test of the run', async () => {
    const before = liveCalls.length
    expect(() => fetch('https://example.invalid/v1/models')).toThrow(/live call/)
    expect(liveCalls.length).toBe(before + 1)
    liveCalls.pop()
    // A loopback address is allowed through: nothing listens on this port, so the request is refused, not blocked.
    await expect(fetch('http://127.0.0.1:9/')).rejects.not.toThrow(/live call/)
  })
})
