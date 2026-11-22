import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { fourthWallBreak } from '../../src/format/fourth-wall.js'
import { DEFAULT_MEDIA_LIMITS } from '../../src/media/limits.js'
import { createLinkReader } from '../../src/media/link-intake.js'
import {
  type ChainRun,
  isBlockStub,
  type ReaderKind,
  type ReaderResult,
  runChain,
  type SocialReader
} from '../../src/social/chain.js'
import { createSocialPostPort } from '../../src/social/port.js'
import { ReplyReader } from '../../src/social/replies/service.js'
import { modelPostResult, partialNote, toPostPortResult } from '../../src/social/result.js'
import type { PostField, SocialPost } from '../../src/social/types.js'
import { findSocialPostTarget, parseSocialPostUrl, type SocialPlatform } from '../../src/social/urls.js'
import { SocialPostViewer } from '../../src/social/viewer.js'
import { readPageTool, readPostTool } from '../../src/tools/core/web.js'
import { outcomePayload } from '../../src/tools/outcomes.js'
import { createFetchPagePort, type PagePort, type PostPort } from '../../src/tools/ports.js'
import type { ToolContext, ToolResult } from '../../src/tools/types.js'
import { createTurnSources } from '../../src/turn/sources.js'

const ALL_FIELDS: PostField[] = ['text', 'author', 'media', 'video']
const xTarget = parseSocialPostUrl('https://x.com/example_user/status/123')!
const settings = { timeoutMs: 1000, maxTextChars: 1500, cacheTtlMs: 0, maxCacheEntries: 2, ytDlpPath: 'unused' }
const limits = { ...DEFAULT_MEDIA_LIMITS, maxVideoSeconds: 180 }

function reader(
  id: string,
  kind: ReaderKind,
  result: () => Promise<ReaderResult>,
  timeoutMs = 1000,
  provides: PostField[] = ALL_FIELDS
): SocialReader & { read: ReturnType<typeof vi.fn> } {
  return { id, kind, provides, timeoutMs, isConfigured: () => true, read: vi.fn(result) }
}

function chainRun(overrides: Partial<ChainRun> = {}): ChainRun {
  return {
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 1000,
    budgetMs: 1000,
    now: Date.now,
    fetcher: vi.fn() as unknown as typeof fetch,
    runExtractor: vi.fn() as unknown as ChainRun['runExtractor'],
    maxTextChars: 1500,
    ...overrides
  }
}

function postFixture(overrides: Partial<SocialPost> = {}): SocialPost {
  return {
    platform: 'x',
    id: '123',
    canonicalUrl: 'https://x.com/example_user/status/123',
    target: xTarget,
    authorHandle: 'example_user',
    authorName: 'Example Person',
    createdAt: null,
    text: 'Hello',
    quotedText: '',
    quotedAuthorHandle: '',
    photoCount: 0,
    videoCount: 0,
    imageUrl: null,
    photoUrls: [],
    thread: [],
    externalTitle: '',
    replyCount: null,
    durationSec: null,
    video: null,
    ...overrides
  }
}

function failedOf(result: ToolResult): Extract<ToolResult, { ok: false }> {
  if (result.ok) throw new Error('expected a failed call')
  return result
}

