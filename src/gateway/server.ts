import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { z } from 'zod'
import type { InstallationMode, StandaloneReadiness } from '../config/installation-mode.js'
import type { Autofetch, AutofetchBatch } from '../media/autofetch.js'
import type { FailureKind } from '../records/kinds.js'
import type { Logger } from '../records/logger.js'
import type { Redactor } from '../records/redact.js'
import { recordFailure } from '../records/turn-record.js'
import { getChatByWaId } from '../settings/chats.js'
import { type Storage, StorageError } from '../storage/database.js'
import type { TurnService } from '../turn/pipeline.js'
import { type GatewayRequest, MalformedRequestError, parseGatewayRequest } from './request.js'
import { NO_REPLY, openStream, writeReply } from './response.js'
import { type StandaloneGateway, StandaloneGatewayError } from './standalone.js'
import { standaloneReplyText } from './standalone-delivery.js'

// The OpenAI-compatible endpoint the gateway calls (docs/trd/system.md#gateway-contract).
// A turn always gets status 200 with a deliverable reply. An error status is only for a request the core
// cannot parse, which is a deployment fault.

export interface GatewayServerOptions {
  turns: TurnService
  storage: Storage
  logger: Logger
  redactor: Redactor
  /** True once start-up has passed every step. The health endpoint reports it. */
  ready: () => boolean
  /** Standalone only: true once an applied model revision authorizes turns. Absent means inactive. */
  chatbotReady?: () => boolean
  /** Standalone only. Legacy servers leave it absent and keep the exact legacy envelope. */
  installationMode?: InstallationMode
  standaloneReadiness?: () => StandaloneReadiness
  standaloneGateway?: StandaloneGateway
  /** More fields for the health report, such as the newest snapshot. The updater reads them. */
  health?: () => Record<string, unknown>
  /** Called after each turn request has been answered. It must not throw. */
  afterTurn?: () => void
  /** The fixed answer to a gateway chore such as a session title. */
  auxiliaryText?: string
  maxBodyBytes?: number
  now?: () => Date
  /** Absent: autofetch answers an empty list (docs/trd/system.md#autofetch). */
  autofetch?: Autofetch
}

const DEFAULT_MAX_BODY = 20 * 1024 * 1024
const AUTOFETCH_MAX_BODY = 64 * 1024
/** Past this the connection is destroyed; between the two the request gets a 400. */
const AUTOFETCH_READ_LIMIT = 1024 * 1024
const autofetchDeliveryKey = z.uuid()
const autofetchBody = z.strictObject({ chat: z.string().min(1).max(256), text: z.string() })
type StandaloneAction = 'v1Attach' | 'v1Turn' | 'v2Attach' | 'v2Turn' | 'v2Claim' | 'v2Ack'
const STANDALONE_ENDPOINTS = new Map<string, StandaloneAction>([
  ['/v1/aira/attach-check', 'v1Attach'],
  ['/v1/aira/turn', 'v1Turn'],
  ['/v2/aira/attach-check', 'v2Attach'],
  ['/v2/aira/turn', 'v2Turn'],
  ['/v2/aira/delivery/claim', 'v2Claim'],
  ['/v2/aira/delivery/ack', 'v2Ack']
])

