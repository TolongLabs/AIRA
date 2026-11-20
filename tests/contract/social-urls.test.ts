import { describe, expect, it, vi } from 'vitest'
import {
  findSocialPostTargets,
  isFacebookPost,
  isResolvedFacebookPost,
  parseSocialPostUrl
} from '../../src/social/urls.js'

describe('parseSocialPostUrl', () => {
  it.each([
    ['x.com', 'https://x.com/example_user/status/1234567890123456789', 'x'],
    ['twitter.com', 'https://twitter.com/example_user/status/1234567890123456789', 'x'],
    ['mobile.twitter.com', 'https://mobile.twitter.com/example_user/status/1234567890123456789', 'x'],
    ['fxtwitter.com', 'https://fxtwitter.com/example_user/status/1234567890123456789', 'x'],
    ['fixupx.com', 'https://fixupx.com/example_user/status/1234567890123456789', 'x'],
    ['vxtwitter.com', 'https://vxtwitter.com/example_user/status/1234567890123456789', 'x'],
    ['fixvx.com', 'https://fixvx.com/example_user/status/1234567890123456789', 'x'],
    ['X web status', 'https://x.com/i/web/status/1234567890123456789', 'x'],
    ['Bluesky handle', 'https://bsky.app/profile/example_user.bsky.social/post/abc123', 'bluesky'],
    ['Bluesky DID', 'https://bsky.app/profile/did:plc:abcd1234/post/abc123', 'bluesky'],
    ['YouTube watch', 'https://www.youtube.com/watch?v=abc_123', 'youtube'],
    ['YouTube short', 'https://youtube.com/shorts/abc_123', 'youtube'],
    ['YouTube short host', 'https://youtu.be/abc_123', 'youtube'],
    ['YouTube live', 'https://www.youtube.com/live/abc_123', 'youtube'],
    ['YouTube embed', 'https://www.youtube.com/embed/abc_123', 'youtube'],
    ['TikTok', 'https://www.tiktok.com/@example_user/video/1234567890', 'tiktok'],
    ['TikTok photo', 'https://www.tiktok.com/@example_user/photo/1234567890', 'tiktok'],
    ['TikTok vm short', 'https://vm.tiktok.com/ZMexample/', 'tiktok'],
    ['TikTok vt short', 'https://vt.tiktok.com/ZMexample/', 'tiktok'],
    ['TikTok /t/ short', 'https://www.tiktok.com/t/ZTexample/', 'tiktok'],
    ['Reddit', 'https://www.reddit.com/r/videos/comments/abc123/a_post/', 'reddit'],
    ['Reddit comment permalink', 'https://www.reddit.com/r/example_sub/comments/abc123/a_post/def456/', 'reddit'],
    ['Reddit share', 'https://www.reddit.com/r/example_sub/s/AbC123xyz', 'reddit'],
    ['Reddit user share', 'https://www.reddit.com/u/example_user/s/AbC123xyz', 'reddit'],
    ['Old Reddit', 'https://old.reddit.com/r/videos/comments/abc123/a_post/', 'reddit'],
    ['Short Reddit', 'https://redd.it/abc123', 'reddit'],
    ['Instagram post', 'https://www.instagram.com/p/AbCd123/', 'instagram'],
    ['Instagram reel', 'https://instagram.com/reel/AbCd123/', 'instagram'],
    ['Instagram share', 'https://www.instagram.com/share/AbCd123/', 'instagram'],
    ['Instagram share reel', 'https://www.instagram.com/share/reel/AbCd123/', 'instagram'],
    ['Instagram TV', 'https://www.instagram.com/tv/AbCd123/', 'instagram'],
    ['Bilibili', 'https://www.bilibili.com/video/BV1ab411c7mD', 'bilibili'],
    ['Bilibili short', 'https://b23.tv/AbC123x', 'bilibili'],
    ['Threads', 'https://www.threads.net/@poster_one/post/DFixtur3abc', 'threads'],
    ['Threads encoded handle', 'https://www.threads.com/%40example_user/post/DFixtur3abc', 'threads'],
    ['Threads post', 'https://www.threads.com/post/DFixtur3abc', 'threads'],
    ['Facebook story', 'https://www.facebook.com/story.php?story_fbid=1234567890&id=1234567890', 'facebook'],
    ['Facebook photo', 'https://www.facebook.com/photo.php?fbid=1234567890', 'facebook'],
    ['Facebook bare share', 'https://www.facebook.com/share/AbCdEf9x/', 'facebook'],
    ['Bluesky account without a dot, on its own host', 'https://bsky.app/profile/alice/post/abc123', 'bluesky'],
    [
      'Facebook video with a slug, on its own host',
      'https://www.facebook.com/example_page/videos/a_slug/1234567890',
      'facebook'
    ]
  ])('recognizes %s', (_name, url, platform) => {
    expect(parseSocialPostUrl(url)).toMatchObject({ platform })
  })

  it.each([
    ['X mirror user status', 'https://mirror.example.test/example_user/status/1234567890123456789', 'x'],
    ['X lookalike host', 'https://x.com.example.test/example_user/status/1234567890123456789', 'x'],
    ['Instagram reel mirror', 'https://oginstagram.test/reel/Df6n2AHsM66/?gpwx=abc', 'instagram'],
    ['Instagram post on an insta host', 'https://ddinstagram.test/p/AbCdEfGhIjK', 'instagram'],
    ['TikTok video mirror', 'https://vxtiktok.test/@example_user/video/1234567890', 'tiktok'],
    ['Reddit comments mirror', 'https://rxddit.test/r/example_sub/comments/abc123/a_post/', 'reddit'],
    ['Bluesky mirror', 'https://fxbsky.test/profile/example_user.test/post/abc123', 'bluesky'],
    ['Threads mirror', 'https://fixthreads.test/@example_user/post/DFixtur3abc', 'threads'],
    ['Bilibili mirror', 'https://vxbilibili.test/video/BV1ab411c7mD', 'bilibili'],
    ['Facebook video mirror', 'https://fbmirror.test/example_page/videos/12345678901234567', 'facebook'],
    ['Facebook reel mirror', 'https://fbmirror.test/reel/123456789012345', 'facebook'],
    ['Facebook watch mirror', 'https://fbmirror.test/watch/?v=123456789012345', 'facebook'],
    ['Facebook pfbid post mirror', 'https://fbmirror.test/example_page/posts/pfbid0AbCdEf123', 'facebook']
  ])('recognizes a %s on its unknown host', (_name, url, platform) => {
    expect(parseSocialPostUrl(url)).toMatchObject({ platform })
  })

  it.each([
    [
      'https://mirror.example.test/example_user/status/1234567890123456789',
      'https://x.com/i/status/1234567890123456789'
    ],
    [
      'https://x.com.example.test/example_user/status/1234567890123456789',
      'https://x.com/i/status/1234567890123456789'
    ],
    ['https://oginstagram.test/reel/Df6n2AHsM66/?gpwx=abc', 'https://www.instagram.com/reel/Df6n2AHsM66/'],
    ['https://ddinstagram.test/p/AbCdEfGhIjK', 'https://www.instagram.com/p/AbCdEfGhIjK/'],
    ['https://vxtiktok.test/@example_user/video/1234567890', 'https://www.tiktok.com/@example_user/video/1234567890'],
    ['https://rxddit.test/r/example_sub/comments/abc123/a_post/', 'https://www.reddit.com/comments/abc123/'],
    [
      'https://fxbsky.test/profile/example_user.test/post/abc123',
      'https://bsky.app/profile/example_user.test/post/abc123'
    ],
    [
      'https://fixthreads.test/@example_user/post/DFixtur3abc',
      'https://www.threads.com/@example_user/post/DFixtur3abc'
    ],
    ['https://vxbilibili.test/video/BV1ab411c7mD', 'https://www.bilibili.com/video/BV1ab411c7mD'],
    [
      'https://fbmirror.test/example_page/videos/12345678901234567',
      'https://www.facebook.com/example_page/videos/12345678901234567/'
    ],
    ['https://fbmirror.test/reel/123456789012345', 'https://www.facebook.com/reel/123456789012345'],
    ['https://fbmirror.test/watch/?v=123456789012345', 'https://www.facebook.com/watch/?v=123456789012345'],
    [
      'https://fbmirror.test/example_page/posts/pfbid0AbCdEf123',
      'https://www.facebook.com/example_page/posts/pfbid0AbCdEf123'
    ]
  ])('reads %s at the platform address, never the mirror', (url, canonicalUrl) => {
    expect(parseSocialPostUrl(url)?.canonicalUrl).toBe(canonicalUrl)
  })

  it.each([
    'https://example.test/example_user/status/1234',
    'https://example.test/example_user/status/123456789012345678901',
    'https://example.test/i/web/status/1234',
    'https://example.test/reel/AbCd',
    'https://example.test/p/AbCdEfGhIjK',
    'https://example.test/share/AbCdEf123',
    'https://example.test/permalink.php?story_fbid=1234567890123456&id=1234567890',
    'https://example.test/example_page/videos/1234567890',
    'https://example.test/example_page/videos/a_slug/12345678901234567',
    'https://fxbsky.test/profile/example_user/post/abc123',
    'https://example.test/watch?v=1234567890',
    'https://example.test/profile/example_user/post/abc123',
    'https://example.test/video/BV1ab411c7m',
    'https://example.test/t/abc123',
    'https://example.test/r/example/s/AbCd123',
    'https://example.test/live/abc_123',
    'https://example.test/example_page/posts/1234567890',
    'https://vm.example.test/abc123',
    'https://youtube.example.test/watch?v=abc_123'
  ])('ignores an ordinary page on an unknown host: %s', (url) => {
    expect(parseSocialPostUrl(url)).toBeNull()
  })

  it.each([
    'http://x.com/example_user/status/1234567890123456789',
    'https://127.0.0.1/example_user/status/1234567890123456789',
    'https://x.com:443/example_user/status/1234567890123456789',
    'https://user@x.com/example_user/status/1234567890123456789',
    'https://x.com/example_user/likes/1234567890123456789',
    'https://youtube.com.evil.com/watch?v=abc_123',
    'https://example.com/watch?v=abc_123'
  ])('rejects unsafe or unsupported URL %s', (url) => {
    expect(parseSocialPostUrl(url)).toBeNull()
  })

  it.each([
    'https://www.reddit.com/r/example_sub/s/AbC123xyz',
    'https://vm.tiktok.com/ZMexample/',
    'https://b23.tv/AbC123x',
    'https://www.instagram.com/share/AbCd123/',
    'https://www.facebook.com/share/AbCdEf9x/',
    'https://fb.watch/AbC12dEf/',
    'https://www.facebook.com/share/v/1AbCdEf9x/',
    'https://www.facebook.com/share/r/1AbCdEf9x/',
    'https://www.facebook.com/share/p/1FrDwJtBqj/'
  ])('marks the share or short link %s for resolution', (url) => {
    expect(parseSocialPostUrl(url)).toMatchObject({ needsRedirect: true })
  })

  it('does not mark a post for resolution', () => {
    expect(parseSocialPostUrl('https://x.com/example_user/status/1234567890123456789')?.needsRedirect).toBeUndefined()
  })

  it('rebuilds canonical extractor URLs from parsed identifiers', () => {
    expect(
      parseSocialPostUrl('https://vxtwitter.com/example_user/status/1234567890123456789?token=secret')
    ).toMatchObject({
      id: '1234567890123456789',
      canonicalUrl: 'https://x.com/i/status/1234567890123456789',
      lookupKey: 'x:1234567890123456789',
      extractorUrl: 'https://x.com/i/status/1234567890123456789'
    })
    expect(parseSocialPostUrl('https://youtu.be/abc_123?t=45')).toMatchObject({
      id: 'abc_123',
      canonicalUrl: 'https://www.youtube.com/watch?v=abc_123',
      extractorUrl: 'https://www.youtube.com/watch?v=abc_123'
    })
  })

  it.each([
    ['plain seconds', 'https://youtu.be/abc_123?t=754', 754],
    ['seconds with s', 'https://youtu.be/abc_123?t=754s', 754],
    ['minutes and seconds', 'https://www.youtube.com/watch?v=abc_123&t=12m34s', 754],
    ['hours, minutes and seconds', 'https://www.youtube.com/watch?v=abc_123&t=1h2m3s', 3723],
    ['start parameter', 'https://www.youtube.com/watch?v=abc_123&start=754', 754],
    ['fragment', 'https://youtu.be/abc_123#t=754', 754],
    ['shorts link', 'https://youtube.com/shorts/abc_123?t=30', 30]
  ])('reads the start time from a YouTube link with %s', (_name, url, startSec) => {
    expect(parseSocialPostUrl(url)).toMatchObject({ startSec })
  })

  it.each([
    'https://youtu.be/abc_123',
    'https://youtu.be/abc_123?t=',
    'https://youtu.be/abc_123?t=garbage',
    'https://youtu.be/abc_123?t=12.5',
    'https://youtu.be/abc_123?t=1m2s3',
    'https://youtu.be/abc_123#t=garbage',
    'https://x.com/example_user/status/1234567890123456789?t=754'
  ])('leaves startSec undefined for %s', (url) => {
    expect(parseSocialPostUrl(url)?.startSec).toBeUndefined()
  })

  it('keeps the start time out of the lookup key and canonical URL', () => {
    const plain = parseSocialPostUrl('https://youtu.be/abc_123')
    const timed = parseSocialPostUrl('https://youtu.be/abc_123?t=754')
    expect(timed).toMatchObject({
      lookupKey: plain?.lookupKey,
      canonicalUrl: plain?.canonicalUrl,
      extractorUrl: plain?.extractorUrl
    })
  })
})

