import type { SocialPlatform } from '../../src/social/urls.js'

export const socialUrlPairs = {
  x: ['twitter.com/sample/status/123/photo/1', 'x.com/i/status/123'],
  bluesky: ['bsky.app/profile/sample.test/post/abc?ref=feed', 'bsky.app/profile/sample.test/post/abc'],
  youtube: ['youtu.be/abcdefghijk?t=4', 'www.youtube.com/watch?v=abcdefghijk'],
  tiktok: ['m.tiktok.com/@sample/video/123?lang=en', 'www.tiktok.com/@sample/video/123'],
  reddit: ['redd.it/abc123', 'www.reddit.com/comments/abc123/'],
  instagram: ['instagram.com/sample/reels/AbC/', 'www.instagram.com/reel/AbC/'],
  bilibili: ['m.bilibili.com/video/av123/?p=2', 'www.bilibili.com/video/av123?p=2'],
  threads: ['threads.net/%40sample/post/AbC/media', 'www.threads.com/@sample/post/AbC'],
  facebook: ['m.facebook.com/groups/sample/posts/123', 'www.facebook.com/groups/sample/permalink/123/'],
  lemon8: ['lemon8-app.com/%40sample/1234567890123456789', 'www.lemon8-app.com/@sample/1234567890123456789'],
  rednote: [
    'www.rednote.com/discovery/item/0123456789abcdef01234567',
    'www.xiaohongshu.com/explore/0123456789abcdef01234567'
  ],
  douyin: ['www.douyin.com/jingxuan/acg?modal_id=1234567890123456789', 'www.douyin.com/video/1234567890123456789'],
  linkedin: [
    'linkedin.com/posts/sample_activity-1234567890123456789-abcd',
    'www.linkedin.com/feed/update/urn:li:activity:1234567890123456789/'
  ]
} satisfies Record<SocialPlatform, [string, string]>
