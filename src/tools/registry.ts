import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import type { Logger } from '../records/logger.js'
import type { Redactor } from '../records/redact.js'
import { recordFailure, recordToolCall } from '../records/turn-record.js'
import { type Db, type Storage, isoNow } from '../storage/database.js'
import type { OfferedTool, TurnContext } from '../turn/types.js'
import type { Receipt, ReceiptDraft, ToolContext, ToolDefinition, ToolResult } from './types.js'

const TOOL_NAME = /^[a-z][a-z0-9_]{1,39}$/
const COMMAND_NAME = /^[a-z][a-z0-9]{1,19}$/
const FORBIDDEN_ARG_KEYS = new Set(['action', 'operation', 'op'])

export interface RegistryDeps {
  storage: Storage
  config: { tools: { defaultTimeoutMs: number } }
  logger: Logger
  redactor: Redactor
  now?: () => Date
}

export interface CommandEntry {
  name: string
  tool: string
  kind: 'direct' | 'skill'
  usage: string
}

export interface ToolRegistry {
  /** Adds one tool. Throws on a fault in the definition (see "Registration"). */
  register<Args>(definition: ToolDefinition<Args>): void
  get(name: string): ToolDefinition | undefined
  all(): ToolDefinition[]
  /** Every registered tool name, for the cleaning chain's narration check. */
  toolNames(): string[]
  /** May this chat use this tool, in any mode? Feature switch and permission. */
  enabled(name: string, context: TurnContext): boolean
  /** The tools the model may call this turn: mode `both` or `implicit`, and enabled. Implements `ToolOffer`. */
  offered(context: TurnContext): OfferedTool[]
  /** The commands this chat may use, sorted by name. */
  commands(context: TurnContext): CommandEntry[]
  /** Runs one call. Never throws: every failure is a typed result. */
  call(
    name: string,
    args: unknown,
    context: TurnContext,
    call: { callId: string; source: 'model' | 'command'; signal?: AbortSignal }
  ): Promise<ToolResult>
  /** Text for prompt block 3: one line per tool offered this turn (`- <name>: <description>`), under a short heading. */
  rulesText(context: TurnContext): string
}

const registryDepsMap = new WeakMap<ToolRegistry, RegistryDeps>()

export function registryDepsOf(registry: ToolRegistry): RegistryDeps {
  const deps = registryDepsMap.get(registry)
  if (!deps) throw new Error('registry was not created by createToolRegistry')
  return deps
}

interface StoredToolResultRow {
  tool: string
  chat_id: string
  result: string
}

interface StoredReceiptRow {
  receipt_id: string
  call_id: string
  tool: string
  kind: string
  target: string | null
  state: string | null
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)'
      return `${path}: ${issue.message}`
    })
    .join('; ')
}

function validateDefinition<Args>(
  definition: ToolDefinition<Args>,
  tools: Map<string, ToolDefinition>,
  commandOwners: Map<string, string>
): void {
  const { name } = definition
  if (!TOOL_NAME.test(name)) {
    throw new Error(`tool ${name}: name must match ${TOOL_NAME.source}`)
  }
  if (tools.has(name)) {
    throw new Error(`tool ${name}: already registered`)
  }
  if (!(definition.schema instanceof z.ZodObject)) {
    throw new Error(`tool ${name}: schema must be a z.object schema`)
  }
  for (const key of Object.keys(definition.schema.shape)) {
    if (FORBIDDEN_ARG_KEYS.has(key)) {
      throw new Error(`tool ${name}: schema must not have a key named ${key}`)
    }
  }
  if (definition.mode === 'implicit' && definition.command !== undefined) {
    throw new Error(`tool ${name}: implicit tool cannot have a command`)
  }
  if (definition.command !== undefined) {
    const seen = new Set<string>()
    for (const cmdName of definition.command.names) {
      if (!COMMAND_NAME.test(cmdName)) {
        throw new Error(`tool ${name}: command ${cmdName} must match ${COMMAND_NAME.source}`)
      }
      if (seen.has(cmdName) || commandOwners.has(cmdName)) {
        throw new Error(`tool ${name}: command ${cmdName} is already used`)
      }
      seen.add(cmdName)
    }
  }
  if (definition.timeoutMs !== undefined && (!Number.isInteger(definition.timeoutMs) || definition.timeoutMs <= 0)) {
    throw new Error(`tool ${name}: timeoutMs must be a positive integer`)
  }
}

