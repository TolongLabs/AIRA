import { randomUUID } from 'node:crypto'
import type { PackSet } from '../character/loader.js'
import type { LineKind } from '../character/schema.js'
import type { Config } from '../config/schema.js'
import type { Attachment, GatewayRequest } from '../gateway/request.js'
import { compactDue } from '../gateway/schedule.js'
import { modelRecordContext } from '../judge/systemone.js'
import { linkPhotos } from '../media/link-intake.js'
import { mediaPromptText, mediaToRead, type TurnMedia, type TurnMediaResult } from '../media/turn-media.js'
import { ModelError } from '../models/types.js'
import type { FailureKind } from '../records/kinds.js'
import type { Logger } from '../records/logger.js'
import type { Redactor } from '../records/redact.js'
import {
  markStage,
  recordFailure,
  recordModelCall,
  saveDiagnostics,
  type TurnRecordFields,
  type TurnStage,
  updateTurnRecord
} from '../records/turn-record.js'
import { reportDocumentSchema } from '../render/types.js'
import { offerAnswer, RESEARCH_LINES, type ResearchOffers, type ResearchRow } from '../research/offer.js'
import {
  type Chat,
  displayNameOfNumber,
  ensureChat,
  ensureSubject,
  getChat,
  getChatByWaId,
  setDisplayName
} from '../settings/chats.js'
import { type Resolved, resolveSettings } from '../settings/settings.js'
import { type Db, isoNow, type Storage } from '../storage/database.js'
import { advanceTurn, closeTurn, closeTurnAsFailed, openTurn, receiveInbound } from '../storage/turns.js'
import type { Alerter } from './alerts.js'
import { type DeliveryKind, type DeliverySettings, mayDeliver } from './deliver.js'
import { createTurnSources } from './sources.js'
import type {
  BuiltPrompt,
  CommandRouter,
  ModelCallRecord,
  PromptBuilder,
  ReplyCleaner,
  ReplyTarget,
  RunResult,
  ToolOffer,
  TurnContext,
  TurnHooks,
  TurnInput,
  TurnRunner,
  WindowMessage
} from './types.js'
import { claimPending, pendingOf, quoteChainTexts, readWindow, storeUserMessage, unansweredTexts } from './window.js'

// The turn pipeline (docs/trd/system.md#one-turn) and turn admission (docs/trd/reliability.md).
// One turn runs per chat. Messages that arrive close together, or while a turn runs, are answered by one turn.
// Every path ends with a closed turn record and a reply the gateway can deliver, which may be empty.

type TurnRequest = Extract<GatewayRequest, { type: 'turn' }>
type ScheduledRequest = Extract<GatewayRequest, { type: 'scheduled' }>

/** The sender of a gateway job's instruction in the window. Not a member: memory never quotes it. */
const ROUTINE_SENDER = 'routine'
const JOB_WINDOW_MS = 10 * 60_000

/** Sent after a reply that stepped out of its role: the same thing again, in character (docs/trd/prompt-engine.md). */
const FOURTH_WALL_NOTE =
  'Your last reply stepped out of your role. Say the same thing again as your character, without naming tools, ' +
  'errors or systems.'

type CleanedRun = ReturnType<ReplyCleaner['clean']> & {
  error?: unknown
  warnings?: { kind?: FailureKind; error: unknown; handledBy?: string }[]
}

export interface TurnReply {
  /** The content for the gateway. Empty means: send nothing. */
  content: string
  turnId?: string
  /** True when the reply came from an earlier request with the same message id. */
  replayed: boolean
}

export interface TurnServiceDeps {
  /** Called after a firing changed a reminder, so the wanted-jobs file is written again. */
  onScheduleChange?: () => void
  storage: Storage
  research?: ResearchOffers
  config: Pick<Config, 'turn' | 'llm' | 'records'> & {
    gateway?: Partial<Pick<Config['gateway'], 'jobs' | 'selfIds'>>
    tools?: Partial<Pick<Config['tools'], 'maxCallsPerTurn'>>
  }
  logger: Logger
  redactor: Redactor
  /** The loaded packs. A function, so a saved pack applies to the next turn. */
  packs: () => PackSet
  runner: TurnRunner
  prompt: PromptBuilder
  cleaner: ReplyCleaner
  alerter: Alerter
  tools?: ToolOffer
  commands?: CommandRouter
  /** Reads the files members send, before the model runs (docs/trd/models.md#media-watching). Absent: no media. */
  media?: TurnMedia
  hooks?: TurnHooks
  /** How many window messages a turn reads. */
  maxWindowMessages?: number
  now?: () => Date
  newId?: () => string
}

export interface TurnService {
  handle(request: TurnRequest): Promise<TurnReply>
  /** A firing of the gateway's schedule. Null when its reminder is not active or not due at that time. */
  handleScheduled(request: ScheduledRequest): Promise<TurnReply | null>
  /** Stops waiting for more messages, then waits for running turns to finish, up to graceMs. */
  drain(graceMs: number): Promise<void>
  /** How many chats have a turn running or waiting. */
  active(): number
}

/** A message that holds a slash command anywhere, by the parser's own shape. An unknown name runs alone too. */
const COMMAND_TEXT = /(?:^|[ \t\r\n])\/[a-z][a-z0-9]*(?=$|\s|[.,!?;:](?=\s|$))/i
/** Leading `/think` prefix (docs/trd/models.md#deeper-thinking). First word only, any case. */
const THINK_PREFIX = /^\s*\/think(?:\s+|$)/i

interface Waiter {
  mid: string
  senderId: string
  scheduled?: DeliveryKind
  /** The text starts with a slash command. Such a message is never merged with another one. */
  command?: boolean
  /** True when `/think` stood first and `features.think` is enabled for the chat. */
  think?: boolean
  /** The files the gateway saved for this message. Kept in memory: a restart answers from the text alone. */
  attachments?: Attachment[]
  settlers: { resolve: (reply: TurnReply) => void; reject: (error: unknown) => void }[]
}

interface ChatQueue {
  chat: Chat
  pending: Waiter[]
  timer?: NodeJS.Timeout
  firstPendingAt?: number
  current?: Promise<void>
}

interface Outcome {
  state: 'delivered' | 'declined' | 'failed'
  content?: string
  fields: TurnRecordFields
  failures: { stage: string; kind: FailureKind; error: unknown; handledBy: string }[]
  calls: ModelCallRecord[]
  stamps: [TurnStage, Date][]
  context?: TurnContext
  diagnostics?: { request: string; reply?: string }
  researchDelivery?: { jobId: string; fileId?: string; openOffer: boolean }
}

interface ReminderOfFiring {
  reminder_id: string
  chat_id: string
  owner_id: string
  target_id: string
  text: string
}

/** A firing whose reminder is no longer active, or is due at another time. Nothing of it is stored. */
class NotDue extends Error {}

