import { describe, expect, it, vi } from 'vitest'
import { enabledMirrorAsset, mirrorAssetPlatform } from '../../src/social/mirror-readers.js'
import { groupOperations, socialCapabilities, switchablePlatforms } from '../../src/social/readers.js'
import { resolveShareLink } from '../../src/social/share.js'
import { findSocialPostTargets, parseSocialPostUrl, recognitionOnlyName } from '../../src/social/urls.js'
import { SocialPostViewer } from '../../src/social/viewer.js'

const NOTE_ID = '0123456789abcdef01234567'
const VIDEO_ID = 'fedcba9876543210fedcba98'
const DIRECT_XHS_EXPLORE = `https://www.xiaohongshu.com/explore/${NOTE_ID}`
const DIRECT_XHS_APEX_ITEM = `https://xiaohongshu.com/discovery/item/${NOTE_ID}`
const DIRECT_REDNOTE_EXPLORE = `https://www.rednote.com/explore/${NOTE_ID}`
const DIRECT_REDNOTE_APEX_ITEM = `https://rednote.com/discovery/item/${NOTE_ID}`
const SHORT_CODE = 'AbC123xYz09'
const SHORT_XHSLINK = `https://xhslink.com/${SHORT_CODE}`
const SHORT_XHSLINK_O = `https://xhslink.com/o/${SHORT_CODE}`
const SHORT_XHSLINK_CN_O = `https://xhslink.cn/o/${SHORT_CODE}`
const MIRROR_URL = 'https://www.xiaohongshu.com/example/status/1234567890123456789'
const X_URL = 'https://x.com/example/status/1234567890123456789'

const PHOTO_FIXTURE = [
  {
    operation: 'get_note_detail',
    note_id: NOTE_ID,
    note_type: 'image',
    title: 'Sample photo note',
    content: 'Body line for the photo note.',
    cover_image_url: 'https://sns-img-qc.xhscdn.com/spectrum/photo-1?imageView2/2/format/png',
    image_items: [
      {
        image_url: 'https://sns-img-qc.xhscdn.com/spectrum/photo-1?imageView2/2/format/png',
        width: 1080,
        height: 1440
      },
      {
        image_url: 'https://sns-img-qc.xhscdn.com/spectrum/photo-2?imageView2/2/format/png',
        width: 1080,
        height: 1440
      },
      { image_url: 'https://sns-avatar-qc.xhscdn.com/avatar/should-be-ignored.jpg', width: 120, height: 120 },
      { image_url: 'https://evil.example/not-xhscdn.png', width: 100, height: 100 }
    ],
    video: null,
    publish_time: 1768352974,
    author_name: 'Sample Author'
  }
]

const VIDEO_FIXTURE = [
  {
    operation: 'get_note_detail',
    note_id: VIDEO_ID,
    note_type: 'video',
    title: 'Sample video note',
    content: 'Video caption text.',
    cover_image_url: 'https://sns-img-qc.xhscdn.com/spectrum/video-cover?imageView2/2/format/png',
    image_items: [
      {
        image_url: 'https://sns-img-qc.xhscdn.com/spectrum/video-cover?imageView2/2/format/png',
        width: 720,
        height: 1280
      }
    ],
    video_video_url: 'https://sns-video-al.xhscdn.com/stream/1/110/258/sample_258.mp4?v=2',
    video_duration_ms: 53000,
    publish_time: 1784275336,
    author_name: 'Video Author'
  }
]

const publicLookup = async () => ['93.184.216.34']

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