describe('reader chain', () => {
  it('stops at the first reader that completes the post', async () => {
    const first = reader('first', 'page_meta', async () => ({ ok: true, post: { authorHandle: 'poster', text: 'Hi' } }))
    const second = reader('second', 'mirror_api', async () => ({ ok: true, post: { text: 'later' } }))

    const outcome = await runChain([first, second], xTarget, chainRun())

    expect(outcome).toMatchObject({ status: 'readable', post: { text: 'Hi', authorHandle: 'poster' }, missing: [] })
    expect(second.read).not.toHaveBeenCalled()
  })

  it('fills a missing field from a later reader and never overwrites a field already found', async () => {
    const first = reader('first', 'page_meta', async () => ({
      ok: true,
      post: { authorHandle: 'poster', text: 'first text', videoCount: 1 }
    }))
    const second = reader('second', 'mirror_api', async () => ({
      ok: true,
      post: {
        text: 'second text',
        video: { url: 'https://video.example/clip.mp4', bytes: null, headers: null, hasAudio: true }
      }
    }))

    const outcome = await runChain([first, second], xTarget, chainRun())

    expect(outcome).toMatchObject({
      status: 'readable',
      post: { text: 'first text', video: { url: 'https://video.example/clip.mp4' } }
    })
  })

  it('keeps a verified partial when fallback declares a different post', async () => {
    const first = reader('first', 'page_meta', async () => ({
      ok: true,
      post: { id: xTarget.id, authorHandle: 'fixture', text: 'original', videoCount: 1 }
    }))
    const fallback = reader('fallback', 'yt_dlp', async () => ({
      ok: true,
      post: {
        id: 'other-post',
        video: {
          url: 'https://img.example/other.mp4',
          bytes: null,
          headers: null,
          hasAudio: null
        }
      }
    }))
    expect(await runChain([first, fallback], xTarget, chainRun())).toMatchObject({
      status: 'partial',
      post: { text: 'original', video: null },
      attempts: [
        expect.objectContaining({ ok: true }),
        expect.objectContaining({ ok: false, reason: 'identity_mismatch' })
      ]
    })
  })

  it('treats whitespace as missing, keeps a known zero replyCount, and still fills zero count placeholders', async () => {
    const first = reader('first', 'page_meta', async () => ({
      ok: true,
      post: { authorHandle: '   ', text: 'first caption', replyCount: 0 }
    }))
    const second = reader('second', 'mirror_api', async () => ({
      ok: true,
      post: { authorHandle: 'real_author', text: 'second caption', replyCount: 5 }
    }))

    const outcome = await runChain([first, second], xTarget, chainRun())

    expect(outcome).toMatchObject({
      status: 'readable',
      missing: [],
      post: { authorHandle: 'real_author', text: 'first caption', replyCount: 0 }
    })

    const countPlaceholder = reader('placeholder', 'page_meta', async () => ({
      ok: true,
      post: { authorHandle: 'poster', photoCount: 0, videoCount: 0 }
    }))
    const countFiller = reader('filler', 'yt_dlp', async () => ({
      ok: true,
      post: {
        text: 'caption',
        photoCount: 2,
        videoCount: 1,
        video: { url: 'https://video.example/clip.mp4', bytes: null, headers: null, hasAudio: true }
      }
    }))

    const countOutcome = await runChain([countPlaceholder, countFiller], xTarget, chainRun())

    expect(countOutcome).toMatchObject({
      status: 'readable',
      missing: [],
      post: { authorHandle: 'poster', text: 'caption', photoCount: 2, videoCount: 1 }
    })
  })

  it('does not run a later reader that cannot supply a missing field', async () => {
    const first = reader('first', 'page_meta', async () => ({ ok: true, post: { authorHandle: 'poster' } }), 1000, [
      'author'
    ])
    const videoOnly = reader('video', 'yt_dlp', async () => ({ ok: true, post: {} }), 1000, ['video'])

    await runChain([first, videoOnly], xTarget, chainRun())

    expect(videoOnly.read).not.toHaveBeenCalled()
  })

  it('returns a partial post with the fields it lacks when the remaining readers fail', async () => {
    const first = reader('first', 'page_meta', async () => ({
      ok: true,
      post: { authorHandle: 'poster', text: 'Hello', videoCount: 1 }
    }))
    const second = reader('second', 'yt_dlp', async () => ({ ok: false, reason: 'exit_1' }))

    const outcome = await runChain([first, second], xTarget, chainRun())

    expect(outcome).toMatchObject({ status: 'partial', missing: ['media', 'video'], post: { text: 'Hello' } })
  })

  it('fails when no reader finds a field, and keeps every attempt reason', async () => {
    const readers = [
      reader('first', 'page_meta', async () => ({ ok: false, reason: 'http_503' })),
      reader('second', 'yt_dlp', async () => ({ ok: false, reason: 'exit_1' }))
    ]

    const outcome = await runChain(readers, xTarget, chainRun())

    expect(outcome.status).toBe('failed')
    expect(outcome.attempts.map((attempt) => attempt.reason)).toEqual(['http_503', 'exit_1'])
  })

  it('ends at the deadline and keeps the fields found before it', async () => {
    const first = reader('first', 'page_meta', async () => ({ ok: true, post: { authorHandle: 'poster' } }))
    const second = reader('second', 'yt_dlp', () => new Promise<ReaderResult>(() => {}), 10_000)

    const started = Date.now()
    const outcome = await runChain([first, second], xTarget, chainRun({ deadlineAt: Date.now() + 40, budgetMs: 40 }))

    expect(Date.now() - started).toBeLessThan(1000)
    expect(outcome).toMatchObject({ status: 'partial', post: { authorHandle: 'poster' } })
    expect(outcome.attempts.at(-1)).toMatchObject({ readerId: 'second', ok: false, reason: 'timeout' })
  })

  it('clips a reader that ignores its signal to its own limit', async () => {
    const slow = reader('slow', 'page_meta', () => new Promise<ReaderResult>(() => {}), 20)

    const outcome = await runChain([slow], xTarget, chainRun())

    expect(outcome).toEqual({
      status: 'failed',
      attempts: [expect.objectContaining({ readerId: 'slow', ok: false, reason: 'timeout' })]
    })
  })

  it('lets a first-party API end the chain on a confirmed removal', async () => {
    const api = reader('api', 'api_public', async () => ({ ok: false, reason: 'http_404', terminal: true }))
    const later = reader('later', 'yt_dlp', async () => ({ ok: true, post: { authorHandle: 'x', text: 'Still here' } }))

    expect(await runChain([api, later], xTarget, chainRun())).toMatchObject({ status: 'failed' })
    expect(later.read).not.toHaveBeenCalled()

    const keyed = reader('keyed', 'api_keyed', async () => ({ ok: false, reason: 'http_410', terminal: true }))
    expect(await runChain([keyed, later], xTarget, chainRun())).toMatchObject({ status: 'failed' })
    expect(later.read).not.toHaveBeenCalled()
  })

  it.each<ReaderKind>(['mirror_api', 'page_meta', 'yt_dlp', 'oembed'])(
    'never lets a non-official %s reader end the chain, even when it reports a removal',
    async (kind) => {
      const nonApi = reader('nonApi', kind, async () => ({ ok: false, reason: 'http_404', terminal: true }))
      const later = reader('later', 'yt_dlp', async () => ({ ok: true, post: { authorHandle: 'x', text: 'Found' } }))

      expect(await runChain([nonApi, later], xTarget, chainRun())).toMatchObject({
        status: 'readable',
        post: { text: 'Found' }
      })
      expect(later.read).toHaveBeenCalledOnce()
    }
  )

  it('passes the clipped remaining limit through ReaderContext to later extractors', async () => {
    let clock = 1000
    const seenTimeouts: number[] = []
    const first = reader(
      'first',
      'page_meta',
      async () => {
        clock += 700
        return { ok: true, post: { authorHandle: 'poster', videoCount: 1 } }
      },
      1000
    )
    const second: SocialReader = {
      id: 'second',
      kind: 'yt_dlp',
      provides: ['text', 'video'],
      timeoutMs: 900,
      isConfigured: () => true,
      read: vi.fn(async (_target, ctx) => {
        seenTimeouts.push(ctx.timeoutMs)
        return {
          ok: true,
          post: {
            text: 'Hi',
            video: { url: 'https://video.example/clip.mp4', bytes: null, headers: null, hasAudio: true }
          }
        }
      })
    }

    const outcome = await runChain(
      [first, second],
      xTarget,
      chainRun({ deadlineAt: 2000, budgetMs: 1000, now: () => clock })
    )

    expect(outcome.status).toBe('readable')
    expect(seenTimeouts).toEqual([300])
  })

  it('cleans invalid playable video URLs while keeping legitimate HTTPS video and YouTube duration rules', async () => {
    for (const badUrl of [
      'http://video.example/clip.mp4',
      'javascript:alert(1)',
      'https://127.0.0.1/clip.mp4',
      'not-a-url'
    ]) {
      const badVideo = reader('bad', 'mirror_api', async () => ({
        ok: true,
        post: {
          authorHandle: 'poster',
          text: 'Clip',
          videoCount: 1,
          video: { url: badUrl, bytes: null, headers: null, hasAudio: true }
        }
      }))
      const outcome = await runChain([badVideo], xTarget, chainRun())
      expect(outcome).toMatchObject({ status: 'partial', post: { video: null }, missing: ['media', 'video'] })

      const videoOnlyBad = reader('only-bad', 'yt_dlp', async () => ({
        ok: true,
        post: { video: { url: badUrl, bytes: null, headers: null, hasAudio: true } }
      }))
      expect(await runChain([videoOnlyBad], xTarget, chainRun())).toMatchObject({ status: 'failed' })
    }

    const validVideo = reader('ok', 'yt_dlp', async () => ({
      ok: true,
      post: {
        authorHandle: 'poster',
        text: 'Clip',
        videoCount: 1,
        video: { url: 'https://video.example/clip.mp4', bytes: null, headers: null, hasAudio: true }
      }
    }))
    expect(await runChain([validVideo], xTarget, chainRun())).toMatchObject({
      status: 'readable',
      post: { video: { url: 'https://video.example/clip.mp4' } },
      missing: []
    })

    const ytTarget = parseSocialPostUrl('https://www.youtube.com/watch?v=abc_123')!
    const ytValidDurationBadVideo = reader('yt-dur', 'yt_dlp', async () => ({
      ok: true,
      post: {
        authorName: 'Channel',
        externalTitle: 'Video Title',
        durationSec: 90,
        video: { url: 'http://video.example/bad.mp4', bytes: null, headers: null, hasAudio: true }
      }
    }))
    expect(await runChain([ytValidDurationBadVideo], ytTarget, chainRun())).toMatchObject({
      status: 'readable',
      post: { durationSec: 90, video: null },
      missing: []
    })

    const ytNoDurationWithVideo = reader('yt-nodur', 'mirror_api', async () => ({
      ok: true,
      post: {
        authorName: 'Channel',
        externalTitle: 'Video Title',
        durationSec: null,
        video: { url: 'https://video.example/clip.mp4', bytes: null, headers: null, hasAudio: true }
      }
    }))
    expect(await runChain([ytNoDurationWithVideo], ytTarget, chainRun())).toMatchObject({
      status: 'partial',
      missing: ['video']
    })

    const ytUrlOnlyNoDuration = reader('yt-url-only', 'yt_dlp', async () => ({
      ok: true,
      post: {
        durationSec: null,
        videoCount: 1,
        video: { url: 'https://video.example/clip.mp4', bytes: null, headers: null, hasAudio: true }
      }
    }))
    expect(await runChain([ytUrlOnlyNoDuration], ytTarget, chainRun())).toMatchObject({ status: 'failed' })

    const ytDurationOnly = reader('yt-dur-only', 'yt_dlp', async () => ({
      ok: true,
      post: { durationSec: 45 }
    }))
    expect(await runChain([ytDurationOnly], ytTarget, chainRun())).toMatchObject({
      status: 'partial',
      missing: ['text', 'author'],
      post: { durationSec: 45 }
    })
  })
})