const REPEAT_STEP: Record<string, (date: Date) => void> = {
  daily: (date) => date.setUTCDate(date.getUTCDate() + 1),
  weekly: (date) => date.setUTCDate(date.getUTCDate() + 7),
  // The same day next month, or that month's last day: 31 January moves to 28 February, not to 3 March.
  monthly: (date) => {
    const day = date.getUTCDate()
    date.setUTCDate(1)
    date.setUTCMonth(date.getUTCMonth() + 1)
    const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate()
    date.setUTCDate(Math.min(day, last))
  }
}

/** The next due time of a repeating reminder after `now`. Missed times are skipped, not sent late. */
export function nextDue(dueAt: string, repeat: string, now: Date): string {
  const step = REPEAT_STEP[repeat]
  if (!step) throw new Error(`unknown repeat rule "${repeat}"`)
  const next = new Date(dueAt)
  do step(next)
  while (next.getTime() <= now.getTime())
  return next.toISOString()
}

function codeRun(text: string, receipts: string[] = []): RunResult {
  return {
    text,
    receipts,
    usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
    costUsd: 0,
    model: '',
    role: '',
    transport: '',
    calls: []
  }
}

const LINE_FOR: Record<string, LineKind> = { refusal: 'refusal', malformed: 'fallback', budget: 'limit' }
const DIRECT_FAILURE: Record<string, FailureKind> = {
  timeout: 'tool_timeout',
  refused: 'tool_refused',
  invalid: 'malformed',
  unavailable: 'transient',
  error: 'tool_error'
}

function deliverySettings(settings: Record<string, Resolved>): DeliverySettings {
  return {
    muted: (settings['muted']?.value ?? false) as DeliverySettings['muted'],
    quietHours: settings['quietHours']?.value as DeliverySettings['quietHours']
  }
}

