import { isIP } from 'node:net'

export type SocialPlatform =
  'x' | 'bluesky' | 'youtube' | 'tiktok' | 'reddit' | 'instagram' | 'bilibili' | 'threads' | 'facebook'

export interface SocialPostTarget {
  platform: SocialPlatform
  id: string
  lookupKey: string
  canonicalUrl: string
  extractorUrl: string
  profile?: string
  startSec?: number
}

const HOSTS: Record<SocialPlatform, string[]> = {
  x: ['x.com', 'twitter.com', 'fxtwitter.com', 'fixupx.com', 'vxtwitter.com', 'fixvx.com'],
  bluesky: ['bsky.app'],
  youtube: ['youtube.com', 'youtu.be'],
  tiktok: ['tiktok.com'],
  reddit: ['reddit.com', 'redd.it'],
  instagram: ['instagram.com'],
  bilibili: ['bilibili.com'],
  threads: ['threads.com', 'threads.net'],
  facebook: ['facebook.com', 'fb.watch']
}

function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`)
}

function platformForHost(host: string): SocialPlatform | null {
  for (const [platform, domains] of Object.entries(HOSTS) as Array<[SocialPlatform, string[]]>) {
    if (domains.some((domain) => hostMatches(host, domain))) return platform
  }
  return null
}

function target(platform: SocialPlatform, id: string, canonicalUrl: string, profile?: string): SocialPostTarget {
  return { platform, id, lookupKey: `${platform}:${id}`, canonicalUrl, extractorUrl: canonicalUrl, profile }
}

const YOUTUBE_CLOCK_TIME = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/

function youtubeStartSec(url: URL): number | undefined {
  const raw = url.searchParams.get('t') ?? url.searchParams.get('start') ?? url.hash.match(/^#t=(.*)$/)?.[1]
  if (raw === undefined) return undefined
  if (/^\d+$/.test(raw)) return Number(raw)
  const match = raw.match(YOUTUBE_CLOCK_TIME)
  if (!match || match.slice(1).every((part) => part === undefined)) return undefined
  const [, hours = '0', minutes = '0', seconds = '0'] = match
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds)
}

/** A Facebook post's own link: the group or page it is in is its profile, which marks it resolved. */
function facebookPost(url: URL): SocialPostTarget | null {
  const post = (id: string, canonicalUrl: string, profile: string): SocialPostTarget => ({
    ...target('facebook', id, canonicalUrl, profile),
    lookupKey: `facebook:post:${id}`
  })
  const group = url.pathname.match(/^\/groups\/([\w.-]+)\/(?:permalink|posts)\/(\d+)\/?$/)
  if (group) {
    const [, name = '', id = ''] = group
    return post(id, `https://www.facebook.com/groups/${name}/permalink/${id}/`, name)
  }
  const page = url.pathname.match(/^\/([\w.-]+)\/posts\/([\w-]+)\/?$/)
  if (page) {
    const [, name = '', id = ''] = page
    return post(id, `https://www.facebook.com/${name}/posts/${id}`, name)
  }
  const story = url.searchParams.get('story_fbid')
  const owner = url.searchParams.get('id')
  if (url.pathname === '/permalink.php' && story && owner && /^[\w-]+$/.test(story) && /^\d+$/.test(owner)) {
    return post(story, `https://www.facebook.com/permalink.php?story_fbid=${story}&id=${owner}`, owner)
  }
  return null
}

/** True for a Facebook post link, shared or resolved, which is read from its page; a video link goes to yt-dlp. */
export function isFacebookPost(target: SocialPostTarget): boolean {
  return target.platform === 'facebook' && target.lookupKey.startsWith('facebook:post')
}

/** Facebook by its video and post links; a profile or home page is left to read_page. */
function facebookTarget(host: string, url: URL): SocialPostTarget | null {
  if (hostMatches(host, 'fb.watch')) {
    const id = url.pathname.match(/^\/([\w-]+)\/?$/)?.[1]
    return id ? { ...target('facebook', id, `https://fb.watch/${id}/`), lookupKey: `facebook:watch:${id}` } : null
  }
  // A share id is not a video id, so its key keeps the two apart; yt-dlp follows the share link itself.
  const share = url.pathname.match(/^\/share\/([vr])\/([\w-]+)\/?$/)
  if (share) {
    const [, kind = '', id = ''] = share
    return {
      ...target('facebook', id, `https://www.facebook.com/share/${kind}/${id}/`),
      lookupKey: `facebook:share:${id}`
    }
  }
  const sharedPost = url.pathname.match(/^\/share\/p\/([\w-]+)\/?$/)?.[1]
  if (sharedPost) {
    return {
      ...target('facebook', sharedPost, `https://www.facebook.com/share/p/${sharedPost}/`),
      lookupKey: `facebook:post-share:${sharedPost}`
    }
  }
  const post = facebookPost(url)
  if (post) return post
  const reel = url.pathname.match(/^\/reel\/(\d+)\/?$/)?.[1]
  if (reel) return target('facebook', reel, `https://www.facebook.com/reel/${reel}`)
  const watch = /^\/watch\/?$/.test(url.pathname) ? url.searchParams.get('v') : null
  if (watch && /^\d+$/.test(watch)) return target('facebook', watch, `https://www.facebook.com/watch/?v=${watch}`)
  const video = url.pathname.match(/^\/([\w.-]+)\/videos\/(?:[\w.-]+\/)?(\d+)\/?$/)
  if (video) {
    const [, page = '', id = ''] = video
    return target('facebook', id, `https://www.facebook.com/${page}/videos/${id}/`)
  }
  return null
}

