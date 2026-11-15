import type { MemoryJudge } from '../../src/memory/types.js'
import type { ProposedOperation } from '../../src/memory/validate.js'
import type { MemoryWorkerOptions } from '../../src/memory/worker.js'
import type { ModelClient, ModelRequest } from '../../src/models/types.js'
import { createLogger } from '../../src/records/logger.js'
import { ensureChat, ensureSubject, setChatStatus } from '../../src/settings/chats.js'
import type { Storage } from '../../src/storage/database.js'

// Helpers for the memory tests and the memory simulator. Every name and message here is invented.

export const quietLogger = createLogger({ level: 'error', module: 'test', sink: () => {} })

export const memoryConfig: MemoryWorkerOptions['config'] = {
  memory: { episodeIdleMs: 180_000, episodeMaxMessages: 25 },
  judge: { memoryAdmit: 0.5, memoryVerify: 0.5, timeoutMs: 200 },
  llm: { main: { model: 'test-main' }, monthlyBudgetUsd: 0 }
}

export function activeChat(storage: Storage, waId: string, type: 'dm' | 'group' = 'group'): string {
  const chat = ensureChat(storage, { waId, type })
  setChatStatus(storage, { chatId: chat.chatId, status: 'active', actor: 'test' })
  return chat.chatId
}

export const subject = (storage: Storage, waId: string): string => ensureSubject(storage, waId)

/** Writes one window message and returns its id. */
export function say(
  storage: Storage,
  message: { chatId: string; senderId?: string; text: string; at: Date; turnId?: string }
): number {
  return storage.tx((db) =>
    Number(
      db
        .prepare(
          `INSERT INTO session_message (chat_id, role, sender_id, content, turn_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          message.chatId,
          message.senderId === undefined ? 'assistant' : 'user',
          message.senderId ?? null,
          message.text,
          message.turnId ?? null,
          message.at.toISOString()
        ).lastInsertRowid
    )
  )
}

export interface ScriptedProposal {
  operations: ProposedOperation[]
  summary?: string
}

/** A model that answers each extraction request from a script, and counts its calls. */
export function scriptedModel(
  answer: (episode: string, request: ModelRequest) => ScriptedProposal | string | Error | Promise<ScriptedProposal>
): ModelClient & { calls: number; episodes: string[] } {
  const client = {
    calls: 0,
    episodes: [] as string[],
    async call(request: ModelRequest) {
      client.calls += 1
      const episode = request.messages.map((message) => message.content).join('\n')
      client.episodes.push(episode)
      const result = await answer(episode, request)
      if (result instanceof Error) throw result
      return {
        text: typeof result === 'string' ? result : JSON.stringify(result),
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 10, cachedTokens: 0 },
        costUsd: 0,
        model: request.model
      }
    }
  }
  return client
}

/** A judge that answers from two functions, and counts its questions. */
export function scriptedJudge(
  script: {
    admit?: (episode: string) => number | Promise<number>
    verify?: (input: { operation: string; quote: string; episode: string }) => number | Promise<number>
  } = {}
): MemoryJudge & { admitted: number; verified: number } {
  const judge = {
    admitted: 0,
    verified: 0,
    async admit(input: { episode: string }) {
      judge.admitted += 1
      return script.admit ? script.admit(input.episode) : 0.9
    },
    async verify(input: { operation: string; quote: string; episode: string }) {
      judge.verified += 1
      return script.verify ? script.verify(input) : 0.9
    }
  }
  return judge
}

export interface FactRow {
  id: string
  subject_id: string | null
  key: string | null
  value: string
  status: string
  kind: string
  source_job: string | null
  source_message_id: number | null
}

export function itemsOf(storage: Storage, chatId: string): FactRow[] {
  return storage.read(
    (db) =>
      db
        .prepare(
          `SELECT id, subject_id, key, value, status, kind, source_job, source_message_id FROM memory_item
           WHERE chat_id = ? ORDER BY rowid`
        )
        .all(chatId) as FactRow[]
  )
}

export function eventsOf(
  storage: Storage,
  chatId: string
): { step: string; outcome: string; op: string | null; reason: string | null }[] {
  return storage.read(
    (db) =>
      db.prepare('SELECT step, outcome, op, reason FROM memory_event WHERE chat_id = ? ORDER BY id').all(chatId) as {
        step: string
        outcome: string
        op: string | null
        reason: string | null
      }[]
  )
}
