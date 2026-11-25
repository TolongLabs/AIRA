import { randomBytes, timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import { ensurePrivateDirectory, readPrivateText, writePrivateText } from './private-store.js'

// The per-install owner credential (docs/trd/site.md#standalone-owner-authentication).
const tokenPattern = /^[0-9a-f]{64}\n$/

export function ensurePrivateToken(dataRoot: string, filename: string): string {
  const directory = join(dataRoot, 'standalone')
  ensurePrivateDirectory(directory)
  const path = join(directory, filename)
  let body = readPrivateText(path, 65)
  if (body === undefined) {
    const candidate = randomBytes(32).toString('hex') + '\n'
    body = writePrivateText(path, candidate) ? candidate : readPrivateText(path, 65)
  }
  if (body === undefined || !tokenPattern.test(body)) throw new Error('standalone private credential is invalid')
  return body.slice(0, 64)
}

export function ensureStandaloneOwnerToken(dataRoot: string): string {
  return ensurePrivateToken(dataRoot, 'owner.token')
}

export function verifyStandaloneOwnerToken(stored: string, candidate: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(candidate) || !/^[0-9a-f]{64}$/.test(stored)) return false
  return timingSafeEqual(Buffer.from(stored, 'hex'), Buffer.from(candidate, 'hex'))
}
