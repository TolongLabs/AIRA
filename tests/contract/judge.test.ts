import { describe, expect, it, vi } from 'vitest'
import {
  createSystemOneClient,
  createSystemOneMemoryJudge,
  createSystemOneMoodJudge
} from '../../src/judge/systemone.js'

// The hosted judge, with recorded reply shapes only. No test calls the real service.

const key = ['an', 'invented', 'judge', 'key'].join('-')
const signal = () => new AbortController().signal

function client(reply: unknown, status = 200) {
  const send = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(JSON.stringify(reply), { status }))
  return {
    send,
    client: createSystemOneClient({ apiKey: key, model: 'judge-model-1', fetch: send as unknown as typeof fetch })
  }
}

describe('the judge client', () => {
  it('sends the state and the questions by id, with the key only in the authorization header', async () => {
    const { send, client: judge } = client({ answers: { a: { type: 'noul', noul: 0.9 } } })
    const answers = await judge.ask('some text', { a: { type: 'noul', instructions: 'Is it?' } }, signal())
    expect(answers['a']).toEqual({ type: 'noul', noul: 0.9 })
    const [url, init] = send.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.typesafe.ai/v1/systemone')
    expect(url).not.toContain(key)
    expect((init.headers as Record<string, string>)['authorization']).toBe(`Bearer ${key}`)
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'judge-model-1',
      state: 'some text',
      questions: { a: { type: 'noul', instructions: 'Is it?' } }
    })
  })

  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [429, 'rate_limit'],
    [529, 'rate_limit'],
    [500, 'transient'],
    [400, 'malformed']
  ])('maps status %i to a %s failure', async (status, kind) => {
    const { client: judge } = client({ error: 'x' }, status)
    await expect(judge.ask('t', { a: { type: 'noul', instructions: 'q' } }, signal())).rejects.toMatchObject({ kind })
  })

  it('rejects a reply with no answer, an answer of another type, or a probability out of range', async () => {
    const question = { a: { type: 'noul' as const, instructions: 'q' } }
    for (const reply of [
      {},
      { answers: {} },
      { answers: { a: { type: 'choice', choice: 'x', probabilities: {} } } },
      { answers: { a: { type: 'noul', noul: 1.4 } } }
    ]) {
      await expect(client(reply).client.ask('t', question, signal())).rejects.toMatchObject({ kind: 'malformed' })
    }
  })

  it('rejects as transient when the service cannot be reached, and never puts the key in an error', async () => {
    const judge = createSystemOneClient({
      apiKey: key,
      model: 'm',
      fetch: (async () => {
        throw new Error(`connect failed for ${key}`)
      }) as unknown as typeof fetch
    })
    const error = await judge
      .ask('t', { a: { type: 'noul', instructions: 'q' } }, signal())
      .catch((caught: Error) => caught)
    expect(error).toMatchObject({ kind: 'transient' })
    expect((error as Error).message).not.toContain(key)
  })
})

describe('the mood judge', () => {
  it('asks one choice over the pack moods and returns the choice with its own probability', async () => {
    const { send, client: judge } = client({
      answers: {
        mood: { type: 'choice', choice: 'cheerful', probabilities: { cheerful: 0.7, neutral: 0.3 }, confidence: 0.6 }
      }
    })
    const result = await createSystemOneMoodJudge(judge).judge(
      {
        moods: [
          { key: 'neutral', tone: 'Calm.' },
          { key: 'cheerful', tone: 'Warm.' }
        ],
        messages: ['yay', 'we won']
      },
      signal()
    )
    expect(result).toEqual({ mood: 'cheerful', probability: 0.7 })
    const body = JSON.parse((send.mock.calls[0]?.[1] as RequestInit).body as string)
    expect(body.state).toBe('yay\nwe won')
    expect(body.questions.mood.criteria).toEqual({ neutral: 'Calm.', cheerful: 'Warm.' })
  })
})

describe('the memory judge', () => {
  it('returns the probability for admission and for verification', async () => {
    const { send, client: judge } = client({ answers: { q: { type: 'noul', noul: 0.82 } } })
    const memory = createSystemOneMemoryJudge(judge)
    expect(await memory.admit({ episode: 'invented chat text' }, signal())).toBe(0.82)
    expect(
      await memory.verify({ operation: 'add likes.food = noodles', quote: 'i love noodles', episode: 'x' }, signal())
    ).toBe(0.82)
    const verifyBody = JSON.parse((send.mock.calls[1]?.[1] as RequestInit).body as string)
    expect(verifyBody.questions.q.instructions).toContain('add likes.food = noodles')
    expect(verifyBody.questions.q.instructions).toContain('i love noodles')
  })

  it('fails closed: any failure rejects, so the caller rejects the operation', async () => {
    const memory = createSystemOneMemoryJudge(client({ error: 'down' }, 500).client)
    await expect(memory.verify({ operation: 'o', quote: 'q', episode: 'e' }, signal())).rejects.toMatchObject({
      kind: 'transient'
    })
    await expect(memory.admit({ episode: 'e' }, signal())).rejects.toMatchObject({ kind: 'transient' })
  })
})
