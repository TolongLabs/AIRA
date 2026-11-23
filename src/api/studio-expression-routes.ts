import type { IncomingMessage, ServerResponse } from 'node:http'
import { convertExpression, STUDIO_MAX_INPUT_BYTES, STUDIO_OUTPUT_LIMIT_BYTES } from '../media/studio-expression.js'

// Already-authorized studio expression routes (docs/trd/site.md#character-studio-operation-contract).
// The orchestrator owns authentication, route recognition, the filesystem publisher and the shared
// pack lock. This module owns HTTP framing, bounded JSON input, field validation, conversion through
// the shared converter, and safe error mapping. It never touches the filesystem, never registers a
// live service, and never sets x-request-id: the caller propagates the request id.

/** One expression as the collection lists it. */
export interface StudioExpressionEntry {
  name: string
  description: string
}

/** What list returns: the pack revision and its expressions. */
export interface StudioExpressionListResult {
  revision: string
  expressions: StudioExpressionEntry[]
}

/** What publish returns: the new pack revision. */
export interface StudioExpressionPublishResult {
  revision: string
}

/** Controlled store failures. Message text never reaches the client, so paths cannot leak. */
export type StudioExpressionStoreCode =
  | 'invalid_id'
  | 'invalid_body'
  | 'not_found'
  | 'pack_read_only'
  | 'pack_unparseable'
  | 'conflict'
  | 'stale_revision'
  | 'too_large'
  | 'busy'

export class StudioExpressionStoreError extends Error {
  override name = 'StudioExpressionStoreError'
  readonly code: StudioExpressionStoreCode
  readonly status: number

  constructor(code: StudioExpressionStoreCode, status: number, message: string = code) {
    super(message)
    this.code = code
    this.status = status
  }
}

/** Injected storage. Each method may return or throw synchronously, or resolve or reject. */
export interface StudioExpressionStore {
  list(id: string): Promise<StudioExpressionListResult> | StudioExpressionListResult
  read(id: string, name: string): Promise<Buffer> | Buffer
  publish(
    id: string,
    expectedRevision: string,
    name: string,
    description: string,
    convertedWebp: Buffer
  ): Promise<StudioExpressionPublishResult> | StudioExpressionPublishResult
}

export interface StudioExpressionRouteParams {
  id: string
  name?: string
}

export interface StudioExpressionRouteOptions {
  signal?: AbortSignal
}

/** Lowercase safe slugs for packs and expressions. */
export const STUDIO_EXPRESSION_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/
const REVISION_PATTERN = /^[0-9a-f]{64}$/
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/

/**
 * Bounded JSON limit: the 4 MiB image plus its base64 expansion and a small object overhead.
 * Derived from the converter limit so the two cannot drift apart.
 */
export const STUDIO_EXPRESSION_JSON_LIMIT = Math.ceil((STUDIO_MAX_INPUT_BYTES * 4) / 3) + 64 * 1024

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp'])

function normalizeMime(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const raw = value.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  const mime = raw === 'image/jpg' ? 'image/jpeg' : raw
  return ALLOWED_MIME.has(mime) ? mime : undefined
}

/** Strict canonical base64: correct alphabet, padding and round-trip. No whitespace. */
function decodeCanonicalBase64(input: unknown): Buffer | undefined {
  if (typeof input !== 'string' || input.length === 0) return undefined
  if (input.length % 4 !== 0) return undefined
  if (!BASE64_PATTERN.test(input)) return undefined
  let decoded: Buffer
  try {
    decoded = Buffer.from(input, 'base64')
  } catch {
    return undefined
  }
  if (decoded.length === 0) return undefined
  if (decoded.toString('base64') !== input) return undefined
  return decoded
}

function isValidDescription(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 300 && !/[\r\n]/.test(value)
}

function json(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent || response.destroyed) return
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  })
  response.end(JSON.stringify(body))
}

function methodNotAllowed(response: ServerResponse): void {
  json(response, 405, { error: 'method_not_allowed' })
}

