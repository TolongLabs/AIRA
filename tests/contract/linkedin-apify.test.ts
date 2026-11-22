import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig, parseConfig } from '../../src/config/loader.js'
import { recordSocialLookup } from '../../src/records/autofetch.js'
import { ensureChat, setChatStatus } from '../../src/settings/chats.js'
import { enabledMirrorAsset, mirrorAssetPlatform } from '../../src/social/mirror-readers.js'
import { groupOperations, socialCapabilities, switchablePlatforms } from '../../src/social/readers.js'
import { ReplyReader } from '../../src/social/replies/service.js'
import { resolveShareLink } from '../../src/social/share.js'
import { findSocialPostTargets, parseSocialPostUrl, recognitionOnlyName } from '../../src/social/urls.js'
import { SocialPostViewer } from '../../src/social/viewer.js'
import { openTurn, receiveInbound } from '../../src/storage/turns.js'
import { EXCLUDED_DOMAINS } from '../../src/tools/excluded-hosts.js'
import { queueModel, startApp } from '../support/app.js'
import { tmpStorage } from '../support/tmp.js'

const ACTIVITY_ID = '7302346926123798528'
const UGC_ID = '7302346926123798529'
const SHARE_ID = '7302346926123798530'
const VIDEO_ID = '7302346926123798531'

const CANONICAL_ACTIVITY = `https://www.linkedin.com/feed/update/urn:li:activity:${ACTIVITY_ID}/`
const CANONICAL_UGC = `https://www.linkedin.com/feed/update/urn:li:ugcPost:${UGC_ID}/`
const CANONICAL_SHARE = `https://www.linkedin.com/feed/update/urn:li:share:${SHARE_ID}/`
const CANONICAL_VIDEO = `https://www.linkedin.com/feed/update/urn:li:activity:${VIDEO_ID}/`

const POST_WITH_SUFFIX = `https://www.linkedin.com/posts/alice_hello-world-activity-${ACTIVITY_ID}-jitu`
const POST_APEX_UNDERSCORE = `https://linkedin.com/posts/alice_activity-${ACTIVITY_ID}`
const SHORT_LINK = 'https://lnkd.in/AbC123x'
const SHORT_POST_LINK = 'https://lnkd.in/p/AbC123x'
const X_URL = 'https://x.com/example/status/1234567890123456789'

const PHOTO_1 = 'https://media.licdn.com/dms/image/v2/D5622AQPhoto1/feedshare-shrink_800/0/1730000000000?e=1&v=beta&t=a'
const PHOTO_2 = 'https://media.licdn.com/dms/image/v2/D5622AQPhoto2/feedshare-shrink_800/0/1730000000001?e=1&v=beta&t=b'
const AVATAR =
  'https://media.licdn.com/dms/image/v2/D5603AQAvatar/profile-displayphoto-shrink_100_100/0/1730000000002?e=1&v=beta&t=c'
const VIDEO_URL =
  'https://dms.licdn.com/playlist/vid/v2/D5605AQVideo/mp4-720p-30fp-crf28/0/1730000000003?e=1&v=beta&t=d'
const VIDEO_THUMB = 'https://media.licdn.com/dms/image/v2/D5605AQThumb/videocover-high/0/1730000000004?e=1&v=beta&t=e'

const IMAGE_FIXTURE = [
  {
    post: {
      id: ACTIVITY_ID,
      urn: {
        activity_urn: ACTIVITY_ID,
        ugcPost_urn: UGC_ID,
        share_urn: SHARE_ID
      },
      text: 'Shipping the new update today.',
      created_at: {
        timestamp: 1733574820000
      }
    },
    author: {
      name: 'Alice Example'
    },
    media: [
      { type: 'image', url: PHOTO_1 },
      { type: 'image', url: AVATAR },
      { type: 'image', url: 'http://media.licdn.com/insecure.jpg' },
      { type: 'image', url: 'https://evil.example/foreign.jpg' },
      { type: 'image', url: 'https://licdn.com/bare-host.jpg' },
      { type: 'image', url: PHOTO_2 },
      { type: 'image', url: PHOTO_1 }
    ]
  }
]