function readBody(request: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new MalformedRequestError('the request body is too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

function json(response: ServerResponse, status: number, body: unknown, log?: Logger): void {
  if (response.headersSent || response.destroyed || response.writableEnded) return
  try {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(body))
  } catch (error) {
    log?.error('gateway.write_failed', { error })
    response.destroy()
  }
}

export function createGatewayServer(options: GatewayServerOptions): Server {
  const { turns, storage, logger } = options
  const now = options.now ?? (() => new Date())
  const log = logger.child({ module: 'gateway' })

  function sendReply(
    response: ServerResponse,
    reply: { id: string; content: string },
    parsed: { stream: boolean; includeUsage: boolean }
  ): void {
    try {
      writeReply(response, reply, { ...parsed, now })
    } catch (error) {
      log.error('gateway.write_failed', { error })
      response.destroy()
    }
  }

  function chatIdFor(parsed: GatewayRequest): string | undefined {
    try {
      if (parsed.type === 'turn') {
        return getChatByWaId(storage, parsed.marker.chat)?.chatId ?? options.redactor.hash(parsed.marker.chat)
      }
      if (parsed.type === 'scheduled') {
        const readChatId = (sql: string, id: string) =>
          storage.read((db) => db.prepare(sql).pluck().get(id)) as string | undefined
        if (parsed.kind === 'reminder') {
          return readChatId('SELECT chat_id FROM reminder WHERE reminder_id = ?', parsed.reminderId)
        }
        if (parsed.kind === 'research') {
          return readChatId('SELECT chat_id FROM research_job WHERE job_id = ?', parsed.jobId)
        }
      }
    } catch {
      return parsed.type === 'turn' ? options.redactor.hash(parsed.marker.chat) : undefined
    }
    return undefined
  }

  function recordTurnFailure(error: unknown, handledBy: string, meta: { chatId?: string; jobId?: string }): void {
    log.error('gateway.turn_failed', {
      ...(meta.chatId ? { chatId: meta.chatId } : {}),
      ...(meta.jobId ? { jobId: meta.jobId } : {}),
      error
    })
    const kind: FailureKind = error instanceof StorageError ? error.kind : 'internal'
    try {
      storage.tx((db) =>
        recordFailure(
          db,
          {
            ...(meta.jobId ? { jobId: meta.jobId } : {}),
            stage: 'receive',
            kind,
            error,
            handledBy
          },
          options.redactor,
          now
        )
      )
    } catch (storageError) {
      log.error('gateway.turn_failure_not_recorded', {
        ...(meta.chatId ? { chatId: meta.chatId } : {}),
        error: storageError
      })
    }
  }

  /** Nothing goes to a chat, and the record shows it: the gateway's own work, or a scope stamp that is off. */
  function answerUnmarked(
    response: ServerResponse,
    parsed: { stream: boolean; includeUsage: boolean },
    reason: string
  ): void {
    log.error('gateway.unmarked', { reason })
    try {
      storage.tx((db) =>
        recordFailure(
          db,
          { stage: 'receive', kind: 'gateway_unmarked', error: new Error(reason), handledBy: 'no_reply' },
          options.redactor,
          now
        )
      )
    } catch (storageError) {
      log.error('gateway.unmarked_not_recorded', { error: storageError })
    }
    sendReply(response, { id: 'unmarked', content: NO_REPLY }, parsed)
  }

  async function completions(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let parsed: ReturnType<typeof parseGatewayRequest>
    try {
      parsed = parseGatewayRequest(JSON.parse(await readBody(request, options.maxBodyBytes ?? DEFAULT_MAX_BODY)))
    } catch (error) {
      // A request the core cannot read is a deployment fault: record it and answer with an error status.
      log.error('gateway.malformed', { error })
      try {
        storage.tx((db) =>
          recordFailure(
            db,
            { stage: 'receive', kind: 'gateway_malformed', error, handledBy: 'status:400' },
            options.redactor,
            now
          )
        )
      } catch (storageError) {
        log.error('gateway.malformed_not_recorded', { error: storageError })
      }
      const message = error instanceof MalformedRequestError ? error.message : 'the request body is not valid JSON'
      json(response, 400, { error: { message, type: 'invalid_request_error' } }, log)
      return
    }

    if (parsed.type === 'auxiliary') {
      // A gateway chore: fixed text, no model call, no turn record.
      sendReply(response, { id: 'auxiliary', content: options.auxiliaryText ?? 'Chat' }, parsed)
      return
    }

    if (parsed.type === 'unmarked') {
      answerUnmarked(response, parsed, 'a request with tools has no scope marker')
      return
    }

    if (parsed.type === 'scheduled') {
      // A firing of the gateway's schedule: not streamed, and answered in one body.
      try {
        const reply = await turns.handleScheduled(parsed)
        if (reply === null) {
          answerUnmarked(
            response,
            parsed,
            parsed.kind === 'job'
              ? 'a job tag names no listed job of an active chat'
              : parsed.kind === 'research'
                ? 'a research tag names no completed research job'
                : 'a scheduled tag names no reminder due at that time'
          )
          return
        }
        sendReply(response, { id: reply.turnId ?? 'none', content: reply.content }, parsed)
        options.afterTurn?.()
      } catch (error) {
        const chatId = chatIdFor(parsed)
        const jobId = parsed.kind === 'job' || parsed.kind === 'research' ? parsed.jobId : undefined
        recordTurnFailure(error, 'status:500', { chatId, jobId })
        json(response, 500, { error: { message: 'the turn could not be handled', type: 'server_error' } }, log)
      }
      return
    }

    try {
      // The stream opens at once, so the gateway sees an answer in progress while the turn runs.
      if (parsed.stream) openStream(response)
      const reply = await turns.handle(parsed)
      sendReply(response, { id: reply.turnId ?? 'none', content: reply.content }, parsed)
      options.afterTurn?.()
    } catch (error) {
      // Nothing was acknowledged. Dropping the connection makes the gateway send the same request again.
      const chatId = chatIdFor(parsed)
      recordTurnFailure(error, response.headersSent ? 'drop' : 'status:500', { chatId })
      if (response.headersSent) response.destroy()
      else json(response, 500, { error: { message: 'the turn could not be handled', type: 'server_error' } }, log)
    }
  }

  // A group message the gateway drops, offered for its post links' media. Nothing here keeps the text.
  async function autofetch(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let input: z.infer<typeof autofetchBody>
    try {
      const raw = await readBody(request, Math.min(options.maxBodyBytes ?? DEFAULT_MAX_BODY, AUTOFETCH_READ_LIMIT))
      if (Buffer.byteLength(raw) > AUTOFETCH_MAX_BODY) throw new MalformedRequestError('the request body is too large')
      input = autofetchBody.parse(JSON.parse(raw))
    } catch {
      json(response, 400, { error: { message: 'the request could not be parsed', type: 'invalid_request_error' } }, log)
      return
    }
    // A gateway that closed before the answer never gets the key: end the batch now, not at its timer.
    try {
      const batch: AutofetchBatch = (await options.autofetch?.fetch(input)) ?? { media: [] }
      const key = batch.deliveryKey
      if (key !== undefined) {
        if (response.destroyed) {
          options.autofetch?.abandon(key)
          return
        }
        response.once('close', () => {
          if (!response.writableFinished) options.autofetch?.abandon(key)
        })
      }
      json(response, 200, batch, log)
    } catch (error) {
      log.error('autofetch.failed', { kind: error instanceof Error ? error.name : 'unknown' })
      json(response, 200, { media: [] }, log)
    }
  }

  async function autofetchDelivery(request: IncomingMessage, response: ServerResponse, claim: boolean): Promise<void> {
    let input: { key: string; outcomes?: boolean[] }
    try {
      const raw = await readBody(request, 4096)
      const shape = claim
        ? z.strictObject({ key: autofetchDeliveryKey })
        : z.strictObject({ key: autofetchDeliveryKey, outcomes: z.array(z.boolean()).min(1).max(30) })
      input = shape.parse(JSON.parse(raw))
    } catch {
      json(response, 400, { accepted: false }, log)
      return
    }
    try {
      const accepted =
        options.autofetch === undefined
          ? false
          : claim
            ? options.autofetch.claim(input.key)
            : options.autofetch.complete(input.key, input.outcomes ?? [])
      json(response, 200, { accepted }, log)
    } catch {
      log.warn('autofetch.record_failed', { phase: claim ? 'claim' : 'receipt' })
      json(response, 503, { accepted: false }, log)
    }
  }

  async function standaloneRequest(
    request: IncomingMessage,
    response: ServerResponse,
    action: StandaloneAction
  ): Promise<void> {
    const adapter = options.standaloneGateway
    if (!adapter?.authorized(request.headers.authorization)) {
      json(response, 401, { error: { code: 'gateway_auth_required' } }, log)
      return
    }
    const needsChatbot = action === 'v1Turn' || action === 'v2Turn' || action === 'v2Claim'
    if (!options.ready() || (needsChatbot && !options.chatbotReady?.())) {
      json(
        response,
        503,
        {
          error: {
            code: !options.ready()
              ? 'service_unavailable'
              : (options.standaloneReadiness?.().chatbotReason ?? 'model_setup_required')
          }
        },
        log
      )
      return
    }
    let input: unknown
    try {
      input = JSON.parse(await readBody(request, 256 * 1024))
    } catch {
      json(response, 400, { error: { code: 'gateway_malformed' } }, log)
      return
    }
    let parsed: Extract<GatewayRequest, { type: 'turn' }> | undefined
    try {
      if (action === 'v1Attach') {
        json(response, 200, { schemaVersion: 1, hermes: adapter.attach(input) }, log)
        return
      }
      if (action === 'v2Attach') {
        json(response, 200, { schemaVersion: 2, hermes: adapter.attachTyped(input) }, log)
        return
      }
      if (action === 'v2Claim') {
        json(response, 200, { schemaVersion: 2, delivery: adapter.claimTyped(input) }, log)
        return
      }
      if (action === 'v2Ack') {
        adapter.ackTyped(input)
        json(response, 200, { schemaVersion: 2, accepted: true }, log)
        return
      }
      const typed = action === 'v2Turn' ? adapter.parseTypedTurn(input) : undefined
      parsed = typed?.request ?? adapter.parseTurn(input)
      const known = getChatByWaId(storage, parsed.marker.chat)
      if (known && known.type !== parsed.marker.kind)
        throw new StandaloneGatewayError(409, 'gateway_chat_kind_conflict')
      const reply = await turns.handle(parsed)
      const chat = known ?? getChatByWaId(storage, parsed.marker.chat)
      const binding =
        chat && reply.turnId ? { chatId: chat.chatId, mid: parsed.marker.mid, turnId: reply.turnId } : null
      if (typed) {
        const deliveries = binding
          ? adapter.delivery.issue({ ...binding, routeId: typed.routeId, replayed: reply.replayed })
          : []
        json(
          response,
          200,
          { schemaVersion: 2, disposition: deliveries.length ? 'reply' : 'no_reply', deliveries },
          log
        )
      } else {
        const attemptedByTyped = reply.replayed && binding && adapter.delivery.hasIssued(binding)
        const content = attemptedByTyped ? null : standaloneReplyText(reply.content)
        json(
          response,
          200,
          { schemaVersion: 1, disposition: content === null ? 'no_reply' : 'reply', reply: content },
          log
        )
      }
      options.afterTurn?.()
    } catch (error) {
      if (error instanceof StandaloneGatewayError) {
        json(response, error.status, { error: { code: error.code } }, log)
      } else {
        const chatId = parsed ? chatIdFor(parsed) : undefined
        recordTurnFailure(error, 'status:500', chatId ? { chatId } : {})
        json(response, 500, { error: { code: 'gateway_failed' } }, log)
      }
    }
  }

  return createServer((request, response) => {
    const path = (request.url ?? '').split('?')[0] ?? ''
    const standalone = options.installationMode === 'standalone'
    const chatbotActive = !standalone || (options.chatbotReady?.() ?? false)
    if (request.method === 'GET' && path === '/health') {
      const ready = options.ready()
      if (standalone) {
        json(
          response,
          ready ? 200 : 503,
          {
            ...options.health?.(),
            status: ready ? 'ready' : 'starting',
            activeTurns: turns.active(),
            schemaVersion: 1,
            installationMode: 'standalone',
            configuration: chatbotActive ? 'configured' : 'setup_required',
            chatbot: chatbotActive ? 'ready' : 'inactive',
            chatbotReason: chatbotActive ? null : 'model_setup_required',
            ...options.standaloneReadiness?.()
          },
          log
        )
        return
      }
      json(
        response,
        ready ? 200 : 503,
        {
          ...options.health?.(),
          status: ready ? 'ready' : 'starting',
          activeTurns: turns.active()
        },
        log
      )
      return
    }
    const standaloneAction = STANDALONE_ENDPOINTS.get(path)
    if (standalone && request.method === 'POST' && standaloneAction) {
      void standaloneRequest(request, response, standaloneAction).catch(() =>
        json(response, 500, { error: { code: 'gateway_failed' } }, log)
      )
      return
    }
    if (
      standalone &&
      request.method === 'POST' &&
      (path === '/v1/chat/completions' ||
        path === '/v1/aira/autofetch' ||
        path === '/v1/aira/autofetch/claim' ||
        path === '/v1/aira/autofetch/complete')
    ) {
      // Standalone with no applied model: refuse before parsing, without a turn record or a reply.
      if (options.ready() && !chatbotActive) {
        if (path === '/v1/aira/autofetch/claim' || path === '/v1/aira/autofetch/complete') {
          json(response, 503, { accepted: false }, log)
        } else {
          json(
            response,
            503,
            {
              error: {
                message: 'the standalone chatbot is inactive',
                type: 'server_error',
                code: options.standaloneReadiness?.().chatbotReason ?? 'model_setup_required'
              }
            },
            log
          )
        }
        return
      }
      if (options.ready()) {
        json(response, 403, { error: { code: 'capability_unavailable' } }, log)
        return
      }
    }
    if (request.method === 'POST' && path === '/v1/chat/completions') {
      if (!options.ready()) {
        json(response, 503, { error: { message: 'the core is not ready', type: 'server_error' } }, log)
        return
      }
      void completions(request, response).catch((error: unknown) => {
        log.error('gateway.request_failed', { error })
        if (response.headersSent) response.destroy()
        else json(response, 500, { error: { message: 'the request could not be handled', type: 'server_error' } }, log)
      })
      return
    }
    if (request.method === 'POST' && (path === '/v1/aira/autofetch/claim' || path === '/v1/aira/autofetch/complete')) {
      if (!options.ready()) {
        json(response, 503, { accepted: false }, log)
        return
      }
      void autofetchDelivery(request, response, path.endsWith('/claim'))
      return
    }
    if (request.method === 'POST' && path === '/v1/aira/autofetch') {
      if (!options.ready()) {
        json(response, 503, { error: { message: 'the core is not ready', type: 'server_error' } }, log)
        return
      }
      void autofetch(request, response)
      return
    }
    json(response, 404, { error: { message: 'not found', type: 'invalid_request_error' } }, log)
  })
}
