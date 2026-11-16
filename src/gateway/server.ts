import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import type { Logger } from '../records/logger.js'
import type { Redactor } from '../records/redact.js'
import { recordFailure } from '../records/turn-record.js'
import type { Storage } from '../storage/database.js'
import type { TurnService } from '../turn/pipeline.js'
import { MalformedRequestError, parseGatewayRequest } from './request.js'
import { NO_REPLY, openStream, writeReply } from './response.js'

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
  /** More fields for the health report, such as the newest snapshot. The updater reads them. */
  health?: () => Record<string, unknown>
  /** Called after each turn request has been answered. It must not throw. */
  afterTurn?: () => void
  /** The fixed answer to a gateway chore such as a session title. */
  auxiliaryText?: string
  maxBodyBytes?: number
  now?: () => Date
}

const DEFAULT_MAX_BODY = 20 * 1024 * 1024

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

function json(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(body))
}

export function createGatewayServer(options: GatewayServerOptions): Server {
  const { turns, storage, logger } = options
  const now = options.now ?? (() => new Date())
  const log = logger.child({ module: 'gateway' })

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
      json(response, 400, { error: { message, type: 'invalid_request_error' } })
      return
    }

    if (parsed.type === 'auxiliary') {
      // A gateway chore: fixed text, no model call, no turn record.
      writeReply(response, { id: 'auxiliary', content: options.auxiliaryText ?? 'Chat' }, { ...parsed, now })
      return
    }

    if (parsed.type === 'unmarked') {
      // Tools but no marker: the gateway's own background work, or a scope stamp that is off. Nothing goes to a
      // chat, and the record shows it.
      log.error('gateway.unmarked', {})
      try {
        storage.tx((db) =>
          recordFailure(
            db,
            {
              stage: 'receive',
              kind: 'gateway_unmarked',
              error: new Error('a request with tools has no scope marker'),
              handledBy: 'no_reply'
            },
            options.redactor,
            now
          )
        )
      } catch (storageError) {
        log.error('gateway.unmarked_not_recorded', { error: storageError })
      }
      writeReply(response, { id: 'unmarked', content: NO_REPLY }, { ...parsed, now })
      return
    }

    // The stream opens at once, so the gateway sees an answer in progress while the turn runs.
    if (parsed.stream) openStream(response)
    try {
      const reply = await turns.handle(parsed)
      writeReply(response, { id: reply.turnId ?? 'none', content: reply.content }, { ...parsed, now })
      options.afterTurn?.()
    } catch (error) {
      // Nothing was acknowledged. Dropping the connection makes the gateway send the same request again.
      log.error('gateway.turn_failed', { error })
      if (response.headersSent) response.destroy()
      else json(response, 500, { error: { message: 'the turn could not be handled', type: 'server_error' } })
    }
  }

  return createServer((request, response) => {
    const path = (request.url ?? '').split('?')[0]
    if (request.method === 'GET' && path === '/health') {
      const ready = options.ready()
      json(response, ready ? 200 : 503, {
        ...options.health?.(),
        status: ready ? 'ready' : 'starting',
        activeTurns: turns.active()
      })
      return
    }
    if (request.method === 'POST' && path === '/v1/chat/completions') {
      if (!options.ready()) {
        json(response, 503, { error: { message: 'the core is not ready', type: 'server_error' } })
        return
      }
      void completions(request, response)
      return
    }
    json(response, 404, { error: { message: 'not found', type: 'invalid_request_error' } })
  })
}
