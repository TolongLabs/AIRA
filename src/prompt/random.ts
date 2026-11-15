import { randomInt } from 'node:crypto'

/** A seeded generator: the same seed always gives the same sequence of numbers in [0, 1). */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A new 32-bit seed from the system's random source. */
export function newSeed(): number {
  return randomInt(0, 0x100000000)
}

export function pick<T>(items: readonly T[], random: () => number): T | undefined {
  if (items.length === 0) return undefined
  return items[Math.floor(random() * items.length)]
}
