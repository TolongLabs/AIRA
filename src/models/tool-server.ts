import { randomBytes } from 'node:crypto'
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { Logger } from '../records/logger.js'
import type { OfferedTool } from '../turn/types.js'

const MAX_BODY_BYTES = 1024 * 1024

export interface ToolSession {
  /** A random token: 32 bytes from randomBytes, as hex. It names this turn to the tool server. */
  token: string
  /** What the turn's tool calls did so far. */
  state: { toolCalls: number; toolMs: number; chainLimit?: 'calls' | 'time'; receipts: string[] }
  /** Ends the session. Its token is refused from now on. Safe to call twice. */
  end(): void
}

export interface ToolServer {
  /** Starts listening on host 127.0.0.1. Port 0 picks a free port. Resolves with the port. */
  listen(port: number): Promise<number>
  open(turn: { turnId: string; tools: OfferedTool[]; firstTool?: string; signal: AbortSignal }): ToolSession
  close(): Promise<void>
}

interface ActiveSession {
  turnId: string
  tools: OfferedTool[]
  toolsByName: Map<string, OfferedTool>
  firstTool?: string
  signal: AbortSignal
  state: ToolSession['state']
}

function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return undefined
  const token = header.slice('Bearer '.length)
  return token === '' ? undefined : token
}

function readJsonBody(req: IncomingMessage): Promise<{ ok: true; body: unknown } | { ok: false; status: 400 | 413 }> {
  const contentLength = req.headers['content-length']
  if (contentLength !== undefined && Number(contentLength) > MAX_BODY_BYTES) {
    return Promise.resolve({ ok: false, status: 413 })
  }
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let total = 0
    let done = false
    req.on('data', (chunk: Buffer) => {
      if (done) return
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        done = true
        req.destroy()
        resolve({ ok: false, status: 413 })
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (done) return
      done = true
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve({ ok: true, body: JSON.parse(raw) })
      } catch {
        resolve({ ok: false, status: 400 })
      }
    })
    req.on('error', () => {
      if (done) return
      done = true
      resolve({ ok: false, status: 400 })
    })
  })
}

export function createToolServer(options: {
  limits: { maxCallsPerTurn: number; timeBudgetMs: number }
  logger: Logger
  now?: () => Date
}): ToolServer {
  const now = options.now ?? (() => new Date())
  const sessions = new Map<string, ActiveSession>()

  const buildMcpServer = (session: ActiveSession): Server => {
    const server = new Server({ name: 'aira-tools', version: '1.0.0' }, { capabilities: { tools: {} } })

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const visible =
        session.firstTool === undefined
          ? session.tools
          : session.tools.filter((tool) => tool.schema.name === session.firstTool)
      return {
        tools: visible.map((tool) => ({
          name: tool.schema.name,
          description: tool.schema.description,
          inputSchema: tool.schema.parameters
        }))
      }
    })

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const toolName = request.params.name
      const args = request.params.arguments ?? {}
      options.logger.debug('mcp_tool_call', { turnId: session.turnId, tool: toolName })

      const tool = session.toolsByName.get(toolName)
      if (!tool) {
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ error: 'refused', reason: 'unknown tool' }) }]
        }
      }
      if (session.firstTool !== undefined && toolName !== session.firstTool) {
        return {
          isError: true,
          content: [
            { type: 'text', text: JSON.stringify({ error: 'refused', reason: 'another tool is required first' }) }
          ]
        }
      }

      const { state } = session
      if (state.toolCalls >= options.limits.maxCallsPerTurn) state.chainLimit ??= 'calls'
      else if (state.toolMs >= options.limits.timeBudgetMs) state.chainLimit ??= 'time'
      if (state.chainLimit) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'refused', reason: 'the tool limit for this turn is reached' })
            }
          ]
        }
      }

      state.toolCalls += 1
      if (session.firstTool === toolName) session.firstTool = undefined
      const callId = `${session.turnId}:${state.toolCalls}`
      const started = now().getTime()
      try {
        // A handler never throws into the MCP server: a failure is a typed result the model can read.
        const result = await tool.call(args, callId, session.signal)
        if (result.receiptId) state.receipts.push(result.receiptId)
        return {
          ...(result.ok ? {} : { isError: true }),
          content: [{ type: 'text', text: result.content }]
        }
      } catch {
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ error: 'error', reason: 'the tool failed' }) }]
        }
      } finally {
        state.toolMs += now().getTime() - started
        if (state.toolCalls >= options.limits.maxCallsPerTurn) state.chainLimit ??= 'calls'
        else if (state.toolMs >= options.limits.timeBudgetMs) state.chainLimit ??= 'time'
      }
    })

    return server
  }

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = (req.url ?? '').split('?')[0]
    if (path !== '/mcp') {
      res.writeHead(404).end()
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end()
      return
    }
    const token = bearerToken(req)
    const session = token === undefined ? undefined : sessions.get(token)
    if (!session) {
      res.writeHead(401).end()
      return
    }
    const parsed = await readJsonBody(req)
    if (!parsed.ok) {
      res.writeHead(parsed.status).end()
      return
    }

    const mcpServer = buildMcpServer(session)
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    })
    res.on('close', () => {
      void transport.close()
      void mcpServer.close()
    })
    await mcpServer.connect(transport)
    await transport.handleRequest(req, res, parsed.body)
  }

  const httpServer = createServer((req, res) => {
    void handleRequest(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500).end()
      else res.end()
    })
  })

  return {
    listen(port: number): Promise<number> {
      return new Promise((resolve, reject) => {
        httpServer.once('error', reject)
        httpServer.listen(port, '127.0.0.1', () => {
          httpServer.off('error', reject)
          resolve((httpServer.address() as AddressInfo).port)
        })
      })
    },

    open(turn): ToolSession {
      const token = randomBytes(32).toString('hex')
      const state: ToolSession['state'] = { toolCalls: 0, toolMs: 0, receipts: [] }
      const session: ActiveSession = {
        turnId: turn.turnId,
        tools: turn.tools,
        toolsByName: new Map(turn.tools.map((tool) => [tool.schema.name, tool])),
        firstTool: turn.tools.some((tool) => tool.schema.name === turn.firstTool) ? turn.firstTool : undefined,
        signal: turn.signal,
        state
      }
      sessions.set(token, session)
      return {
        token,
        state,
        end() {
          sessions.delete(token)
        }
      }
    },

    close(): Promise<void> {
      sessions.clear()
      if (!httpServer.listening) return Promise.resolve()
      return new Promise((resolve, reject) => {
        httpServer.close((err) => {
          if (err) reject(err)
          else resolve()
        })
      })
    }
  }
}
