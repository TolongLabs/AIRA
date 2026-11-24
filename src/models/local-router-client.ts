import { request } from 'node:http'
import { dirname, join } from 'node:path'
import { createOpenAiClient, type OpenAiClientOptions } from './openai-client.js'

/** Only the private host socket can dispatch to the named router. No API credential goes to that service. */
export function localRouterClient(ownerSocket: string, effort: string, prices: OpenAiClientOptions['prices']) {
  const send: typeof fetch = async (_url, init) =>
    new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath: join(dirname(ownerSocket), 'settings.sock'),
          path: '/internal/aira_router',
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal: init?.signal ?? undefined
        },
        async (reply) => {
          try {
            const chunks: Buffer[] = []
            let size = 0
            for await (const bytes of reply) {
              size += bytes.length
              if (size > 2 * 1024 * 1024) {
                reply.destroy()
                throw Error('Router response too large')
              }
              chunks.push(bytes)
            }
            resolve(
              new Response(Uint8Array.from(Buffer.concat(chunks)), {
                status: reply.statusCode ?? 502,
                headers: { 'content-type': 'application/json' }
              })
            )
          } catch (error) {
            reject(error)
          }
        }
      )
      req.once('error', reject)
      req.end(typeof init?.body === 'string' ? init.body : '')
    })
  return createOpenAiClient({ baseUrl: 'http://router.internal/v1', apiKey: '', effort, prices, fetch: send })
}