function storeFailure(error: unknown): { status: number; code: string } {
  if (error instanceof StudioExpressionStoreError) {
    switch (error.code) {
      case 'invalid_id':
        return { status: 400, code: 'invalid_id' }
      case 'invalid_body':
        return { status: 400, code: 'invalid_body' }
      case 'not_found':
        return { status: 404, code: 'not_found' }
      case 'stale_revision':
        return { status: 409, code: 'stale_revision' }
      case 'pack_read_only':
        return { status: 409, code: 'pack_read_only' }
      case 'pack_unparseable':
        return { status: 409, code: 'pack_unparseable' }
      case 'conflict':
        return { status: 409, code: 'conflict' }
      case 'busy':
        return { status: 409, code: 'busy' }
      case 'too_large':
        return { status: 413, code: 'too_large' }
    }
  }
  return { status: 500, code: 'internal' }
}

function converterFailure(reason: string): { status: number; code: string } {
  switch (reason) {
    case 'unsupported_type':
      return { status: 415, code: 'unsupported_media' }
    case 'too_large':
    case 'dimensions_exceeded':
    case 'output_too_large':
      return { status: 413, code: reason === 'too_large' ? 'too_large' : reason }
    case 'busy':
      return { status: 409, code: 'busy' }
    case 'aborted':
      return { status: 400, code: 'aborted' }
    case 'timeout':
      return { status: 500, code: 'timeout' }
    case 'invalid_image':
    case 'animated':
      return { status: 400, code: reason }
    default:
      return { status: 500, code: 'conversion_failed' }
  }
}

type ReadOk = { ok: true; value: unknown }
type ReadFail = { ok: false; status: number; code: string }

