import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { createSiteApiServer } from './api/server.js'
import { pendingStudioPacks, recoverStudioPacks } from './api/studio-packs.js'
import { loadPacks, type PackSet } from './character/loader.js'
import { previewPack } from './character/preview.js'
import { writeUnavailableLine } from './character/unavailable.js'
import { credentialPurposes, deploymentSettings } from './config/dashboard-settings.js'
import { type InstallationMode, installationModeFromEnv, type StandaloneReadiness } from './config/installation-mode.js'
import { ConfigError, requireDeployable } from './config/loader.js'
import type { Config } from './config/schema.js'
import { createStandaloneModelStore } from './config/standalone-models.js'
import { ensureStandaloneOwnerToken } from './config/standalone-owner.js'
import { createConfigStatus } from './config/status.js'
import { expireFeedback, pruneFeedbackAnswers } from './feedback/store.js'
import { createFeedbackSync, type FeedbackSync } from './feedback/sync.js'
import { withAttachments } from './format/attachments.js'
import { createReplyCleaner } from './format/clean.js'
import { createFooterLinks } from './format/short-links.js'
import { writeChatFlags } from './gateway/chat-flags.js'
import { discardInterruptedReminders } from './gateway/reminder-scope.js'
import { writeScheduleFile } from './gateway/schedule.js'
import { createGatewayServer } from './gateway/server.js'
import { createStandaloneGateway } from './gateway/standalone.js'
import {
  createSystemOneClient,
  createSystemOneMemoryJudge,
  createSystemOneMoodJudge,
  modelRecordContext
} from './judge/systemone.js'
import { createAutofetch } from './media/autofetch.js'
import { createGeminiWatcher, type MediaWatcher } from './media/gemini-watcher.js'
import { DEFAULT_MEDIA_LIMITS } from './media/limits.js'
import { createLinkReader } from './media/link-intake.js'
import { createTurnMedia } from './media/turn-media.js'
import { createVideoCompressor } from './media/video-compression.js'
import { createShortDownload } from './media/youtube-short.js'
import { createMemoryPort } from './memory/port.js'
import { presentLabels, recallForTurn } from './memory/recall.js'
import type { MemoryJudge } from './memory/types.js'
import { createMemoryWorker, type MemoryWorker } from './memory/worker.js'
import { createAnthropicClient } from './models/anthropic-client.js'
import { createApiRunner } from './models/api-runner.js'
import { type Breaker, createBreaker } from './models/breaker.js'
import { localRouterClient } from './models/local-router-client.js'
import { createOpenAiClient } from './models/openai-client.js'
import { createRoutedClient } from './models/routed-client.js'
import { addSpend, spendState } from './models/spend.js'
import { createSubscriptionRunner, withSubscriptionFallback } from './models/subscription-runner.js'
import { createToolServer } from './models/tool-server.js'
import { type ModelClient, ModelError, type ModelResponse } from './models/types.js'
import { createPromptBuilder, loadHarnessRules } from './prompt/builder.js'
import type { MoodJudge } from './prompt/mood.js'
import { withStickers } from './prompt/stickers.js'
import { createLogger, type Logger } from './records/logger.js'
import { createRedactor, secretsFromEnv } from './records/redact.js'
import { pruneRecords } from './records/retention.js'
import { endJobRun, recordFailure, recordModelCall, startJobRun } from './records/turn-record.js'
import { okToolsOfTurn } from './records/turn-view.js'
import { renderNote, renderReport } from './render/render.js'
import { reportFormatSchema } from './render/types.js'
import { createResearchOffers, type ReportRenderer } from './research/offer.js'
import { createResearchWorker, type ResearchWorker } from './research/worker.js'
import { listChats } from './settings/chats.js'
import { resolveSettings } from './settings/settings.js'
import { enabledMirrorAsset, isDouyinRedirectMediaUrl } from './social/mirror-readers.js'
import { createSocialPostPort } from './social/port.js'
import { ReplyReader } from './social/replies/service.js'
import { sharePendingDownloads } from './social/shared-download.js'
import { findLinkTarget } from './social/urls.js'
import { SocialPostViewer } from './social/viewer.js'
import { isYtDlpAvailable } from './social/yt-dlp.js'
import { archiveAndPrune } from './storage/archive.js'
import type { Storage } from './storage/database.js'
import { createOffsite } from './storage/offsite.js'
import { type SnapshotReason, type SnapshotResult, startSnapshotTimer, takeSnapshot } from './storage/snapshot.js'
import { type DataPaths, startStorage } from './storage/startup.js'
import { createCommandRouter } from './tools/commands.js'
import { registerCoreTools } from './tools/core/index.js'
import { createExaPagePort, createExaSearchPort } from './tools/exa.js'
import { createSerpApiIdentify } from './tools/identify.js'
import { registerLessonTools } from './tools/lessons/index.js'
import { connectMcpServers } from './tools/mcp-client.js'
import { registerOwnerTools } from './tools/owner/index.js'
import { createFetchPagePort, type ToolPorts } from './tools/ports.js'
import { createToolRegistry, type ToolRegistry } from './tools/registry.js'
import { type Alerter, createAlerter } from './turn/alerts.js'
import { createTurnService, type TurnService } from './turn/pipeline.js'
import type { TurnRunner } from './turn/types.js'

