import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config/loader.js'
import { createLogger } from '../src/records/logger.js'
import { ensureChat, setChatStatus } from '../src/settings/chats.js'
import { setSetting } from '../src/settings/settings.js'

export function syntheticTurnBody() {
  return {
    messages: [
      {
        role: 'user',
        content:
          '[HERMES-SCOPE v1 platform=whatsapp kind=dm chat=deploy-fixture sender=deploy-fixture mid=probe]\nCheck the release fixture.'
      }
    ],
    tools: [{ type: 'function', function: { name: 'deploy_check', description: 'Deploy fixture' } }],
    stream: false
  }
}

export async function verifyRunnerReachability(transport: string, runnerUrl: string, request = fetch) {
  if (transport !== 'subscription') return
  const response = await request(new URL('/health', runnerUrl), {
    signal: AbortSignal.timeout(5000),
    redirect: 'error'
  })
  const health: unknown = response.ok ? await response.json() : null
  if (!health || typeof health !== 'object' || !('ok' in health) || health.ok !== true)
    throw new Error('Subscription runner health check failed')
}

/** Use the deployed code with an isolated store and a deterministic model. Never contact a chat or model provider. */
export async function probeTurn() {
  const dir = await mkdtemp(join(tmpdir(), 'aira-deploy-check-'))
  try {
    const config = loadConfig('config.yml')
    await verifyRunnerReachability(config.llm.transport, config.llm.subscription.runnerUrl)
    config.storage.path = dir
    config.gateway.hostDataDir = dir
    config.llm.transport = 'api'
    config.turn.batchMs = 1
    const answer = 'Release fixture answered.'
    const app = await createApp({
      config,
      env: {},
      logger: createLogger({ level: 'error', module: 'probe', sink: () => {} }),
      clients: {
        main: {
          async call() {
            return {
              text: answer,
              toolCalls: [],
              usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
              costUsd: 0,
              model: 'fixture'
            }
          }
        }
      }
    })
    try {
      const chat = ensureChat(app.storage, { waId: 'deploy-fixture', type: 'dm' })
      setSetting(app.storage, { level: 'chat', scope: chat.chatId, key: 'character', value: 'example', actor: 'probe' })
      setChatStatus(app.storage, { chatId: chat.chatId, status: 'active', actor: 'probe' })
      const addr = await app.listen(0, '127.0.0.1')
      const res = await fetch('http://127.0.0.1:' + addr.port + '/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(syntheticTurnBody()),
        signal: AbortSignal.timeout(10_000)
      })
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
      const row = app.storage.read((db) =>
        db.prepare("SELECT 1 FROM turn WHERE chat_id=? AND state='delivered'").get(chat.chatId)
      )
      if (!res.ok || !row || !data.choices?.[0]?.message?.content?.includes(answer))
        throw new Error('Synthetic gateway turn failed')
    } finally {
      await app.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await probeTurn()
  process.stdout.write('deploy-turn-ok\n')
}