export function parseSocialPostUrl(value: string): SocialPostTarget | null {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return null
  }

  const authority = value.trim().match(/^https:\/\/([^/?#]+)/i)?.[1]
  if (
    url.protocol !== 'https:' ||
    !authority ||
    authority.includes('@') ||
    authority.includes(':') ||
    isIP(url.hostname.replace(/^\[|\]$/g, ''))
  ) {
    return null
  }

  const host = url.hostname.toLowerCase()
  const platform = platformForHost(host)
  if (!platform) return null

  if (platform === 'x') {
    const match = url.pathname.match(/^\/([\w]+)\/status\/(\d+)(?:\/.*)?$/i)
    if (!match) return null
    const [, profile = '', id = ''] = match
    return target('x', id, `https://x.com/i/status/${id}`, profile)
  }

  if (platform === 'bluesky') {
    const match = url.pathname.match(/^\/profile\/([^/]+)\/post\/([a-z0-9]+)\/?$/i)
    if (!match) return null
    const [, profile = '', id = ''] = match
    return {
      ...target('bluesky', id, `https://bsky.app/profile/${profile}/post/${id}`, profile),
      lookupKey: `bluesky:${profile.toLowerCase()}:${id}`
    }
  }

  if (platform === 'youtube') {
    const id = hostMatches(host, 'youtu.be')
      ? url.pathname.match(/^\/([\w-]+)\/?$/)?.[1]
      : url.pathname === '/watch'
        ? url.searchParams.get('v')
        : url.pathname.match(/^\/shorts\/([\w-]+)\/?$/)?.[1]
    if (!id || !/^[\w-]+$/.test(id)) return null
    const canonicalUrl = `https://www.youtube.com/watch?v=${id}`
    return { ...target('youtube', id, canonicalUrl), startSec: youtubeStartSec(url) }
  }

  if (platform === 'tiktok') {
    const match = url.pathname.match(/^\/@([\w.-]+)\/video\/(\d+)\/?$/i)
    if (!match) return null
    const [, profile = '', id = ''] = match
    return target('tiktok', id, `https://www.tiktok.com/@${profile}/video/${id}`, profile)
  }

  if (platform === 'reddit') {
    const id = hostMatches(host, 'redd.it')
      ? url.pathname.match(/^\/([a-z0-9]+)\/?$/i)?.[1]
      : (url.pathname.match(/^\/r\/[\w-]+\/comments\/([a-z0-9]+)(?:\/[^/]*)?\/?$/i)?.[1] ??
        url.pathname.match(/^\/comments\/([a-z0-9]+)\/?$/i)?.[1])
    if (!id) return null
    return target('reddit', id, `https://www.reddit.com/comments/${id}/`)
  }

  if (platform === 'instagram') {
    // A link may carry the account before the kind; `/reels/` is the plural of `/reel/`.
    const match = url.pathname.match(/^\/(?:[\w.]+\/)?(p|reels?)\/([\w-]+)\/?$/i)
    if (!match) return null
    const [, rawKind = '', id = ''] = match
    const kind = rawKind.toLowerCase() === 'p' ? 'p' : 'reel'
    return target('instagram', id, `https://www.instagram.com/${kind}/${id}/`)
  }

  if (platform === 'facebook') return facebookTarget(host, url)

  if (platform === 'threads') {
    const short = url.pathname.match(/^\/t\/([\w-]+)\/?$/)?.[1]
    if (short) return target('threads', short, `https://www.threads.com/t/${short}`)
    // A share id is not a post code, so its key keeps the two apart; the post code comes from the redirect.
    const share = url.pathname.match(/^\/share\/([\w-]+)\/?$/)?.[1]
    if (share) {
      return {
        ...target('threads', share, `https://www.threads.com/share/${share}`),
        lookupKey: `threads:share:${share}`
      }
    }
    const match = url.pathname.match(/^\/@([\w.]+)\/post\/([\w-]+)(?:\/media)?\/?$/)
    if (!match) return null
    const [, profile = '', id = ''] = match
    return target('threads', id, `https://www.threads.com/@${profile}/post/${id}`, profile)
  }

  const id = url.pathname.match(/^\/video\/(BV[\da-z]+|av\d+)\/?$/i)?.[1]
  if (!id) return null
  const normalizedId = id.startsWith('av') ? id.toLowerCase() : `BV${id.slice(2)}`
  return target('bilibili', normalizedId, `https://www.bilibili.com/video/${normalizedId}`)
}

/** Every supported post link in a text, in order. */
export function findSocialPostTargets(text: string): SocialPostTarget[] {
  const urls = text.match(/https?:\/\/[^\s<>()[\]{}]+/gi) ?? []
  return urls
    .map((candidate) => parseSocialPostUrl(candidate.replace(/[.,!?;:'"`]+$/g, '')))
    .filter((parsed): parsed is SocialPostTarget => parsed !== null)
}

export function findSocialPostTarget(text: string): SocialPostTarget | null {
  return findSocialPostTargets(text)[0] ?? null
}

export function findLinkTarget(texts: string[]): SocialPostTarget | null {
  for (const text of texts) {
    const target = findSocialPostTarget(text)
    if (target) return target
  }
  return null
}