describe('block-page check', () => {
  it.each<[string, SocialPlatform]>([
    ['Log in', 'instagram'],
    ['Sign in', 'x'],
    ['Just a moment...', 'reddit'],
    ['Reddit', 'reddit'],
    ['Log in to Instagram', 'instagram'],
    ['   ', 'x']
  ])('counts %j on %s as no text', (text, platform) => {
    expect(isBlockStub(text, platform)).toBe(true)
  })

  it('keeps a short real caption', () => {
    expect(isBlockStub('Nice shot', 'instagram')).toBe(false)
    expect(isBlockStub('Log in now, it is free', 'instagram')).toBe(false)
  })

  it('treats a stub as missing text, so a text-only stub is a partial read', async () => {
    const page = reader('page', 'page_meta', async () => ({
      ok: true,
      post: { authorHandle: 'poster', text: 'Log in' }
    }))

    const outcome = await runChain([page], xTarget, chainRun())

    expect(outcome).toMatchObject({ status: 'partial', post: { text: '' } })
    expect(outcome.status === 'partial' && outcome.missing).toContain('text')
  })
})

describe('model post result', () => {
  const payload = {
    untrusted: true as const,
    author: 'poster',
    text: 'Hello',
    media: [],
    platform: 'reddit' as const,
    handle: 'poster',
    createdAt: null,
    quotedText: '',
    replyCount: null,
    canonicalUrl: 'https://www.reddit.com/comments/1x0b7lo/',
    thread: [],
    replies: [],
    durationSec: null
  }

  it('names the visible fields with a fixed note, and carries no reason code', () => {
    const result = modelPostResult({ ...payload, missing: ['media', 'video'] })

    expect(result).toMatchObject({
      status: 'partial',
      platform: 'Reddit',
      missing: ['media', 'video'],
      note: 'Only the text and author were visible.'
    })
    const text = JSON.stringify(result)
    expect(text).not.toMatch(/http_|exit_|binary_missing|timeout|network_error|no_post_data|missing_post/)
    expect(fourthWallBreak(text, ['read_post'])).toBeUndefined()
  })

  it('marks a complete read readable with no note', () => {
    expect(modelPostResult(payload)).toEqual({
      status: 'readable',
      untrusted: true,
      platform: 'Reddit',
      post: payload
    })
  })

  it('joins three visible fields with commas and "and" from actual data', () => {
    expect(partialNote(postFixture({ photoUrls: ['https://img.example/1.jpg'] }), ['video'])).toBe(
      'Only the text, author and pictures were visible.'
    )
  })

  it('derives partial notes from actually visible data: title plus author with no other fields, and video partial with no photos', () => {
    const titleAuthor = postFixture({
      platform: 'youtube',
      canonicalUrl: 'https://www.youtube.com/watch?v=abc_123',
      text: '',
      externalTitle: 'Title Only',
      authorHandle: '',
      authorName: 'Channel'
    })
    const titlePort = toPostPortResult(titleAuthor, { missing: ['video'] })
    const titleModel = modelPostResult(titlePort)
    expect(titleModel).toMatchObject({
      status: 'partial',
      platform: 'YouTube',
      missing: ['video'],
      note: 'Only the text and author were visible.',
      post: { text: 'Title Only', author: 'Channel', media: [] }
    })
    expect(partialNote(titleAuthor, ['video'])).toBe('Only the text and author were visible.')

    const videoPartialNoPhotos = postFixture({
      platform: 'tiktok',
      canonicalUrl: 'https://www.tiktok.com/@poster/video/123',
      text: 'Clip caption',
      authorHandle: 'poster',
      photoUrls: [],
      imageUrl: null,
      video: null,
      durationSec: null
    })
    expect(modelPostResult(toPostPortResult(videoPartialNoPhotos, { missing: ['video'] })).note).toBe(
      'Only the text and author were visible.'
    )

    const authorOnly = postFixture({ text: '', externalTitle: '', authorHandle: 'poster', authorName: '' })
    expect(modelPostResult(toPostPortResult(authorOnly, { missing: ['text', 'media'] })).note).toBe(
      'Only the author was visible.'
    )

    const videoNoPhotosNoDuration = postFixture({
      platform: 'tiktok',
      text: '',
      externalTitle: '',
      authorHandle: 'poster',
      authorName: '',
      photoUrls: [],
      imageUrl: null,
      durationSec: null,
      video: { url: 'https://video.example/clip.mp4', bytes: null, headers: null, hasAudio: true }
    })
    expect(modelPostResult(toPostPortResult(videoNoPhotosNoDuration, { missing: ['text'] })).note).toBe(
      'Only the author and video were visible.'
    )

    const ytUrlWithTextAuthor = postFixture({
      platform: 'youtube',
      canonicalUrl: 'https://www.youtube.com/watch?v=abc_123',
      text: '',
      externalTitle: 'Title Only',
      authorHandle: '',
      authorName: 'Channel',
      durationSec: null,
      video: { url: 'https://video.example/clip.mp4', bytes: null, headers: null, hasAudio: true }
    })
    const ytPartialModel = modelPostResult(toPostPortResult(ytUrlWithTextAuthor, { missing: ['video'] }))
    expect(ytPartialModel).toMatchObject({
      status: 'partial',
      platform: 'YouTube',
      missing: ['video'],
      note: 'Only the text and author were visible.'
    })
    expect(JSON.stringify(ytPartialModel)).not.toMatch(
      /http_|exit_|binary_missing|timeout|network_error|no_post_data|missing_post|You could not get|It took too long/
    )

    expect(
      partialNote(
        postFixture({
          platform: 'youtube',
          canonicalUrl: 'https://www.youtube.com/watch?v=abc_123',
          text: '',
          externalTitle: '',
          authorHandle: '',
          authorName: 'Channel',
          durationSec: null,
          video: { url: 'https://video.example/clip.mp4', bytes: null, headers: null, hasAudio: true }
        }),
        ['text', 'video']
      )
    ).toBe('Only the author was visible.')
    expect(
      partialNote(
        postFixture({
          platform: 'youtube',
          canonicalUrl: 'https://www.youtube.com/watch?v=abc_123',
          text: '',
          externalTitle: '',
          authorHandle: '',
          authorName: '',
          durationSec: 90,
          video: null
        }),
        ['text', 'author']
      )
    ).toBe('Only the video was visible.')
  })

  it('keeps reader reasons out of a partial read from the reader port', async () => {
    const feed = readFileSync(new URL('../fixtures/social/reddit-post.rss', import.meta.url), 'utf8').replace(
      'https://i.redd.it/sample.jpeg',
      'https://v.redd.it/sample'
    )
    const fetcher = vi.fn(async () => new Response(feed))
    const runExtractor = vi.fn(async () => ({ reason: 'exit_1' }))
    const viewer = new SocialPostViewer(settings, {
      fetcher,
      runExtractor,
      warn: vi.fn(),
      lookup: async () => ['8.8.8.8']
    })
    const replies = new ReplyReader(
      { ...settings, maxReplies: 5, maxReplyChars: 280 },
      { fetcher, runExtractor, warn: vi.fn(), youtubeApiKey: () => undefined }
    )
    const port = createSocialPostPort(viewer, replies)

    const read = await port.read(
      'https://www.reddit.com/r/osugame/comments/1x0b7lo/sample/',
      new AbortController().signal
    )
    const result = modelPostResult(read)

    expect(result.status).toBe('partial')
    expect(result.missing).toContain('video')
    expect(JSON.stringify(result)).not.toContain('exit_1')
  })
})

