import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Logger } from '../records/logger.js'
import type { Storage } from '../storage/database.js'
import { isoNow } from '../storage/database.js'
import {authorizeOwner} from './owner-auth.js'
import { ownerCronTransport } from './owner-cron.js'
import { hostAllowed, originAllowed } from './writes.js'

// Confirmed owner text (docs/trd/site.md#confirmed-owner-text).
// POST /owner-api/messages reserves one dispatch; GET returns its outcome.
// Only the reservation creator dispatches. Duplicates never resend. Unknown is preserved.

export interface OwnerMessageDeps {
  storage: Storage
  ownerApiOrigin?: string
  ownerApiSocket?: string
  allowedOrigins: readonly string[]
  logger: Logger
  now?: () => Date
}

const MAX_BODY_BYTES = 64 * 1024
const MAX_TEXT_CODE_POINTS = 4000
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Outcome = 'unknown' | 'acknowledged' | 'refused'

interface OwnerMessageRow {
  submission_id: string
  chat_id: string
  fingerprint: string
  outcome: Outcome
  created_at: string
  updated_at: string
}

function noStoreJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return
  response
    .writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; sandbox"
    })
    .end(JSON.stringify(body))
}

function fail(response: ServerResponse, logger: Logger, status: number, code: string, event: string): void {
  logger.warn(event, { code, status })
  noStoreJson(response, status, { error: code })
}

async function readJsonBody(request: IncomingMessage): Promise<{ body: unknown } | { error: string; status: number }> {
  const type = request.headers['content-type'] ?? ''
  if (!/^application\/json(\s*;|$)/i.test(type)) return { status: 415, error: 'unsupported_media_type' }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) return { status: 413, error: 'body_too_large' }
    chunks.push(chunk as Buffer)
  }
  try {
    return { body: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) }
  } catch {
    return { status: 400, error: 'invalid_json' }
  }
}

function fingerprintOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function normalizeText(input: unknown): string | undefined {
  if (typeof input !== 'string' || !input.isWellFormed()) return undefined
  return input.trim()
}

