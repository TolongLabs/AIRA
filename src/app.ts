import { existsSync } from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { createSiteApiServer } from './api/server.js'
import { type PackSet, loadPacks } from './character/loader.js'
import { writeUnavailableLine } from './character/unavailable.js'
import { ConfigError } from './config/loader.js'
import type { Config } from './config/schema.js'
import { withAttachments } from './format/attachments.js'
import { createReplyCleaner } from './format/clean.js'
import { writeChatFlags } from './gateway/chat-flags.js'
import { writeScheduleFile } from './gateway/schedule.js'
import { createGatewayServer } from './gateway/server.js'
import { createSystemOneClient, createSystemOneMemoryJudge, createSystemOneMoodJudge } from './judge/systemone.js'
import { type MediaWatcher, createGeminiWatcher } from './media/gemini-watcher.js'
import { DEFAULT_MEDIA_LIMITS } from './media/limits.js'
import { createLinkReader } from './media/link-intake.js'
import { createTurnMedia } from './media/turn-media.js'
import { createMemoryPort } from './memory/port.js'
import { presentLabels, recallForTurn } from './memory/recall.js'
import type { MemoryJudge } from './memory/types.js'
import { type MemoryWorker, createMemoryWorker } from './memory/worker.js'
import { createAnthropicClient } from './models/anthropic-client.js'
import { createApiRunner } from './models/api-runner.js'
import { type Breaker, createBreaker } from './models/breaker.js'
import { createOpenAiClient } from './models/openai-client.js'
import { createRoutedClient } from './models/routed-client.js'
import { spendState } from './models/spend.js'
import { createSubscriptionRunner } from './models/subscription-runner.js'
import { createToolServer } from './models/tool-server.js'
import type { ModelClient } from './models/types.js'
import { createPromptBuilder, loadHarnessRules } from './prompt/builder.js'
import type { MoodJudge } from './prompt/mood.js'
import { withStickers } from './prompt/stickers.js'
import { type Logger, createLogger } from './records/logger.js'
import { createRedactor, secretsFromEnv } from './records/redact.js'
import { pruneRecords } from './records/retention.js'
import { recordModelCall } from './records/turn-record.js'
import { okToolsOfTurn } from './records/turn-view.js'
import { listChats } from './settings/chats.js'
import { resolveSettings } from './settings/settings.js'
import { createSocialPostPort } from './social/port.js'
import { ReplyReader } from './social/replies/service.js'
import { findLinkTarget } from './social/urls.js'
import { SocialPostViewer } from './social/viewer.js'
import { isYtDlpAvailable } from './social/yt-dlp.js'
import { archiveAndPrune } from './storage/archive.js'
import type { Storage } from './storage/database.js'
import { type SnapshotReason, type SnapshotResult, startSnapshotTimer, takeSnapshot } from './storage/snapshot.js'
import { type DataPaths, startStorage } from './storage/startup.js'
import { createCommandRouter } from './tools/commands.js'
import { registerCoreTools } from './tools/core/index.js'
import { createExaPagePort, createExaSearchPort } from './tools/exa.js'
import { registerLessonTools } from './tools/lessons/index.js'
import { connectMcpServers } from './tools/mcp-client.js'
import { registerOwnerTools } from './tools/owner/index.js'
import { type ToolPorts, createFetchPagePort } from './tools/ports.js'
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
  'YOUTUBE_API_KEY',
  'TYPESAFE_API_KEY',
  'EXA_API_KEY',
  'RUNNER_TOKEN',
  'OPENAI_API_KEY',
  'SITE_TOKEN'
] as const

/** How often the memory worker looks for a closed episode or a due job. */
const MEMORY_TICK_MS = 15_000
const MIN_SITE_TOKEN_LENGTH = 32

export interface AppOptions {
  config: Config
  /** Where secrets are read from, by name. */
  env: NodeJS.ProcessEnv
  version?: string
  /** The built site, served under /app/ on the site API's port. */
  siteDir?: string
  logger?: Logger
  /** Model clients to use instead of the configured endpoints: recordings, fakes. */
  clients?: { main?: ModelClient; fallback?: ModelClient }
  /** The mood judge. Absent means rules only. */
  judge?: MoodJudge
  /** The memory judge. Absent means the hosted judge when it is configured, else none: memory admits nothing. */
  memoryJudge?: MemoryJudge
  /** The media model. Absent means the configured model when its key is set, else media is off. */
  mediaWatcher?: MediaWatcher
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
  /** The memory worker, when passive memory is on. Its timer runs it; a test or an operator may run one tick. */
  memory?: MemoryWorker
  server: Server
  siteServer?: Server
  alerter: Alerter
  packs: () => PackSet
  listen(port: number, host: string): Promise<AddressInfo>
  listenSite(port: number, host: string): Promise<AddressInfo | undefined>
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
  if (target.provider !== 'anthropic' && target.provider !== 'openai-compatible') {
    throw new ConfigError(`llm.${role}.provider is "${target.provider}": use "anthropic" or "openai-compatible"`)
  }
  // A role with no key is switched off (docs/trd/models.md#roles). The caller decides whether that stops start-up.
  if (key === undefined || key === '') return undefined
  if (target.provider === 'anthropic') {
    return createAnthropicClient({ baseUrl: target.baseUrl, apiKey: key, effort: target.effort, prices: target })
  }
  return createOpenAiClient({ baseUrl: target.baseUrl, apiKey: key, effort: target.effort, prices: target })
}

