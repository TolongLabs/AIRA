import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import type { ResearchOffers } from '../research/offer.js'
import type { SocialReply } from '../social/types.js'
import type { SocialPlatform } from '../social/urls.js'
import type { Db } from '../storage/database.js'

export interface MemoryPort {
  /** Facts and summaries of this chat. With an asker, a line says whether a fact is about them or another member. */
  recall(chatId: string, query: string, limit: number, askerId?: string): { itemId: string; text: string }[]
  history(chatId: string, query: string, limit: number): { at: string; senderId?: string; text: string }[]
  /** Validates a note and asks the judge. It runs before the commit, outside any transaction. */
  checkNote(
    input: { chatId: string; subjectId: string; text: string; turnId: string },
    signal: AbortSignal
  ): Promise<{ ok: true } | { ok: false; reason: string }>
  /** Stores a note inside the caller's transaction. */
  note(
    db: Db,
    input: { chatId: string; subjectId: string; text: string; turnId: string }
  ): { itemId: string; effect: 'added' | 'unchanged' }
  /** Forgets one fact of this chat by id and sets the forget barrier, inside the caller's transaction. False when the chat has no such fact. */
  forget(db: Db, input: { chatId: string; itemId: string }): boolean
  /** Sets the forget barrier alone, inside the caller's transaction. */
  forgetPending(db: Db, input: { chatId: string }): void
  lingo(db: Db, input: { chatId: string; word: string; meaning: string; turnId: string }): string
}

export interface SearchPort {
  search(query: string, signal: AbortSignal): Promise<{ title: string; url: string; snippet: string }[]>
  images?(query: string, signal: AbortSignal): Promise<{ url: string }[]>
}

export interface PagePort {
  read(url: string, signal: AbortSignal): Promise<{ title: string; text: string }>
  download(url: string, signal: AbortSignal, maxBytes: number): Promise<{ data: Buffer; contentType: string }>
}

export interface PostPort {
  read(
    url: string,
    signal: AbortSignal
  ): Promise<{
    untrusted?: true
    author: string
    text: string
    media: string[]
    platform?: SocialPlatform
    handle?: string
    createdAt?: string | null
    quotedText?: string
    replyCount?: number | null
    canonicalUrl?: string
    replies?: SocialReply[]
    durationSec?: number | null
  }>
}

/** The gateway's schedule. The reminder tools are the only code that talks to it. */
/** The gateway's schedule, as the core reaches it: by rewriting the wanted-jobs file after a change. */
export interface SchedulePort {
  sync(): void
}

/** The lyrics provider of the lessons tools (docs/trd/tools.md#lessons-data-model). Its text is untrusted. */
export interface LyricsPort {
  /** The provider's name, stored with each candidate. */
  name: string
  search(query: string, signal: AbortSignal): Promise<{ ref: string; title: string; artist: string }[]>
  /** The lyrics of one result, by the reference the provider gave in a search. */
  fetch(ref: string, signal: AbortSignal): Promise<{ title: string; artist: string; lines: string[] }>
}

export interface ToolPorts {
  research?: ResearchOffers
  memory?: MemoryPort
  search?: SearchPort
  lyrics?: LyricsPort
  page?: PagePort
  post?: PostPort
  schedule?: SchedulePort
  /** The files folder of the data volume, for putFile. */
  filesDir: string
}

function isForbiddenIpv4Parts(a: number, b: number): boolean {
  if (a === 0) return true // 0.0.0.0/8
  if (a === 10) return true // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64.0.0/10
  if (a === 127) return true // 127.0.0.0/8
  if (a === 169 && b === 254) return true // 169.254.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
  if (a === 192 && b === 168) return true // 192.168.0.0/16
  return false
}

function parseIpv4(ip: string): [number, number, number, number] | undefined {
  const parts = ip.split('.')
  if (parts.length !== 4) return undefined
  const nums: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined
    const n = Number(part)
    if (n < 0 || n > 255) return undefined
    nums.push(n)
  }
  return [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0, nums[3] ?? 0]
}

function parseIpv6Groups(raw: string): number[] | undefined {
  const zoneIdx = raw.indexOf('%')
  const ip = zoneIdx === -1 ? raw : raw.slice(0, zoneIdx)
  const doubleColon = ip.indexOf('::')
  if (doubleColon !== -1 && ip.indexOf('::', doubleColon + 2) !== -1) return undefined

  const parseSide = (side: string): number[] | undefined => {
    if (side === '') return []
    const tokens = side.split(':')
    const out: number[] = []
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i] ?? ''
      if (token.includes('.')) {
        if (i !== tokens.length - 1) return undefined
        const v4 = parseIpv4(token)
        if (!v4) return undefined
        out.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3])
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(token)) return undefined
        out.push(Number.parseInt(token, 16))
      }
    }
    return out
  }

  if (doubleColon === -1) {
    const groups = parseSide(ip)
    return groups && groups.length === 8 ? groups : undefined
  }
  const left = parseSide(ip.slice(0, doubleColon))
  const right = parseSide(ip.slice(doubleColon + 2))
  if (!left || !right) return undefined
  const missing = 8 - left.length - right.length
  if (missing < 1) return undefined
  return [...left, ...new Array<number>(missing).fill(0), ...right]
}