describe('findSocialPostTargets', () => {
  it.each([
    ['asterisks', '*https://youtu.be/abc_123*', 'abc_123'],
    ['underscores', '_https://youtu.be/abc_123_', 'abc_123'],
    ['tildes', '~https://youtu.be/abc_123~', 'abc_123'],
    ['nested marks', '*_https://youtu.be/abc_123_*', 'abc_123'],
    ['marks before punctuation', '*https://youtu.be/abc_123*.', 'abc_123'],
    ['an unwrapped id ending in an underscore', 'https://youtu.be/abc_', 'abc_']
  ])('reads a link wrapped in %s', (_name, text, id) => {
    expect(findSocialPostTargets(text)).toMatchObject([{ platform: 'youtube', id }])
  })

  it('leaves a link with one unpaired mark unread', () => {
    expect(findSocialPostTargets('*https://youtu.be/abc_123')).toEqual([])
  })

  it('reports the platform and hostname of a shape-matched link on an unknown host, never its path or query', () => {
    const onUnknownHost = vi.fn()
    findSocialPostTargets('see https://ddinstagram.test/p/AbCdEfGhIjK?igsh=secret', onUnknownHost)
    expect(onUnknownHost).toHaveBeenCalledOnce()
    expect(onUnknownHost).toHaveBeenCalledWith({ platform: 'instagram', hostname: 'ddinstagram.test' })
    expect(JSON.stringify(onUnknownHost.mock.calls)).not.toContain('AbCdEfGhIjK')
    expect(JSON.stringify(onUnknownHost.mock.calls)).not.toContain('secret')
  })

  it('reports nothing for a link on a known platform host', () => {
    const onUnknownHost = vi.fn()
    findSocialPostTargets('see https://www.instagram.com/p/AbCdEfGhIjK/', onUnknownHost)
    expect(onUnknownHost).not.toHaveBeenCalled()
  })
})

describe('Facebook photo links', () => {
  it.each([
    ['photo', 'https://www.facebook.com/photo/?fbid=1234567890'],
    ['photo.php', 'https://www.facebook.com/photo.php?fbid=1234567890']
  ])('reads a %s link as a resolved page post with its stable key', (_name, url) => {
    const target = parseSocialPostUrl(url)!
    expect(target).toMatchObject({
      lookupKey: 'facebook:photo:1234567890',
      canonicalUrl: 'https://www.facebook.com/photo/?fbid=1234567890'
    })
    expect(isFacebookPost(target)).toBe(true)
    expect(isResolvedFacebookPost(target)).toBe(true)
  })

  it('leaves a share unresolved until its redirect, and a video on yt-dlp', () => {
    expect(isResolvedFacebookPost(parseSocialPostUrl('https://www.facebook.com/share/p/1FrDwJtBqj/')!)).toBe(false)
    expect(isFacebookPost(parseSocialPostUrl('https://www.facebook.com/example_page/videos/1234567890')!)).toBe(false)
  })
})
