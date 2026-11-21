import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import type { NoteDocument, ReportFormat } from '../render/types.js'
import type { ResearchOffers } from '../research/offer.js'
import type { PostPortResult } from '../social/result.js'
import type { SocialLookupObserver } from '../social/types.js'
import type { Db } from '../storage/database.js'
import { isBlockedPage } from './blocked-page.js'

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
  depthSearch?(query: string, signal: AbortSignal): ReturnType<SearchPort['search']>
  images?(query: string, signal: AbortSignal): Promise<{ url: string }[]>
}

export interface PagePort {
  read(url: string, signal: AbortSignal): Promise<{ title: string; text: string }>
  /** Only the user agent and referrer are forwarded. A verified size permits a bounded MP4 range download. */
  download(
    url: string,
    signal: AbortSignal,
    maxBytes: number,
    headers?: Record<string, string> | null,
    rangeBytes?: number
  ): Promise<{ data: Buffer; contentType: string }>
}

export interface PostPort {
  read(url: string, signal: AbortSignal, observe?: SocialLookupObserver): Promise<PostPortResult>
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

export type NoteRenderer = (doc: NoteDocument, format: ReportFormat) => Promise<{ pdf: Buffer; pages: number }>

export interface ToolPorts {
  research?: ResearchOffers
  noteRenderer?: NoteRenderer
  reportFormat?: ReportFormat
  memory?: MemoryPort
  search?: SearchPort
  lyrics?: LyricsPort
  page?: PagePort
  /** One guarded page operation for search depth, without switching to another provider. */
  searchPage?: Pick<PagePort, 'read'>
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
const MAX_REDIRECTS = 5
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

function htmlToTitleAndText(html: string, preserveLines: boolean): { title: string; text: string } {
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
  const layout = preserveLines ? stripped.replace(/<\/(?:li|tr|p|h[1-6])\s*>|<br\s*\/?>/gi, '\n') : stripped
  const readable = decodeEntities(layout.replace(/<[^>]+>/g, ' '))
  const text = trimPageText(readable, preserveLines)
  return { title, text }
}

function trimPageText(text: string, preserveLines: boolean): string {
  const normalized = preserveLines
    ? text
        .replace(/[^\S\n]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .replace(/\n{3,}/g, '\n\n')
    : text.replace(/\s+/g, ' ')
  return normalized.trim().slice(0, MAX_READ_CHARS)
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

/** A byte range that sends nothing for this long resumes from its last byte. */
const RANGE_IDLE_MS = 4_000
const RANGE_RESUMES = 2

/** A response that is not the requested range of the same file. It ends the batch without a resume. */
class InvalidRange extends Error {}

/** The only request headers a media download may carry: a host's user agent and referrer, never cookies. */
function forwardedMediaHeaders(headers: Record<string, string> | null | undefined): Record<string, string> | undefined {
  const kept = Object.entries(headers ?? {}).filter(([name]) => ['user-agent', 'referer'].includes(name.toLowerCase()))
  return kept.length > 0 ? Object.fromEntries(kept) : undefined
}

/** One name=value pair of a Set-Cookie header. Attributes such as Path or Max-Age are dropped. */
function cookiePair(setCookie: string): [string, string] | undefined {
  const pair = setCookie.split(';', 1)[0] ?? ''
  const eq = pair.indexOf('=')
  const name = eq === -1 ? '' : pair.slice(0, eq).trim()
  return name === '' ? undefined : [name, pair.slice(eq + 1).trim()]
}

/** Cookies by host, for one lookup only. A host is sent back only the cookies it set. */
type CookieJar = Map<string, Map<string, string>>

function rememberCookies(jar: CookieJar, host: string, setCookies: string[]): void {
  for (const setCookie of setCookies) {
    const pair = cookiePair(setCookie)
    if (!pair) continue
    const cookies = jar.get(host) ?? new Map<string, string>()
    cookies.set(pair[0], pair[1])
    jar.set(host, cookies)
  }
}

function cookieHeader(jar: CookieJar, host: string): string | undefined {
  const cookies = jar.get(host)
  if (!cookies || cookies.size === 0) return undefined
  return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ')
}

/**
 * A PagePort over fetch. It resolves the host first and refuses a forbidden address, also after each redirect. A page
 * whose text is a block page is a failed read (docs/trd/tools.md#page-reads).
 */
export function createFetchPagePort(
  options: {
    maxBytes?: number
    lookup?: (host: string) => Promise<string[]>
    fetch?: typeof fetch
    preserveLines?: boolean
    sameOriginCookieless?: boolean
  } = {}
): PagePort {
  const defaultMaxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const lookup =
    options.lookup ?? (async (host: string) => (await dnsLookup(host, { all: true })).map((entry) => entry.address))
  // The global is looked up per request, so a fetch stubbed after the port exists still applies.
  const fetchFn: (url: string, init: RequestInit) => Promise<Response> =
    options.fetch ?? ((url, init) => fetch(url, init))

  const fetchChecked = async (
    initialUrl: string,
    signal: AbortSignal,
    headers?: Record<string, string>
  ): Promise<{ res: Response; url: string }> => {
    let currentUrl = initialUrl
    const lockedOrigin = options.sameOriginCookieless ? new URL(initialUrl).origin : undefined
    const jar: CookieJar | undefined = lockedOrigin ? undefined : new Map()
    for (let hops = 0; hops <= MAX_REDIRECTS; hops++) {
      if (isForbiddenUrl(currentUrl)) {
        throw new Error('forbidden url')
      }
      const parsed = new URL(currentUrl)
      if (lockedOrigin && (parsed.protocol !== 'https:' || parsed.origin !== lockedOrigin)) {
        throw new Error('media redirect left its origin')
      }
      const host = stripHostBrackets(parsed.hostname)
      if (isIP(host) === 0) {
        const addresses = await lookup(host)
        if (addresses.length === 0) throw new Error('host resolution returned no addresses')
        if (addresses.some(isForbiddenIp)) throw new Error('host resolved to a forbidden address')
      }
      const cookie = jar ? cookieHeader(jar, parsed.hostname) : undefined
      const res = await fetchFn(currentUrl, {
        redirect: 'manual',
        signal,
        headers: { ...headers, ...(cookie ? { cookie } : {}) }
      })
      if (jar) rememberCookies(jar, parsed.hostname, res.headers.getSetCookie())
      if (REDIRECT_STATUSES.has(res.status)) {
        if (hops === MAX_REDIRECTS) throw new Error('too many redirects')
        const location = res.headers.get('location')
        await res.body?.cancel()
        if (!location) throw new Error('redirect missing location')
        currentUrl = new URL(location, currentUrl).toString()
        continue
      }
      if (!res.ok) {
        throw new Error(`http status ${res.status}`)
      }
      return { res, url: currentUrl }
    }
    throw new Error('too many redirects')
  }

  /**
   * Reads one MP4 byte range. A part that sends nothing for RANGE_IDLE_MS resumes from its last byte, up to
   * RANGE_RESUMES times; every response must be the exact next range of the same file.
   */
  async function downloadRange(
    url: string,
    batchSignal: AbortSignal,
    start: number,
    end: number,
    bytes: number,
    headers?: Record<string, string>
  ): Promise<{ part: Buffer; finalUrl: string; version: string | null }> {
    const size = end - start + 1
    const chunks: Uint8Array[] = []
    let received = 0
    let first: { finalUrl: string; version: string | null } | undefined
    for (let attempt = 0; ; attempt++) {
      const idle = new AbortController()
      const attemptSignal = AbortSignal.any([batchSignal, idle.signal])
      let timer = setTimeout(() => idle.abort(), RANGE_IDLE_MS)
      const touch = () => {
        clearTimeout(timer)
        timer = setTimeout(() => idle.abort(), RANGE_IDLE_MS)
      }
      try {
        const from = start + received
        const { res, url: finalUrl } = await fetchChecked(url, attemptSignal, {
          ...headers,
          Range: `bytes=${from}-${end}`,
          'Accept-Encoding': 'identity'
        })
        const mime = res.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
        const version = res.headers.get('etag') ?? res.headers.get('last-modified')
        if (
          res.status !== 206 ||
          mime !== 'video/mp4' ||
          res.headers.get('content-range') !== `bytes ${from}-${end}/${bytes}` ||
          (first && (first.finalUrl !== finalUrl || first.version !== version)) ||
          !res.body
        ) {
          void res.body?.cancel().catch(() => undefined)
          throw new InvalidRange('invalid MP4 byte range')
        }
        first ??= { finalUrl, version }
        touch()
        const reader = res.body.getReader()
        const aborted = new Promise<never>((_, reject) => {
          const fail = () => reject(new Error('MP4 byte range stalled'))
          if (attemptSignal.aborted) fail()
          else attemptSignal.addEventListener('abort', fail, { once: true })
        })
        aborted.catch(() => undefined)
        try {
          while (received < size) {
            const { done, value } = await Promise.race([reader.read(), aborted])
            if (done) break
            touch()
            received += value.byteLength
            if (received > size) throw new InvalidRange('invalid MP4 byte range')
            chunks.push(value)
          }
        } finally {
          void reader.cancel().catch(() => undefined)
        }
        if (received !== size) throw new Error('incomplete MP4 byte range')
        return { part: Buffer.concat(chunks, size), ...first }
      } catch (error) {
        // A stall, a dropped connection or an early end resumes; a wrong response or the caller's deadline does not.
        if (!(error instanceof InvalidRange) && !batchSignal.aborted && attempt < RANGE_RESUMES) continue
        throw error
      } finally {
        clearTimeout(timer)
      }
    }
  }

  async function downloadRanges(url: string, signal: AbortSignal, bytes: number, headers?: Record<string, string>) {
    const cancel = new AbortController()
    const batchSignal = AbortSignal.any([signal, cancel.signal])
    const rangeCount = 4
    const parts = await Promise.all(
      Array.from({ length: rangeCount }, async (_, index) => {
        const start = Math.floor((index * bytes) / rangeCount)
        const end = Math.floor(((index + 1) * bytes) / rangeCount) - 1
        try {
          return await downloadRange(url, batchSignal, start, end, bytes, headers)
        } catch (error) {
          cancel.abort()
          throw error
        }
      })
    )
    if (parts.some((part) => part.finalUrl !== parts[0]?.finalUrl || part.version !== parts[0]?.version))
      throw new Error('MP4 byte ranges came from different versions')
    return {
      data: Buffer.concat(
        parts.map(({ part }) => part),
        bytes
      ),
      contentType: 'video/mp4'
    }
  }

  return {
    async read(url: string, signal: AbortSignal): Promise<{ title: string; text: string }> {
      const preserveLines = options.preserveLines ?? false
      const { res, url: finalUrl } = await fetchChecked(url, signal)
      const contentType = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
      if (contentType !== 'text/html' && contentType !== 'text/plain') {
        throw new Error(`unsupported content type: ${contentType || 'unknown'}`)
      }
      const body = await readBodyLimited(res, defaultMaxBytes)
      const raw = body.toString('utf8')
      const page =
        contentType === 'text/plain'
          ? { title: '', text: trimPageText(raw, preserveLines) }
          : htmlToTitleAndText(raw, preserveLines)
      if (isBlockedPage(page.text, finalUrl, page.title)) throw new Error('blocked page')
      return page
    },

    async download(
      url: string,
      signal: AbortSignal,
      maxBytes: number,
      headers?: Record<string, string> | null,
      rangeBytes?: number
    ): Promise<{ data: Buffer; contentType: string }> {
      const forwarded = forwardedMediaHeaders(headers)
      if (rangeBytes !== undefined) {
        if (
          !options.sameOriginCookieless ||
          !Number.isSafeInteger(rangeBytes) ||
          rangeBytes < 8 ||
          rangeBytes > maxBytes
        )
          throw new Error('invalid MP4 byte range limit')
        return downloadRanges(url, signal, rangeBytes, forwarded)
      }
      const { res } = await fetchChecked(url, signal, forwarded)
      const contentType = res.headers.get('content-type') ?? 'application/octet-stream'
      const data = await readBodyLimited(res, maxBytes)
      return { data, contentType }
    }
  }
}