export function isForbiddenIp(ip: string): boolean {
  const version = isIP(ip)
  if (version === 4) {
    const v4 = parseIpv4(ip)
    return v4 ? isForbiddenIpv4Parts(v4[0], v4[1]) : true
  }
  if (version === 6) {
    const groups = parseIpv6Groups(ip)
    if (!groups) return true
    const allZero = groups.every((g) => g === 0)
    if (allZero) return true // ::
    const isLoopback = groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1
    if (isLoopback) return true // ::1
    const first = groups[0] ?? 0
    if ((first & 0xfe00) === 0xfc00) return true // fc00::/7
    if ((first & 0xffc0) === 0xfe80) return true // fe80::/10
    const isV4Mapped =
      groups[0] === 0 &&
      groups[1] === 0 &&
      groups[2] === 0 &&
      groups[3] === 0 &&
      groups[4] === 0 &&
      groups[5] === 0xffff
    if (isV4Mapped) {
      const g6 = groups[6] ?? 0
      const g7 = groups[7] ?? 0
      return isForbiddenIpv4Parts((g6 >> 8) & 0xff, g6 & 0xff) || (g6 === 0 && g7 === 0)
    }
    return false
  }
  return false
}

function stripHostBrackets(hostname: string): string {
  const lower = hostname.toLowerCase().replace(/\.$/, '')
  if (lower.startsWith('[') && lower.endsWith(']')) return lower.slice(1, -1)
  return lower
}

/** True for an address the core must never fetch: not http or https, localhost, or a private or link-local IP. */
export function isForbiddenUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return true
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return true
  if (parsed.username !== '' || parsed.password !== '') return true

  const host = stripHostBrackets(parsed.hostname)
  if (host === '') return true
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return true
  }
  return isForbiddenIp(host)
}

const DEFAULT_MAX_BYTES = 2_000_000
const MAX_REDIRECTS = 3
const MAX_READ_CHARS = 8_000
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
}

function htmlToTitleAndText(html: string): { title: string; text: string } {
  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)
  const title = titleMatch
    ? decodeEntities(titleMatch[1] ?? '')
        .replace(/\s+/g, ' ')
        .trim()
    : ''
  const stripped = html
    .replace(/<title\b[^>]*>[\s\S]*?<\/title>/gi, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
  const text = decodeEntities(stripped).replace(/\s+/g, ' ').trim().slice(0, MAX_READ_CHARS)
  return { title, text }
}

async function readBodyLimited(res: Response, maxBytes: number): Promise<Buffer> {
  const lenHeader = res.headers.get('content-length')
  if (lenHeader !== null) {
    const parsedLen = Number(lenHeader)
    if (Number.isFinite(parsedLen) && parsedLen > maxBytes) {
      throw new Error('response exceeds size limit')
    }
  }
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > maxBytes) throw new Error('response exceeds size limit')
    return buf
  }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        total += value.byteLength
        if (total > maxBytes) {
          await reader.cancel()
          throw new Error('response exceeds size limit')
        }
        chunks.push(value)
      }
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, total)
}

/** A PagePort over fetch. It resolves the host first and refuses a forbidden address, also after each redirect. */
export function createFetchPagePort(
  options: { maxBytes?: number; lookup?: (host: string) => Promise<string[]> } = {}
): PagePort {
  const defaultMaxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const lookup =
    options.lookup ?? (async (host: string) => (await dnsLookup(host, { all: true })).map((entry) => entry.address))

  const fetchChecked = async (initialUrl: string, signal: AbortSignal): Promise<Response> => {
    let currentUrl = initialUrl
    for (let hops = 0; hops <= MAX_REDIRECTS; hops++) {
      if (isForbiddenUrl(currentUrl)) {
        throw new Error('forbidden url')
      }
      const parsed = new URL(currentUrl)
      const host = stripHostBrackets(parsed.hostname)
      if (isIP(host) === 0) {
        const addresses = await lookup(host)
        if (addresses.length === 0) throw new Error('host resolution returned no addresses')
        if (addresses.some(isForbiddenIp)) throw new Error('host resolved to a forbidden address')
      }
      const res = await fetch(currentUrl, { redirect: 'manual', signal })
      if (REDIRECT_STATUSES.has(res.status)) {
        if (hops === MAX_REDIRECTS) throw new Error('too many redirects')
        const location = res.headers.get('location')
        if (!location) throw new Error('redirect missing location')
        currentUrl = new URL(location, currentUrl).toString()
        continue
      }
      if (!res.ok) {
        throw new Error(`http status ${res.status}`)
      }
      return res
    }
    throw new Error('too many redirects')
  }

  return {
    async read(url: string, signal: AbortSignal): Promise<{ title: string; text: string }> {
      const res = await fetchChecked(url, signal)
      const contentType = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
      if (contentType !== 'text/html' && contentType !== 'text/plain') {
        throw new Error(`unsupported content type: ${contentType || 'unknown'}`)
      }
      const body = await readBodyLimited(res, defaultMaxBytes)
      const raw = body.toString('utf8')
      if (contentType === 'text/plain') {
        return { title: '', text: raw.replace(/\s+/g, ' ').trim().slice(0, MAX_READ_CHARS) }
      }
      return htmlToTitleAndText(raw)
    },

    async download(url: string, signal: AbortSignal, maxBytes: number): Promise<{ data: Buffer; contentType: string }> {
      const res = await fetchChecked(url, signal)
      const contentType = res.headers.get('content-type') ?? 'application/octet-stream'
      const data = await readBodyLimited(res, maxBytes)
      return { data, contentType }
    }
  }
}
