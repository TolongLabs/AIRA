import { AsyncLocalStorage } from 'node:async_hooks'
import { z } from 'zod'
import type { MemoryJudge } from '../memory/types.js'
import { ModelError, type ModelFailureKind } from '../models/types.js'
import type { MoodJudge } from '../prompt/mood.js'

// The judge model (docs/trd/models.md#roles): a hosted small model that answers typed questions about a text
// with calibrated probabilities. It makes no text. Code decides on its numbers, and every caller has a timeout.

/** Carries record ownership across concurrent turns and background attempts, without storing prompt data. */
export const modelRecordContext = new AsyncLocalStorage<{ turnId?: string; jobId?: string }>()

export interface JudgeCall {
  turnId?: string
  jobId?: string
  model: string
  startedAt: Date
  durationMs: number
  failureKind?: ModelFailureKind
}

export interface SystemOneOptions {
  apiKey: string
  /** A versioned model id. The thresholds in config.yml were chosen against it. */
  model: string
  baseUrl?: string
  fetch?: typeof fetch
  onCall?: (call: JudgeCall) => void
  now?: () => Date
}

export type JudgeQuestion =
  | { type: 'noul'; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string | null> }

const noulAnswer = z.object({ type: z.literal('noul'), noul: z.number().min(0).max(1) })
const choiceAnswer = z.object({
  type: z.literal('choice'),
  choice: z.string(),
  probabilities: z.record(z.string(), z.number().min(0).max(1))
})
const responseSchema = z.object({ answers: z.record(z.string(), z.union([noulAnswer, choiceAnswer])) })

export type JudgeAnswer = z.infer<typeof noulAnswer> | z.infer<typeof choiceAnswer>

export interface SystemOneClient {
  /** Asks every question about one state in one request. Rejects with a ModelError on any failure. */
  ask(
    state: string,
    questions: Record<string, JudgeQuestion>,
    signal: AbortSignal
  ): Promise<Record<string, JudgeAnswer>>
}

const DEFAULT_BASE_URL = 'https://api.typesafe.ai'

export function createSystemOneClient(options: SystemOneOptions): SystemOneClient {
  const send = options.fetch ?? fetch
  const endpoint = `${(options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')}/v1/systemone`
  const client: SystemOneClient = {
    async ask(state, questions, signal) {
      let response: Response
      try {
        response = await send(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` },
          body: JSON.stringify({ model: options.model, state, questions }),
          signal
        })
      } catch (cause) {
        throw new ModelError('transient', signal.aborted ? 'aborted' : 'the judge could not be reached', { cause })
      }
      if (!response.ok) {
        const kind =
          response.status === 401 || response.status === 403
            ? 'auth'
            : response.status === 429 || response.status === 529
              ? 'rate_limit'
              : response.status >= 500 || response.status === 408
                ? 'transient'
                : 'malformed'
        throw new ModelError(kind, `the judge answered HTTP ${response.status}`)
      }
      let body: unknown
      try {
        body = await response.json()
      } catch (cause) {
        throw new ModelError('malformed', 'the judge reply is not JSON', { cause })
      }
      const parsed = responseSchema.safeParse(body)
      if (!parsed.success) throw new ModelError('malformed', 'the judge reply has no usable answers')
      for (const id of Object.keys(questions)) {
        if (parsed.data.answers[id]?.type !== questions[id]?.type) {
          throw new ModelError('malformed', `the judge gave no answer of the asked type for question ${id}`)
        }
      }
      return parsed.data.answers
    }
  }
  return {
    async ask(state, questions, signal) {
      const startedAt = (options.now ?? (() => new Date()))()
      const start = performance.now()
      let failureKind: ModelFailureKind | undefined
      try {
        // Race the signal too: a transport that ignores cancellation must still leave exactly one record.
        if (signal.aborted) throw new ModelError('transient', 'judge request aborted')
        let onAbort: () => void = () => {}
        const aborted = new Promise<never>((_, reject) => {
          onAbort = () => reject(new ModelError('transient', 'judge request aborted'))
          signal.addEventListener('abort', onAbort, { once: true })
        })
        try {
          return await Promise.race([client.ask(state, questions, signal), aborted])
        } finally {
          signal.removeEventListener('abort', onAbort)
        }
      } catch (error) {
        failureKind = error instanceof ModelError ? error.kind : 'transient'
        throw error
      } finally {
        options.onCall?.({
          ...modelRecordContext.getStore(),
          model: options.model,
          startedAt,
          durationMs: Math.max(0, Math.round(performance.now() - start)),
          failureKind
        })
      }
    }
  }
}

/** Text given to the judge is data. It is cut to a length the judge reads whole. */
const MAX_STATE_CHARS = 24_000
const clip = (text: string): string => (text.length > MAX_STATE_CHARS ? text.slice(-MAX_STATE_CHARS) : text)

/** The mood judge: one choice question over the pack's moods (docs/trd/prompt-engine.md#mood-detection). */
export function createSystemOneMoodJudge(client: SystemOneClient): MoodJudge {
  return {
    async judge(input, signal) {
      const answers = await client.ask(
        clip(input.messages.join('\n')),
        {
          mood: {
            type: 'choice',
            instructions: 'Which of these moods fits the newest messages of this chat best?',
            criteria: Object.fromEntries(input.moods.map((mood) => [mood.key, mood.tone]))
          }
        },
        signal
      )
      const answer = answers['mood']
      if (answer?.type !== 'choice') throw new ModelError('malformed', 'the judge gave no mood')
      return { mood: answer.choice, probability: answer.probabilities[answer.choice] ?? 0 }
    }
  }
}

/** The memory judge: admission and verification as yes/no probabilities (docs/trd/memory.md#write-path). */
export function createSystemOneMemoryJudge(client: SystemOneClient): MemoryJudge {
  const noul = async (state: string, question: JudgeQuestion, signal: AbortSignal): Promise<number> => {
    const answer = (await client.ask(clip(state), { q: question }, signal))['q']
    if (answer?.type !== 'noul') throw new ModelError('malformed', 'the judge gave no probability')
    return answer.noul
  }
  return {
    admit: (input, signal) =>
      noul(
        input.episode,
        {
          type: 'noul',
          instructions:
            'Does this chat excerpt state anything lasting about a person or the group that is worth remembering later?',
          criteria: {
            true: 'It states a lasting fact, preference, plan, relationship or correction about a person or the group.',
            false: 'It holds only greetings, small talk, reactions, questions with no stated fact, or passing remarks.'
          }
        },
        signal
      ),
    verify: (input, signal) =>
      noul(
        input.episode,
        {
          type: 'noul',
          instructions: `Is this memory operation supported by the chat excerpt, and does the quoted message say it? Operation: ${input.operation}. Quoted message: ${input.quote}`,
          criteria: {
            true: 'The quoted message is in the excerpt, was written by the person the operation is about or is plainly about them, and states what the operation records.',
            false:
              'The excerpt does not say it, says the opposite, says it about someone else, or it is a joke, a guess or a question.'
          }
        },
        signal
      )
  }
}