export async function createApp(options: AppOptions): Promise<App> {
  const { config, env } = options
  const now = options.now ?? (() => new Date())
  const redactor = createRedactor({ secrets: secretsFromEnv(SECRET_NAMES, env) })
  const logger = options.logger ?? createLogger({ level: config.log.level, module: 'core', redactor })

  // Steps 1 to 4: the data volume, the database, migrations, the recovery pass.
  const alerter = createAlerter({ minGapMs: config.alerts.minGapMs, logger, now })
  // Steps 1 to 4. The disk guard's three levels each alert the operator.
  const started = await startStorage({
    config,
    logger,
    now,
    onDiskAlert: (state) => alerter.raise('storage', { level: state.level, freeMb: state.freeMb }),
    onStorageError: () => alerter.raise('storage', { level: 'error' })
  })
  const { storage, paths } = started
  const closers: (() => void | Promise<void>)[] = []
  try {
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
    const subscription = config.llm.transport === 'subscription'
    const main = modelClient(config.llm.main, env['LLM_API_KEY'], 'main', options.clients?.main)
    if (!main && !subscription) {
      throw new ConfigError('llm.main needs a model, a baseUrl and LLM_API_KEY in the environment')
    }
    const fallback = modelClient(
      config.llm.fallback,
      env['LLM_FALLBACK_API_KEY'],
      'fallback',
      options.clients?.fallback
    )
    for (const [role, client] of [
      ['main', main],
      ['fallback', fallback]
    ] as const) {
      if (!client && config.llm[role].model !== '') logger.warn('model_role.off', { role, reason: 'no_key' })
    }
    const breaker = createBreaker({
      breakerMs: config.llm.breakerMs,
      now,
      onOpen: (role) => alerter.raise('breaker_open', { role })
    })
    const limits = { maxCallsPerTurn: config.tools.maxCallsPerTurn, timeBudgetMs: config.tools.timeBudgetMs }
    type Target = { client: ModelClient; model: string }
    /** The API runner on one model, with an optional second model behind it. */
    const apiRunner = (first: Target, second: Target | undefined, roleBreaker: Breaker): TurnRunner =>
      createApiRunner({
        clientFor: (onCall, onSpendError) =>
          createRoutedClient({
            main: first,
            fallback: second,
            config,
            breaker: roleBreaker,
            storage,
            transport: 'api',
            onCall,
            onSpendError,
            onAuthFailure: (role) => alerter.raise('model_auth', { role }),
            now
          }),
        model: first.model,
        limits,
        now
      })
    const mainTarget = main ? { client: main, model: config.llm.main.model } : undefined
    const fallbackTarget = fallback ? { client: fallback, model: config.llm.fallback.model } : undefined

    let runner: TurnRunner
    let fallbackBreaker: Breaker | undefined
    if (!subscription) {
      runner = apiRunner(mainTarget as Target, fallbackTarget, breaker)
    } else {
      // The program on the host runs the loop and calls the tools through the core's tool server. The fallback
      // model answers on the API runner, with its own breaker: the two limits it guards are different accounts.
      const runnerToken = env['RUNNER_TOKEN']
      if (!runnerToken)
        throw new ConfigError('RUNNER_TOKEN is not set in the environment (llm.transport is "subscription")')
      const toolServer = createToolServer({ limits, logger, now })
      await toolServer.listen(config.llm.subscription.toolServerPort)
      closers.push(() => toolServer.close())
      fallbackBreaker = fallbackTarget ? createBreaker({ breakerMs: config.llm.breakerMs, now }) : undefined
      runner = createSubscriptionRunner({
        subscription: config.llm.subscription,
        model: config.llm.main.model,
        effort: config.llm.main.effort,
        runnerToken,
        toolServer,
        breaker,
        fallback: fallbackTarget && fallbackBreaker ? apiRunner(fallbackTarget, undefined, fallbackBreaker) : undefined,
        onAuthFailure: (role) => alerter.raise('model_auth', { role }),
        logger,
        now
      })
    }
    // Memory extraction needs a model behind a key: the main one, or on the subscription transport the fallback.
    const extractionTarget = mainTarget ?? fallbackTarget

    // The hosted judge, when its model and key are set. Without it the mood comes from rules and memory admits nothing.
    const judgeKey = env['TYPESAFE_API_KEY']
    const hosted =
      config.judge.model !== '' && judgeKey
        ? createSystemOneClient({ apiKey: judgeKey, model: config.judge.model })
        : undefined
    const moodJudge = options.judge ?? (hosted ? createSystemOneMoodJudge(hosted) : undefined)
    const memoryJudge = options.memoryJudge ?? (hosted ? createSystemOneMemoryJudge(hosted) : undefined)

    // Tools: one registry. The prompt text about tools and the cleaner's name list come from it.
    // The gateway's schedule fires reminders from the wanted-jobs file (docs/trd/system.md#scheduled-turns). It is
    // written at start-up, which is the reminders' start-up reconciliation, and after every change.
    const schedule = { sync: () => void writeScheduleFile(storage, paths.root, now) }
    logger.info('schedule.written', { reminders: writeScheduleFile(storage, paths.root, now) })
    writeChatFlags(storage, paths.root, packs)
    const registry = createToolRegistry({ storage, config, logger, redactor, now })
    const exaKey = env['EXA_API_KEY']
    let search = options.ports?.search
    if (!search && config.search.provider === 'exa') {
      if (typeof exaKey === 'string' && exaKey.length > 0) {
        search = createExaSearchPort({ apiKey: exaKey })
      } else {
        logger.warn('search.off', { reason: 'no_key' })
      }
    }
    // read_page goes through Exa when search does, so pages that refuse plain fetches still read.
    const plainPage = createFetchPagePort()
    const page =
      config.search.provider === 'exa' && typeof exaKey === 'string' && exaKey.length > 0
        ? createExaPagePort({ apiKey: exaKey, fallback: plainPage, maxChars: config.search.pageMaxChars })
        : plainPage
    const viewer = new SocialPostViewer(config.social, { logger })
    const replyReader = new ReplyReader(config.social, { logger, youtubeApiKey: () => env['YOUTUBE_API_KEY'] })
    const extractorAvailable = await isYtDlpAvailable(config.social.ytDlpPath)
    viewer.setYtDlpAvailable(extractorAvailable)
    replyReader.setYtDlpAvailable(extractorAvailable)
    if (!extractorAvailable) logger.warn('social.extractor_off', { platform: 'yt-dlp', reason: 'binary_missing' })
    registerCoreTools(registry, {
      post: createSocialPostPort(viewer, replyReader),
      memory: createMemoryPort({
        storage,
        judge: memoryJudge,
        verifyThreshold: config.judge.memoryVerify,
        timeoutMs: config.judge.timeoutMs
      }),
      // The plain reader refuses private addresses, also after a redirect; the Exa reader falls back to it.
      page,
      schedule,
      ...(search ? { search } : {}),
      ...options.ports,
      filesDir: paths.files
    })
    // The lessons and library tools, behind `features.lessons`. No lyrics provider is built: those two tools say so.
    registerLessonTools(registry, { ...options.ports, filesDir: paths.files })
    // The owner's market and coding-session tools, behind `features.owner`.
    registerOwnerTools(registry, config.owner)
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
        createReplyCleaner(
          config,
          () => registry.toolNames(),
          (turnId) => okToolsOfTurn(storage, turnId),
          (turnId) => registry.takeSources(turnId)
        ),
        { storage, hostDataDir }
      ),
      { storage, hostDataDir, now }
    )

    // Media watching (docs/trd/models.md#media-watching). With no model or no key, media is off: files get a note.
    const mediaModel = config.media.watcher.model
    const mediaKey = env['MEDIA_WATCHER_API_KEY']
    const mediaWatcher =
      options.mediaWatcher ??
      (mediaModel !== null && mediaKey ? createGeminiWatcher({ apiKey: mediaKey, model: mediaModel }) : undefined)
    if (!mediaWatcher) logger.warn('media.off', { reason: mediaModel === null ? 'no_model' : 'no_key' })
    else if (config.media.gatewayDirs.length === 0) logger.warn('media.no_gateway_dirs', {})
    for (const dir of config.media.gatewayDirs) {
      if (!existsSync(dir.container)) logger.warn('media.dir_missing', { container: dir.container })
    }

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
      commands: createCommandRouter(registry, { timeZone: config.format.timeZone }),
      media: createTurnMedia({
        ...(mediaWatcher ? { watcher: mediaWatcher } : {}),
        links: createLinkReader({
          viewer,
          findTarget: (text) => findLinkTarget([text]),
          ...(mediaWatcher ? { watcher: mediaWatcher } : {}),
          download: (url, signal, maxBytes) => plainPage.download(url, signal, maxBytes),
          model: mediaModel ?? '',
          limits: {
            ...DEFAULT_MEDIA_LIMITS,
            maxVideoSeconds: config.media.maxVideoSeconds,
            maxLinkVideoSeconds: config.media.maxLinkVideoSeconds
          },
          logger,
          now
        }),
        model: mediaModel ?? '',
        limits: { ...DEFAULT_MEDIA_LIMITS, maxVideoSeconds: config.media.maxVideoSeconds },
        gatewayDirs: config.media.gatewayDirs,
        timeoutMs: config.media.timeoutMs,
        now
      }),
      hooks: { spendAllows: () => spendState(storage, config.llm.monthlyBudgetUsd, now).repliesAllowed },
      onScheduleChange: () => {
        try {
          schedule.sync()
        } catch (error) {
          logger.warn('schedule.write_failed', { error })
        }
      },
      now
    })

    // Memory extraction (docs/trd/memory.md#write-path): background work, one job at a time.
    let memory: MemoryWorker | undefined
    if (config.memory.enabled === 'on' && !extractionTarget) {
      logger.warn('memory.no_extraction_model', {})
    } else if (config.memory.enabled === 'on' && extractionTarget) {
      const memoryWorker = createMemoryWorker({
        storage,
        config,
        client: createRoutedClient({
          main: extractionTarget,
          fallback: extractionTarget === mainTarget ? fallbackTarget : undefined,
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
      memory = memoryWorker
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
    // The daily retention job. With the archive on, rows are exported before they are deleted, and the job waits
    // while the disk guard pauses the archive. With the archive off, rows are deleted without an export.
    const retention = setInterval(() => {
      const run =
        config.archive.enabled === 'on'
          ? archiveAndPrune(storage, {
              archiveDir: paths.archive,
              config: config.records,
              enabled: !started.diskGuard.state().paused.archive,
              now
            })
          : Promise.resolve().then(() => pruneRecords(storage, config.records, { now }))
      run.catch((error: unknown) => logger.error('storage.retention_failed', { error }))
    }, 86_400_000)
    retention.unref()
    closers.push(stopDiskGuard, stopSnapshots, () => clearInterval(retention))

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

    const siteToken = env['SITE_TOKEN']
    let siteServer: Server | undefined
    if (siteToken !== undefined && siteToken.length >= MIN_SITE_TOKEN_LENGTH) {
      siteServer = createSiteApiServer({
        token: siteToken,
        allowedOrigins: config.site.allowedOrigins,
        packs,
        ...(options.siteDir ? { siteDir: options.siteDir } : {}),
        storage,
        paths,
        version: options.version ?? '0.0.0',
        ready: () => ready,
        activeTurns: () => turns.active(),
        roles: () => ({
          main: { configured: Boolean(mainTarget) || subscription, breakerOpen: breaker.isOpen('main') },
          fallback: {
            configured: Boolean(fallbackTarget),
            breakerOpen: subscription ? (fallbackBreaker?.isOpen('main') ?? false) : breaker.isOpen('fallback')
          },
          judge: { configured: Boolean(moodJudge || memoryJudge), breakerOpen: false },
          media: { configured: Boolean(mediaWatcher), breakerOpen: false }
        }),
        logger,
        now,
        onWrite: () => void writeChatFlags(storage, paths.root, packs)
      })
    } else {
      logger.warn('site_api.no_token', { reason: siteToken ? 'too_short' : 'unset' })
    }

    let closed = false
    return {
      storage,
      paths,
      turns,
      registry,
      ...(memory ? { memory } : {}),
      server,
      ...(siteServer ? { siteServer } : {}),
      alerter,
      packs,
      refreshUnavailableLine,
      snapshot: (reason) => takeSnapshot(storage, paths.snapshots, reason, now),
      listen: (port, host) =>
        new Promise((resolve, reject) => {
          server.once('error', reject)
          server.listen(port, host, () => resolve(server.address() as AddressInfo))
        }),
      listenSite: (port, host) => {
        if (!siteServer) return Promise.resolve(undefined)
        return new Promise((resolve, reject) => {
          siteServer.once('error', reject)
          siteServer.listen(port, host, () => resolve(siteServer.address() as AddressInfo))
        })
      },
      async close() {
        if (closed) return
        closed = true
        // Stop admitting turns, let running turns finish, then stop the rest.
        ready = false
        await turns.drain(config.shutdown.graceMs)
        server.closeAllConnections()
        if (server.listening) await new Promise((resolve) => server.close(resolve))
        if (siteServer) {
          siteServer.closeAllConnections()
          if (siteServer.listening) await new Promise((resolve) => siteServer.close(resolve))
        }
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
