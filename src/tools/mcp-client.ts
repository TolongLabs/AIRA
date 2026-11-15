import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { Logger } from '../records/logger.js'
import type { ToolRegistry } from './registry.js'

const MAX_DESCRIPTION_CHARS = 500
const MAX_ERROR_CHARS = 200

export interface McpServerConfig {
  id: string
  transport: 'stdio'
  command: string[]
  tools: string[]
  chats: string[]
  timeoutMs: number
}

export interface McpServerState {
  id: string
  status: 'connected' | 'unavailable'
  tools: string[]
  error?: string
}

export interface McpHost {
  /** One entry per configured server. */
  states(): McpServerState[]
  /** Closes every connection and stops every server process. */
  close(): Promise<void>
}

function shortError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.slice(0, MAX_ERROR_CHARS) || 'unknown error'
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), timeoutMs)
      })
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Connects to each configured server and registers its allowlisted tools. Never throws for a server fault. */
export async function connectMcpServers(
  servers: McpServerConfig[],
  registry: ToolRegistry,
  logger: Logger
): Promise<McpHost> {
  const serverStates: McpServerState[] = []
  const clients: Client[] = []
  const seenIds = new Set<string>()

  for (const server of servers) {
    if (seenIds.has(server.id)) {
      const error = `duplicate server id: ${server.id}`
      logger.warn('mcp_duplicate_server_id', { serverId: server.id })
      serverStates.push({ id: server.id, status: 'unavailable', tools: [], error })
      continue
    }
    seenIds.add(server.id)

    const [command, ...args] = server.command
    if (!command) {
      const error = 'empty command'
      logger.warn('mcp_server_unavailable', { serverId: server.id, error })
      serverStates.push({ id: server.id, status: 'unavailable', tools: [], error })
      continue
    }

    const transport = new StdioClientTransport({ command, args, stderr: 'pipe' })
    const client = new Client({ name: 'aira', version: '0.0.0' })
    const state: McpServerState = { id: server.id, status: 'unavailable', tools: [] }

    client.onclose = () => {
      if (state.status === 'connected') {
        state.status = 'unavailable'
        state.error ??= 'connection closed'
      }
    }
    client.onerror = (err) => {
      logger.warn('mcp_client_error', { serverId: server.id, error: shortError(err) })
    }

    try {
      await withTimeout(client.connect(transport, { timeout: server.timeoutMs }), server.timeoutMs, 'connect timed out')
      const listed = await withTimeout(
        client.listTools(undefined, { timeout: server.timeoutMs }),
        server.timeoutMs,
        'list tools timed out'
      )

      const offeredByName = new Map(listed.tools.map((tool) => [tool.name, tool]))
      const allowlist = new Set(server.tools)
      for (const allowed of allowlist) {
        if (!offeredByName.has(allowed)) {
          logger.warn('mcp_missing_tool', { serverId: server.id, tool: allowed })
        }
      }

      const registeredTools: string[] = []
      for (const tool of listed.tools) {
        if (!allowlist.has(tool.name)) continue
        const fullName = `${server.id}.${tool.name}`
        registry.registerExternal({
          name: fullName,
          // One line: a server's description must not be able to add a line to the prompt.
          description: (tool.description ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_DESCRIPTION_CHARS),
          parameters: tool.inputSchema as Record<string, unknown>,
          feature: `mcp.${server.id}`,
          chats: server.chats,
          timeoutMs: server.timeoutMs,
          invoke: async (toolArgs: unknown, signal: AbortSignal): Promise<string> => {
            if (state.status !== 'connected') {
              throw new Error(`mcp server ${server.id} is unavailable`)
            }
            const res = await client.callTool(
              { name: tool.name, arguments: toolArgs as Record<string, unknown> },
              undefined,
              // The registry owns the time limit and aborts through the signal. The client's own timer is set later,
              // so one slow call always ends as a timeout, never as a failure of the server.
              { signal, timeout: server.timeoutMs + 5000 }
            )
            if (res.isError) {
              throw new Error(`mcp tool ${fullName} returned an error`)
            }
            const parts: string[] = []
            if (Array.isArray(res.content)) {
              for (const item of res.content) {
                if (item.type === 'text' && typeof item.text === 'string') {
                  parts.push(item.text)
                }
              }
            }
            return parts.join('\n')
          }
        })
        registeredTools.push(fullName)
      }

      state.status = 'connected'
      state.tools = registeredTools
      clients.push(client)
      serverStates.push(state)
    } catch (err) {
      state.status = 'unavailable'
      state.tools = []
      state.error = shortError(err)
      serverStates.push(state)
      logger.warn('mcp_server_unavailable', { serverId: server.id, error: state.error })
      try {
        await client.close()
      } catch {
        // Ignore close errors after a failed connection.
      }
    }
  }

  let closed = false
  return {
    states(): McpServerState[] {
      return serverStates.map((s) => ({ ...s, tools: [...s.tools] }))
    },
    async close(): Promise<void> {
      if (closed) return
      closed = true
      for (const state of serverStates) {
        if (state.status === 'connected') {
          state.status = 'unavailable'
          state.error ??= 'closed'
        }
      }
      await Promise.allSettled(clients.map((client) => client.close()))
    }
  }
}