describe('rednote URL parsing and mirror reader', () => {
  it('parses direct China and international note URLs to one canonical key and rejects nearby non-posts', () => {
    for (const url of [DIRECT_XHS_EXPLORE, DIRECT_XHS_APEX_ITEM, DIRECT_REDNOTE_EXPLORE, DIRECT_REDNOTE_APEX_ITEM]) {
      const parsed = parseSocialPostUrl(url)
      expect(parsed).toMatchObject({
        platform: 'rednote',
        id: NOTE_ID,
        lookupKey: `rednote:${NOTE_ID}`,
        canonicalUrl: DIRECT_XHS_EXPLORE
      })
      expect(parsed?.needsRedirect).toBeUndefined()
    }

    expect(recognitionOnlyName(DIRECT_XHS_EXPLORE)).toBeNull()
    expect(parseSocialPostUrl('https://www.xiaohongshu.com/user/profile/synthetic123')).toBeNull()
    expect(parseSocialPostUrl('https://www.xiaohongshu.com/explore/abc123')).toBeNull()
    expect(parseSocialPostUrl(`https://www.xiaohongshu.com/explore/${'z'.repeat(24)}`)).toBeNull()
    expect(parseSocialPostUrl('https://www.rednote.com/posts/synthetic123')).toBeNull()
  })

  it('parses verified short share shapes and rejects bare roots and subdomains', () => {
    expect(parseSocialPostUrl(SHORT_XHSLINK)).toMatchObject({
      platform: 'rednote',
      id: SHORT_CODE,
      needsRedirect: true,
      canonicalUrl: SHORT_XHSLINK
    })
    expect(parseSocialPostUrl(SHORT_XHSLINK_O)).toMatchObject({
      platform: 'rednote',
      id: SHORT_CODE,
      needsRedirect: true,
      canonicalUrl: SHORT_XHSLINK_O
    })
    expect(parseSocialPostUrl(SHORT_XHSLINK_CN_O)).toMatchObject({
      platform: 'rednote',
      id: SHORT_CODE,
      needsRedirect: true,
      canonicalUrl: SHORT_XHSLINK_CN_O
    })

    expect(parseSocialPostUrl('https://xhslink.com/')).toBeNull()
    expect(parseSocialPostUrl('https://xhslink.com/o')).toBeNull()
    expect(parseSocialPostUrl('https://xhslink.cn/')).toBeNull()
    expect(parseSocialPostUrl('https://www.xiaohongshu.com/explore/')).toBeNull()
    expect(parseSocialPostUrl(MIRROR_URL)).toBeNull()

    for (const host of ['m.xiaohongshu.com', 'mobile.rednote.com', 'www.xhslink.com', 'm.xhslink.cn']) {
      const url = `https://${host}/example/status/1234567890123456789`
      expect(parseSocialPostUrl(url)).toBeNull()
      expect(findSocialPostTargets(`${url} ${X_URL}`).map((target) => target.platform)).toEqual(['x'])
    }
  })

  it('resolves xhslink short links to canonical note targets and rejects homepage redirects', async () => {
    const share = parseSocialPostUrl(SHORT_XHSLINK_O)!
    const resolved = await resolveShareLink(
      share,
      async () =>
        new Response(null, {
          status: 302,
          headers: {
            location: `https://www.xiaohongshu.com/discovery/item/${NOTE_ID}?xsec_token=secret&type=normal`
          }
        })
    )
    expect(resolved).toMatchObject({
      platform: 'rednote',
      id: NOTE_ID,
      lookupKey: `rednote:${NOTE_ID}`,
      canonicalUrl: DIRECT_XHS_EXPLORE
    })

    const homepage = await resolveShareLink(
      share,
      async () => new Response(null, { status: 307, headers: { location: 'https://www.xiaohongshu.com/' } })
    )
    expect(homepage).toBeNull()
  })

  it('reads image notes via Apify mirror, strips avatars and foreign hosts, and attaches photos only for read_and_group', async () => {
    const fetcher = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(String(input)).toContain('socialdatax~socialdatax-xhs-data-api/run-sync-get-dataset-items')
      expect(init?.method).toBe('POST')
      expect(init?.redirect).toBe('manual')
      const headers = new Headers(init?.headers)
      expect(headers.get('authorization')).toBe('Bearer test-apify-token')
      expect(JSON.parse(String(init?.body))).toEqual({
        operation: 'get_note_detail',
        note_id: NOTE_ID,
        max_items: 1,
        auto_paginate: false
      })
      return jsonResponse(PHOTO_FIXTURE)
    })

    const readOnlyViewer = new SocialPostViewer(
      {
        mirrors: { rednote: 'read', apifyToken: 'test-apify-token' },
        timeoutMs: 12000,
        maxTextChars: 1500,
        cacheTtlMs: 0,
        maxCacheEntries: 16,
        ytDlpPath: 'yt-dlp'
      },
      { fetcher, lookup: publicLookup }
    )
    const readOnly = await readOnlyViewer.lookup(parseSocialPostUrl(DIRECT_REDNOTE_EXPLORE)!)
    expect(readOnly.status).toBe('found')
    if (readOnly.status !== 'found') throw new Error('expected found')
    expect(readOnly.post.text).toBe('Sample photo note Body line for the photo note.')
    expect(readOnly.post.authorName).toBe('Sample Author')
    expect(readOnly.post.photoUrls).toEqual([
      'https://sns-img-qc.xhscdn.com/spectrum/photo-1?imageView2/2/format/png',
      'https://sns-img-qc.xhscdn.com/spectrum/photo-2?imageView2/2/format/png'
    ])
    expect(readOnly.post.attachments).toBeUndefined()

    const groupViewer = new SocialPostViewer(
      {
        mirrors: { rednote: 'read_and_group', apifyToken: 'test-apify-token' },
        timeoutMs: 12000,
        maxTextChars: 1500,
        cacheTtlMs: 0,
        maxCacheEntries: 16,
        ytDlpPath: 'yt-dlp'
      },
      { fetcher, lookup: publicLookup }
    )
    const forGroup = await groupViewer.lookup(parseSocialPostUrl(DIRECT_XHS_EXPLORE)!)
    expect(forGroup.status).toBe('found')
    if (forGroup.status !== 'found') throw new Error('expected found')
    expect(forGroup.post.attachments).toEqual([
      {
        kind: 'image',
        owner: `rednote:${NOTE_ID}`,
        url: 'https://sns-img-qc.xhscdn.com/spectrum/photo-1?imageView2/2/format/png'
      },
      {
        kind: 'image',
        owner: `rednote:${NOTE_ID}`,
        url: 'https://sns-img-qc.xhscdn.com/spectrum/photo-2?imageView2/2/format/png'
      }
    ])
  })

  it('reads video notes with duration and preview cover kept out of photoUrls', async () => {
    const fetcher = vi.fn(async () => jsonResponse(VIDEO_FIXTURE))
    const viewer = new SocialPostViewer(
      {
        mirrors: { rednote: 'read_and_group', apifyToken: 'test-apify-token' },
        timeoutMs: 12000,
        maxTextChars: 1500,
        cacheTtlMs: 0,
        maxCacheEntries: 16,
        ytDlpPath: 'yt-dlp'
      },
      { fetcher, lookup: publicLookup }
    )
    const result = await viewer.lookup(parseSocialPostUrl(`https://www.xiaohongshu.com/explore/${VIDEO_ID}`)!)
    expect(result.status).toBe('found')
    if (result.status !== 'found') throw new Error('expected found')
    expect(result.post.photoUrls).toEqual([])
    expect(result.post.photoCount).toBe(0)
    expect(result.post.imageUrl).toBe('https://sns-img-qc.xhscdn.com/spectrum/video-cover?imageView2/2/format/png')
    expect(result.post.durationSec).toBe(53)
    expect(result.post.video).toEqual({
      url: 'https://sns-video-al.xhscdn.com/stream/1/110/258/sample_258.mp4?v=2',
      mirror: 'rednote',
      bytes: null,
      hasAudio: null,
      headers: null
    })
    expect(result.post.attachments).toEqual([
      {
        kind: 'video',
        owner: `rednote:${VIDEO_ID}`,
        video: result.post.video,
        durationSec: 53
      }
    ])
  })

  it('rejects mismatched note_id and stays inactive when mirror is off or token is missing', async () => {
    const fetcher = vi.fn(async () => jsonResponse(VIDEO_FIXTURE))
    const mismatchViewer = new SocialPostViewer(
      {
        mirrors: { rednote: 'read', apifyToken: 'test-apify-token' },
        timeoutMs: 12000,
        maxTextChars: 1500,
        cacheTtlMs: 0,
        maxCacheEntries: 16,
        ytDlpPath: 'yt-dlp'
      },
      { fetcher, lookup: publicLookup }
    )
    const mismatched = await mismatchViewer.lookup(parseSocialPostUrl(DIRECT_XHS_EXPLORE)!)
    expect(mismatched).toMatchObject({ status: 'failed', platform: 'rednote', reason: 'identity_mismatch' })

    const noTokenFetcher = vi.fn(async () => {
      throw new Error('must not call Apify without token')
    })
    const noTokenViewer = new SocialPostViewer(
      {
        mirrors: { rednote: 'read_and_group' },
        timeoutMs: 12000,
        maxTextChars: 1500,
        cacheTtlMs: 0,
        maxCacheEntries: 16,
        ytDlpPath: 'yt-dlp'
      },
      { fetcher: noTokenFetcher }
    )
    const skipped = await noTokenViewer.lookup(parseSocialPostUrl(DIRECT_XHS_EXPLORE)!)
    expect(skipped.status).toBe('failed')
    expect(noTokenFetcher).not.toHaveBeenCalled()
  })

  it('gates capabilities, switches, and mirror asset policy on mirror mode and token', () => {
    expect(switchablePlatforms().read).toContain('rednote')
    expect(switchablePlatforms().fetch).toContain('rednote')

    const offCaps = socialCapabilities(true, { rednote: 'off', apifyToken: 'tok' })
    expect(offCaps['features.social'].some((e) => e.id === 'rednote')).toBe(false)
    expect(offCaps['features.autofetch'].some((e) => e.id === 'rednote')).toBe(false)

    const noKeyCaps = socialCapabilities(true, { rednote: 'read_and_group' })
    expect(noKeyCaps['features.social'].some((e) => e.id === 'rednote')).toBe(false)
    expect(noKeyCaps['features.autofetch'].some((e) => e.id === 'rednote')).toBe(false)

    const readCaps = socialCapabilities(true, { rednote: 'read', apifyToken: 'tok' })
    expect(readCaps['features.social'].find((e) => e.id === 'rednote')?.operations).toEqual([
      'text',
      'preview',
      'photos',
      'video'
    ])
    expect(readCaps['features.autofetch'].some((e) => e.id === 'rednote')).toBe(false)

    const groupCaps = socialCapabilities(true, { rednote: 'read_and_group', apifyToken: 'tok' })
    expect(groupCaps['features.autofetch'].find((e) => e.id === 'rednote')?.operations).toEqual(['photos', 'video'])
    expect(groupOperations('rednote', { rednote: 'read_and_group', apifyToken: 'tok' }, 'c_1', false)).toEqual([
      'photos',
      'video'
    ])

    const mediaUrl = 'https://sns-video-al.xhscdn.com/stream/1/110/258/sample_258.mp4'
    const avatarUrl = 'https://sns-avatar-qc.xhscdn.com/avatar/user.jpg'
    expect(mirrorAssetPlatform(mediaUrl)).toBe('rednote')
    expect(mirrorAssetPlatform(avatarUrl)).toBeUndefined()
    expect(enabledMirrorAsset(mediaUrl, 'rednote', { rednote: 'read', apifyToken: 'tok' })).toBe(true)
    expect(enabledMirrorAsset(mediaUrl, 'rednote', { rednote: 'read' })).toBe(false)
    expect(enabledMirrorAsset(avatarUrl, 'rednote', { rednote: 'read', apifyToken: 'tok' })).toBe(false)
  })
})