export function createTurnService(deps: TurnServiceDeps): TurnService {
  const { storage, config, logger } = deps
  const now = deps.now ?? (() => new Date())
  const newId = deps.newId ?? randomUUID
  const queues = new Map<string, ChatQueue>()
  let draining = false

  async function execute(turnId: string, chat: Chat, batch: Waiter[], outcome: Outcome): Promise<Outcome> {
    const newest = batch[batch.length - 1] as Waiter
    const stage = (name: string) => advanceTurn(storage, turnId, name)
    const stamp = (name: TurnStage) => {
      const at = now()
      storage.tx((db) => markStage(db, turnId, name, () => at))
      outcome.stamps.push([name, at])
    }
    const log = logger.child({ turnId, module: 'turn' })
    const fail = (at: string, kind: FailureKind, error: unknown, handledBy: string) => {
      outcome.failures.push({ stage: at, kind, error, handledBy })
      outcome.fields.failureKind = kind
    }
    const decline = (reason: 'declined' | 'muted'): Outcome => {
      outcome.state = 'declined'
      outcome.fields.outcome = reason
      return outcome
    }

    // 2. Resolve: the chat, its settings and its character pack. A broken binding stops the turn.
    stage('resolve')
    const settings = resolveSettings(storage, chat)
    const characterId = settings['character']?.value
    const packs = deps.packs()
    const pack = typeof characterId === 'string' ? packs.packs.get(characterId) : undefined
    if (chat.status !== 'active' || !pack) {
      const why =
        chat.status !== 'active'
          ? 'the chat is pending and not yet switched on'
          : typeof characterId === 'string'
            ? `the chat is bound to character ${characterId}, which is missing or invalid`
            : 'the chat has no character'
      fail('resolve', 'binding_invalid', new Error(why), 'admission')
      deps.alerter.raise('binding_invalid', { chatId: chat.chatId, reason: why })
      outcome.state = 'failed'
      outcome.fields.outcome = 'failed'
      return outcome
    }
    const think = batch.some((waiter) => waiter.think === true) && settings['features.think']?.value !== false
    const delivery: DeliveryKind = newest.scheduled ?? { kind: 'reply' }
    const context: TurnContext = {
      turnId,
      chat,
      senderId: newest.senderId,
      character: pack,
      settings,
      kind: newest.scheduled ? 'scheduled' : 'reply',
      delivery,
      deadline: now().getTime() + config.llm.turnDeadlineMs,
      sources: createTurnSources(),
      ...(think ? { think: true } : {})
    }
    outcome.context = context
    outcome.fields.characterId = pack.id
    const line = (kind: LineKind, failure: FailureKind, error: unknown): Outcome => {
      if (!outcome.calls.some((call) => call.error === error)) {
        fail(context.kind === 'command' ? 'command' : 'run', failure, error, `line:${kind}`)
      }
      outcome.fields.failureKind = failure
      outcome.state = 'failed'
      outcome.fields.outcome = 'failed'
      outcome.content = pack.lines[kind]
      return outcome
    }
    const failDirect = (
      result: { ok: boolean; kind?: string; reason?: string; cause?: unknown },
      fallback: string
    ): Outcome =>
      line(
        'error',
        (result.kind ? DIRECT_FAILURE[result.kind] : undefined) ?? 'tool_error',
        result.cause ?? new Error(result.reason || fallback)
      )

    // 3. Admit: the sender, mute and quiet for a scheduled turn, the spend cap.
    stage('admit')
    const allowed = settings['allowedSenders']?.value
    if (!newest.scheduled && allowed !== 'all' && !(Array.isArray(allowed) && allowed.includes(newest.senderId))) {
      return decline('declined')
    }
    const decision = mayDeliver(deliverySettings(settings), delivery, now())
    if (!decision.allowed) {
      // The stage names the reason, muted or quiet.
      stage(`admit:${decision.reason}`)
      return decline('muted')
    }
    if (delivery.kind !== 'research' && deps.hooks?.spendAllows?.() === false) {
      return line('limit', 'budget', new Error('the monthly spend cap is reached'))
    }
    stamp('admitted')

    // 5. Build: the window, then the prompt.
    stage('build')
    const contextOn = settings['features.context']?.value !== false
    const rawMaxMessages = settings['context.maxMessages']?.value
    const chatMaxMessages =
      typeof rawMaxMessages === 'number' &&
      Number.isInteger(rawMaxMessages) &&
      rawMaxMessages >= 0 &&
      rawMaxMessages <= 100
        ? rawMaxMessages
        : 40
    const maxMessages = deps.maxWindowMessages ?? chatMaxMessages
    const readLimit = !contextOn || maxMessages === 0 ? Math.max(batch.length, 100) : maxMessages
    const window = readWindow(
      storage,
      chat.chatId,
      { windowDays: config.records.windowDays, maxMessages: readLimit },
      now
    )
    // A message that arrived after this turn opened belongs to the next turn, so the window stops before it.
    const pending = pendingOf(window, turnId)
    const lastPending = pending.length > 0 ? window.lastIndexOf(pending[pending.length - 1] as WindowMessage) : -1
    const trimmed = lastPending < 0 ? window : window.slice(0, lastPending + 1)
    const input: TurnInput = { context, window: !contextOn || maxMessages === 0 ? pending : trimmed, pending }
    outcome.fields.windowSize = input.window.length
    outcome.diagnostics = { request: input.pending.map((message) => message.content).join('\n\n') }
    context.messageText = outcome.diagnostics.request
    // One quote-chain snapshot covers both the seen-URL registry (earliest first) and link intake (newest first).
    const quoteTexts = storage.read((db) => quoteChainTexts(db, chat.chatId, turnId))
    const pendingSet = new Set(input.pending)
    for (const message of input.window) {
      if (pendingSet.has(message)) continue
      if (message.quote) context.sources.addText(message.quote.text, 'quote')
      context.sources.addText(message.content, 'message')
    }
    for (const text of [...quoteTexts].reverse()) {
      context.sources.addText(text, 'quote')
    }
    for (const message of input.pending) {
      if (message.quote) context.sources.addText(message.quote.text, 'quote')
      context.sources.addText(message.content, 'message')
    }

    // 4. Command check. Command tokens anywhere in the message name the tools to offer first.
    const text = input.pending[input.pending.length - 1]?.content ?? ''
    const researchRow =
      delivery.kind === 'research'
        ? storage.read(
            (db) =>
              db
                .prepare('SELECT * FROM research_job WHERE job_id = ? AND chat_id = ?')
                .get(delivery.jobId, chat.chatId) as ResearchRow | undefined
          )
        : undefined
    if (researchRow) {
      outcome.researchDelivery = { jobId: researchRow.job_id, openOffer: false }
      if (researchRow.findings)
        context.researchSources = reportDocumentSchema
          .parse(JSON.parse(researchRow.findings))
          .sources.map((source) => source.url)
    }
    let handoverReceipts: string[] = []
    let handover = false
    let handoverText = ''
    // Mechanical offers are checked before command parsing. Other members and sentences never accept them.
    if (!newest.scheduled && deps.research && settings['features.research']?.value !== false) {
      const offer = deps.research.open(chat.chatId, newest.senderId)
      const answer = offerAnswer(text)
      if (offer && answer === 'declined') {
        storage.tx((db) =>
          db
            .prepare(
              "UPDATE research_job SET offer = 'declined', updated_at = ? WHERE job_id = ? AND chat_id = ? AND requester_id = ? AND offer = 'open'"
            )
            .run(isoNow(now), offer.job_id, chat.chatId, newest.senderId)
        )
      } else if (offer && answer === 'accepted' && text.trim().toLowerCase() !== '/pdf' && deps.commands) {
        const command = deps.commands.match('/pdf', context)[0]
        if (command) {
          const result = await deps.commands.runDirect(command, context)
          if (!result.ok) return failDirect(result, 'report_pdf failed')
          handover = result.receipts.length > 0
          handoverReceipts = result.receipts
          handoverText = result.text
          if (!handover) {
            outcome.content = result.text
            outcome.state = 'delivered'
            return outcome
          }
        }
      }
    }
    const commands = researchRow || handover ? [] : (deps.commands?.match(text, context) ?? [])
    let built: BuiltPrompt
    let run: RunResult
    let modelMs = 0
    if (commands.length > 0) {
      stage('command')
      context.kind = 'command'
    }

    const aloneDirect = commands.length === 1 && commands[0]?.kind === 'direct'
    let researchMedia: string | undefined
    if (researchRow && researchRow.state === 'failed') {
      outcome.content = pack.lines.researchFailed ?? RESEARCH_LINES.researchFailed
      outcome.state = 'delivered'
      outcome.fields.outcome = 'delivered'
      outcome.researchDelivery = { jobId: researchRow.job_id, openOffer: false }
      return outcome
    }
    if (researchRow?.wants_pdf && deps.research) {
      try {
        const file = await deps.research.prepare(researchRow, context)
        researchMedia = deps.research.media(file.attachment)
        outcome.researchDelivery = { jobId: researchRow.job_id, fileId: file.fileId, openOffer: false }
      } catch (error) {
        return line('error', 'tool_error', error)
      }
    }
    if (aloneDirect && deps.commands && commands[0]) {
      const command = commands[0]
      // A message with one command, a direct one: code runs the handler and writes the answer. No model call.
      stamp('built')
      const result = await deps.commands.runDirect(command, context)
      stamp('model_done')
      if (!result.ok) return failDirect(result, `the command ${command.name} failed`)
      built = { system: [], messages: [], record: { lengthBypass: 'command_list' }, shape: { lengthBypass: true } }
      run = codeRun(result.text, result.receipts)
      Object.assign(outcome.fields, built.record, { receipts: result.receipts } satisfies TurnRecordFields)
    } else {
      if (think) outcome.fields.think = true
      // The files members sent, and at most one supported link, are read before the model runs. A failure never ends
      // the turn: the prompt carries a note, and the failure is recorded.
      const mediaOn = !researchRow && !handover && settings['features.media']?.value !== false
      const socialOn = !researchRow && !handover && settings['features.social']?.value !== false
      // identify_image may look up only pictures this turn validated, and only while media intake is on.
      const identifyOn = settings['features.identify']?.value === true
      const files = mediaToRead(batch.map((waiter) => waiter.attachments ?? []))
      // Newest message text first, then the texts its quote chains reach in this chat (QUOTE_HOPS at most).
      const linkTexts = [...[...input.pending].reverse().map((message) => message.content), ...quoteTexts].filter(
        (entry) => entry.trim().length > 0
      )
      const shouldReadLinks = deps.media !== undefined && (mediaOn || socialOn) && linkTexts.length > 0

      if (deps.media && (files.length > 0 || shouldReadLinks)) {
        const combined: TurnMediaResult = { readings: [], unreadable: [], calls: [] }
        const mediaStartedAt = now().getTime()
        let enteredMediaStage = false
        const enterMediaStage = () => {
          if (!enteredMediaStage) {
            enteredMediaStage = true
            stage('media')
          }
        }
        if (files.length > 0) {
          enterMediaStage()
          const fileRead = await deps.media.read(files, context.deadline, { enabled: mediaOn, pictures: identifyOn })
          combined.readings.push(...fileRead.readings)
          combined.unreadable.push(...fileRead.unreadable)
          combined.calls.push(...fileRead.calls)
          if (fileRead.pictures) combined.pictures = fileRead.pictures
        }
        if (shouldReadLinks) {
          const linkRead = await deps.media.readLink(
            linkTexts,
            context.deadline,
            { media: mediaOn, social: socialOn },
            enterMediaStage
          )
          combined.readings.push(...linkRead.readings)
          if (linkRead.links && linkRead.links.length > 0) {
            combined.links = [...(combined.links ?? []), ...linkRead.links]
          }
          combined.unreadable.push(...linkRead.unreadable)
          if (linkRead.partial && linkRead.partial.length > 0) {
            combined.partial = [...(combined.partial ?? []), ...linkRead.partial]
          }
          combined.calls.push(...linkRead.calls)
          if (linkRead.tried && linkRead.tried.length > 0)
            combined.tried = [...(combined.tried ?? []), ...linkRead.tried]
        }
        const readLinks = (combined.links ?? []).filter((link) => link.post.platform !== 'youtube' || link.reading)
        context.intakeKinds = [
          ...combined.readings.map((entry) => `media_${entry.kind}`),
          ...readLinks.map((link) =>
            link.post.platform === 'youtube'
              ? 'media_youtube'
              : link.mediaKind
                ? `media_${link.mediaKind}`
                : 'media_post'
          )
        ]
        // A link is closed to read_post and read_page only when intake watched its video or image (owner, 17 Nov).
        // Text alone, or a failed watch, leaves the tools open: they also return the replies and the media.
        context.intakeUrls = readLinks.map((link) => link.post.canonicalUrl).filter((url) => url.length > 0)
        // A share or alias link the reader resolved is closed under both its own address and the post's.
        context.intakeWatchedUrls = [
          ...new Set(
            readLinks
              .filter((link) => link.reading !== undefined)
              .flatMap((link) => [link.post.canonicalUrl, link.post.target.canonicalUrl, link.post.target.originalUrl])
              .filter((url): url is string => typeof url === 'string' && url.length > 0)
          )
        ]
        // Every social address intake opened, watched or not. read_post and read_page refuse one that failed.
        context.intakeTriedSocialUrls = combined.tried ?? []
        for (const link of combined.links ?? []) {
          for (const url of [link.post.canonicalUrl, link.post.target.canonicalUrl]) {
            if (typeof url === 'string') context.sources.add(url, 'intake')
          }
        }
        for (const tried of context.intakeTriedSocialUrls) context.sources.add(tried.url, 'intake')
        // identify_image's pictures, in index order: this turn's valid ones, then intake post photos.
        context.images = [
          ...(combined.pictures ?? []).map((attachment) => ({ kind: 'file' as const, attachment })),
          ...readLinks.flatMap((link) =>
            linkPhotos(link.post).map((photo) => ({ kind: 'url' as const, url: photo.url }))
          )
        ]
        outcome.fields.mediaMs = Math.max(0, now().getTime() - mediaStartedAt)
        const promptText = mediaPromptText(combined, pack.lines.unreadableMedia)
        if (promptText.length > 0) input.media = promptText
        outcome.calls.push(...combined.calls)
        for (const item of combined.unreadable) {
          outcome.failures.push({
            stage: 'media',
            kind: 'media_unreadable',
            error: item.error ?? new Error(`${item.kind}: ${item.reason}`),
            handledBy: 'line:unreadableMedia'
          })
        }
        for (const item of combined.partial ?? []) {
          outcome.failures.push({
            stage: 'media',
            kind: 'media_unreadable',
            error: new Error(`${item.kind}: ${item.reason}`),
            handledBy: 'coverage:partial'
          })
        }
        if (combined.calls.some((call) => call.failureKind === 'auth')) {
          deps.alerter.raise('model_auth', { role: 'media' })
        }
      }
      built = await deps.prompt.build(input)
      if (researchRow) {
        built.shape = { ...(typeof built.shape === 'object' ? built.shape : {}), maxChars: 1400, lengthBypass: false }
        built.record.lengthBypass = 'research'
        const shape = built.system.find((block) => block.name === 'shape')
        if (shape)
          shape.text = 'Give a brief research summary: the answer and 3 to 5 key points, at most 1400 characters.'
      }
      if (handover) {
        built.shape = { maxChars: 280, lengthBypass: false }
        const shape = built.system.find((block) => block.name === 'shape')
        if (shape) shape.text = 'Give only a one-line hand-over for the attached PDF report.'
      }
      Object.assign(outcome.fields, built.record)
      stamp('built')
      if (commands.length > 0 && deps.commands) {
        // Commands in a model turn: the model fills each named tool's arguments from the person's own words.
        context.commandTool = commands[0]?.tool
        const last = built.messages[built.messages.length - 1]
        for (const command of commands) {
          const extra = await deps.commands.contextFor(command, context)
          if (extra !== undefined && last?.role === 'user') last.content += `\n\n${extra}`
        }
      }

      // 6. Run: one loop, inside the turn deadline.
      stage('run')
      const rawMaxTools = settings['tools.maxPerMessage']?.value
      const chatMaxTools =
        typeof rawMaxTools === 'number' && Number.isInteger(rawMaxTools) && rawMaxTools >= 1 ? rawMaxTools : 3
      const ceiling = config.tools?.maxCallsPerTurn
      const maxToolCalls = Math.max(
        ceiling === undefined ? chatMaxTools : Math.min(chatMaxTools, ceiling),
        commands.length
      )
      const abort = new AbortController()
      const timer = setTimeout(() => abort.abort(), Math.max(0, context.deadline - now().getTime()))
      const runStartedAt = now().getTime()
      try {
        if (researchRow?.findings && deps.hooks?.spendAllows?.() === false) {
          const findings = reportDocumentSchema.parse(JSON.parse(researchRow.findings))
          run = codeRun([findings.summary, ...findings.keyFindings.map((finding) => `- ${finding.text}`)].join('\n'))
        } else
          run = await Promise.race([
            deps.runner.run({
              system: built.system,
              messages: built.messages,
              tools: researchRow || handover ? [] : (deps.tools?.offered(context) ?? []),
              context,
              signal: abort.signal,
              firstTools: commands.length > 0 ? commands.map((command) => command.tool) : undefined,
              maxToolCalls,
              onCall: (call) => {
                outcome.calls.push(call)
                Object.assign(outcome.fields, {
                  transport: call.transport,
                  role: call.role,
                  model: call.model,
                  attempts: outcome.calls.filter((entry) => entry.role !== 'media').length
                })
              },
              onSpendError: (error) => {
                log.warn('model.spend_failed', { kind: 'storage_error' })
                outcome.failures.push({ stage: 'run', kind: 'storage_error', error, handledBy: 'reply' })
              }
            }),
            new Promise<never>((_, reject) =>
              abort.signal.addEventListener('abort', () =>
                reject(new ModelError('transient', 'the turn deadline passed'))
              )
            )
          ])
      } catch (error) {
        if (handover) {
          run = codeRun(handoverText)
          fail('run', 'transient', error, 'pdf_handover')
        } else {
          if (abort.signal.aborted) return line('slow', 'transient', error)
          if (error instanceof ModelError) return line(LINE_FOR[error.kind] ?? 'error', error.kind, error)
          throw error
        }
      } finally {
        clearTimeout(timer)
        stamp('model_done')
        modelMs = now().getTime() - runStartedAt
      }
      // Older runner seams may only return calls; the callback owns calls from current runners.
      for (const call of run.calls) if (!outcome.calls.includes(call)) outcome.calls.push(call)
      Object.assign(outcome.fields, {
        transport: run.transport,
        role: run.role,
        model: run.model,
        attempts: run.calls.length,
        inputTokens: run.usage.inputTokens,
        outputTokens: run.usage.outputTokens,
        cachedTokens: run.usage.cachedTokens,
        costUsd: run.costUsd,
        receipts: run.receipts,
        chainLimit: run.chainLimit
      } satisfies TurnRecordFields)
    }
    run.receipts.push(...handoverReceipts)
    outcome.diagnostics.reply = run.text

    // 7. Clean: the cleaning chain, the renderer, the bubbles.
    stage('clean')
    const cleanRun = (reply: RunResult): CleanedRun => {
      try {
        return deps.cleaner.clean({ text: reply.text, context, built, run: reply })
      } catch (error) {
        return { content: '', bubbleCount: 0, steps: [], error }
      }
    }
    // A reply that steps out of its role gets one regeneration, with no tools, on the route that gave it. It runs only
    // when the deadline leaves time for a call as long as the last model call; the same prompt answers.
    const regenerateInRole = async (first: RunResult): Promise<RunResult | undefined> => {
      const successful = first.calls.filter((call) => call.error === undefined)
      const last = successful[successful.length - 1]
      const replyTarget: ReplyTarget | undefined = last
        ? { transport: last.transport, role: last.role, model: last.model }
        : undefined
      const remaining = context.deadline - now().getTime()
      // A run with tools can hold several calls, so one call's own time is the estimate for another.
      const estimate = last?.durationMs ?? modelMs
      if (!replyTarget || remaining <= 0 || remaining < estimate) return undefined
      const abort = new AbortController()
      const timer = setTimeout(() => abort.abort(), Math.max(0, remaining))
      try {
        return await Promise.race([
          deps.runner.run({
            system: built.system,
            messages: [
              ...built.messages,
              { role: 'assistant', content: first.text },
              { role: 'user', content: FOURTH_WALL_NOTE }
            ],
            tools: [],
            replyTarget,
            context,
            signal: abort.signal,
            maxToolCalls: 0,
            onCall: (call) => {
              outcome.calls.push(call)
            },
            onSpendError: (error) => {
              log.warn('model.spend_failed', { kind: 'storage_error' })
              outcome.failures.push({ stage: 'run', kind: 'storage_error', error, handledBy: 'reply' })
            }
          }),
          new Promise<never>((_, reject) =>
            abort.signal.addEventListener('abort', () =>
              reject(new ModelError('transient', 'the turn deadline passed'))
            )
          )
        ])
      } catch {
        return undefined
      } finally {
        clearTimeout(timer)
      }
    }
    let cleaned = cleanRun(run)
    if (cleaned.fourthWall !== undefined) {
      // The flagged reply stays out of the diagnostics: the pattern's name is all the failure keeps.
      if (outcome.diagnostics) delete outcome.diagnostics.reply
      const firstSteps = cleaned.steps
      const why = new Error(cleaned.fourthWall)
      const again = await regenerateInRole(run)
      const second = again ? cleanRun(again) : undefined
      // A regeneration call counts as an attempt, whether or not it answered. Runners that report calls through
      // onCall add them already; the others are added here.
      if (again) for (const call of again.calls) if (!outcome.calls.includes(call)) outcome.calls.push(call)
      Object.assign(outcome.fields, { attempts: outcome.calls.filter((call) => call.role !== 'media').length })
      if (again) {
        // The regenerated call's tokens and cost count even when its reply is flagged and the pack line is sent.
        Object.assign(outcome.fields, {
          inputTokens: (outcome.fields.inputTokens ?? run.usage.inputTokens) + again.usage.inputTokens,
          outputTokens: (outcome.fields.outputTokens ?? run.usage.outputTokens) + again.usage.outputTokens,
          cachedTokens: (outcome.fields.cachedTokens ?? run.usage.cachedTokens) + again.usage.cachedTokens,
          costUsd: (outcome.fields.costUsd ?? run.costUsd) + again.costUsd
        } satisfies TurnRecordFields)
      }
      if (!again || !second || second.fourthWall !== undefined || second.error !== undefined) {
        fail('clean', 'persona_leak', why, 'line:error')
        Object.assign(outcome.fields, { cleaningSteps: firstSteps } satisfies TurnRecordFields)
        stamp('cleaned')
        outcome.state = 'failed'
        outcome.fields.outcome = 'failed'
        outcome.content = pack.lines.error
        return outcome
      }
      fail('clean', 'persona_leak', why, 'regenerate')
      cleaned = { ...second, steps: [...firstSteps, ...second.steps] }
    }
    Object.assign(outcome.fields, {
      cleaningSteps: cleaned.steps,
      bubbleCount: cleaned.bubbleCount,
      stickerId: cleaned.stickerId,
      attachments: cleaned.attachments
    } satisfies TurnRecordFields)
    stamp('cleaned')
    if (cleaned.warnings) {
      for (const warning of cleaned.warnings) {
        outcome.failures.push({
          stage: 'clean',
          kind: warning.kind ?? 'storage_error',
          error: warning.error,
          handledBy: warning.handledBy ?? 'clean'
        })
      }
    }
    if (cleaned.error !== undefined) {
      fail('clean', 'internal', cleaned.error, 'line:error')
      outcome.state = 'failed'
      outcome.fields.outcome = 'failed'
      outcome.content = pack.lines.error
      return outcome
    }
    if (cleaned.content.trim() === '')
      return line('fallback', 'malformed', new Error('the reply was empty after cleaning'))
    if (cleaned.replacedBy)
      fail('clean', 'malformed', new Error(`the reply was replaced by the ${cleaned.replacedBy} line`), 'clean')

    // A mute can arrive while a scheduled turn runs, so the rule is asked again just before the return.
    if (
      context.kind === 'scheduled' &&
      !mayDeliver(deliverySettings(resolveSettings(storage, chat)), delivery, now()).allowed
    ) {
      return decline('muted')
    }

    log.debug('turn.cleaned', { bubbles: cleaned.bubbleCount, steps: cleaned.steps })
    outcome.content = cleaned.content
    if (researchRow && !cleaned.replacedBy) {
      if (!researchRow.wants_pdf) {
        const mediaAt = outcome.content.indexOf('\nMEDIA:')
        const at = mediaAt < 0 ? outcome.content.length : mediaAt
        outcome.content =
          outcome.content.slice(0, at) +
          `\n\n${pack.lines.offerPdf ?? RESEARCH_LINES.offerPdf}` +
          outcome.content.slice(at)
        outcome.researchDelivery = { jobId: researchRow.job_id, openOffer: true }
      } else if (researchMedia) {
        outcome.content += `\n${researchMedia}`
        outcome.fields.attachments = [...(cleaned.attachments ?? []), researchMedia.slice(6)]
      }
    }
    outcome.state = cleaned.replacedBy ? 'failed' : 'delivered'
    outcome.fields.outcome = cleaned.replacedBy ? 'failed' : 'delivered'
    return outcome
  }

  async function runTurn(chat: Chat, batch: Waiter[]): Promise<void> {
    const turnId = newId()
    const newest = batch[batch.length - 1] as Waiter
    const log = logger.child({ turnId, module: 'turn' })
    const defaultErrorLine = (): string | undefined => {
      try {
        const raw = storage.read((db) =>
          db.prepare("SELECT value FROM setting WHERE level = 'global' AND key = 'character'").pluck().get()
        )
        if (typeof raw !== 'string') return undefined
        const characterId: unknown = JSON.parse(raw)
        if (typeof characterId !== 'string') return undefined
        return deps.packs().packs.get(characterId)?.lines.error
      } catch {
        return undefined
      }
    }
    let opened = false
    let outcome: Outcome | undefined
    let shouldReject = false
    let rejectError: unknown
    let reply: TurnReply = { content: '', turnId, replayed: false }
    try {
      // 1. Receive: the opening turn record.
      openTurn(
        storage,
        {
          turnId,
          chatId: chat.chatId,
          senderId: newest.senderId,
          kind: newest.scheduled ? 'scheduled' : 'reply',
          mids: batch.map((waiter) => waiter.mid),
          also: (db) => claimPending(db, chat.chatId, turnId, newest.mid)
        },
        now
      )
      opened = true
      log.info('turn.received', { messages: batch.length })

      const timing = storage.read(
        (db) =>
          db
            .prepare(
              `SELECT t.received_at, MIN(i.received_at) AS arrived_at FROM turn t
         LEFT JOIN inbound_message i ON i.turn_id = t.turn_id WHERE t.turn_id = ?`
            )
            .get(turnId) as { received_at: string; arrived_at: string | null }
      )
      const arrivedAt = timing.arrived_at ?? timing.received_at
      let currentOutcome: Outcome = {
        state: 'failed',
        fields: {
          arrivedAt,
          queueMs: Math.max(0, Date.parse(timing.received_at) - Date.parse(arrivedAt)),
          mediaMs: 0
        },
        failures: [],
        calls: [],
        stamps: []
      }
      outcome = currentOutcome
      try {
        currentOutcome = await modelRecordContext.run({ turnId }, () => execute(turnId, chat, batch, currentOutcome))
        outcome = currentOutcome
      } catch (error) {
        // An uncaught exception ends the turn with the pack's error line. The process stays up.
        log.error('turn.uncaught', { error })
        const fallbackLine = currentOutcome.context?.character.lines.error ?? defaultErrorLine()
        currentOutcome.failures.push({
          stage: 'internal',
          kind: 'internal',
          error,
          handledBy: fallbackLine === undefined ? 'unavailable' : 'line:error'
        })
        currentOutcome.state = 'failed'
        currentOutcome.fields.outcome = 'failed'
        currentOutcome.fields.failureKind = 'internal'
        currentOutcome.content = fallbackLine
        if (fallbackLine === undefined) {
          shouldReject = true
          rejectError = error
        }
      }

      // 8. Return: store the reply and close the turn record in one transaction. Only then is it sent.
      const content = currentOutcome.state === 'declined' ? undefined : currentOutcome.content
      currentOutcome.fields.replyChars = content?.length ?? 0
      const returnedAt = now()
      currentOutcome.fields.totalMs = Math.max(0, returnedAt.getTime() - Date.parse(arrivedAt))
      currentOutcome.fields.toolMs = storage.read((db) =>
        Number(db.prepare('SELECT COALESCE(SUM(duration_ms), 0) FROM tool_call WHERE turn_id = ?').pluck().get(turnId))
      )
      const modelCalls = currentOutcome.calls.filter((call) => call.role !== 'media')
      for (const [index, call] of modelCalls.entries()) {
        if (!call.failureKind) continue
        const next = modelCalls[index + 1]
        currentOutcome.failures.push({
          stage: 'run',
          kind: call.failureKind,
          error: call.error ?? new Error(call.failureKind),
          handledBy: next
            ? next.role === call.role && next.transport === call.transport
              ? 'retry'
              : 'fallback'
            : `line:${LINE_FOR[call.failureKind] ?? (currentOutcome.fields.outcome === 'failed' ? 'error' : 'fallback')}`
        })
      }
      const writeTurnClose = (db: Db) => {
        for (const [stage, at] of currentOutcome.stamps) markStage(db, turnId, stage, () => at)
        markStage(db, turnId, 'returned', () => returnedAt)
        updateTurnRecord(db, turnId, currentOutcome.fields)
        if (currentOutcome.context?.kind === 'command') {
          db.prepare("UPDATE turn SET kind = 'command' WHERE turn_id = ?").run(turnId)
        }
        for (const call of currentOutcome.calls) {
          recordModelCall(db, {
            turnId,
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
            failureKind: call.failureKind,
            effort: call.effort
          })
        }
        for (const failure of currentOutcome.failures) recordFailure(db, { turnId, ...failure }, deps.redactor, now)
        if (currentOutcome.state === 'failed' && currentOutcome.diagnostics) {
          saveDiagnostics(db, { turnId, ...currentOutcome.diagnostics }, now)
        }
        if (currentOutcome.state !== 'declined' && currentOutcome.content && currentOutcome.researchDelivery) {
          const delivered = currentOutcome.researchDelivery
          db.prepare(
            `UPDATE research_job SET delivered_at = ?, report_file_id = coalesce(?, report_file_id),
            offer = ?, offer_expires_at = ?, updated_at = ? WHERE job_id = ? AND chat_id = ? AND delivered_at IS NULL`
          ).run(
            isoNow(now),
            delivered.fileId ?? null,
            delivered.openOffer ? 'open' : 'none',
            delivered.openOffer
              ? new Date(now().getTime() + (deps.research?.offerMinutes ?? 30) * 60000).toISOString()
              : null,
            isoNow(now),
            delivered.jobId,
            chat.chatId
          )
        }
        if (currentOutcome.state === 'delivered' && currentOutcome.context) {
          deps.hooks?.onDelivered?.(db, currentOutcome.context)
        }
      }
      const closed = shouldReject
        ? closeTurnAsFailed(storage, { turnId, closeInbound: false, also: writeTurnClose }, now)
        : closeTurn(
            storage,
            {
              turnId,
              state: currentOutcome.state,
              reply: content,
              replyMid: newest.mid,
              also: writeTurnClose
            },
            now
          )
      if (!shouldReject) {
        if (closed && currentOutcome.researchDelivery) deps.onScheduleChange?.()
        if (closed) reply = { content: content ?? '', turnId, replayed: false }
      }
      for (const failure of currentOutcome.failures) {
        log.warn('turn.failure', { stage: failure.stage, kind: failure.kind, error: failure.error })
      }
      log.info('turn.returned', {
        state: currentOutcome.state,
        outcome: currentOutcome.fields.outcome,
        chars: reply.content.length,
        arrivedAt,
        queueMs: currentOutcome.fields.queueMs,
        mediaMs: currentOutcome.fields.mediaMs,
        toolMs: currentOutcome.fields.toolMs,
        totalMs: currentOutcome.fields.totalMs
      })
    } catch (error) {
      // Storage failed around the turn. Run one small transaction to record it; if that fails too, reject so the gateway retries.
      log.error('turn.storage_failed', { error })
      const intentionalEmpty = outcome?.state === 'declined' || outcome?.fields.failureKind === 'binding_invalid'
      const fallbackLine = intentionalEmpty
        ? undefined
        : (outcome?.context?.character.lines.error ?? defaultErrorLine())
      if (!opened || (!intentionalEmpty && fallbackLine === undefined)) {
        shouldReject = true
        rejectError = error
      }
      if (opened) {
        try {
          const closed = closeTurnAsFailed(
            storage,
            {
              turnId,
              reply: fallbackLine,
              replyMid: newest.mid,
              closeInbound: !shouldReject,
              also: (db, stage) => {
                updateTurnRecord(db, turnId, { outcome: 'failed', failureKind: 'storage_error' })
                recordFailure(
                  db,
                  {
                    turnId,
                    stage,
                    kind: 'storage_error',
                    error,
                    handledBy: shouldReject ? 'unavailable' : intentionalEmpty ? 'no_reply' : 'line:error'
                  },
                  deps.redactor,
                  now
                )
              }
            },
            now
          )
          if (!closed) {
            shouldReject = true
            rejectError = error
          } else if (!shouldReject) {
            reply = { content: fallbackLine ?? '', turnId, replayed: false }
          }
        } catch (fallbackError) {
          log.error('turn.storage_fallback_failed', { error: fallbackError })
          shouldReject = true
          rejectError = fallbackError
        }
      }
    }
    if (shouldReject) {
      for (const waiter of batch) {
        for (const settler of waiter.settlers) settler.reject(rejectError)
      }
      return
    }
    // One reply goes out, to the newest message. The messages merged into the turn get nothing.
    for (const waiter of batch) {
      const answer = waiter === newest ? reply : { content: '', turnId, replayed: false }
      for (const settler of waiter.settlers) settler.resolve(answer)
    }
  }

  /**
   * How many pending messages the next turn answers: a command alone, else the messages before the next command.
   * One merged turn answers only its newest message, so a command merged with others would be lost.
   */
  function batchLength(pending: Waiter[]): number {
    if (pending[0]?.command) return 1
    const next = pending.findIndex((waiter) => waiter.command)
    return next === -1 ? pending.length : next
  }

  function start(queue: ChatQueue): void {
    if (queue.timer) clearTimeout(queue.timer)
    queue.timer = undefined
    queue.firstPendingAt = undefined
    const batch = queue.pending.splice(0, batchLength(queue.pending))
    queue.current = runTurn(queue.chat, batch).finally(() => {
      queue.current = undefined
      // Messages that arrived while the turn ran have waited already: the next turn starts at once.
      if (queue.pending.length > 0) start(queue)
      else queues.delete(queue.chat.chatId)
    })
  }

  function enqueue(chat: Chat, waiter: Omit<Waiter, 'settlers'>): Promise<TurnReply> {
    let queue = queues.get(chat.chatId)
    if (!queue) {
      queue = { chat, pending: [] }
      queues.set(chat.chatId, queue)
    }
    queue.chat = chat
    const target = queue
    return new Promise((resolve, reject) => {
      const same = target.pending.find((item) => item.mid === waiter.mid)
      if (same) same.settlers.push({ resolve, reject })
      else target.pending.push({ ...waiter, settlers: [{ resolve, reject }] })
      if (target.current) return
      // Before a turn starts, messages that arrive within batchMs of each other form one turn.
      const at = now().getTime()
      target.firstPendingAt ??= at
      const wait = draining ? 0 : Math.min(config.turn.batchMs, target.firstPendingAt + 3 * config.turn.batchMs - at)
      if (target.timer) clearTimeout(target.timer)
      target.timer = setTimeout(() => start(target), Math.max(0, wait))
    })
  }

  async function handle(incoming: TurnRequest): Promise<TurnReply> {
    let request = incoming
    // Identity comes from code: the scope marker's ids are mapped to internal ids here, once.
    const chat = ensureChat(storage, { waId: request.marker.chat, type: request.marker.kind }, now)
    const senderId = ensureSubject(storage, request.marker.sender, now)
    if (request.senderName) setDisplayName(storage, request.marker.sender, request.senderName)
    const key = { chatId: chat.chatId, mid: request.marker.mid, senderId }

    // A WhatsApp id never reaches the window, the model or a reply: a mention becomes a name.
    const settings = resolveSettings(storage, chat)
    const characterId = settings['character']?.value
    const pack = typeof characterId === 'string' ? deps.packs().packs.get(characterId) : undefined
    const thinkPrefix = THINK_PREFIX.exec(request.text)
    const strippedText = thinkPrefix ? request.text.slice(thinkPrefix[0].length) : request.text
    const selfIds = new Set((config.gateway?.selfIds ?? []).map((id) => id.replace(/@.*$/, '')))
    let _mentionsSelf = false
    const text = strippedText.replace(/@(\d{6,20})\b/g, (_, number: string) => {
      if (selfIds.has(number)) {
        _mentionsSelf = true
        return `@${pack?.card.displayName ?? 'you'}`
      }
      return `@${displayNameOfNumber(storage, number) ?? 'member'}`
    })
    request = { ...request, text }

    // The gateway decides which group messages reach the core: a mention, a reply, a command, free response, or one
    // of the chat's names while name call is on. It removes the bot's own mention from the text, so the core cannot
    // tell a mention from a name and does not try (docs/trd/system.md, Name call).

    return admit(
      chat,
      key,
      undefined,
      (db) => {
        // The window is the durable input of a turn. Earlier text the gateway resent is stored only if the
        // core does not hold it already.
        if (request.earlier !== '') {
          const held = unansweredTexts(db, chat.chatId).join('\n\n')
          if (!held.includes(request.earlier)) {
            storeUserMessage(db, { chatId: chat.chatId, senderId, content: request.earlier }, now)
          }
        }
        storeUserMessage(
          db,
          {
            chatId: chat.chatId,
            senderId,
            content: request.text,
            mid: request.marker.mid,
            ...(request.quote ? { quote: request.quote } : {})
          },
          now
        )
      },
      undefined,
      request.attachments,
      COMMAND_TEXT.test(request.text) || offerAnswer(request.text) !== undefined,
      thinkPrefix !== null && settings['features.think']?.value !== false
    )
  }

  /**
   * Writes the inbound row, or settles a request seen before: its stored reply, or the turn it waits for. A new
   * request runs `onNew` in the same transaction, then joins the chat's queue.
   */
  async function admit(
    chat: Chat,
    key: { chatId: string; mid: string; senderId: string },
    scheduled: DeliveryKind | undefined,
    onNew: (db: Db) => void,
    afterNew?: () => void,
    attachments?: Attachment[],
    command?: boolean,
    think?: boolean
  ): Promise<TurnReply> {
    for (let round = 0; round < 3; round++) {
      const status = receiveInbound(storage, { ...key, onNew }, now)
      if (status.status === 'answered') return { content: status.reply, turnId: status.turnId, replayed: true }
      if (status.status === 'dropped') return { content: '', replayed: true }
      if (status.status === 'running') {
        // The same message again while its turn runs: wait for that turn, then read what it stored.
        const current = queues.get(chat.chatId)?.current
        if (!current) throw new Error(`turn ${status.turnId} is marked running but no turn runs in this process`)
        await current
        continue
      }
      afterNew?.()
      return enqueue(chat, {
        mid: key.mid,
        senderId: key.senderId,
        ...(scheduled ? { scheduled } : {}),
        ...(command ? { command } : {}),
        ...(think ? { think } : {}),
        ...(attachments && attachments.length > 0 ? { attachments } : {})
      })
    }
    throw new Error('a repeated message did not settle')
  }

  /** An owner's gateway job, run as a routine turn in the chat the host's list names. */
  async function handleJob(request: Extract<ScheduledRequest, { kind: 'job' }>): Promise<TurnReply | null> {
    const listed = deps.config.gateway?.jobs?.find((job) => job.id === request.jobId)
    const chat = listed ? getChatByWaId(storage, listed.chat) : undefined
    if (chat?.status !== 'active' || request.text === '') return null
    // One firing per 10-minute window: the gateway's repeats of a firing are answered from the stored reply.
    const window = Math.floor(now().getTime() / JOB_WINDOW_MS)
    const mid = `job-${request.jobId}-${window}`
    const tag = `[AIRA-SCHEDULED v1 kind=job id=${request.jobId}]`
    return await admit(chat, { chatId: chat.chatId, mid, senderId: ROUTINE_SENDER }, { kind: 'routine' }, (db) => {
      storeUserMessage(
        db,
        { chatId: chat.chatId, senderId: ROUTINE_SENDER, content: `${tag}\n${request.text}`, mid },
        now
      )
    })
  }

  async function handleScheduled(request: ScheduledRequest): Promise<TurnReply | null> {
    if (request.kind === 'job') return handleJob(request)
    if (request.kind === 'research') {
      const row = storage.read(
        (db) =>
          db
            .prepare("SELECT * FROM research_job WHERE job_id = ? AND state IN ('done', 'failed')")
            .get(request.jobId) as ResearchRow | undefined
      )
      const chat = row ? getChat(storage, row.chat_id) : undefined
      if (!row || !chat || !deps.research) return null
      const mid = `research-${row.job_id}`
      return admit(
        chat,
        { chatId: chat.chatId, senderId: row.requester_id, mid },
        { kind: 'research', jobId: row.job_id, owner: row.requester_id },
        (db) => {
          if (row.delivered_at) throw new NotDue()
          const findings = row.findings ? reportDocumentSchema.parse(JSON.parse(row.findings)) : undefined
          const body = JSON.stringify(findings ?? {}).replace(/<\/?research_findings[^>]*>/gi, '')
          storeUserMessage(
            db,
            {
              chatId: chat.chatId,
              senderId: ROUTINE_SENDER,
              content: `<research_findings untrusted="true">${body}</research_findings>`,
              mid
            },
            now
          )
        },
        undefined,
        undefined,
        true
      )
    }
    // Identity comes from the core's own reminder row. The request names a reminder and a due time, nothing else.
    const row = storage.read(
      (db) =>
        db
          .prepare('SELECT reminder_id, chat_id, owner_id, target_id, text FROM reminder WHERE reminder_id = ?')
          .get(request.reminderId) as ReminderOfFiring | undefined
    )
    const chat = row ? getChat(storage, row.chat_id) : undefined
    if (!row || !chat) return null
    const mid = `sched-${row.reminder_id}-${request.due}`
    const tag = `[AIRA-SCHEDULED v1 kind=reminder owner=${row.owner_id} target=${row.target_id} id=${row.reminder_id}]`
    try {
      return await admit(
        chat,
        { chatId: chat.chatId, mid, senderId: row.owner_id },
        { kind: 'reminder', owner: row.owner_id, target: row.target_id },
        (db) => {
          // The firing is used up in the transaction that stores it: a repeat of this request is answered from it.
          const current = db
            .prepare("SELECT due_at, repeat FROM reminder WHERE reminder_id = ? AND chat_id = ? AND state = 'active'")
            .get(row.reminder_id, chat.chatId) as { due_at: string; repeat: string | null } | undefined
          if (!current || compactDue(current.due_at) !== request.due) throw new NotDue()
          if (current.repeat) {
            db.prepare('UPDATE reminder SET due_at = ?, updated_at = ? WHERE reminder_id = ?').run(
              nextDue(current.due_at, current.repeat, now()),
              isoNow(now),
              row.reminder_id
            )
          } else {
            db.prepare("UPDATE reminder SET state = 'fired', updated_at = ? WHERE reminder_id = ?").run(
              isoNow(now),
              row.reminder_id
            )
          }
          storeUserMessage(
            db,
            { chatId: chat.chatId, senderId: row.owner_id, content: `${tag}\n${row.text}`, mid },
            now
          )
        },
        () => deps.onScheduleChange?.()
      )
    } catch (error) {
      if (error instanceof NotDue) return null
      throw error
    }
  }

  return {
    handle,
    handleScheduled,
    active: () => queues.size,
    drain: async (graceMs) => {
      draining = true
      for (const queue of queues.values()) if (!queue.current && queue.pending.length > 0) start(queue)
      const all = Promise.all([...queues.values()].map((queue) => queue.current))
      await Promise.race([all, new Promise((resolve) => setTimeout(resolve, graceMs).unref())])
    }
  }
}