export function createToolRegistry(deps: RegistryDeps): ToolRegistry {
  const now = deps.now ?? (() => new Date())
  const tools = new Map<string, ToolDefinition>()
  const commandOwners = new Map<string, string>()

  const enabled = (name: string, context: TurnContext): boolean => {
    const def = tools.get(name)
    if (!def) return false
    if (def.feature !== undefined && context.settings[def.feature]?.value !== true) return false
    if (def.permission !== undefined && !def.permission(context)) return false
    return true
  }

  const offeredDefs = (context: TurnContext): ToolDefinition[] =>
    [...tools.values()].filter((def) => (def.mode === 'both' || def.mode === 'implicit') && enabled(def.name, context))

  const checkAccess = (
    def: ToolDefinition,
    source: 'model' | 'command',
    context: TurnContext
  ): ToolResult | undefined => {
    if (def.mode === 'explicit' && source === 'model') {
      return { ok: false, kind: 'refused', reason: 'tool is explicit only' }
    }
    if (def.mode === 'implicit' && source === 'command') {
      return { ok: false, kind: 'refused', reason: 'tool is implicit only' }
    }
    if (def.feature !== undefined && context.settings[def.feature]?.value !== true) {
      return { ok: false, kind: 'refused', reason: `feature ${def.feature} is disabled` }
    }
    if (def.permission !== undefined && !def.permission(context)) {
      return { ok: false, kind: 'refused', reason: 'permission denied' }
    }
    return undefined
  }

  const readStoredResult = (def: ToolDefinition, callId: string, chatId: string): ToolResult | undefined => {
    const row = deps.storage.read((db) => {
      const q = 'SELECT tool, chat_id, result FROM tool_result WHERE call_id = ?'
      return db.prepare(q).get(callId) as StoredToolResultRow | undefined
    })
    if (!row) return undefined
    if (row.tool !== def.name || row.chat_id !== chatId) {
      return { ok: false, kind: 'invalid', reason: 'call id belongs to another call' }
    }
    const parsed = JSON.parse(row.result) as { ok: true; data: unknown }
    const receiptRow = deps.storage.read(
      (db) =>
        db
          .prepare('SELECT receipt_id, call_id, tool, kind, target, state FROM receipt WHERE call_id = ?')
          .get(callId) as StoredReceiptRow | undefined
    )
    const receipt: Receipt | undefined = receiptRow
      ? {
          receiptId: receiptRow.receipt_id,
          callId: receiptRow.call_id,
          tool: receiptRow.tool,
          kind: receiptRow.kind,
          ...(receiptRow.target !== null ? { target: receiptRow.target } : {}),
          ...(receiptRow.state !== null ? { state: JSON.parse(receiptRow.state) as Record<string, unknown> } : {})
        }
      : undefined
    return receipt ? { ok: true, data: parsed.data, receipt } : { ok: true, data: parsed.data }
  }

  const runHandler = async (
    def: ToolDefinition,
    parsedArgs: unknown,
    context: TurnContext,
    call: { callId: string; signal?: AbortSignal }
  ): Promise<{ result: ToolResult; error?: unknown }> => {
    const timeoutMs = def.timeoutMs ?? deps.config.tools.defaultTimeoutMs
    const controller = new AbortController()
    const onParentAbort = () => controller.abort(call.signal?.reason)
    if (call.signal) {
      if (call.signal.aborted) controller.abort(call.signal.reason)
      else call.signal.addEventListener('abort', onParentAbort, { once: true })
    }

    let committedResult: { ok: true; data: unknown; receipt: Receipt } | undefined
    let commitCalled = false
    // Set when the call has returned. A handler that is still running after its timeout must not commit: the
    // caller was already told the call failed.
    let ended = false

    const commit = <T>(write: (db: Db) => { data: T; receipt: ReceiptDraft }): { data: T; receipt: Receipt } => {
      if (!def.mutates) {
        throw new Error(`tool ${def.name} cannot commit because mutates is false`)
      }
      if (commitCalled) {
        throw new Error(`tool ${def.name} already committed in this call`)
      }
      if (ended) {
        throw new Error(`tool ${def.name} tried to commit after its call ended`)
      }
      commitCalled = true
      const out = deps.storage.tx((db) => {
        const { data, receipt: draft } = write(db)
        const at = isoNow(now)
        const receiptId = `r_${randomBytes(6).toString('hex')}`
        db.prepare(
          `INSERT INTO tool_result (call_id, turn_id, chat_id, tool, result, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(call.callId, context.turnId, context.chat.chatId, def.name, JSON.stringify({ ok: true, data }), at)

        const stateJson = draft.state === undefined ? null : JSON.stringify(draft.state)
        db.prepare(
          `INSERT INTO receipt (receipt_id, call_id, turn_id, chat_id, tool, kind, target, state, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          receiptId,
          call.callId,
          context.turnId,
          context.chat.chatId,
          def.name,
          draft.kind,
          draft.target ?? null,
          stateJson,
          at
        )

        const receipt: Receipt = {
          receiptId,
          callId: call.callId,
          tool: def.name,
          kind: draft.kind,
          ...(draft.target !== undefined ? { target: draft.target } : {}),
          ...(draft.state !== undefined ? { state: draft.state } : {})
        }
        return { data, receipt }
      })
      committedResult = { ok: true, data: out.data, receipt: out.receipt }
      return out
    }

    const toolContext: ToolContext = {
      ...context,
      callId: call.callId,
      signal: controller.signal,
      now,
      commit
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<{ timedOut: true }>((resolve) => {
      timer = setTimeout(() => {
        controller.abort(new Error(`${def.name} timed out`))
        resolve({ timedOut: true })
      }, timeoutMs)
    })

    const handlerPromise = Promise.resolve()
      .then(() => def.handler(parsedArgs, toolContext))
      .then((value) => ({ timedOut: false as const, value }))
      .catch((err: unknown) => ({ timedOut: false as const, err }))

    try {
      const race = await Promise.race([handlerPromise, timeoutPromise])
      if (committedResult !== undefined) {
        return { result: committedResult }
      }
      if (race.timedOut) {
        return {
          result: { ok: false, kind: 'timeout', reason: 'tool timed out' },
          error: new Error(`${def.name} timed out`)
        }
      }
      if ('err' in race) {
        return {
          result: { ok: false, kind: 'error', reason: 'the tool failed' },
          error: race.err
        }
      }
      const res = race.value
      if (res.ok) {
        if (def.mutates) {
          return {
            result: { ok: false, kind: 'error', reason: 'mutating tool did not commit' },
            error: new Error(`${def.name} did not commit`)
          }
        }
        return { result: { ok: true, data: res.data } }
      }
      return {
        result: res,
        error:
          res.kind === 'timeout'
            ? new Error(`${def.name} timed out`)
            : res.kind === 'error'
              ? new Error(`${def.name} failed`)
              : undefined
      }
    } finally {
      ended = true
      if (timer !== undefined) clearTimeout(timer)
      call.signal?.removeEventListener('abort', onParentAbort)
    }
  }

  const recordOutcome = (
    name: string,
    args: unknown,
    context: TurnContext,
    source: 'model' | 'command',
    startedAt: Date,
    outcome: ToolResult,
    error: unknown
  ): void => {
    const durationMs = Math.max(0, now().getTime() - startedAt.getTime())
    const outcomeLabel = outcome.ok ? 'ok' : outcome.kind
    const receiptId = outcome.ok ? outcome.receipt?.receiptId : undefined
    try {
      deps.storage.tx((db) => {
        recordToolCall(db, {
          turnId: context.turnId,
          tool: name,
          source,
          startedAt,
          durationMs,
          outcome: outcomeLabel,
          receiptId,
          args
        })
        if (!outcome.ok && (outcome.kind === 'timeout' || outcome.kind === 'error' || outcome.kind === 'refused')) {
          const failureKind =
            outcome.kind === 'timeout' ? 'tool_timeout' : outcome.kind === 'error' ? 'tool_error' : 'tool_refused'
          const failureError =
            outcome.kind === 'refused'
              ? new Error(`${name} refused`)
              : outcome.kind === 'timeout'
                ? (error ?? new Error(`${name} timed out`))
                : (error ?? new Error(`${name} failed`))
          recordFailure(
            db,
            {
              turnId: context.turnId,
              stage: 'tool',
              kind: failureKind,
              error: failureError,
              handledBy: 'tool_result'
            },
            deps.redactor,
            now
          )
        }
      })
    } catch (err) {
      deps.logger.warn('tool_record_failed', { turnId: context.turnId, tool: name, error: err })
    }
  }

  const registry: ToolRegistry = {
    register<Args>(definition: ToolDefinition<Args>): void {
      validateDefinition(definition, tools, commandOwners)
      tools.set(definition.name, definition as ToolDefinition)
      if (definition.command) {
        for (const cmdName of definition.command.names) {
          commandOwners.set(cmdName, definition.name)
        }
      }
    },

    get(name: string): ToolDefinition | undefined {
      return tools.get(name)
    },

    all(): ToolDefinition[] {
      return [...tools.values()]
    },

    toolNames(): string[] {
      return [...tools.keys()]
    },

    enabled,

    offered(context: TurnContext): OfferedTool[] {
      return offeredDefs(context).map((def) => ({
        schema: {
          name: def.name,
          description: def.description,
          parameters: z.toJSONSchema(def.schema) as Record<string, unknown>
        },
        call: async (args: unknown, callId: string, signal: AbortSignal) => {
          // The tool a skill-style command names is called for the person who typed the command.
          const source = context.kind === 'command' && context.commandTool === def.name ? 'command' : 'model'
          const result = await registry.call(def.name, args, context, { callId, source, signal })
          if (result.ok) {
            return {
              ok: true,
              content: JSON.stringify(result.data),
              ...(result.receipt ? { receiptId: result.receipt.receiptId } : {})
            }
          }
          return {
            ok: false,
            content: JSON.stringify({ error: result.kind, reason: result.reason })
          }
        }
      }))
    },

    commands(context: TurnContext): CommandEntry[] {
      const entries: CommandEntry[] = []
      for (const def of tools.values()) {
        if (!def.command || !enabled(def.name, context)) continue
        for (const cmdName of def.command.names) {
          entries.push({
            name: cmdName,
            tool: def.name,
            kind: def.command.kind,
            usage: def.command.usage
          })
        }
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      return entries
    },

    async call(name, args, context, call): Promise<ToolResult> {
      const startedAt = now()
      let result: ToolResult
      let error: unknown

      const def = tools.get(name)
      if (!def) {
        result = { ok: false, kind: 'unavailable', reason: 'no such tool' }
      } else {
        const refused = checkAccess(def, call.source, context)
        if (refused) {
          result = refused
        } else {
          const stored = readStoredResult(def, call.callId, context.chat.chatId)
          if (stored) {
            result = stored
          } else {
            const parsed = def.schema.safeParse(args)
            if (!parsed.success) {
              result = { ok: false, kind: 'invalid', reason: formatZodIssues(parsed.error) }
            } else {
              const ran = await runHandler(def, parsed.data, context, call)
              result = ran.result
              error = ran.error
            }
          }
        }
      }

      recordOutcome(name, args, context, call.source, startedAt, result, error)
      return result
    },

    rulesText(context: TurnContext): string {
      const items = offeredDefs(context)
      if (items.length === 0) return 'Tools: none available this turn.'
      return ['Tools:', ...items.map((def) => `- ${def.name}: ${def.description}`)].join('\n')
    }
  }

  registryDepsMap.set(registry, deps)
  return registry
}
