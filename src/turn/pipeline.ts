import { randomUUID } from 'node:crypto'
import type { Pack, PackSet } from '../character/loader.js'
import type { LineKind } from '../character/schema.js'
import type { Config } from '../config/schema.js'
import type { Attachment, GatewayRequest } from '../gateway/request.js'
import { compactDue } from '../gateway/schedule.js'
import { type TurnMedia, mediaPromptText, mediaToRead } from '../media/turn-media.js'
import { ModelError } from '../models/types.js'
import type { FailureKind } from '../records/kinds.js'
import type { Logger } from '../records/logger.js'
import type { Redactor } from '../records/redact.js'
import {
  type TurnRecordFields,
  type TurnStage,
  markStage,
  recordFailure,
  recordModelCall,
  saveDiagnostics,
  updateTurnRecord
} from '../records/turn-record.js'
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
import { type Db, type Storage, isoNow } from '../storage/database.js'
import { advanceTurn, closeTurn, openTurn, receiveInbound } from '../storage/turns.js'
import type { Alerter } from './alerts.js'
import { type DeliveryKind, type DeliverySettings, mayDeliver } from './deliver.js'
import type {
  BuiltPrompt,
  CommandRouter,
  ModelCallRecord,
  PromptBuilder,
  ReplyCleaner,
  RunResult,
  ToolOffer,
  TurnContext,
  TurnHooks,
  TurnInput,
  TurnRunner,
  WindowMessage
} from './types.js'
import { claimPending, pendingOf, readWindow, storeUserMessage, unansweredTexts } from './window.js'

// The turn pipeline (docs/trd/system.md#one-turn) and turn admission (docs/trd/reliability.md).
// One turn runs per chat. Messages that arrive close together, or while a turn runs, are answered by one turn.
// Every path ends with a closed turn record and a reply the gateway can deliver, which may be empty.

type TurnRequest = Extract<GatewayRequest, { type: 'turn' }>
type ScheduledRequest = Extract<GatewayRequest, { type: 'scheduled' }>

/** The sender of a gateway job's instruction in the window. Not a member: memory never quotes it. */
const ROUTINE_SENDER = 'routine'
const JOB_WINDOW_MS = 10 * 60_000

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
  config: Pick<Config, 'turn' | 'llm' | 'records'> & { gateway?: Partial<Pick<Config['gateway'], 'jobs' | 'selfIds'>> }
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

/** A message that starts with a slash command, by the parser's own shape. An unknown name runs alone too. */
const COMMAND_TEXT = /^\s*\/[a-z][a-z0-9_-]*(?:\s|$)/i

interface Waiter {
  mid: string
  senderId: string
  scheduled?: DeliveryKind
  /** The text starts with a slash command. Such a message is never merged with another one. */
  command?: boolean
  /** The files the gateway saved for this message. Kept in memory: a restart answers from the text alone. */
  attachments?: Attachment[]
  resolvers: ((reply: TurnReply) => void)[]
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

const LINE_FOR: Record<string, LineKind> = { refusal: 'refusal', malformed: 'fallback', budget: 'limit' }

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
    const delivery: DeliveryKind = newest.scheduled ?? { kind: 'reply' }
    const context: TurnContext = {
      turnId,
      chat,
      senderId: newest.senderId,
      character: pack,
      settings,
      kind: newest.scheduled ? 'scheduled' : 'reply',
      delivery,
      deadline: now().getTime() + config.llm.turnDeadlineMs
    }
    outcome.context = context
    outcome.fields.characterId = pack.id
    const line = (kind: LineKind, failure: FailureKind, error: unknown): Outcome => {
      fail(context.kind === 'command' ? 'command' : 'run', failure, error, `line:${kind}`)
      outcome.state = 'failed'
      outcome.fields.outcome = 'failed'
      outcome.content = pack.lines[kind]
      return outcome
    }

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
    if (deps.hooks?.spendAllows?.() === false) {
      return line('limit', 'budget', new Error('the monthly spend cap is reached'))
    }
    outcome.stamps.push(['admitted', now()])

    // 5. Build: the window, then the prompt.
    stage('build')
    const window = readWindow(
      storage,
      chat.chatId,
      { windowDays: config.records.windowDays, maxMessages: deps.maxWindowMessages ?? 40 },
      now
    )
    // A message that arrived after this turn opened belongs to the next turn, so the window stops before it.
    const pending = pendingOf(window, turnId)
    const lastPending = pending.length > 0 ? window.lastIndexOf(pending[pending.length - 1] as WindowMessage) : -1
    const input: TurnInput = { context, window: lastPending < 0 ? window : window.slice(0, lastPending + 1), pending }
    outcome.fields.windowSize = input.window.length
    outcome.diagnostics = { request: input.pending.map((message) => message.content).join('\n\n') }

