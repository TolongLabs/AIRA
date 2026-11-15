import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { type PackSet, loadPacks } from './character/loader.js'
import { writeUnavailableLine } from './character/unavailable.js'
import { ConfigError } from './config/loader.js'
import type { Config } from './config/schema.js'
import { withAttachments } from './format/attachments.js'
import { createReplyCleaner } from './format/clean.js'
import { createGatewayServer } from './gateway/server.js'
import { createSystemOneClient, createSystemOneMemoryJudge, createSystemOneMoodJudge } from './judge/systemone.js'
import { createMemoryPort } from './memory/port.js'
import { presentLabels, recallForTurn } from './memory/recall.js'
import type { MemoryJudge } from './memory/types.js'
import { createMemoryWorker } from './memory/worker.js'
import { createApiRunner } from './models/api-runner.js'
import { createBreaker } from './models/breaker.js'
import { createOpenAiClient } from './models/openai-client.js'
import { createRoutedClient } from './models/routed-client.js'
import { spendState } from './models/spend.js'
import type { ModelClient } from './models/types.js'
import { createPromptBuilder, loadHarnessRules } from './prompt/builder.js'
import type { MoodJudge } from './prompt/mood.js'
import { withStickers } from './prompt/stickers.js'
import { type Logger, createLogger } from './records/logger.js'
import { createRedactor, secretsFromEnv } from './records/redact.js'
import { recordModelCall } from './records/turn-record.js'
import { listChats } from './settings/chats.js'
import { resolveSettings } from './settings/settings.js'
import type { Storage } from './storage/database.js'
import { type SnapshotReason, type SnapshotResult, startSnapshotTimer, takeSnapshot } from './storage/snapshot.js'
import { type DataPaths, startStorage } from './storage/startup.js'
import { createCommandRouter } from './tools/commands.js'
import { registerCoreTools } from './tools/core/index.js'
import { connectMcpServers } from './tools/mcp-client.js'
import type { ToolPorts } from './tools/ports.js'
import { type ToolRegistry, createToolRegistry } from './tools/registry.js'
import { type Alerter, createAlerter } from './turn/alerts.js'
import { type TurnService, createTurnService } from './turn/pipeline.js'
import type { TurnRunner } from './turn/types.js'

// The service, put together (docs/trd/system.md). One function builds every part in the start-up order of
// docs/trd/storage.md#start-up-sequence, so the entry point, the tests and the harness run the same core.

/** The names of every secret in .env. Their values are masked in every log line. */
export const SECRET_NAMES = [
  'LLM_API_KEY',
  'LLM_FALLBACK_API_KEY',
  'MEDIA_WATCHER_API_KEY',
  'TYPESAFE_API_KEY',
  'OPENAI_API_KEY'
] as const

/** How often the memory worker looks for a closed episode or a due job. */
const MEMORY_TICK_MS = 15_000

export interface AppOptions {
  config: Config
  /** Where secrets are read from, by name. */
  env: NodeJS.ProcessEnv
  logger?: Logger
  /** Model clients to use instead of the configured endpoints: recordings, fakes. */
  clients?: { main?: ModelClient; fallback?: ModelClient }
  /** The mood judge. Absent means rules only. */
  judge?: MoodJudge
  /** The memory judge. Absent means the hosted judge when it is configured, else none: memory admits nothing. */
  memoryJudge?: MemoryJudge
  ports?: Partial<Omit<ToolPorts, 'filesDir'>>
  /** The folder of the packs that ship with the release. */
  repositoryCharactersDir?: string
  harnessRulesPath?: string
  now?: () => Date
}

export interface App {
  storage: Storage
  paths: DataPaths
  turns: TurnService
  registry: ToolRegistry
  server: Server
  alerter: Alerter
  packs: () => PackSet
  listen(port: number, host: string): Promise<AddressInfo>
  /** Takes one verified snapshot now. */
  snapshot(reason: SnapshotReason): Promise<SnapshotResult>
  /** Writes the default pack's unavailable line for the gateway, if it changed. */
  refreshUnavailableLine(): void
  /** Stops admitting turns, lets running turns finish, stops the timers and closes the database. */
  close(): Promise<void>
}

function modelClient(
  target: Config['llm']['main'],
  key: string | undefined,
  role: string,
  override?: ModelClient
): ModelClient | undefined {
  if (override) return override
  if (target.model === '' || target.baseUrl === '') return undefined
  if (target.provider !== 'openai-compatible') {
    throw new ConfigError(`llm.${role}.provider is "${target.provider}": only "openai-compatible" is built`)
  }
  if (key === undefined || key === '') throw new ConfigError(`the key for llm.${role} is not set in the environment`)
  return createOpenAiClient({ baseUrl: target.baseUrl, apiKey: key, prices: target })
}

