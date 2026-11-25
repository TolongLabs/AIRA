import { afterEach, expect, it, vi } from 'vitest'
import { createGeminiWatcher } from '../../src/media/gemini-watcher.js'
import { DEFAULT_MEDIA_LIMITS } from '../../src/media/limits.js'
import { createLinkReader } from '../../src/media/link-intake.js'
import { mediaPromptText } from '../../src/media/turn-media.js'
import { createLogger } from '../../src/records/logger.js'
import { createRedactor } from '../../src/records/redact.js'
import type { SocialPost } from '../../src/social/types.js'
import { parseSocialPostUrl } from '../../src/social/urls.js'

interface ResponseSchedule {
  ms: number
  status?: number
  retryAfter?: string
}

interface Sample {
  id: string
  initial: ResponseSchedule[]
  retry?: ResponseSchedule[]
  short?: boolean
  longEvidence?: boolean
}

const ok = (ms: number): ResponseSchedule => ({ ms })
const matrix: Sample[] = [
  { id: 'fast-a', initial: [ok(900), ok(1200), ok(1800), ok(2500)] },
  { id: 'fast-b', initial: [ok(2200), ok(1300), ok(1800), ok(1500)] },
  { id: 'slow-success', initial: [ok(1000), ok(15000), ok(1500), ok(1000)] },
  {
    id: 'two-recoveries',
    initial: [ok(1000), { ms: 100, status: 503 }, { ms: 200, status: 408 }, ok(1500)],
    retry: [ok(1000), ok(3000), ok(4000), ok(1000)]
  },
  {
    id: 'quota-breaker',
    initial: [ok(1000), { ms: 100, status: 429, retryAfter: '1' }, { ms: 300, status: 429 }, ok(1500)]
  },
  {
    id: 'permanent-gap',
    initial: [ok(1000), { ms: 100, status: 400 }, ok(1200), ok(1500)]
  },
  { id: 'long-evidence', initial: [ok(2200), ok(1800), ok(1200), ok(900)], longEvidence: true },
  { id: 'short-fallback', initial: [{ ms: 14000, status: 503 }], short: true }
]