// The service, put together (docs/trd/system.md). One function builds every part in the start-up order of
// docs/trd/storage.md#start-up-sequence, so the entry point, the tests and the harness run the same core.

/** The names of every secret in .env. Their values are masked in every log line. */
export const SECRET_NAMES = Object.keys(credentialPurposes)

/** How often the memory worker looks for a closed episode or a due job. */
const MEMORY_TICK_MS = 15_000

export interface AppOptions {
  config: Config
  /** Where secrets are read from, by name. */
  env: NodeJS.ProcessEnv
  /** The service process schedules a graceful restart after an accepted standalone activation. */
  onActivationRequested?: () => void
  version?: string
  /** The built site, served under /app/ on the site API's port. */
  siteDir?: string
  /** Optional read-only gateway channel directory JSON for fallback chat names. */
  channelDirectoryPath?: string
  /** The exact config path parsed at start-up. Absent means injected in-memory config with no source file. */
  configPath?: string
  /** When the running config was applied. Defaults to creation time. */
  configAppliedAt?: Date
  logger?: Logger
  /** Model clients to use instead of the configured endpoints: recordings, fakes. */
  clients?: { main?: ModelClient; fallback?: ModelClient }
  /** PDF renderer port. Tests supply a fake. */
  reportRenderer?: ReportRenderer
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
  installationMode: InstallationMode
  /** False while the standalone chatbot has no applied model revision. Legacy mirrors service readiness. */
  chatbotReady: () => boolean
  /** The process invokes this only after both listeners have bound successfully. */
  completeStartup(): void
  failStartup(): void
  /** The memory worker, when passive memory is on. Its timer runs it; a test or an operator may run one tick. */
  memory?: MemoryWorker
  /** The research worker. Its timer runs it; a test or an operator may run one tick. */
  research: ResearchWorker
  feedback: FeedbackSync
  server: Server
  siteServer: Server
  alerter: Alerter
  packs: () => PackSet
  /** Deployment activation readback for the owner dashboard. */
  configStatus: () => import('./config/status.js').ConfigStatusSnapshot
  listen(port: number, host: string): Promise<AddressInfo>
  listenSite(port: number, host: string): Promise<AddressInfo>
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
  override?: ModelClient,
  effort = target.effort,
  ownerSocket?: string
): ModelClient | undefined {
  if (override) return override
  if (target.provider === 'aira-router') return ownerSocket ? localRouterClient(ownerSocket, effort, target) : undefined
  if (target.model === '' || target.baseUrl === '') return undefined
  if (target.provider !== 'anthropic' && target.provider !== 'openai-compatible') {
    throw new ConfigError(`llm.${role}.provider is "${target.provider}": use "anthropic" or "openai-compatible"`)
  }
  // A role with no key is switched off (docs/trd/models.md#roles). The caller decides whether that stops start-up.
  if (key === undefined || key === '') return undefined
  if (target.provider === 'anthropic') {
    return createAnthropicClient({ baseUrl: target.baseUrl, apiKey: key, effort, prices: target })
  }
  return createOpenAiClient({ baseUrl: target.baseUrl, apiKey: key, effort, prices: target })
}

