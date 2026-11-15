import { randomUUID } from 'node:crypto'
import type { PackSet } from '../character/loader.js'
import type { LineKind } from '../character/schema.js'
import type { Config } from '../config/schema.js'
import type { GatewayRequest } from '../gateway/request.js'
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
import { type Chat, ensureChat, ensureSubject } from '../settings/chats.js'
import { type Resolved, resolveSettings } from '../settings/settings.js'
import type { Storage } from '../storage/database.js'
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

export interface TurnReply {
  /** The content for the gateway. Empty means: send nothing. */
  content: string
  turnId?: string
  /** True when the reply came from an earlier request with the same message id. */
  replayed: boolean
}

export interface TurnServiceDeps {
  storage: Storage
  config: Pick<Config, 'turn' | 'llm' | 'records'>
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
  hooks?: TurnHooks
  /** How many window messages a turn reads. */
  maxWindowMessages?: number
  now?: () => Date
  newId?: () => string
}

export interface TurnService {
  handle(request: TurnRequest): Promise<TurnReply>
  /** Stops waiting for more messages, then waits for running turns to finish, up to graceMs. */
  drain(graceMs: number): Promise<void>
  /** How many chats have a turn running or waiting. */
  active(): number
}

interface Waiter {
  mid: string
  senderId: string
  scheduled?: DeliveryKind
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

/** A text the core itself wrote into a scheduled job, so the turn it starts is known to be scheduled. */
const SCHEDULED_TAG =
  /^\[AIRA-SCHEDULED v1 kind=(reminder|proactive|routine)(?: owner=(\S+))?(?: target=(\S+))?[^\]]*\]/

export function parseScheduledTag(text: string): DeliveryKind | undefined {
  const match = SCHEDULED_TAG.exec(text.trimStart())
  if (!match) return undefined
  if (match[1] === 'reminder') return { kind: 'reminder', owner: match[2] ?? '', target: match[3] ?? '-' }
  return { kind: match[1] as 'proactive' | 'routine' }
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
      outcome.calls = run.calls
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
          also: (db) => claimPending(db, chat.chatId, turnId)
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

  function start(queue: ChatQueue): void {
    if (queue.timer) clearTimeout(queue.timer)
    queue.timer = undefined
    queue.firstPendingAt = undefined
    const batch = queue.pending.splice(0)
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

  async function handle(request: TurnRequest): Promise<TurnReply> {
    // Identity comes from code: the scope marker's ids are mapped to internal ids here, once.
    const chat = ensureChat(storage, { waId: request.marker.chat, type: request.marker.kind }, now)
    const senderId = ensureSubject(storage, request.marker.sender, now)
    const key = { chatId: chat.chatId, mid: request.marker.mid, senderId }

    for (let round = 0; round < 3; round++) {
      const status = receiveInbound(
        storage,
        {
          ...key,
          onNew: (db) => {
            // The window is the durable input of a turn. Earlier text the gateway resent is stored only if the
            // core does not hold it already.
            if (request.earlier !== '') {
              const held = unansweredTexts(db, chat.chatId).join('\n\n')
              if (!held.includes(request.earlier)) {
                storeUserMessage(db, { chatId: chat.chatId, senderId, content: request.earlier }, now)
              }
            }
            storeUserMessage(db, { chatId: chat.chatId, senderId, content: request.text, mid: request.marker.mid }, now)
          }
        },
        now
      )
      if (status.status === 'answered') return { content: status.reply, turnId: status.turnId, replayed: true }
      if (status.status === 'dropped') return { content: '', replayed: true }
      if (status.status === 'running') {
        // The same message again while its turn runs: wait for that turn, then read what it stored.
        const current = queues.get(chat.chatId)?.current
        if (!current) throw new Error(`turn ${status.turnId} is marked running but no turn runs in this process`)
        await current
        continue
      }
      return enqueue(chat, { mid: key.mid, senderId, scheduled: parseScheduledTag(request.text) })
    }
    throw new Error('a repeated message did not settle')
  }

  return {
    handle,
    active: () => queues.size,
    drain: async (graceMs) => {
      draining = true
      for (const queue of queues.values()) if (!queue.current && queue.pending.length > 0) start(queue)
      const all = Promise.all([...queues.values()].map((queue) => queue.current))
      await Promise.race([all, new Promise((resolve) => setTimeout(resolve, graceMs).unref())])
    }
  }
}