describe('intake failures close the link to read_post and read_page', () => {
  const seenPost = createTurnSources()
  seenPost.add('https://x.com/example_user/status/123', 'message')
  const triedFailed = {
    sources: seenPost,
    signal: new AbortController().signal,
    intakeTriedSocialUrls: [{ url: xTarget.canonicalUrl, failed: true }]
  }
  const triedRead = {
    sources: seenPost,
    signal: new AbortController().signal,
    intakeTriedSocialUrls: [{ url: xTarget.canonicalUrl, failed: false }]
  }
  const unreachable = async (): Promise<never> => {
    throw new Error('a reader must not run')
  }
  const postPort: PostPort = { read: unreachable }
  const pagePort: PagePort = { read: unreachable, download: unreachable }

  it('refuses read_post with the already-tried sentence, without running a reader', async () => {
    const tool = readPostTool({ post: postPort, filesDir: '/tmp' })
    const refused = failedOf(
      await tool.handler({ url: 'https://x.com/example_user/status/123' }, triedFailed as unknown as ToolContext)
    )

    expect(refused).toMatchObject({ kind: 'refused', code: 'already_tried' })
    expect(JSON.parse(outcomePayload(refused)).outcome).toBe('You already tried that link and it would not open.')
  })

  it('refuses read_page for the same address', async () => {
    const tool = readPageTool({ page: pagePort, filesDir: '/tmp' })
    const refused = failedOf(
      await tool.handler({ url: 'https://x.com/example_user/status/123' }, triedFailed as unknown as ToolContext)
    )

    expect(refused).toMatchObject({ kind: 'refused', code: 'already_tried' })
  })

  it('still lets read_post fetch a post intake read as text', async () => {
    const readPost = vi.fn(async () => ({
      untrusted: true as const,
      author: 'a',
      text: 'b',
      media: [],
      platform: 'x' as const,
      handle: 'a',
      createdAt: null,
      quotedText: '',
      replyCount: null,
      canonicalUrl: xTarget.canonicalUrl,
      thread: [],
      replies: [],
      durationSec: null
    }))
    const tool = readPostTool({ post: { read: readPost }, filesDir: '/tmp' })

    const result = await tool.handler(
      { url: 'https://x.com/example_user/status/123' },
      triedRead as unknown as ToolContext
    )

    expect(result).toMatchObject({ ok: true, data: { status: 'readable' } })
    expect(readPost).toHaveBeenCalledOnce()
  })

  it('records a failed social read at intake as tried and failed', async () => {
    const link = createLinkReader({
      viewer: { lookup: async () => ({ status: 'failed', platform: 'x', reason: 'http_404' }) },
      findTarget: () => xTarget,
      model: 'fake-media-model',
      limits
    })

    const result = await link.read(['https://x.com/example_user/status/123'], 5000, { media: true, social: true })

    expect(result.tried).toEqual([
      { url: 'https://x.com/example_user/status/123', failed: true },
      { url: xTarget.canonicalUrl, failed: true }
    ])
    expect(result.unreadable).toEqual([{ kind: 'X link', reason: 'link' }])
  })

  it('records a successful or partial social read at intake with ModelPostResult, fixed note and rich internal post', async () => {
    const richPartial = postFixture({
      text: '',
      externalTitle: 'Title Only',
      photoUrls: ['https://img.example/p1.jpg'],
      imageUrl: 'https://img.example/p1.jpg'
    })
    const partialReader = createLinkReader({
      viewer: {
        lookup: async () => ({ status: 'found', post: richPartial, missing: ['video'] })
      },
      findTarget: () => xTarget,
      model: 'fake-media-model',
      limits
    })

    const partialResult = await partialReader.read(['https://x.com/example_user/status/123'], 5000, {
      media: true,
      social: true
    })

    // The post's canonical address may differ from the one asked for; both count as tried, neither as failed.
    expect(partialResult.tried?.length).toBeGreaterThan(0)
    expect(partialResult.tried?.every((entry) => entry.failed === false)).toBe(true)
    expect(partialResult.tried).toContainEqual({ url: xTarget.canonicalUrl, failed: false })
    expect(partialResult.links?.[0]?.note).toBe('Only the text, author and pictures were visible.')
    expect(partialResult.links?.[0]?.result).toEqual({
      status: 'partial',
      untrusted: true,
      platform: 'X',
      post: {
        untrusted: true,
        author: 'Example Person',
        text: 'Title Only',
        media: ['https://img.example/p1.jpg'],
        platform: 'x',
        handle: 'example_user',
        createdAt: null,
        quotedText: '',
        replyCount: null,
        canonicalUrl: 'https://x.com/example_user/status/123',
        thread: [],
        replies: [],
        durationSec: null
      },
      missing: ['video'],
      note: 'Only the text, author and pictures were visible.'
    })
    expect(partialResult.links?.[0]?.post.externalTitle).toBe('Title Only')
    expect(partialResult.links?.[0]?.post.photoUrls).toEqual(['https://img.example/p1.jpg'])

    const readableReader = createLinkReader({
      viewer: {
        lookup: async () => ({ status: 'found', post: postFixture() })
      },
      findTarget: () => xTarget,
      model: 'fake-media-model',
      limits
    })
    const readableResult = await readableReader.read(['https://x.com/example_user/status/123'], 5000, {
      media: true,
      social: true
    })
    expect(readableResult.links?.[0]?.note).toBeUndefined()
    expect(readableResult.links?.[0]?.result).toMatchObject({ status: 'readable', untrusted: true, platform: 'X' })
  })

  it('keeps the plain outcome as the only model payload on a failed read_post call', async () => {
    const viewer = new SocialPostViewer(settings, {
      fetcher: vi.fn(async () => new Response('secret error body', { status: 404 })),
      runExtractor: vi.fn(async () => ({ reason: 'unused' })),
      lookup: async () => ['8.8.8.8'],
      warn: vi.fn()
    })
    const replies = new ReplyReader(
      { ...settings, maxReplies: 5, maxReplyChars: 280 },
      { fetcher: vi.fn(async () => new Response('', { status: 404 })), runExtractor: vi.fn(), warn: vi.fn() }
    )
    const tool = readPostTool({ post: createSocialPostPort(viewer, replies), filesDir: '/tmp' })
    const failed = failedOf(
      await tool.handler({ url: 'https://x.com/example_user/status/123' }, {
        signal: new AbortController().signal,
        sources: seenPost
      } as ToolContext)
    )
    expect(JSON.parse(outcomePayload(failed))).toEqual({
      ok: false,
      outcome: 'You could not get that post or page to open. It may be private, removed or blocked.'
    })
  })

  it('preserves the original address and resolved share canonical alias on failure and refuses all spellings across read_post and read_page', async () => {
    const shareOriginal = 'https://www.reddit.com/r/example_sub/s/AbC123xyz?utm=share'
    const shareCanonical = 'https://www.reddit.com/r/example_sub/s/AbC123xyz/'
    const resolvedCanonical = 'https://www.reddit.com/comments/abc123/'
    const resolvedAlias = 'https://www.reddit.com/r/example_sub/comments/abc123/a_post/'

    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url === shareCanonical) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://www.reddit.com/r/example_sub/comments/abc123/a_post/?share_id=x' }
        })
      }
      if (url === 'https://www.reddit.com/comments/abc123/.rss?limit=1') {
        return new Response('', { status: 500 })
      }
      throw new Error(`unexpected endpoint ${url}`)
    })
    const runExtractor = vi.fn(async () => ({ reason: 'exit_1' }))
    const viewer = new SocialPostViewer(settings, {
      fetcher,
      runExtractor,
      lookup: async () => ['8.8.8.8'],
      warn: vi.fn()
    })
    const link = createLinkReader({
      viewer,
      findTarget: (text) => findSocialPostTarget(text),
      model: 'fake-media-model',
      limits
    })

    const intake = await link.read([`see ${shareOriginal}`], 5000, { media: true, social: true })

    expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual([
      shareCanonical,
      'https://www.reddit.com/comments/abc123/.rss?limit=1'
    ])
    expect(intake.tried).toEqual([
      { url: shareOriginal, failed: true },
      { url: shareCanonical, failed: true },
      { url: resolvedCanonical, failed: true }
    ])

    const sources = createTurnSources()
    for (const entry of intake.tried ?? []) sources.add(entry.url, 'intake')
    sources.add(resolvedAlias, 'message')
    const httpAlias = resolvedAlias.replace('https:', 'http:')
    sources.add(httpAlias, 'message')
    const context = {
      sources,
      signal: new AbortController().signal,
      intakeTriedSocialUrls: intake.tried
    } as unknown as ToolContext
    const postTool = readPostTool({ post: postPort, filesDir: '/tmp' })
    const pageTool = readPageTool({ page: pagePort, filesDir: '/tmp' })

    for (const candidate of [shareOriginal, shareCanonical, resolvedCanonical, resolvedAlias, httpAlias]) {
      expect(failedOf(await postTool.handler({ url: candidate }, context))).toMatchObject({
        kind: 'refused',
        code: 'already_tried'
      })
      expect(failedOf(await pageTool.handler({ url: candidate }, context))).toMatchObject({
        kind: 'refused',
        code: 'already_tried'
      })
    }
  })
})