function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('aborted', 'AbortError'))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('aborted', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

/**
 * Identical synthetic schedules on both baseline and candidate. Opt in to aggregate rows with
 * AIRA_YOUTUBE_BENCH_OUTPUT=1 bun run test -- tests/contract/youtube-watch-benchmark.test.ts
 * The watcher, reader and final prompt path are real; only fetch and lookup are mocked.
 */
it.each(matrix)('synthetic watch probe: $id', async (sample) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  vi.spyOn(Math, 'random').mockReturnValue(0.5)

  const url = sample.short
    ? 'https://www.youtube.com/shorts/synthetic01'
    : 'https://www.youtube.com/watch?v=synthetic01&t=775'
  const target = parseSocialPostUrl(url)!
  const post: SocialPost = {
    platform: 'youtube',
    id: target.id,
    canonicalUrl: target.canonicalUrl,
    target,
    authorHandle: 'fixture',
    authorName: 'Fixture',
    createdAt: null,
    text: sample.longEvidence ? 'Metadata '.repeat(400) : '',
    quotedText: '',
    quotedAuthorHandle: '',
    photoCount: 0,
    videoCount: 0,
    imageUrl: null,
    photoUrls: [],
    thread: [],
    externalTitle: sample.longEvidence ? 'Title '.repeat(400) : 'Synthetic sample',
    replyCount: null,
    durationSec: sample.short ? 35 : sample.longEvidence ? 1700 : 1375,
    video: null
  }
  const rangeStarts = sample.short ? [0] : [775, 835, 1015, 1195]
  const attempts = rangeStarts.map(() => 0)
  let byteCalls = 0
  const marker = (i: number) => `EVIDENCE_${i}`
  const usage = { promptTokenCount: 100, candidatesTokenCount: 10 }
  const fetchFn: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      contents: { parts: { inline_data?: unknown; video_metadata?: { start_offset?: string } }[] }[]
    }
    const part = body.contents[0]!.parts[0]!
    if (part.inline_data) {
      byteCalls++
      await wait(1000, init?.signal ?? undefined)
      return Response.json({
        candidates: [{ content: { parts: [{ text: JSON.stringify({ description: 'Byte fallback evidence' }) }] } }],
        usageMetadata: usage
      })
    }
    const start = Number.parseInt(part.video_metadata?.start_offset ?? '0', 10)
    const i = rangeStarts.indexOf(start)
    expect(i).toBeGreaterThanOrEqual(0)
    const attempt = ++attempts[i]!
    const schedule = (attempt === 1 ? sample.initial[i] : sample.retry?.[i]) ?? sample.initial[i]!
    await wait(schedule.ms, init?.signal ?? undefined)
    if (schedule.status !== undefined) {
      return new Response('Synthetic provider failure', {
        status: schedule.status,
        ...(schedule.retryAfter !== undefined ? { headers: { 'Retry-After': schedule.retryAfter } } : {})
      })
    }
    const reading = {
      description: marker(i) + (sample.longEvidence ? ' distinct visual evidence'.repeat(70) : ''),
      transcript: `SPEECH_${i}` + (sample.longEvidence ? ' distinct spoken evidence'.repeat(180) : '')
    }
    return Response.json({
      candidates: [{ content: { parts: [{ text: JSON.stringify(reading) }] } }],
      usageMetadata: usage
    })
  }
  const logs: Record<string, unknown>[] = []
  const reader = createLinkReader({
    viewer: {
      lookup: async () => {
        await wait(250, undefined)
        return { status: 'found', post }
      }
    },
    findTarget: parseSocialPostUrl,
    watcher: createGeminiWatcher({ apiKey: 'synthetic-key', model: 'fixture-model', fetch: fetchFn }),
    model: 'fixture-model',
    limits: { ...DEFAULT_MEDIA_LIMITS, maxVideoSeconds: 300 },
    ...(sample.short
      ? { downloadShort: async () => ({ data: Buffer.from('synthetic'), contentType: 'video/mp4' }) }
      : {}),
    logger: createLogger({
      level: 'info',
      module: 'synthetic-probe',
      redactor: createRedactor(),
      sink: (line) => logs.push(JSON.parse(line))
    })
  })
  let elapsedMs = 0
  const started = performance.now()
  const resultPromise = reader.read([url], 30000, { media: true, social: true }).then((result) => {
    elapsedMs = performance.now() - started
    return result
  })
  await vi.runAllTimersAsync()
  const result = await resultPromise
  const prompt = mediaPromptText(result, 'Could not watch', () => 'S1')
  const event = logs.find((row) => row['event'] === 'media.link_segments')!
  const urlAttempts = attempts.reduce((sum, count) => sum + count, 0)
  const answered = Number(event['answered'])
  const planned = Number(event['segments'])
  const missingOrdinals = (result.partial ?? []).map((item) => Number(/part (\d+)/.exec(item.kind)?.[1]) - 1)
  const lengths = sample.short ? [35] : [60, 180, 180, 180]
  const answeredSeconds =
    answered === 0 ? 0 : lengths.reduce((sum, length, i) => sum + (missingOrdinals.includes(i) ? 0 : length), 0)
  const omittedEvidence = rangeStarts.filter(
    (_, i) => answered > 0 && !missingOrdinals.includes(i) && !prompt.includes(marker(i))
  )
  const row = {
    sample: sample.id,
    planned,
    answered,
    plannedSeconds: lengths.reduce((sum, length) => sum + length, 0),
    answeredSeconds,
    urlAttempts,
    byteCalls,
    elapsedMs,
    full: answered === planned,
    partial: answered > 0 && answered < planned,
    none: answered === 0,
    clipped: sample.longEvidence === true,
    omittedEvidence: omittedEvidence.length,
    failureKinds: result.calls.filter((call) => call.failureKind).map((call) => call.failureKind)
  }
  if (process.env['AIRA_YOUTUBE_BENCH_OUTPUT'] === '1') console.log('YOUTUBE_PROBE', JSON.stringify(row))
  expect(result.calls).toHaveLength(urlAttempts + byteCalls)
  expect(urlAttempts).toBeLessThanOrEqual(planned + 2)
  expect(elapsedMs).toBeLessThanOrEqual(30000)
  expect(vi.getTimerCount()).toBe(0)
})