export async function createApp(options: AppOptions): Promise<App> {
  const { config, env } = options
  const now = options.now ?? (() => new Date())
  const redactor = createRedactor({ secrets: secretsFromEnv(SECRET_NAMES, env) })
  const logger = options.logger ?? createLogger({ level: config.log.level, module: 'core', redactor })

  // Steps 1 to 4: the data volume, the database, migrations, the recovery pass.
  const started = await startStorage({ config, logger, now })
  const { storage, paths } = started
  const closers: (() => void | Promise<void>)[] = []
  try {
    const alerter = createAlerter({ minGapMs: config.alerts.minGapMs, logger, now })
    for (const turnId of started.recovery.interruptedTurns) alerter.raise('turn_interrupted', { turnId })

    // Step 5: character packs and bindings. A fault in one pack or one chat disables that pack or chat only.
    const packs = () =>
      loadPacks({
        repositoryDir: options.repositoryCharactersDir ?? 'characters',
        dataDir: join(paths.root, 'characters')
      })
    const loaded = packs()
    for (const fault of loaded.faults) {
      logger.error('pack.invalid', { pack: fault.id, fault: fault.message })
      alerter.raise('pack_invalid', { pack: fault.id })
    }
    for (const chat of listChats(storage)) {
      if (chat.status !== 'active') continue
      const character = resolveSettings(storage, chat)['character']?.value
      if (typeof character !== 'string' || !loaded.packs.has(character)) {
        logger.error('binding.invalid', {
          chatId: chat.chatId,
          character: typeof character === 'string' ? character : null
        })
        alerter.raise('binding_invalid', { chatId: chat.chatId })
      }
    }

    // Models: one loop, one tool set. A fallback changes the model and nothing else.
    if (config.llm.transport !== 'api') {
      throw new ConfigError('llm.transport is "subscription": the subscription runner is not built in this release')
    }
    const main = modelClient(config.llm.main, env['LLM_API_KEY'], 'main', options.clients?.main)
    if (!main) throw new ConfigError('llm.main.model and llm.main.baseUrl must be set')
    const fallback = modelClient(
      config.llm.fallback,
      env['LLM_FALLBACK_API_KEY'],
      'fallback',
      options.clients?.fallback
    )
    const breaker = createBreaker({
      breakerMs: config.llm.breakerMs,
      now,
      onOpen: (role) => alerter.raise('breaker_open', { role })
    })
    const runner: TurnRunner = createApiRunner({
      clientFor: (onCall) =>
        createRoutedClient({
          main: { client: main, model: config.llm.main.model },
          fallback: fallback ? { client: fallback, model: config.llm.fallback.model } : undefined,
          config,
          breaker,
          storage,
          transport: 'api',
          onCall,
          onAuthFailure: (role) => alerter.raise('model_auth', { role }),
          now
        }),
      model: config.llm.main.model,
      limits: { maxCallsPerTurn: config.tools.maxCallsPerTurn, timeBudgetMs: config.tools.timeBudgetMs },
      now
    })

    // The hosted judge, when its model and key are set. Without it the mood comes from rules and memory admits nothing.
    const judgeKey = env['TYPESAFE_API_KEY']
    const hosted =
      config.judge.model !== '' && judgeKey
        ? createSystemOneClient({ apiKey: judgeKey, model: config.judge.model })
        : undefined
    const moodJudge = options.judge ?? (hosted ? createSystemOneMoodJudge(hosted) : undefined)
    const memoryJudge = options.memoryJudge ?? (hosted ? createSystemOneMemoryJudge(hosted) : undefined)

    // Tools: one registry. The prompt text about tools and the cleaner's name list come from it.
    const registry = createToolRegistry({ storage, config, logger, redactor, now })
    registerCoreTools(registry, {
      memory: createMemoryPort({
        storage,
        judge: memoryJudge,
        verifyThreshold: config.judge.memoryVerify,
        timeoutMs: config.judge.timeoutMs
      }),
      ...options.ports,
      filesDir: paths.files
    })
    // External tool servers (docs/trd/tools.md#external-tool-servers). None is configured at launch.
    if (config.mcp.servers.length > 0) {
      const mcp = await connectMcpServers(config.mcp.servers, registry, logger)
      closers.push(() => mcp.close())
    }

    const prompt = createPromptBuilder({
      storage,
      config,
      harnessRules: loadHarnessRules(options.harnessRulesPath),
      judge: moodJudge,
      recall: (input) =>
        recallForTurn(storage, {
          chatId: input.context.chat.chatId,
          present: presentLabels(input.window, input.context.chat.type === 'group'),
          queryTexts: input.pending.map((message) => message.content),
          tokenBudget: config.memory.recallTokenBudget,
          now
        }),
      toolRules: (context) => registry.rulesText(context),
      now
    })
    const hostDataDir = config.gateway.hostDataDir === '' ? paths.root : config.gateway.hostDataDir
    // After the cleaning chain: files a tool made, then the mood's sticker, which is always the last line.
    const cleaner = withStickers(
      withAttachments(
        createReplyCleaner(config, () => registry.toolNames()),
        { storage, hostDataDir }
      ),
      { storage, hostDataDir, now }
    )

    const turns = createTurnService({
      storage,
      config,
      logger,
      redactor,
      packs,
      runner,
      prompt,
      cleaner,
      alerter,
      tools: registry,
      commands: createCommandRouter(registry),
      hooks: { spendAllows: () => spendState(storage, config.llm.monthlyBudgetUsd, now).repliesAllowed },
      now
    })

    // Memory extraction (docs/trd/memory.md#write-path): background work, one job at a time.
    if (config.memory.enabled === 'on') {
      const memoryWorker = createMemoryWorker({
        storage,
        config,
        client: createRoutedClient({
          main: { client: main, model: config.llm.main.model },
          fallback: fallback ? { client: fallback, model: config.llm.fallback.model } : undefined,
          config,
          breaker,
          storage,
          transport: 'api',
          onCall: (call) => {
            storage.tx((db) =>
              recordModelCall(db, {
                role: call.role,
                model: call.model,
                transport: call.transport,
                attempt: call.attempt,
                startedAt: call.startedAt,
                durationMs: call.durationMs,
                inputTokens: call.usage?.inputTokens,
                outputTokens: call.usage?.outputTokens,
                cachedTokens: call.usage?.cachedTokens,
                costUsd: call.costUsd,
                failureKind: call.failureKind
              })
            )
          },
          onAuthFailure: (role) => alerter.raise('model_auth', { role }),
          now
        }),
        judge: memoryJudge,
        logger,
        alerter,
        paused: () => started.diskGuard.state().paused.memoryExtraction,
        now
      })
      closers.push(memoryWorker.start(MEMORY_TICK_MS))
    }

    // The gateway's failure helper reads the default pack's unavailable line from the data volume.
    let writtenLine: string | undefined
    const refreshUnavailableLine = (): void => {
      try {
        const id = storage.read((db): string | undefined => {
          const row = db.prepare("SELECT value FROM setting WHERE level = 'global' AND key = 'character'")
          return row.pluck().get() as string | undefined
        })
        const pack = id === undefined ? undefined : packs().packs.get(JSON.parse(id) as string)
        if (!pack || pack.lines.unavailable === writtenLine) return
        writeUnavailableLine(paths.root, pack)
        writtenLine = pack.lines.unavailable
      } catch (error) {
        logger.error('gateway.unavailable_line_failed', { error })
      }
    }
    refreshUnavailableLine()

    const stopDiskGuard = started.diskGuard.start(config.storage.checkEveryMin * 60_000)
    const stopSnapshots = startSnapshotTimer(storage, paths.snapshots, {
      everyMin: config.backup.everyMin,
      keepDays: config.backup.keepDays,
      now,
      onResult: (result) => {
        if (result.state !== 'verified')
          logger.error('storage.snapshot_failed', { file: result.file, detail: result.detail })
      }
    })
    closers.push(stopDiskGuard, stopSnapshots)

    // Step 6: report ready.
    let ready = true
    const server = createGatewayServer({
      turns,
      storage,
      logger,
      redactor,
      ready: () => ready,
      now,
      afterTurn: refreshUnavailableLine,
      health: () => ({
        snapshot: storage.read((db): Record<string, unknown> | undefined => {
          const newest = db.prepare('SELECT id, state, reason FROM backup_run ORDER BY id DESC LIMIT 1')
          return newest.get() as Record<string, unknown> | undefined
        })
      })
    })

    let closed = false
    return {
      storage,
      paths,
      turns,
      registry,
      server,
      alerter,
      packs,
      refreshUnavailableLine,
      snapshot: (reason) => takeSnapshot(storage, paths.snapshots, reason, now),
      listen: (port, host) =>
        new Promise((resolve, reject) => {
          server.once('error', reject)
          server.listen(port, host, () => resolve(server.address() as AddressInfo))
        }),
      async close() {
        if (closed) return
        closed = true
        // Stop admitting turns, let running turns finish, then stop the rest.
        ready = false
        await turns.drain(config.shutdown.graceMs)
        server.closeAllConnections()
        if (server.listening) await new Promise((resolve) => server.close(resolve))
        for (const stop of closers) await stop()
        storage.close()
      }
    }
  } catch (error) {
    for (const stop of closers) await stop()
    storage.close()
    throw error
  }
}
