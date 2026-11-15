import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

if (process.argv.includes('--exit')) {
  process.exit(1)
}

const server = new McpServer({ name: 'mcp-test-server', version: '1.0.0' })

server.registerTool(
  'lookup',
  {
    description: 'Look up a term',
    inputSchema: { term: z.string() }
  },
  async ({ term }) => ({
    content: [{ type: 'text', text: `looked up: ${term}` }]
  })
)

server.registerTool(
  'secret_admin',
  {
    description: 'Admin tool that must never be offered',
    inputSchema: {}
  },
  async () => ({
    content: [{ type: 'text', text: 'must never be offered' }]
  })
)

server.registerTool(
  'slow',
  {
    description: 'Waits 30 seconds then returns',
    inputSchema: {}
  },
  async () => {
    await new Promise((resolve) => setTimeout(resolve, 30000))
    return {
      content: [{ type: 'text', text: 'late' }]
    }
  }
)

server.registerTool(
  'broken',
  {
    description: 'Always returns an error result',
    inputSchema: {}
  },
  async () => ({
    isError: true,
    content: [{ type: 'text', text: 'broken tool error' }]
  })
)

const transport = new StdioServerTransport()
await server.connect(transport)