const VIDEO_FIXTURE = [
  {
    post: {
      id: '9999999999999999999',
      urn: {
        activity_urn: VIDEO_ID,
        ugcPost_urn: '8888888888888888888',
        share_urn: '7777777777777777777'
      },
      text: 'Demo walkthrough clip.',
      created_at: {
        timestamp: 1733574900000
      }
    },
    author: {
      name: 'Bob Example'
    },
    media: [
      {
        type: 'video',
        video_url: VIDEO_URL,
        thumbnail: VIDEO_THUMB,
        duration: 42500
      }
    ]
  }
]

const publicLookup = async () => ['93.184.216.34']

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('linkedin Apify mirror', () => {
  it('parses /posts/, /feed/update/ URN, and lnkd.in links while reserving other paths and subdomains', () => {
    expect(EXCLUDED_DOMAINS).toEqual([])

    for (const url of [POST_WITH_SUFFIX, `${POST_WITH_SUFFIX}/`, POST_APEX_UNDERSCORE, `${POST_APEX_UNDERSCORE}/`]) {
      const parsed = parseSocialPostUrl(url)
      expect(parsed).toMatchObject({
        platform: 'linkedin',
        id: ACTIVITY_ID,
        lookupKey: `linkedin:${ACTIVITY_ID}`,
        canonicalUrl: CANONICAL_ACTIVITY
      })
      expect(parsed?.needsRedirect).toBeUndefined()
    }

    expect(parseSocialPostUrl(`https://www.linkedin.com/feed/update/urn:li:activity:${ACTIVITY_ID}`)).toMatchObject({
      platform: 'linkedin',
      id: ACTIVITY_ID,
      lookupKey: `linkedin:${ACTIVITY_ID}`,
      canonicalUrl: CANONICAL_ACTIVITY
    })
    expect(parseSocialPostUrl(`https://linkedin.com/feed/update/urn:li:ugcPost:${UGC_ID}/`)).toMatchObject({
      platform: 'linkedin',
      id: UGC_ID,
      lookupKey: `linkedin:${UGC_ID}`,
      canonicalUrl: CANONICAL_UGC
    })
    expect(parseSocialPostUrl(`https://www.linkedin.com/feed/update/urn:li:share:${SHARE_ID}`)).toMatchObject({
      platform: 'linkedin',
      id: SHARE_ID,
      lookupKey: `linkedin:${SHARE_ID}`,
      canonicalUrl: CANONICAL_SHARE
    })

    expect(parseSocialPostUrl(SHORT_LINK)).toMatchObject({
      platform: 'linkedin',
      id: 'AbC123x',
      lookupKey: 'linkedin:share:AbC123x',
      canonicalUrl: SHORT_LINK,
      needsRedirect: true
    })
    expect(parseSocialPostUrl(SHORT_POST_LINK)).toMatchObject({
      platform: 'linkedin',
      id: 'AbC123x',
      lookupKey: 'linkedin:share:p:AbC123x',
      canonicalUrl: SHORT_POST_LINK,
      needsRedirect: true
    })

    expect(recognitionOnlyName(POST_WITH_SUFFIX)).toBeNull()

    for (const nonPost of [
      'https://www.linkedin.com/in/example',
      'https://www.linkedin.com/company/example',
      'https://www.linkedin.com/posts/alice-activity-12345-abcd',
      'https://www.linkedin.com/posts/alice-activity-12345678901234567890-abcd',
      `https://www.linkedin.com/posts/alice-ugcPost-${UGC_ID}-abcd`,
      'https://www.linkedin.com/feed/update/urn:li:comment:1234567890123456789',
      'https://lnkd.in/',
      'https://lnkd.in/p',
      'https://lnkd.in/p/'
    ]) {
      expect(parseSocialPostUrl(nonPost), nonPost).toBeNull()
    }

    for (const host of ['de.linkedin.com', 'm.linkedin.com', 'www.lnkd.in']) {
      const url = `https://${host}/example/status/1234567890123456789`
      expect(parseSocialPostUrl(url)).toBeNull()
      expect(findSocialPostTargets(`${url} ${X_URL}`).map((t) => t.platform)).toEqual(['x'])
    }
  })

  it('resolves lnkd.in share links to canonical LinkedIn targets and rejects non-post redirects', async () => {
    const bareShare = parseSocialPostUrl(SHORT_LINK)!
    const resolvedPost = await resolveShareLink(
      bareShare,
      async () => new Response(null, { status: 302, headers: { location: `${POST_WITH_SUFFIX}?rcm=secret` } })
    )
    expect(resolvedPost).toMatchObject({
      platform: 'linkedin',
      id: ACTIVITY_ID,
      lookupKey: `linkedin:${ACTIVITY_ID}`,
      canonicalUrl: CANONICAL_ACTIVITY
    })

    const prefixedShare = parseSocialPostUrl(SHORT_POST_LINK)!
    const resolvedUgc = await resolveShareLink(
      prefixedShare,
      async () => new Response(null, { status: 301, headers: { location: CANONICAL_UGC } })
    )
    expect(resolvedUgc).toMatchObject({
      platform: 'linkedin',
      id: UGC_ID,
      lookupKey: `linkedin:${UGC_ID}`,
      canonicalUrl: CANONICAL_UGC
    })

    const profileRedirect = await resolveShareLink(
      bareShare,
      async () => new Response(null, { status: 302, headers: { location: 'https://www.linkedin.com/in/example' } })
    )
    expect(profileRedirect).toBeNull()
  })

  it('reads image posts via Apify, excludes avatars and untrusted hosts, and gates attachments on read_and_group', async () => {
    const fetcher = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(String(input)).toBe(
        'https://api.apify.com/v2/acts/apimaestro~linkedin-post-detail/run-sync-get-dataset-items?timeout=30&memory=256'
      )
      expect(init?.method).toBe('POST')
      expect(init?.redirect).toBe('manual')
      const headers = new Headers(init?.headers)
      expect(headers.get('authorization')).toBe('Bearer test-apify-token')
      expect(JSON.parse(String(init?.body))).toEqual({
        post_urls: [CANONICAL_ACTIVITY]
      })
      return jsonResponse(IMAGE_FIXTURE)
    })

    const readOnlyViewer = new SocialPostViewer(
      {
        mirrors: { linkedin: 'read', apifyToken: 'test-apify-token' },
        timeoutMs: 12000,
        maxTextChars: 1500,
        cacheTtlMs: 0,
        maxCacheEntries: 16,
        ytDlpPath: 'yt-dlp'
      },
      { fetcher, lookup: publicLookup }
    )
    const readOnly = await readOnlyViewer.lookup(parseSocialPostUrl(POST_WITH_SUFFIX)!)
    expect(readOnly.status).toBe('found')
    if (readOnly.status !== 'found') throw new Error('expected found')
    expect(readOnly.post.text).toBe('Shipping the new update today.')
    expect(readOnly.post.authorName).toBe('Alice Example')
    expect(readOnly.post.createdAt).toBe(new Date(1733574820000).toISOString())
    expect(readOnly.post.photoUrls).toEqual([PHOTO_1, PHOTO_2])
    expect(readOnly.post.photoCount).toBe(2)
    expect(readOnly.post.imageUrl).toBe(PHOTO_1)
    expect(readOnly.post.attachments).toBeUndefined()

    const groupViewer = new SocialPostViewer(
      {
        mirrors: { linkedin: 'read_and_group', apifyToken: 'test-apify-token' },
        timeoutMs: 12000,
        maxTextChars: 1500,
        cacheTtlMs: 0,
        maxCacheEntries: 16,
        ytDlpPath: 'yt-dlp'
      },
      { fetcher, lookup: publicLookup }
    )
    const forGroup = await groupViewer.lookup(parseSocialPostUrl(CANONICAL_ACTIVITY)!)
    expect(forGroup.status).toBe('found')
    if (forGroup.status !== 'found') throw new Error('expected found')
    expect(forGroup.post.attachments).toEqual([
      { kind: 'image', owner: `linkedin:${ACTIVITY_ID}`, url: PHOTO_1 },
      { kind: 'image', owner: `linkedin:${ACTIVITY_ID}`, url: PHOTO_2 }
    ])

    const cappedPhotos = Array.from({ length: 25 }, (_, i) => ({
      type: 'image',
      url: `https://media.licdn.com/dms/image/v2/photo-${i}`
    }))
    const cappedViewer = new SocialPostViewer(
      {
        mirrors: { linkedin: 'read_and_group', apifyToken: 'test-apify-token' },
        timeoutMs: 12000,
        maxTextChars: 1500,
        cacheTtlMs: 0,
        maxCacheEntries: 16,
        ytDlpPath: 'yt-dlp'
      },
      {
        fetcher: async () =>
          jsonResponse([{ ...IMAGE_FIXTURE[0], post: { ...IMAGE_FIXTURE[0]!.post }, media: cappedPhotos }]),
        lookup: publicLookup
      }
    )
    const cappedResult = await cappedViewer.lookup(parseSocialPostUrl(CANONICAL_UGC)!)
    expect(cappedResult.status).toBe('found')
    if (cappedResult.status !== 'found') throw new Error('expected found')
    expect(cappedResult.post.photoUrls).toHaveLength(20)
    expect(cappedResult.post.attachments).toHaveLength(20)
  })

  it('reads video posts via any matching URN, converts duration ms to s, and keeps thumbnail out of photoUrls', async () => {
    const fetcher = vi.fn(async () => jsonResponse(VIDEO_FIXTURE))
    const viewer = new SocialPostViewer(
      {
        mirrors: { linkedin: 'read_and_group', apifyToken: 'test-apify-token' },
        timeoutMs: 12000,
        maxTextChars: 1500,
        cacheTtlMs: 0,
        maxCacheEntries: 16,
        ytDlpPath: 'yt-dlp'
      },
      { fetcher, lookup: publicLookup }
    )
    const result = await viewer.lookup(parseSocialPostUrl(CANONICAL_VIDEO)!)
    expect(result.status).toBe('found')
    if (result.status !== 'found') throw new Error('expected found')
    expect(result.post.authorName).toBe('Bob Example')
    expect(result.post.photoUrls).toEqual([])
    expect(result.post.photoCount).toBe(0)
    expect(result.post.imageUrl).toBe(VIDEO_THUMB)
    expect(result.post.durationSec).toBe(42.5)
    expect(result.post.video).toEqual({
      url: VIDEO_URL,
      mirror: 'linkedin',
      bytes: null,
      hasAudio: null,
      headers: null
    })
    expect(result.post.attachments).toEqual([
      {
        kind: 'video',
        owner: `linkedin:${VIDEO_ID}`,
        video: result.post.video,
        durationSec: 42.5
      }
    ])

    // Matches ugcPost_urn and share_urn as well.
    const ugcViewer = new SocialPostViewer(
      {
        mirrors: { linkedin: 'read', apifyToken: 'test-apify-token' },
        timeoutMs: 12000,
        maxTextChars: 1500,
        cacheTtlMs: 0,
        maxCacheEntries: 16,
        ytDlpPath: 'yt-dlp'
      },
      { fetcher, lookup: publicLookup }
    )
    expect(
      (
        await ugcViewer.lookup(
          parseSocialPostUrl('https://www.linkedin.com/feed/update/urn:li:ugcPost:8888888888888888888/')!
        )
      ).status
    ).toBe('found')
    expect(
      (
        await ugcViewer.lookup(
          parseSocialPostUrl('https://www.linkedin.com/feed/update/urn:li:share:7777777777777777777/')!
        )
      ).status
    ).toBe('found')

    // Excludes profile-displayphoto URLs even if returned inside video media fields.
    const avatarVideoViewer = new SocialPostViewer(
      {
        mirrors: { linkedin: 'read_and_group', apifyToken: 'test-apify-token' },
        timeoutMs: 12000,
        maxTextChars: 1500,
        cacheTtlMs: 0,
        maxCacheEntries: 16,
        ytDlpPath: 'yt-dlp'
      },
      {
        fetcher: async () =>
          jsonResponse([
            {
              ...VIDEO_FIXTURE[0],
              media: [{ type: 'video', video_url: AVATAR, thumbnail: AVATAR, duration: 10000 }]
            }
          ]),
        lookup: publicLookup
      }
    )
    const stripped = await avatarVideoViewer.lookup(parseSocialPostUrl(CANONICAL_VIDEO)!)
    expect(stripped.status).toBe('found')
    if (stripped.status !== 'found') throw new Error('expected found')
    expect(stripped.post.imageUrl).toBeNull()
    expect(stripped.post.video).toBeNull()
    expect(stripped.post.attachments).toBeUndefined()
  })

  it('rejects identity mismatch, handles empty datasets, and stays inactive when off or without token', async () => {
    const mismatchViewer = new SocialPostViewer(
      {
        mirrors: { linkedin: 'read', apifyToken: 'test-apify-token' },
        timeoutMs: 12000,
        maxTextChars: 1500,
        cacheTtlMs: 0,
        maxCacheEntries: 16,
        ytDlpPath: 'yt-dlp'
      },
      { fetcher: vi.fn(async () => jsonResponse(VIDEO_FIXTURE)), lookup: publicLookup }
    )
    expect(await mismatchViewer.lookup(parseSocialPostUrl(CANONICAL_ACTIVITY)!)).toMatchObject({
      status: 'failed',
      platform: 'linkedin',
      reason: 'identity_mismatch'
    })

    const emptyViewer = new SocialPostViewer(
      {
        mirrors: { linkedin: 'read', apifyToken: 'test-apify-token' },
        timeoutMs: 12000,
        maxTextChars: 1500,
        cacheTtlMs: 0,
        maxCacheEntries: 16,
        ytDlpPath: 'yt-dlp'
      },
      { fetcher: vi.fn(async () => jsonResponse([])), lookup: publicLookup }
    )
    expect(await emptyViewer.lookup(parseSocialPostUrl(CANONICAL_ACTIVITY)!)).toMatchObject({
      status: 'failed',
      platform: 'linkedin',
      reason: 'no_post_data'
    })

    const noNetwork = vi.fn(async () => {
      throw new Error('must not call Apify when gated')
    })
    for (const mirrors of [{ linkedin: 'read_and_group' as const }, { linkedin: 'off' as const, apifyToken: 'tok' }]) {
      const gatedViewer = new SocialPostViewer(
        {
          mirrors,
          timeoutMs: 12000,
          maxTextChars: 1500,
          cacheTtlMs: 0,
          maxCacheEntries: 16,
          ytDlpPath: 'yt-dlp'
        },
        { fetcher: noNetwork, lookup: publicLookup }
      )
      expect((await gatedViewer.lookup(parseSocialPostUrl(CANONICAL_ACTIVITY)!)).status).toBe('failed')
    }
    expect(noNetwork).not.toHaveBeenCalled()
  })

  it('gates capabilities, switches, asset policy, 20s viewer budget, replies, records, config, and app warnings', async () => {
    expect(switchablePlatforms().read).toContain('linkedin')
    expect(switchablePlatforms().fetch).toContain('linkedin')

    const offCaps = socialCapabilities(true, { linkedin: 'off', apifyToken: 'tok' })
    expect(offCaps['features.social'].some((e) => e.id === 'linkedin')).toBe(false)
    expect(offCaps['features.autofetch'].some((e) => e.id === 'linkedin')).toBe(false)

    const noKeyCaps = socialCapabilities(true, { linkedin: 'read_and_group' })
    expect(noKeyCaps['features.social'].some((e) => e.id === 'linkedin')).toBe(false)
    expect(noKeyCaps['features.autofetch'].some((e) => e.id === 'linkedin')).toBe(false)

    const readCaps = socialCapabilities(true, { linkedin: 'read', apifyToken: 'tok' })
    expect(readCaps['features.social'].find((e) => e.id === 'linkedin')).toEqual({
      id: 'linkedin',
      name: 'LinkedIn',
      operations: ['text', 'preview', 'photos', 'video']
    })
    expect(readCaps['features.autofetch'].some((e) => e.id === 'linkedin')).toBe(false)

    const groupCaps = socialCapabilities(true, { linkedin: 'read_and_group', apifyToken: 'tok' })
    expect(groupCaps['features.autofetch'].find((e) => e.id === 'linkedin')?.operations).toEqual(['photos', 'video'])
    expect(groupOperations('linkedin', { linkedin: 'read_and_group', apifyToken: 'tok' }, 'c_1', false)).toEqual([
      'photos',
      'video'
    ])
    expect(groupOperations('linkedin', { linkedin: 'read_and_group', apifyToken: 'tok' }, 'c_1', true)).toEqual([
      'photos',
      'video'
    ])

    expect(mirrorAssetPlatform(PHOTO_1)).toBe('linkedin')
    expect(mirrorAssetPlatform(VIDEO_URL)).toBe('linkedin')
    expect(mirrorAssetPlatform(AVATAR)).toBeUndefined()
    expect(mirrorAssetPlatform('https://licdn.com/bare.jpg')).toBeUndefined()
    expect(enabledMirrorAsset(PHOTO_1, 'linkedin', { linkedin: 'read', apifyToken: 'tok' })).toBe(true)
    expect(enabledMirrorAsset(PHOTO_1, 'linkedin', { linkedin: 'read' })).toBe(false)
    expect(enabledMirrorAsset(PHOTO_1, 'linkedin', { linkedin: 'off', apifyToken: 'tok' })).toBe(false)
    expect(enabledMirrorAsset(AVATAR, 'linkedin', { linkedin: 'read', apifyToken: 'tok' })).toBe(false)

    // Config schema and repository config.yml default to off.
    expect(loadConfig('config.yml').social.mirrors.linkedin).toBe('off')
    const rawConfig = readFileSync('config.yml', 'utf8')
    expect(parseConfig(rawConfig.replace('linkedin: off', 'linkedin: read_and_group')).social.mirrors.linkedin).toBe(
      'read_and_group'
    )

    // Replies stay unsupported.
    const replies = new ReplyReader({
      timeoutMs: 1000,
      maxReplies: 5,
      maxReplyChars: 280,
      cacheTtlMs: 0,
      maxCacheEntries: 4,
      ytDlpPath: 'yt-dlp'
    })
    expect(await replies.read(parseSocialPostUrl(CANONICAL_ACTIVITY)!)).toEqual({
      status: 'failed',
      platform: 'linkedin',
      reason: 'unsupported'
    })

    // Record keeping recognizes linkedin.apify in ATTEMPT_IDS.
    const storage = tmpStorage()
    const chat = ensureChat(storage, { waId: 'fake-chat-li-record', type: 'group' })
    setChatStatus(storage, { chatId: chat.chatId, status: 'active', actor: 'test' })
    receiveInbound(storage, { chatId: chat.chatId, mid: 'mid-li-1', senderId: 'subj-li-1' })
    openTurn(storage, {
      turnId: 'turn-li-1',
      chatId: chat.chatId,
      senderId: 'subj-li-1',
      kind: 'reply',
      mids: ['mid-li-1']
    })
    const now = new Date('2026-11-22T00:00:00.000Z')
    storage.tx((db) =>
      recordSocialLookup(
        db,
        { turnId: 'turn-li-1' },
        {
          target: parseSocialPostUrl(CANONICAL_ACTIVITY)!,
          started: now,
          ended: now,
          lookup: { status: 'failed', platform: 'linkedin', reason: 'no_post_data' },
          trace: { attempts: [{ readerId: 'linkedin.apify', ok: false, reason: 'no_post_data', ms: 42 }] }
        }
      )
    )
    const recordedAttempts = storage.read((db) =>
      db.prepare('SELECT attempts FROM social_turn_lookup WHERE turn_id = ?').pluck().get('turn-li-1')
    ) as string
    expect(JSON.parse(recordedAttempts)).toEqual([
      { reader: 'linkedin.apify', ok: false, reason: 'no_post_data', ms: 42 }
    ])

    // Viewer grants linkedin a 20,000 ms budget even when settings.timeoutMs is lower.
    vi.useFakeTimers()
    const budgetViewer = new SocialPostViewer(
      {
        mirrors: { linkedin: 'read', apifyToken: 'test-apify-token' },
        timeoutMs: 1000,
        maxTextChars: 1500,
        cacheTtlMs: 0,
        maxCacheEntries: 4,
        ytDlpPath: 'yt-dlp'
      },
      {
        fetcher: async (_input, init) =>
          new Promise<Response>((resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
            setTimeout(() => resolve(jsonResponse(IMAGE_FIXTURE)), 15_000)
          }),
        lookup: publicLookup
      }
    )
    const pendingLookup = budgetViewer.lookup(parseSocialPostUrl(CANONICAL_ACTIVITY)!)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await pendingLookup).toMatchObject({ status: 'found', post: { id: ACTIVITY_ID } })
    vi.useRealTimers()

    // App warns social.mirror_off when enabled without Apify key, and accepts APIFY_API_KEY.
    const withoutKey = await startApp(queueModel([{ text: 'ok' }]), {
      config: (config) => {
        config.social.mirrors.linkedin = 'read'
      },
      env: {}
    })
    expect(withoutKey.logs).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        event: 'social.mirror_off',
        platform: 'linkedin',
        reason: 'no_key'
      })
    )

    const withKey = await startApp(queueModel([{ text: 'ok' }]), {
      config: (config) => {
        config.social.mirrors.linkedin = 'read'
      },
      env: { APIFY_API_KEY: 'test-apify-key' }
    })
    expect(
      withKey.logs.some((entry) => entry['event'] === 'social.mirror_off' && entry['platform'] === 'linkedin')
    ).toBe(false)
  })
})