    // 4. Command check. A message that starts with a registered command names the tool.
    const text = input.pending[input.pending.length - 1]?.content ?? ''
    const command = deps.commands?.match(text, context)
    let built: BuiltPrompt
    let run: RunResult
    if (command) {
      stage('command')
      context.kind = 'command'
    }

    if (command?.kind === 'direct' && deps.commands) {
      // A direct command: code runs the handler and writes the answer. No model call.
      const result = await deps.commands.runDirect(command, context)
      if (!result.ok) return line('error', 'tool_error', new Error(`the command ${command.name} failed`))
      built = { system: [], messages: [], record: { lengthBypass: 'command_list' }, shape: { lengthBypass: true } }
      run = {
        text: result.text,
        usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
        costUsd: 0,
        model: '',
        role: '',
        transport: '',
        calls: [],
        receipts: result.receipts
      }
      Object.assign(outcome.fields, built.record, { receipts: result.receipts } satisfies TurnRecordFields)
    } else {
      // The files members sent are read before the model runs. A file that cannot be read never ends the turn:
      // the prompt carries a note, and the failure is recorded.
      const files = mediaToRead(batch.map((waiter) => waiter.attachments ?? []))
      if (deps.media && files.length > 0) {
        stage('media')
        const read = await deps.media.read(files, context.deadline)
        input.media = mediaPromptText(read, pack.lines.unreadableMedia)
        outcome.calls.push(...read.calls)
        for (const item of read.unreadable) {
          outcome.failures.push({
            stage: 'media',
            kind: 'media_unreadable',
            error: new Error(`${item.kind}: ${item.reason}`),
            handledBy: 'line:unreadableMedia'
          })
        }
        if (read.calls.some((call) => call.failureKind === 'auth')) deps.alerter.raise('model_auth', { role: 'media' })
      }
      built = await deps.prompt.build(input)
      Object.assign(outcome.fields, built.record)
      outcome.stamps.push(['built', now()])
      if (command && deps.commands) {
        // A skill-style command: the model fills the named tool's arguments from the person's own words.
        context.commandTool = command.tool
        const extra = await deps.commands.contextFor(command, context)
        const last = built.messages[built.messages.length - 1]
        if (extra !== undefined && last?.role === 'user') last.content += `\n\n${extra}`
      }

      // 6. Run: one loop, inside the turn deadline.
      stage('run')
      const abort = new AbortController()
      const timer = setTimeout(() => abort.abort(), Math.max(0, context.deadline - now().getTime()))
      try {
        run = await Promise.race([
          deps.runner.run({
            system: built.system,
            messages: built.messages,
            tools: deps.tools?.offered(context) ?? [],
            context,
            signal: abort.signal,
            firstTool: command?.tool
          }),
          new Promise<never>((_, reject) =>
            abort.signal.addEventListener('abort', () =>
              reject(new ModelError('transient', 'the turn deadline passed'))
            )
          )
        ])
      } catch (error) {
        if (abort.signal.aborted) return line('slow', 'transient', error)
        if (error instanceof ModelError) return line(LINE_FOR[error.kind] ?? 'error', error.kind, error)
        throw error
      } finally {
        clearTimeout(timer)
      }
      outcome.calls.push(...run.calls)
      outcome.stamps.push(['model_done', now()])
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
    outcome.diagnostics.reply = run.text

    // 7. Clean: the cleaning chain, the renderer, the bubbles.
    stage('clean')
    const cleaned = deps.cleaner.clean({ text: run.text, context, built, run })
    Object.assign(outcome.fields, {
      cleaningSteps: cleaned.steps,
      bubbleCount: cleaned.bubbleCount,
      stickerId: cleaned.stickerId,
      attachments: cleaned.attachments
    } satisfies TurnRecordFields)
    outcome.stamps.push(['cleaned', now()])
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
    outcome.state = cleaned.replacedBy ? 'failed' : 'delivered'
    outcome.fields.outcome = cleaned.replacedBy ? 'failed' : 'delivered'
    return outcome
  }