describe('media download headers', () => {
  it('sends only the user agent and referrer to a media host', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(Buffer.from('mp4'), { headers: { 'content-type': 'video/mp4' } }))
    try {
      const port = createFetchPagePort({ lookup: async () => ['8.8.8.8'] })
      await port.download('https://video.example/clip.mp4', new AbortController().signal, 1000, {
        'User-Agent': 'UA/1',
        Referer: 'https://www.example.com/',
        Cookie: 'session=secret'
      })

      const headers = new Headers((fetchSpy.mock.calls[0]![1] as RequestInit).headers)
      expect(headers.get('user-agent')).toBe('UA/1')
      expect(headers.get('referer')).toBe('https://www.example.com/')
      expect(headers.has('cookie')).toBe(false)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('passes the video headers of a linked post to the video download', async () => {
    const download = vi.fn(async () => ({ data: Buffer.from('mp4'), contentType: 'video/mp4' }))
    const link = createLinkReader({
      viewer: {
        lookup: async () => ({
          status: 'found',
          post: postFixture({
            videoCount: 1,
            durationSec: 10,
            video: {
              url: 'https://video.example/clip.mp4',
              bytes: null,
              headers: { 'User-Agent': 'UA/1' },
              hasAudio: true
            }
          })
        })
      },
      findTarget: () => xTarget,
      watcher: {
        watch: async () => ({
          reading: { description: 'x' },
          usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
          costUsd: 0,
          model: 'm'
        })
      },
      download,
      model: 'fake-media-model',
      limits
    })

    await link.read(['https://x.com/example_user/status/123'], 5000, { media: true, social: true })

    expect(download).toHaveBeenCalledWith(
      'https://video.example/clip.mp4',
      expect.any(AbortSignal),
      DEFAULT_MEDIA_LIMITS.maxBytes,
      { 'User-Agent': 'UA/1' },
      undefined,
      'x'
    )
  })
})