async function readJsonBody(request: IncomingMessage, limit: number, signal?: AbortSignal): Promise<ReadOk | ReadFail> {
  const type = request.headers['content-type'] ?? ''
  if (!/^application\/json(\s*;|$)/i.test(type)) return { ok: false, status: 415, code: 'unsupported_media' }
  if (signal?.aborted) return { ok: false, status: 400, code: 'aborted' }
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of request) {
      if (signal?.aborted) return { ok: false, status: 400, code: 'aborted' }
      const piece = chunk as Buffer
      size += piece.length
      if (size > limit) return { ok: false, status: 413, code: 'body_too_large' }
      chunks.push(piece)
    }
  } catch {
    return { ok: false, status: 400, code: 'aborted' }
  }
  if (signal?.aborted) return { ok: false, status: 400, code: 'aborted' }
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  } catch {
    return { ok: false, status: 400, code: 'invalid_json' }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function handleList(response: ServerResponse, store: StudioExpressionStore, id: string): Promise<void> {
  try {
    const listed = await store.list(id)
    if (
      typeof listed !== 'object' ||
      listed === null ||
      typeof (listed as { revision?: unknown }).revision !== 'string' ||
      !Array.isArray((listed as { expressions?: unknown }).expressions)
    ) {
      json(response, 500, { error: 'internal' })
      return
    }
    json(response, 200, { revision: listed.revision, expressions: listed.expressions })
  } catch (error) {
    const mapped = storeFailure(error)
    json(response, mapped.status, { error: mapped.code })
  }
}

async function handleItem(
  response: ServerResponse,
  store: StudioExpressionStore,
  id: string,
  name: string
): Promise<void> {
  try {
    const data = await store.read(id, name)
    if (!Buffer.isBuffer(data)) {
      json(response, 500, { error: 'internal' })
      return
    }
    if (response.headersSent || response.destroyed) return
    response.writeHead(200, {
      'content-type': 'image/webp',
      'content-length': data.length,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    })
    response.end(data)
  } catch (error) {
    const mapped = storeFailure(error)
    json(response, mapped.status, { error: mapped.code })
  }
}

async function handlePost(
  request: IncomingMessage,
  response: ServerResponse,
  store: StudioExpressionStore,
  id: string,
  signal?: AbortSignal
): Promise<void> {
  const read = await readJsonBody(request, STUDIO_EXPRESSION_JSON_LIMIT, signal)
  if (!read.ok) {
    json(response, read.status, { error: read.code })
    return
  }
  if (!isRecord(read.value)) {
    json(response, 400, { error: 'invalid_body' })
    return
  }
  const body = read.value
  const expectedRevision = body['expectedRevision']
  if (expectedRevision === undefined || expectedRevision === null || expectedRevision === '') {
    json(response, 428, { error: 'revision_required' })
    return
  }
  if (typeof expectedRevision !== 'string' || !REVISION_PATTERN.test(expectedRevision)) {
    json(response, 400, { error: 'invalid_body' })
    return
  }
  const name = body['name']
  if (typeof name !== 'string' || !STUDIO_EXPRESSION_SLUG.test(name)) {
    json(response, 400, { error: 'invalid_body' })
    return
  }
  const description = body['description']
  if (!isValidDescription(description)) {
    json(response, 400, { error: 'invalid_body' })
    return
  }
  const mimeRaw = body['mime'] ?? body['mimeType'] ?? body['contentType']
  const mime = normalizeMime(mimeRaw)
  if (mime === undefined) {
    json(response, 415, { error: 'unsupported_media' })
    return
  }
  const dataRaw = body['data'] ?? body['base64'] ?? body['image']
  const decoded = decodeCanonicalBase64(dataRaw)
  if (decoded === undefined) {
    json(response, 400, { error: 'invalid_body' })
    return
  }
  if (decoded.length > STUDIO_MAX_INPUT_BYTES) {
    json(response, 413, { error: 'too_large' })
    return
  }
  if (signal?.aborted) {
    json(response, 400, { error: 'aborted' })
    return
  }
  let converted: Buffer | undefined
  try {
    const result = await convertExpression(decoded, mime, signal)
    if (!result.ok) {
      const mapped = converterFailure(result.reason)
      json(response, mapped.status, { error: mapped.code })
      return
    }
    converted = result.data
  } catch {
    json(response, 500, { error: 'conversion_failed' })
    return
  }
  if (converted === undefined || converted.length === 0 || converted.length > STUDIO_OUTPUT_LIMIT_BYTES) {
    json(response, 413, { error: 'output_too_large' })
    return
  }
  if (signal?.aborted) {
    json(response, 400, { error: 'aborted' })
    return
  }
  // No publish happened before this point: conversion is fully validated first.
  try {
    const published = await store.publish(id, expectedRevision, name, description, converted)
    if (
      typeof published !== 'object' ||
      published === null ||
      typeof (published as { revision?: unknown }).revision !== 'string'
    ) {
      json(response, 500, { error: 'internal' })
      return
    }
    json(response, 200, { id, name, description, revision: published.revision })
  } catch (error) {
    const mapped = storeFailure(error)
    json(response, mapped.status, { error: mapped.code })
  }
}

/**
 * Already-authorized studio expression handler.
 * Collection GET/POST when params has no name, item GET when it does.
 * The caller owns authentication, route recognition and the request id.
 */
export async function handleStudioExpressions(
  request: IncomingMessage,
  response: ServerResponse,
  store: StudioExpressionStore,
  params: StudioExpressionRouteParams,
  options: StudioExpressionRouteOptions = {}
): Promise<void> {
  const method = request.method ?? 'GET'
  const id = params.id
  if (typeof id !== 'string' || !STUDIO_EXPRESSION_SLUG.test(id)) {
    json(response, 400, { error: 'invalid_id' })
    return
  }
  if (params.name !== undefined) {
    if (typeof params.name !== 'string' || !STUDIO_EXPRESSION_SLUG.test(params.name)) {
      json(response, 400, { error: 'invalid_body' })
      return
    }
    if (method !== 'GET') {
      methodNotAllowed(response)
      return
    }
    await handleItem(response, store, id, params.name)
    return
  }
  if (method === 'GET') {
    await handleList(response, store, id)
    return
  }
  if (method === 'POST') {
    await handlePost(request, response, store, id, options.signal)
    return
  }
  methodNotAllowed(response)
}