  async function runTurn(chat: Chat, batch: Waiter[]): Promise<void> {
    const turnId = newId()
    const newest = batch[batch.length - 1] as Waiter
    const log = logger.child({ turnId, module: 'turn' })
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
      log.info('turn.received', { chatId: chat.chatId, messages: batch.length })

      let outcome: Outcome = { state: 'failed', fields: {}, failures: [], calls: [], stamps: [] }
      try {
        outcome = await execute(turnId, chat, batch, outcome)
      } catch (error) {
        // An uncaught exception ends the turn with the pack's error line. The process stays up.
        log.error('turn.uncaught', { error })
        outcome.failures.push({ stage: 'internal', kind: 'internal', error, handledBy: 'line:error' })
        outcome.state = 'failed'
        outcome.fields.outcome = 'failed'
        outcome.fields.failureKind = 'internal'
        outcome.content = outcome.context?.character.lines.error
      }

      // 8. Return: store the reply and close the turn record in one transaction. Only then is it sent.
      const content = outcome.state === 'declined' ? undefined : outcome.content
      outcome.fields.replyChars = content?.length ?? 0
      const closed = closeTurn(
        storage,
        {
          turnId,
          state: outcome.state,
          reply: content,
          replyMid: newest.mid,
          also: (db) => {
            for (const [stage, at] of outcome.stamps) markStage(db, turnId, stage, () => at)
            markStage(db, turnId, 'returned', now)
            updateTurnRecord(db, turnId, outcome.fields)
            if (outcome.context?.kind === 'command') {
              db.prepare("UPDATE turn SET kind = 'command' WHERE turn_id = ?").run(turnId)
            }
            for (const call of outcome.calls) {
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
                failureKind: call.failureKind
              })
            }
            for (const failure of outcome.failures) recordFailure(db, { turnId, ...failure }, deps.redactor, now)
            if (outcome.state === 'failed' && outcome.diagnostics) {
              saveDiagnostics(db, { turnId, ...outcome.diagnostics }, now)
            }
            if (outcome.state === 'delivered' && outcome.context) deps.hooks?.onDelivered?.(db, outcome.context)
          }
        },
        now
      )
      if (closed) reply = { content: content ?? '', turnId, replayed: false }
      for (const failure of outcome.failures) {
        log.warn('turn.failure', { stage: failure.stage, kind: failure.kind, error: failure.error })
      }
      log.info('turn.returned', { state: outcome.state, outcome: outcome.fields.outcome, chars: reply.content.length })
    } catch (error) {
      // Storage failed around the turn. Nothing was acknowledged, so nothing is sent.
      log.error('turn.storage_failed', { error })
    }
    // One reply goes out, to the newest message. The messages merged into the turn get nothing.
    for (const waiter of batch) {
      const answer = waiter === newest ? reply : { content: '', turnId, replayed: false }
      for (const resolve of waiter.resolvers) resolve(answer)
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

  function enqueue(chat: Chat, waiter: Omit<Waiter, 'resolvers'>): Promise<TurnReply> {
    let queue = queues.get(chat.chatId)
    if (!queue) {
      queue = { chat, pending: [] }
      queues.set(chat.chatId, queue)
    }
    queue.chat = chat
    const target = queue
    return new Promise((resolve) => {
      const same = target.pending.find((item) => item.mid === waiter.mid)
      if (same) same.resolvers.push(resolve)
      else target.pending.push({ ...waiter, resolvers: [resolve] })
      if (target.current) return
      // Before a turn starts, messages that arrive within batchMs of each other form one turn.
      const at = now().getTime()
      target.firstPendingAt ??= at
      const wait = draining ? 0 : Math.min(config.turn.batchMs, target.firstPendingAt + 3 * config.turn.batchMs - at)
      if (target.timer) clearTimeout(target.timer)
      target.timer = setTimeout(() => start(target), Math.max(0, wait))
    })
  }

  /** True when the text names the character by its display name or an alias, whole word, in any case. */
  function namesCharacter(text: string, pack: Pack): boolean {
    const names = [pack.card.displayName, ...(pack.card.aliases ?? [])]
    return names.some((name) =>
      new RegExp(`(^|[^\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'iu').test(
        text
      )
    )
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
    const selfIds = new Set((config.gateway?.selfIds ?? []).map((id) => id.replace(/@.*$/, '')))
    let mentionsSelf = false
    const text = request.text.replace(/@(\d{6,20})\b/g, (_, number: string) => {
      if (selfIds.has(number)) {
        mentionsSelf = true
        return `@${pack?.card.displayName ?? 'you'}`
      }
      return `@${displayNameOfNumber(storage, number) ?? 'member'}`
    })
    request = { ...request, text }

    // A group message that only names the character is answered only when the chat allows name calls.
    if (
      chat.type === 'group' &&
      selfIds.size > 0 &&
      !mentionsSelf &&
      !request.quote?.ofAira &&
      settings['freeResponse']?.value !== true &&
      settings['nameCall']?.value !== true &&
      !COMMAND_TEXT.test(text) &&
      pack !== undefined &&
      namesCharacter(text, pack)
    ) {
      logger.info('turn.name_call_off', { chatId: chat.chatId })
      return { content: 'NO_REPLY', replayed: true }
    }

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
      COMMAND_TEXT.test(request.text)
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
    command?: boolean
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
        ...(attachments && attachments.length > 0 ? { attachments } : {})
      })
    }
    throw new Error('a repeated message did not settle')
  }

  /** An owner's gateway job, run as a routine turn in the chat the host's list names. */
  async function handleJob(request: Extract<ScheduledRequest, { kind: 'job' }>): Promise<TurnReply | null> {
    const listed = deps.config.gateway?.jobs?.find((job) => job.id === request.jobId)
    const chat = listed ? getChatByWaId(storage, listed.chat) : undefined
    if (!chat || chat.status !== 'active' || request.text === '') return null
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
