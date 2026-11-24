import { createServer } from 'node:http'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { localRouterClient } from '../../src/models/local-router-client.js'
import { tmpDir } from '../support/tmp.js'

it('uses the fixed private socket for either router role without forwarding API credentials', async () => {
  const dir = tmpDir('aira-router-socket-')
  const requests: { path: string | undefined; hasAuthorization: boolean; model: string }[] = []
  const server = createServer(async (req, res) => {
    const parts: Buffer[] = []
    for await (const chunk of req) parts.push(chunk)
    requests.push({
      path: req.url,
      hasAuthorization: !!req.headers.authorization,
      model: JSON.parse(Buffer.concat(parts).toString()).model
    })
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(
        JSON.stringify({ model: 'aira', choices: [{ message: { role: 'assistant', content: 'synthetic response' } }] })
      )
  })
  await new Promise<void>((r) => server.listen(join(dir, 'settings.sock'), r))
  try {
    const client = localRouterClient(join(dir, 'owner-api.sock'), 'medium', {
      usdPerMTokIn: 0,
      usdPerMTokOut: 0,
      usdPerMTokCached: 0
    })
    for (const role of ['main', 'fallback'] as const) {
      const response = await client.call({
        role,
        model: 'aira',
        system: [],
        messages: [{ role: 'user', content: 'synthetic request' }],
        tools: [],
        params: {}
      })
      expect(response.text).toBe('synthetic response')
    }
    expect(requests).toEqual(Array(2).fill({ path: '/internal/aira_router', hasAuthorization: false, model: 'aira' }))
  } finally {
    server.closeAllConnections()
    await new Promise<void>((r) => server.close(() => r()))
  }
})