function countCodePoints(text: string): number {
  return [...text].length
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

function resolveTarget(storage: Storage, chatId: string): string | undefined {
  return storage.read((db) => {
    const row = db.prepare('SELECT wa_id, type FROM chat WHERE chat_id = ?').get(chatId) as
      { wa_id: string; type: string } | undefined
    if (!row || (row.type !== 'group' && row.type !== 'dm')) return undefined
    const bare = row.wa_id.replace(/^whatsapp:/, '')
    if (!/^[A-Za-z0-9._+-]+(?:@[A-Za-z0-9.-]+)?$/.test(bare) || bare.length > 80) return undefined
    const domain = bare.split('@')[1]
    if (domain && !(row.type === 'group' ? domain === 'g.us' : ['s.whatsapp.net', 'c.us', 'lid'].includes(domain)))
      return undefined
    const target = 'whatsapp:' + bare
    const count = db.prepare('SELECT count(*) FROM chat WHERE wa_id IN (?,?)').pluck().get(bare, target)
    return count === 1 ? target : undefined
  })
}

async function dispatchIntro(
  deps: OwnerMessageDeps,
  token: string,
  target: string,
  text: string
): Promise<'acknowledged' | 'refused' | 'unknown'> {
  const origin = deps.ownerApiOrigin ?? 'http://owner.internal'
  try {
    const call = ownerCronTransport(origin, deps.ownerApiSocket, token, '/api/chats/intro')
    const result = await call({ target, text, stamp: false })
    if (
      result.status === 200 &&
      result.body.target === target &&
      result.body.text === text &&
      result.body.sent_at === null &&
      !('error' in result.body)
    )
      return 'acknowledged'
    if ([400, 401, 403, 404].includes(result.status) && typeof result.body.error === 'string') return 'refused'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

function readReservation(storage: Storage, submissionId: string): OwnerMessageRow | undefined {
  return storage.read((db) => {
    const row = db
      .prepare(
        'SELECT submission_id, chat_id, fingerprint, outcome, created_at, updated_at FROM owner_message WHERE submission_id = ?'
      )
      .get(submissionId) as OwnerMessageRow | undefined
    return row
  })
}

function tryReserve(
  storage: Storage,
  submissionId: string,
  chatId: string,
  fingerprint: string,
  now: () => Date
): { created: true } | { created: false; row: OwnerMessageRow } | { error: true } {
  try {
    return storage.tx((db) => {
      const at = isoNow(now)
      const insert = db
        .prepare(
          `INSERT INTO owner_message (submission_id, chat_id, fingerprint, outcome, created_at, updated_at)
           VALUES (?, ?, ?, 'unknown', ?, ?)
           ON CONFLICT (submission_id) DO NOTHING`
        )
        .run(submissionId, chatId, fingerprint, at, at)
      const created = Number((insert as { changes: number }).changes) === 1
      if (created) return { created: true as const }
      const existing = db
        .prepare(
          'SELECT submission_id, chat_id, fingerprint, outcome, created_at, updated_at FROM owner_message WHERE submission_id = ?'
        )
        .get(submissionId) as OwnerMessageRow | undefined
      if (!existing) return { error: true as const }
      return { created: false as const, row: existing }
    })
  } catch {
    return { error: true as const }
  }
}

function setOutcome(
  storage: Storage,
  submissionId: string,
  outcome: Extract<Outcome, 'acknowledged' | 'refused'>,
  now: () => Date
): boolean {
  try {
    storage.tx((db) => {
      db.prepare('UPDATE owner_message SET outcome = ?, updated_at = ? WHERE submission_id = ?').run(
        outcome,
        isoNow(now),
        submissionId
      )
    })
    return true
  } catch {
    return false
  }
}

function checkHostOrigin(
  request: IncomingMessage,
  allowedOrigins: readonly string[]
): { status: number; code: string } | null {
  if (!hostAllowed(request.headers.host)) return { status: 403, code: 'host_refused' }
  if (!originAllowed(request.headers.origin, allowedOrigins, request.headers.host))
    return { status: 403, code: 'origin_refused' }
  return null
}

function tokenOf(request: IncomingMessage): string | undefined {
  const token = request.headers['x-tolongai-token']
  if (typeof token !== 'string' || token.trim() === '') return undefined
  return token
}

/** POST /owner-api/messages. Reserves one dispatch and returns its outcome. Never auto resends. */
export async function handleOwnerMessagePost(
  request: IncomingMessage,
  response: ServerResponse,
  deps: OwnerMessageDeps
): Promise<void> {
  const log = deps.logger.child({ module: 'owner_message' })
  const now = deps.now ?? (() => new Date())

  const blocked = checkHostOrigin(request, deps.allowedOrigins)
  if (blocked) {
    fail(response, log, blocked.status, blocked.code, 'owner_message.origin_refused')
    return
  }
  if (!deps.ownerApiOrigin && !deps.ownerApiSocket) {
    fail(response, log, 503, 'owner_service_unconfigured', 'owner_message.unconfigured')
    return
  }
  const token = tokenOf(request)
  if (!token) {
    fail(response, log, 401, 'Owner token required', 'owner_message.auth_missing')
    return
  }

  const read = await readJsonBody(request)
  if ('error' in read) {
    fail(response, log, read.status, read.error, 'owner_message.invalid')
    return
  }
  const input = read.body as Record<string, unknown> | null
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    fail(response, log, 400, 'invalid_body', 'owner_message.invalid')
    return
  }
  const {
    submissionId: rawId,
    chatId,
    text
  } = input as {
    submissionId?: unknown
    chatId?: unknown
    text?: unknown
  }
  if (!isUuid(rawId)) {
    fail(response, log, 400, 'invalid_body', 'owner_message.invalid')
    return
  }
  const submissionId = rawId.toLowerCase()
  if (typeof chatId !== 'string' || chatId === '' || chatId.length > 200) {
    fail(response, log, 400, 'invalid_body', 'owner_message.invalid')
    return
  }
  const normalized = normalizeText(text)
  if (normalized === undefined) {
    fail(response, log, 400, 'invalid_body', 'owner_message.invalid')
    return
  }
  const codePoints = countCodePoints(normalized)
  if (codePoints < 1 || codePoints > MAX_TEXT_CODE_POINTS) {
    fail(response, log, 400, 'invalid_body', 'owner_message.invalid')
    return
  }
  const fingerprint = fingerprintOf(normalized)

  const auth = await authorizeOwner(deps, token)
  if (!auth.ok) {
    fail(
      response,
      log,
      auth.status,
      auth.code,
      auth.status === 401 ? 'owner_message.auth_failed' : 'owner_message.host_unavailable'
    )
    return
  }

  const existing = readReservation(deps.storage, submissionId)
  if (existing) {
    if (existing.chat_id !== chatId || existing.fingerprint !== fingerprint) {
      fail(response, log, 409, 'conflict', 'owner_message.conflict')
      return
    }
    log.info('owner_message.duplicate', { outcome: existing.outcome })
    noStoreJson(response, 200, { submissionId, outcome: existing.outcome })
    return
  }

  const target = resolveTarget(deps.storage, chatId)
  if (!target) {
    fail(response, log, 404, 'not_found', 'owner_message.unknown_chat')
    return
  }

  const reserved = tryReserve(deps.storage, submissionId, chatId, fingerprint, now)
  if ('error' in reserved) {
    fail(response, log, 500, 'internal', 'owner_message.reserve_failed')
    return
  }
  if (!reserved.created) {
    if (reserved.row.chat_id !== chatId || reserved.row.fingerprint !== fingerprint) {
      fail(response, log, 409, 'conflict', 'owner_message.conflict')
      return
    }
    log.info('owner_message.duplicate', { outcome: reserved.row.outcome })
    noStoreJson(response, 200, { submissionId, outcome: reserved.row.outcome })
    return
  }

  const result = await dispatchIntro(deps, token, target, normalized)
  if (result === 'acknowledged' || result === 'refused') {
    const saved = setOutcome(deps.storage, submissionId, result, now)
    if (!saved) {
      log.error('owner_message.record_failed', { outcome: result })
      noStoreJson(response, 200, { submissionId, outcome: 'unknown' })
      return
    }
    log.info('owner_message.dispatch', { outcome: result })
    noStoreJson(response, 200, { submissionId, outcome: result })
    return
  }

  log.warn('owner_message.ambiguous', {})
  noStoreJson(response, 200, { submissionId, outcome: 'unknown' })
}

/** GET /owner-api/messages/:submissionId. Returns the recorded outcome. */
export async function handleOwnerMessageGet(
  request: IncomingMessage,
  response: ServerResponse,
  deps: OwnerMessageDeps,
  rawId: string
): Promise<void> {
  const log = deps.logger.child({ module: 'owner_message' })

  const blocked = checkHostOrigin(request, deps.allowedOrigins)
  if (blocked) {
    fail(response, log, blocked.status, blocked.code, 'owner_message.origin_refused')
    return
  }
  if (!deps.ownerApiOrigin && !deps.ownerApiSocket) {
    fail(response, log, 503, 'owner_service_unconfigured', 'owner_message.unconfigured')
    return
  }
  const token = tokenOf(request)
  if (!token) {
    fail(response, log, 401, 'Owner token required', 'owner_message.auth_missing')
    return
  }

  let submissionId: string
  try {
    submissionId = decodeURIComponent(rawId).toLowerCase()
  } catch {
    fail(response, log, 400, 'invalid_request', 'owner_message.invalid')
    return
  }
  if (!isUuid(submissionId)) {
    fail(response, log, 400, 'invalid_request', 'owner_message.invalid')
    return
  }

  const auth = await authorizeOwner(deps, token)
  if (!auth.ok) {
    fail(
      response,
      log,
      auth.status,
      auth.code,
      auth.status === 401 ? 'owner_message.auth_failed' : 'owner_message.host_unavailable'
    )
    return
  }

  const row = readReservation(deps.storage, submissionId)
  if (!row) {
    fail(response, log, 404, 'not_found', 'owner_message.missing')
    return
  }
  noStoreJson(response, 200, { submissionId, outcome: row.outcome })
}

/** True for POST /owner-api/messages. */
export function isOwnerMessagePost(pathname: string, method: string | undefined): boolean {
  return pathname === '/owner-api/messages' && method === 'POST'
}

/** The submission id for GET /owner-api/messages/:id, or undefined when the path is not that route. */
export function ownerMessageIdOf(pathname: string, method: string | undefined): string | undefined {
  if (method !== 'GET') return undefined
  const prefix = '/owner-api/messages/'
  if (!pathname.startsWith(prefix)) return undefined
  const rest = pathname.slice(prefix.length)
  if (rest === '' || rest.includes('/') || rest.includes('?')) return undefined
  return rest
}