export async function createApp(options: AppOptions): Promise<App> {
  const installationMode = installationModeFromEnv(options.env)
  const standalone = installationMode === 'standalone'
  if (standalone) requireDeployable(options.config, installationMode)
  const standaloneModels = standalone
    ? createStandaloneModelStore(options.config.storage.path, options.config)
    : undefined
  const modelBoot = standaloneModels?.beginBoot()
  const config = modelBoot?.config ?? options.config
  // Standalone never inherits legacy credentials or host service addresses.
  const env = standalone ? (modelBoot?.env ?? {}) : options.env
  const now = options.now ?? (() => new Date())
  const redactor = createRedactor({
    secrets: { ...secretsFromEnv(SECRET_NAMES, options.env), ...secretsFromEnv(SECRET_NAMES, env) }
  })
  const logger = options.logger ?? createLogger({ level: config.log.level, module: 'core', redactor })
  if (redactor.weak.length > 0) logger.warn('records.weak_secret', { keys: redactor.weak })
  const configStatusHolder = createConfigStatus({
    config,
    ...(!standalone && options.configPath !== undefined ? { configPath: options.configPath } : {}),
    ...(options.configAppliedAt !== undefined ? { appliedAt: options.configAppliedAt } : {}),
    now
  })
  const configStatus = () => configStatusHolder.read()

  // Steps 1 to 4: the data volume, the database, migrations, the recovery pass.
  let alerter = createAlerter({ minGapMs: config.alerts.minGapMs, logger, now })
  // Steps 1 to 4. The disk guard's three levels each alert the operator.
  const started = await startStorage({
    config,
    logger,
    now,
    onDiskAlert: (state) => alerter.raise('storage', { level: state.level, freeMb: state.freeMb }),
    onStorageError: () => alerter.raise('storage', { level: 'error' })
  })
  const { storage, paths } = started
  alerter = createAlerter({
    minGapMs: config.alerts.minGapMs,
    logger,
    storage,
    deliveryFile: join(paths.root, 'alerts.jsonl'),
    now
  })
  const closers: (() => void | Promise<void>)[] = []
  try {
    if (standalone) discardInterruptedReminders(storage, now)
    const standaloneOwnerToken = standalone ? ensureStandaloneOwnerToken(paths.root) : undefined
    const standaloneGateway = standalone ? createStandaloneGateway(paths.root, storage, now) : undefined
    for (const turnId of started.recovery.interruptedTurns) alerter.raise('turn_interrupted', { turnId })

    recoverStudioPacks({ paths, storage, now }, (id) => alerter.raise('pack_invalid', { pack: id }))

    // Step 5: character packs and bindings. A fault in one pack or one chat disables that pack or chat only.
    const packs = () =>
      loadPacks({
        excluded: pendingStudioPacks(paths),
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
    const wrapperFallback = config.llm.fallbackTransport === 'subscription'
    type Target = { client: ModelClient; model: string; effort: string }
    type RoleTargets = { normal: Target; deep: Target }
    const buildRole = (
      targetConfig: Config['llm']['main'],
      key: string | undefined,
      role: string,
      override?: ModelClient
    ): RoleTargets | undefined => {
      const normalClient = modelClient(
        targetConfig,
        key,
        role,
        override,
        targetConfig.effort,
        env.AIRA_OWNER_API_SOCKET
      )
      if (!normalClient) return undefined
      const deepEffort = targetConfig.deepEffort !== '' ? targetConfig.deepEffort : targetConfig.effort
      const deepClient =
        override || deepEffort === targetConfig.effort
          ? normalClient
          : (modelClient(targetConfig, key, role, undefined, deepEffort, env.AIRA_OWNER_API_SOCKET) as ModelClient)
      return {
        normal: { client: normalClient, model: targetConfig.model, effort: targetConfig.effort },
        deep: { client: deepClient, model: targetConfig.model, effort: deepEffort }
      }
    }
    const mainRole =
      standalone && !modelBoot?.configured
        ? undefined
        : buildRole(config.llm.main, env['LLM_API_KEY'], 'main', options.clients?.main)
    if (!mainRole && !subscription && (!standalone || modelBoot?.configured)) {
      throw new ConfigError('llm.main needs a model, a baseUrl and LLM_API_KEY in the environment')
    }
    const fallbackRole =
      wrapperFallback || (standalone && !env.LLM_FALLBACK_API_KEY)
        ? undefined
        : buildRole(config.llm.fallback, env['LLM_FALLBACK_API_KEY'], 'fallback', options.clients?.fallback)
    for (const [role, target] of [
      ['main', mainRole],
      ['fallback', fallbackRole]
    ] as const) {
      if (!standalone && !target && config.llm[role].model !== '')
        logger.warn('model_role.off', { role, reason: 'no_key' })
    }
    const breaker = createBreaker({
      breakerMs: config.llm.breakerMs,
      now,
      onOpen: (role) => alerter.raise('breaker_open', { role })
    })
    const limits = { maxCallsPerTurn: config.tools.maxCallsPerTurn, timeBudgetMs: config.tools.timeBudgetMs }
    /** The API runner on one model, with an optional second model behind it. */
    const apiRunner = (first: RoleTargets, second: RoleTargets | undefined, roleBreaker: Breaker): TurnRunner =>
      createApiRunner({
        clientFor: (onCall, onSpendError, think, route, deadline) =>
          createRoutedClient({
            main: think ? first.deep : first.normal,
            fallback: second ? (think ? second.deep : second.normal) : undefined,
            ...(route ? { pin: route } : {}),
            deadline,
            config,
            breaker: roleBreaker,
            storage,
            transport: 'api',
            onCall: (call) => {
              onCall(call)
              const budget = config.llm.monthlyBudgetUsd
              const spent = spendState(storage, budget, now).spentUsd
              if (budget > 0 && call.costUsd !== undefined) {
                for (const threshold of [0.8, 1]) {
                  if (spent < budget * threshold && spent + call.costUsd >= budget * threshold) {
                    alerter.raise('spend', { threshold })
                  }
                }
              }
            },
            onSpendError,
            onAuthFailure: (role) => alerter.raise('model_auth', { role }),
            now
          }),
        model: first.normal.model,
        limits,
        now
      })

    let runner: TurnRunner
    let fallbackBreaker: Breaker | undefined
    /** Guards the turn dependency while the standalone chatbot is inactive. The gateway refuses turns first. */
    const inertRunner: TurnRunner = {
      run: async () => {
        throw new Error('model_setup_required: the chatbot is inactive')
      }
    }
    if (standalone && !mainRole) {
      runner = inertRunner
    } else if (!subscription && !wrapperFallback) {
      runner = apiRunner(mainRole as RoleTargets, fallbackRole, breaker)
    } else {
      // The program on the host runs the loop and calls the tools through the core's tool server. The fallback
      // model answers on the API runner, with its own breaker: the two limits it guards are different accounts.
      const runnerToken = env['RUNNER_TOKEN']
      if (!runnerToken || runnerToken.length < 16)
        throw new ConfigError('RUNNER_TOKEN must contain at least 16 characters for subscription transport')
      const toolServer = createToolServer({ limits, logger: logger.child({ module: 'tool_server' }), now })
      await toolServer.listen(config.llm.subscription.toolServerPort)
      closers.push(() => toolServer.close())
      fallbackBreaker = fallbackRole ? createBreaker({ breakerMs: config.llm.breakerMs, now }) : undefined
      const wrapperRole = wrapperFallback ? 'fallback' : 'main'
      const wrapper = createSubscriptionRunner({
        role: wrapperRole,
        subscription: config.llm.subscription,
        model: config.llm[wrapperRole].model,
        effort: config.llm[wrapperRole].effort,
        deepEffort: config.llm[wrapperRole].deepEffort,
        runnerToken,
        toolServer,
        breaker,
        fallback: fallbackRole && fallbackBreaker ? apiRunner(fallbackRole, undefined, fallbackBreaker) : undefined,
        onAuthFailure: (role) => alerter.raise('model_auth', { role }),
        logger: logger.child({ module: 'subscription' }),
        now
      })
      runner = wrapperFallback
        ? withSubscriptionFallback(apiRunner(mainRole as RoleTargets, undefined, breaker), wrapper)
        : wrapper
    }
    // Memory extraction needs a model behind a key: the main one, or on the subscription transport the fallback.
    // Standalone stays inactive in this packet, so no extraction target is built from inherited credentials.
    const extractionTarget = standalone ? undefined : (mainRole?.normal ?? fallbackRole?.normal)

    // The hosted judge, when its model and key are set. Without it the mood comes from rules and memory admits nothing.
    // Standalone inactive builds no judge from inherited credentials.
    const judgeKey = env['TYPESAFE_API_KEY']
    const hosted =
      config.judge.model !== '' && judgeKey
        ? createSystemOneClient({
            apiKey: judgeKey,
            model: config.judge.model,
            now,
            onCall: (call) => {
              storage.tx((db) => {
                recordModelCall(db, { ...call, role: 'judge', transport: 'api', attempt: 1 })
                if (call.failureKind)
                  recordFailure(
                    db,
                    {
                      turnId: call.turnId,
                      jobId: call.jobId,
                      stage: 'judge',
                      kind: 'judge_unavailable',
                      error: new Error(`judge request failed: ${call.failureKind}`),
                      handledBy: 'judge_fallback'
                    },
                    redactor,
                    now
                  )
              })
              if (call.failureKind)
                logger.warn('judge.unavailable', { ...modelRecordContext.getStore(), kind: call.failureKind })
              if (call.failureKind === 'auth') alerter.raise('model_auth', { role: 'judge' })
            }
          })
        : undefined
    const moodJudge = standalone
      ? undefined
      : (options.judge ?? (hosted ? createSystemOneMoodJudge(hosted) : undefined))
    const memoryJudge = standalone
      ? undefined
      : (options.memoryJudge ?? (hosted ? createSystemOneMemoryJudge(hosted) : undefined))

    // Tools: one registry. The prompt text about tools and the cleaner's name list come from it.
    // The gateway's schedule fires reminders from the wanted-jobs file (docs/trd/system.md#scheduled-turns). It is
    // written at start-up, which is the reminders' start-up reconciliation, and after every change.
    const schedule = {
      sync: () => {
        if (!standalone) writeScheduleFile(storage, paths.root, now)
      }
    }
    if (!standalone) logger.info('schedule.written', { reminders: writeScheduleFile(storage, paths.root, now) })
    writeChatFlags(storage, paths.root, packs)
    const registry = createToolRegistry({ storage, config, logger: logger.child({ module: 'tools' }), redactor, now })
    const exaKey = env['EXA_API_KEY']
    const serpKey = env['SERPAPI_API_KEY']
    let search = options.ports?.search
    if (!search && config.search.provider === 'exa') {
      if (typeof exaKey === 'string' && exaKey.length > 0) {
        search = createExaSearchPort({ apiKey: exaKey })
      } else {
        logger.warn('search.off', { reason: 'no_key' })
      }
    }
    // read_page goes through Exa when search does, so pages that refuse plain fetches still read.
    const plainPage = createFetchPagePort({ maxChars: config.search.pageMaxChars })
    const page =
      config.search.provider === 'exa' && typeof exaKey === 'string' && exaKey.length > 0
        ? createExaPagePort({ apiKey: exaKey, fallback: plainPage, maxChars: config.search.pageMaxChars })
        : plainPage
    const socialLog = logger.child({ module: 'social' })
    const apifyToken = env['APIFY_API_TOKEN']?.trim() || env['APIFY_API_KEY']?.trim() || undefined
    for (const platform of ['rednote', 'douyin', 'linkedin'] as const) {
      if (config.social.mirrors[platform] !== 'off' && !apifyToken) {
        logger.warn('social.mirror_off', { platform, reason: 'no_key' })
      }
    }
    const socialMirrors = { ...config.social.mirrors, ...(apifyToken ? { apifyToken } : {}) }
    const viewer = new SocialPostViewer({ ...config.social, mirrors: socialMirrors }, { logger })
    const replyReader = new ReplyReader(config.social, { logger, youtubeApiKey: () => env['YOUTUBE_API_KEY'] })
    const extractorAvailable = await isYtDlpAvailable(config.social.ytDlpPath)
    viewer.setYtDlpAvailable(extractorAvailable)
    replyReader.setYtDlpAvailable(extractorAvailable)
    if (!extractorAvailable) logger.warn('social.extractor_off', { platform: 'yt-dlp', reason: 'binary_missing' })
    const hostDataDir = config.gateway.hostDataDir === '' ? paths.root : config.gateway.hostDataDir
    // Social downloads keep user agent and referrer on the asset origin and carry no cookies.
    const compressVideo = createVideoCompressor()
    const socialAssetDownload = sharePendingDownloads(
      createFetchPagePort({
        sameOriginCookieless: true,
        ...(apifyToken ? { apifyToken } : {})
      }).download
    )
    // Other social media files may redirect to a CDN on another origin; they still carry no cookies.
    const socialMediaDownload = sharePendingDownloads(createFetchPagePort({ cookieless: true }).download)
    const downloadShort = createShortDownload(config.social.ytDlpPath)
    const autofetch = createAutofetch({
      downloadShort,
      mirrors: socialMirrors,
      compressVideo,
      storage,
      viewer,
      download: (url, signal, maxBytes, headers, rangeBytes) =>
        isDouyinRedirectMediaUrl(url)
          ? socialMediaDownload(url, signal, maxBytes, headers)
          : socialAssetDownload(url, signal, maxBytes, headers, rangeBytes),
      cacheDir: join(paths.cache, 'autofetch'),
      hostCacheDir: join(hostDataDir, 'cache', 'autofetch'),
      logger: logger.child({ module: 'autofetch' }),
      now
    })
    const research = createResearchOffers({
      storage,
      filesDir: paths.files,
      hostDataDir,
      renderer: options.reportRenderer ?? ((doc, format) => renderReport(doc, format, config.render ?? {})),
      format: config.render?.report ?? reportFormatSchema.parse({}),
      offerMinutes: config.research.offerMinutes,
      now
    })
    const worker = createResearchWorker({
      storage,
      config,
      search: search ?? {
        search: async () => {
          throw new Error('search_unavailable')
        }
      },
      page: options.ports?.page ?? page,
      schedule,
      logger,
      redactor,
      now,
      client: (jobId) => ({
        async call(request, signal) {
          if (!extractionTarget) throw new Error('research_model_unavailable')
          const startedAt = now()
          // One provider call per step: retries here would exceed research's three-call budget.
          let response: ModelResponse
          try {
            response = await extractionTarget.client.call({ ...request, model: extractionTarget.model }, signal)
          } catch (error) {
            storage.tx((db) =>
              recordModelCall(db, {
                jobId,
                role: 'main',
                model: extractionTarget.model,
                transport: 'api',
                effort: extractionTarget.effort,
                attempt: 1,
                startedAt,
                durationMs: Math.max(0, now().getTime() - startedAt.getTime()),
                failureKind: error instanceof ModelError ? error.kind : 'transient'
              })
            )
            throw error
          }
          storage.tx((db) => {
            addSpend(
              db,
              {
                role: 'main',
                counted: true,
                costUsd: response.costUsd,
                inputTokens: response.usage.inputTokens,
                outputTokens: response.usage.outputTokens
              },
              now
            )
            recordModelCall(db, {
              jobId,
              role: 'main',
              model: response.model,
              transport: 'api',
              effort: extractionTarget.effort,
              attempt: 1,
              startedAt,
              durationMs: Math.max(0, now().getTime() - startedAt.getTime()),
              inputTokens: response.usage.inputTokens,
              outputTokens: response.usage.outputTokens,
              cachedTokens: response.usage.cachedTokens,
              costUsd: response.costUsd
            })
          })
          return response
        }
      })
    })
    // No background model work while the standalone chatbot is inactive.
    if (!standalone) closers.push(worker.start(1000))
    registerCoreTools(
      registry,
      {
        research,
        noteRenderer: (doc, format) => renderNote(doc, format, config.render ?? {}),
        reportFormat: config.render?.report ?? reportFormatSchema.parse({}),
        post: createSocialPostPort(viewer, replyReader),
        memory: createMemoryPort({
          storage,
          judge: memoryJudge,
          verifyThreshold: config.judge.memoryVerify,
          timeoutMs: config.judge.timeoutMs,
          excludeAbandonedPortable: standalone
        }),
        // The plain reader refuses private addresses, also after a redirect; the Exa reader falls back to it.
        page,
        searchPage:
          options.ports?.page ?? createFetchPagePort({ preserveLines: true, maxChars: config.search.pageMaxChars }),
        schedule,
        ...(search ? { search } : {}),
        ...options.ports,
        filesDir: paths.files
      },
      {
        feedback: config.feedback,
        searchDepth: config.search.depth,
        standaloneTextOnly: standalone,
        ...(standaloneGateway
          ? {
              standaloneReportPermission: (context) =>
                context.delivery.kind === 'reply' &&
                standaloneGateway.canDeliverDocument(context.typedRouteId, context.chat.chatId),
              standaloneReminderScope: (context) =>
                context.delivery.kind === 'reply'
                  ? standaloneGateway.reminderScopeFor(context.typedRouteId, context.chat.chatId)
                  : null
            }
          : {}),
        ...(serpKey
          ? {
              identify: {
                port: createSerpApiIdentify({ apiKey: serpKey }),
                gatewayDirs: config.media.gatewayDirs,
                maxUploadBytes: config.identify.maxUploadBytes,
                timeoutMs: config.identify.timeoutMs
              }
            }
          : {})
      }
    )
    const feedback = createFeedbackSync({
      storage,
      url: env['FEEDBACK_SYNC_URL'] ?? '',
      secret: env['FEEDBACK_SYNC_SECRET'] ?? '',
      enabled: () =>
        Boolean(config.feedback.formUrl && config.feedback.referenceEntryId) &&
        listChats(storage).some((chat) => resolveSettings(storage, chat)['features.feedback']?.value === true),
      redactor,
      logger,
      now,
      onFailure: () => alerter.raise('feedback_sync_failed', {})
    })
    closers.push(feedback.start(config.feedback.pollMinutes * 60_000))
    void feedback.tick()
    // The lessons and library tools, behind `features.lessons`. No lyrics provider is built: those two tools say so.
    if (!standalone) registerLessonTools(registry, { ...options.ports, filesDir: paths.files })
    // Host-dependent tools are not a supported standalone capability.
    if (!standalone) registerOwnerTools(registry, config.owner)
    // External tool servers (docs/trd/tools.md#external-tool-servers). None is configured at launch.
    if (!standalone && config.mcp.servers.length > 0) {
      const mcp = await connectMcpServers(config.mcp.servers, registry, logger)
      closers.push(() => mcp.close())
    }

    const harnessRules = loadHarnessRules(options.harnessRulesPath)
    const prompt = createPromptBuilder({
      storage,
      config,
      harnessRules,
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
    // Stickers follow the text. PDF reports follow the sticker.
    const textCleaner = createReplyCleaner(
      config,
      () => registry.toolNames(),
      (turnId) => okToolsOfTurn(storage, turnId),
      (turnId) => registry.takeSources(turnId)
    )
    const cleaner = standalone
      ? textCleaner
      : withStickers(withAttachments(textCleaner, { storage, hostDataDir }), { storage, hostDataDir, now })

    // Media watching (docs/trd/models.md#media-watching). With no model or no key, media is off: files get a note.
    const mediaModel = config.media.watcher.model
    const mediaKey = env['MEDIA_WATCHER_API_KEY']
    const mediaWatcher =
      standalone && !(mediaModel && mediaKey)
        ? undefined
        : (options.mediaWatcher ??
          (mediaModel !== null && mediaKey ? createGeminiWatcher({ apiKey: mediaKey, model: mediaModel }) : undefined))
    const mediaReadyNow = () => Boolean(mediaWatcher) && activationCommitted
    if (!mediaWatcher) logger.warn('media.off', { reason: mediaModel === null ? 'no_model' : 'no_key' })
    else if (config.media.gatewayDirs.length === 0) logger.warn('media.no_gateway_dirs', {})
    for (const dir of config.media.gatewayDirs) {
      if (!existsSync(dir.container)) logger.warn('media.dir_missing', { container: dir.container })
    }

    const footerLinks = createFooterLinks(config.links, env['LINKS_SECRET'])
    const turns = createTurnService({
      storage,
      research,
      config,
      logger,
      redactor,
      packs,
      runner,
      prompt,
      cleaner,
      ...(footerLinks ? { footerLinks } : {}),
      alerter,
      tools: registry,
      commands: createCommandRouter(registry, { timeZone: config.format.timeZone }),
      ...(standaloneGateway
        ? {
            mayReadPortableMedia: (routeId, chatId) =>
              mediaReadyNow() && standaloneGateway.canReceiveMedia(routeId, chatId),
            mayRunPortableReminder: (scope, chatId) =>
              activationCommitted && Boolean(modelBoot?.configured) && standaloneGateway.mayRunReminder(scope, chatId)
          }
        : {}),
      media: createTurnMedia({
        ...(mediaWatcher ? { watcher: mediaWatcher } : {}),
        ...(!standalone
          ? {
              links: createLinkReader({
                downloadShort,
                compressVideo,
                viewer,
                findTarget: (text) => findLinkTarget([text], (entry) => socialLog.info('social.unknown_host', entry)),
                ...(mediaWatcher ? { watcher: mediaWatcher } : {}),
                download: (url, signal, maxBytes, headers, rangeBytes, source) =>
                  enabledMirrorAsset(url, source, socialMirrors) && !isDouyinRedirectMediaUrl(url)
                    ? socialAssetDownload(url, signal, maxBytes, headers, rangeBytes)
                    : socialMediaDownload(url, signal, maxBytes, headers),
                model: mediaModel ?? '',
                limits: {
                  ...DEFAULT_MEDIA_LIMITS,
                  maxVideoSeconds: config.media.maxVideoSeconds,
                  maxLinkVideoSeconds: config.media.maxLinkVideoSeconds,
                  linkWatchMs: config.media.linkWatchMs,
                  linkSegmentSeconds: config.media.linkSegmentSeconds,
                  linkFirstSegmentSeconds: config.media.linkFirstSegmentSeconds,
                  maxLinkSegments: config.media.maxLinkSegments,
                  linkFps: config.media.linkFps
                },
                logger,
                now
              })
            }
          : {}),
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
          fallback: extractionTarget === mainRole?.normal ? fallbackRole?.normal : undefined,
          config,
          breaker,
          storage,
          transport: 'api',
          onCall: (call) => {
            storage.tx((db) =>
              recordModelCall(db, {
                jobId: modelRecordContext.getStore()?.jobId,
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
        redactor,
        logger: logger.child({ module: 'memory' }),
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

    const storageFault = (kind: 'backup_failed' | 'storage_error', error: unknown, recorded = false): void => {
      logger.error(`storage.${kind}`, { error })
      alerter.raise('storage', { failureKind: kind })
      if (!recorded) {
        try {
          storage.tx((db) =>
            recordFailure(db, { stage: 'storage', kind, error, handledBy: 'background' }, redactor, now)
          )
        } catch (recordError) {
          logger.error('storage.failure_record_failed', { error: recordError })
        }
      }
    }
    const stopDiskGuard = started.diskGuard.start(config.storage.checkEveryMin * 60_000, (error) =>
      storageFault('storage_error', error)
    )
    const offsite = createOffsite({ config, env, storage, alerter, logger, now })
    const stopSnapshots = startSnapshotTimer(storage, paths.snapshots, {
      everyMin: config.backup.everyMin,
      keepDays: config.backup.keepDays,
      now,
      redactor,
      onError: (error) => storageFault('backup_failed', error, true),
      onResult: (result) => {
        if (result.state === 'verified') logger.info('storage.snapshot', { file: result.file })
      },
      onVerified: (file) => offsite.ship(file)
    })
    let retentionRunning: Promise<void> | undefined
    const checkRetention = (): Promise<void> => {
      if (retentionRunning) return retentionRunning
      const last = storage.read((db) =>
        db
          .prepare(
            "SELECT ended_at FROM job_run WHERE kind = 'retention' AND outcome = 'ok' ORDER BY ended_at DESC LIMIT 1"
          )
          .pluck()
          .get()
      ) as string | undefined
      if (last && now().getTime() - Date.parse(last) < 86_400_000) return Promise.resolve()
      retentionRunning = (async () => {
        const jobId = randomUUID()
        const runId = storage.tx((db) => startJobRun(db, { kind: 'retention', jobId }, now))
        let outcome = 'failed'
        let counts: Record<string, number> | undefined
        let feedbackExpired = 0
        try {
          feedbackExpired = storage.tx((db) => expireFeedback(db, now().toISOString()))
          const result =
            config.archive.enabled === 'on'
              ? (
                  await archiveAndPrune(storage, {
                    archiveDir: paths.archive,
                    config: config.records,
                    enabled: !started.diskGuard.state().paused.archive,
                    now
                  })
                )?.retention
              : pruneRecords(storage, config.records, { now })
          if (result) {
            counts = result.counts
            // Pruning also writes a success receipt. Keep the attempt opened before work as the single run.
            storage.tx((db) => db.prepare('DELETE FROM job_run WHERE id = ?').run(result.jobRunId))
            outcome = 'ok'
          } else outcome = 'paused'
        } catch (error) {
          logger.error('storage.retention_failed', { jobId, error })
          storage.tx((db) =>
            recordFailure(
              db,
              {
                jobId,
                stage: 'retention',
                kind: 'storage_error',
                error,
                handledBy: 'retention'
              },
              redactor,
              now
            )
          )
        } finally {
          // Normal retention owns answer pruning. A paused or failed archive must not extend private retention.
          if (outcome !== 'ok') {
            const cleared = storage.tx((db) =>
              pruneFeedbackAnswers(
                db,
                new Date(now().getTime() - config.records.feedbackDays * 86_400_000).toISOString()
              )
            )
            counts = { ...counts, feedback_answers: (counts?.['feedback_answers'] ?? 0) + cleared }
          }
          counts = { ...counts, feedback_expired: feedbackExpired }
          storage.tx((db) => endJobRun(db, runId, { outcome, counts }, now))
        }
      })()
        .catch((error: unknown) => storageFault('storage_error', error))
        .finally(() => {
          retentionRunning = undefined
        })
      return retentionRunning
    }
    closers.push(stopDiskGuard, stopSnapshots, offsite.start())
    await checkRetention()
    const retention = setInterval(() => void checkRetention(), 3_600_000)
    retention.unref()
    closers.push(async () => {
      clearInterval(retention)
      await retentionRunning
    })

    // Step 6: report ready. Service readiness is independent of chatbot readiness in standalone mode
    // (docs/trd/system.md#standalone-service-readiness): health reports ready while turns stay refused.
    let serviceReady = true
    let activationCommitted = !modelBoot?.claimed
    const completeStartup = (): void => {
      if (standaloneModels && modelBoot?.claimed && modelBoot.revision && !activationCommitted) {
        standaloneModels.completeActivation(modelBoot.revision)
        activationCommitted = true
      }
    }
    const failStartup = (): void => {
      if (standaloneModels && modelBoot?.claimed && modelBoot.revision && !activationCommitted)
        standaloneModels.failActivation(modelBoot.revision)
    }
    const chatbotReadyNow = (): boolean =>
      serviceReady &&
      (!standalone ||
        (activationCommitted && Boolean(modelBoot?.configured) && standaloneGateway?.status().state === 'connected'))
    const standaloneReadiness = (): StandaloneReadiness => {
      const snapshot = standaloneModels?.snapshot()
      const hermes = standaloneGateway?.status()
      const active = chatbotReadyNow()
      return {
        configuration: snapshot?.configuration ?? 'setup_required',
        chatbot: active ? 'ready' : 'inactive',
        chatbotReason: active
          ? null
          : !activationCommitted
            ? 'pending_activation'
            : modelBoot?.configured
              ? 'hermes_disconnected'
              : snapshot?.configuration === 'invalid'
                ? 'model_config_invalid'
                : 'model_setup_required',
        appliedRevision: snapshot?.appliedRevision ?? null,
        ...(hermes ? { hermes } : {})
      }
    }
    const server = createGatewayServer({
      turns,
      storage,
      logger,
      redactor,
      ready: () => serviceReady,
      chatbotReady: chatbotReadyNow,
      mediaReady: mediaReadyNow,
      installationMode,
      ...(standalone ? { standaloneReadiness } : {}),
      ...(standaloneGateway ? { standaloneGateway } : {}),
      now,
      autofetch,
      afterTurn: refreshUnavailableLine,
      health: () => ({
        snapshot: storage.read((db): Record<string, unknown> | undefined => {
          const newest = db.prepare('SELECT id, state, reason FROM backup_run ORDER BY id DESC LIMIT 1')
          return newest.get() as Record<string, unknown> | undefined
        })
      })
    })

    const siteServer = createSiteApiServer({
      packValidation: { ceiling: config.prompt.maxSystemTokens, harnessRules },
      packPreview: (pack, message, live) =>
        previewPack({
          pack,
          config,
          harnessRules,
          message,
          live,
          runner:
            !standalone || (serviceReady && activationCommitted && Boolean(modelBoot?.configured)) ? runner : undefined
        }),
      extractorAvailable,
      socialMirrors,
      allowedOrigins: config.site.allowedOrigins,
      marketsPath: config.owner.marketsConfig,
      dashboardEntry: standalone ? true : env.AIRA_DASHBOARD_ENTRY === 'dashboard',
      installationMode,
      ...(standaloneModels ? { standaloneModels, standaloneReadiness } : {}),
      ...(options.onActivationRequested ? { onActivationRequested: options.onActivationRequested } : {}),
      ...(standaloneOwnerToken !== undefined ? { standaloneOwnerToken } : {}),
      ...(env.AIRA_OWNER_API_SOCKET ? { ownerApiSocket: env.AIRA_OWNER_API_SOCKET } : {}),
      ...(env.AIRA_OWNER_API_ORIGIN ? { ownerApiOrigin: env.AIRA_OWNER_API_ORIGIN } : {}),
      ...(options.channelDirectoryPath !== undefined ? { channelDirectoryPath: options.channelDirectoryPath } : {}),
      registry,
      packs,
      ...(options.siteDir ? { siteDir: options.siteDir } : {}),
      storage,
      paths,
      version: options.version ?? '0.0.0',
      ready: () => serviceReady,
      activeTurns: () => turns.active(),
      configStatus,
      deploymentSettings: (roles) => deploymentSettings(config, env, configStatus(), roles),
      roles: () => ({
        main: { configured: Boolean(mainRole) || subscription, breakerOpen: breaker.isOpen('main') },
        fallback: {
          configured: Boolean(fallbackRole) || wrapperFallback,
          breakerOpen: subscription ? (fallbackBreaker?.isOpen('main') ?? false) : breaker.isOpen('fallback')
        },
        judge: { configured: Boolean(moodJudge || memoryJudge), breakerOpen: false },
        media: { configured: mediaReadyNow(), breakerOpen: false }
      }),
      logger,
      now,
      onWrite: () => void writeChatFlags(storage, paths.root, packs)
    })

    let closed = false
    return {
      storage,
      paths,
      turns,
      registry,
      installationMode,
      chatbotReady: chatbotReadyNow,
      completeStartup,
      failStartup,
      ...(memory ? { memory } : {}),
      research: worker,
      feedback,
      server,
      siteServer,
      alerter,
      packs,
      configStatus,
      refreshUnavailableLine,
      snapshot: async (reason) => {
        try {
          const result = await takeSnapshot(storage, paths.snapshots, reason, now, { redactor })
          if (result.state === 'failed')
            storageFault('backup_failed', new Error(result.detail ?? 'snapshot failed'), true)
          return result
        } catch (error) {
          storageFault('backup_failed', error, true)
          throw error
        }
      },
      listen: (port, host) =>
        new Promise((resolve, reject) => {
          server.once('error', reject)
          server.listen(port, host, () => resolve(server.address() as AddressInfo))
        }),
      listenSite: (port, host) =>
        new Promise((resolve, reject) => {
          siteServer.once('error', reject)
          siteServer.listen(port, host, () => resolve(siteServer.address() as AddressInfo))
        }),
      async close() {
        if (closed) return
        closed = true
        // Stop admitting turns, let running turns finish, then stop the rest.
        serviceReady = false
        await turns.drain(config.shutdown.graceMs)
        server.closeAllConnections()
        if (server.listening) await new Promise((resolve) => server.close(resolve))
        siteServer.closeAllConnections()
        if (siteServer.listening) await new Promise((resolve) => siteServer.close(resolve))
        for (const stop of closers) await stop()
        storage.close()
      }
    }
  } catch (error) {
    alerter.raise('deploy_health', {})
    for (const stop of closers) await stop()
    storage.close()
    if (standaloneModels && modelBoot?.claimed && modelBoot.revision) {
      standaloneModels.failActivation(modelBoot.revision)
      throw new ConfigError('standalone model activation failed')
    }
    throw error
  }
}
