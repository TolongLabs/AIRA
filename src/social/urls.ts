import { isIP } from 'node:net'

export type SocialPlatform =
  'x' | 'bluesky' | 'youtube' | 'tiktok' | 'reddit' | 'instagram' | 'bilibili' | 'threads' | 'facebook'

/** The name a person sees for each platform: a footer, a note or a model sentence. */
export const PLATFORM_NAME: Record<SocialPlatform, string> = {
  x: 'X',
  bluesky: 'Bluesky',
  threads: 'Threads',
  youtube: 'YouTube',
  tiktok: 'TikTok',
  reddit: 'Reddit',
  instagram: 'Instagram',
  facebook: 'Facebook',
  bilibili: 'Bilibili'
}

export interface SocialPostTarget {
  platform: SocialPlatform
  id: string
  lookupKey: string
  canonicalUrl: string
  extractorUrl: string
  profile?: string
  startSec?: number
  /** The post is readable, but its Bilibili part does not select a deliverable asset. */
  invalidPart?: true
  /** A share or short link. Its address names no post, so resolveShareLink follows it before the lookup. */
  needsRedirect?: boolean
  /** The unwrapped input URL before normalization, when it differs from `canonicalUrl`. */
  originalUrl?: string
}

const HOSTS: Record<SocialPlatform, string[]> = {
  x: ['x.com', 'twitter.com', 'fxtwitter.com', 'fixupx.com', 'vxtwitter.com', 'fixvx.com'],
  bluesky: ['bsky.app'],
  youtube: ['youtube.com', 'youtu.be'],
  tiktok: ['tiktok.com'],
  reddit: ['reddit.com', 'redd.it'],
  instagram: ['instagram.com'],
  bilibili: ['bilibili.com', 'b23.tv'],
  threads: ['threads.com', 'threads.net'],
  facebook: ['facebook.com', 'fb.watch']
}

// Tried in this order on a host that is no platform's own. YouTube is host-only and never matches there.
const UNKNOWN_HOST_PLATFORMS: SocialPlatform[] = [
  'x',
  'bluesky',
  'tiktok',
  'reddit',
  'instagram',
  'threads',
  'facebook',
  'bilibili'
]

function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`)
}

function platformForHost(host: string): SocialPlatform | null {
  for (const [platform, domains] of Object.entries(HOSTS) as Array<[SocialPlatform, string[]]>) {
    if (domains.some((domain) => hostMatches(host, domain))) return platform
  }
  return null
}

/** True when `hostname` is one of the platform's own domains, subdomains included. */
export function platformOwnsHost(hostname: string, platform: SocialPlatform): boolean {
  return HOSTS[platform].some((domain) => hostMatches(hostname, domain))
}

function target(platform: SocialPlatform, id: string, canonicalUrl: string, profile?: string): SocialPostTarget {
  return { platform, id, lookupKey: `${platform}:${id}`, canonicalUrl, extractorUrl: canonicalUrl, profile }
}

function shareTarget(platform: SocialPlatform, id: string, canonicalUrl: string, lookupKey: string): SocialPostTarget {
  return { ...target(platform, id, canonicalUrl), lookupKey, needsRedirect: true }
}

// Each parser reads one platform's paths. On a host that is no platform's own (`unknown`) it accepts only the
// strict shapes, and it always returns the target on the platform's own address, never on the pasted host.

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

function parseYouTube(url: URL, host: string, unknown: boolean): SocialPostTarget | null {
  if (unknown) return null
  const id = hostMatches(host, 'youtu.be')
    ? url.pathname.match(/^\/([\w-]+)\/?$/)?.[1]
    : url.pathname === '/watch'
      ? url.searchParams.get('v')
      : url.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]+)\/?$/)?.[1]
  if (!id || !/^[\w-]+$/.test(id)) return null
  const canonicalUrl = `https://www.youtube.com/watch?v=${id}`
  return { ...target('youtube', id, canonicalUrl), startSec: youtubeStartSec(url) }
}

function parseX(url: URL, unknown: boolean): SocialPostTarget | null {
  const web = url.pathname.match(/^\/i\/web\/status\/(\d+)\/?$/)?.[1]
  const status = web === undefined ? url.pathname.match(/^\/(\w+)\/status\/(\d+)(?:\/.*)?$/i) : null
  const id = web ?? status?.[2]
  if (!id || (unknown && !/^\d{15,20}$/.test(id))) return null
  return target('x', id, `https://x.com/i/status/${id}`, status?.[1])
}

const BLUESKY_ACCOUNT = /^(?:[\w-]+(?:\.[\w-]+)+|did:[a-z]+:[\w.:%-]+)$/i

function parseBluesky(url: URL, unknown: boolean): SocialPostTarget | null {
  const match = url.pathname.match(/^\/profile\/([^/]+)\/post\/([a-z0-9]+)\/?$/i)
  if (!match) return null
  const [, profile = '', id = ''] = match
  // A mirror host must name the account as a handle or DID. The platform's own host takes any profile, as before.
  if (unknown && !BLUESKY_ACCOUNT.test(profile)) return null
  return {
    ...target('bluesky', id, `https://bsky.app/profile/${profile}/post/${id}`, profile),
    lookupKey: `bluesky:${profile.toLowerCase()}:${id}`
  }
}

function parseTikTok(url: URL, host: string, unknown: boolean): SocialPostTarget | null {
  const video = url.pathname.match(/^\/@([\w.-]+)\/video\/(\d+)\/?$/i)
  if (video) {
    const [, profile = '', id = ''] = video
    return target('tiktok', id, `https://www.tiktok.com/@${profile}/video/${id}`, profile)
  }
  if (unknown) return null
  const photo = url.pathname.match(/^\/@([\w.-]+)\/photo\/(\d+)\/?$/i)
  if (photo) {
    const [, profile = '', id = ''] = photo
    return target('tiktok', id, `https://www.tiktok.com/@${profile}/photo/${id}`, profile)
  }
  if (/^v[mt]\.tiktok\.com$/.test(host)) {
    const code = url.pathname.match(/^\/([\w-]+)\/?$/)?.[1]
    if (code) return shareTarget('tiktok', code, `https://${host}/${code}/`, `tiktok:share:${code}`)
  }
  const short = url.pathname.match(/^\/t\/([\w-]+)\/?$/)?.[1]
  return short ? shareTarget('tiktok', short, `https://www.tiktok.com/t/${short}/`, `tiktok:share:${short}`) : null
}

function parseReddit(url: URL, host: string, unknown: boolean): SocialPostTarget | null {
  if (!unknown && hostMatches(host, 'redd.it')) {
    const id = url.pathname.match(/^\/([a-z0-9]+)\/?$/i)?.[1]
    return id ? target('reddit', id, `https://www.reddit.com/comments/${id}/`) : null
  }
  // A comment permalink names its post, then a slug, then the comment; the comment id is not kept.
  const comments =
    url.pathname.match(/^\/r\/[\w-]+\/comments\/([a-z0-9]+)(?:\/[^/]*)?(?:\/[a-z0-9]+)?\/?$/i)?.[1] ??
    (unknown ? undefined : url.pathname.match(/^\/comments\/([a-z0-9]+)\/?$/i)?.[1])
  if (comments) return target('reddit', comments, `https://www.reddit.com/comments/${comments}/`)
  if (unknown) return null
  const share = url.pathname.match(/^\/((?:r|u)\/[\w-]+)\/s\/([\w-]+)\/?$/i)
  if (!share) return null
  const [, base = '', code = ''] = share
  return shareTarget('reddit', code, `https://www.reddit.com/${base}/s/${code}/`, `reddit:share:${code}`)
}

function parseInstagram(url: URL, host: string, unknown: boolean): SocialPostTarget | null {
  if (!unknown) {
    const share = url.pathname.match(/^\/share\/(?:(p|reel)\/)?([\w-]+)\/?$/i)
    if (share) {
      const [, kind, code = ''] = share
      const path = kind ? `${kind.toLowerCase()}/` : ''
      return shareTarget(
        'instagram',
        code,
        `https://www.instagram.com/share/${path}${code}/`,
        `instagram:share:${code}`
      )
    }
    const tv = url.pathname.match(/^\/tv\/([\w-]+)\/?$/)?.[1]
    if (tv) return target('instagram', tv, `https://www.instagram.com/tv/${tv}/`)
  }
  // A link may carry the account before the kind, but `/share/` is never an account. `/reels/` is the plural of `/reel/`.
  const match = url.pathname.match(/^\/(?:(?!share\/)[\w.]+\/)?(p|reels?)\/([\w-]+)\/?$/i)
  if (!match) return null
  const [, rawKind = '', id = ''] = match
  const kind = rawKind.toLowerCase() === 'p' ? 'p' : 'reel'
  if (unknown && (!/^[\w-]{11}$/.test(id) || (kind === 'p' && !host.includes('insta')))) return null
  return target('instagram', id, `https://www.instagram.com/${kind}/${id}/`)
}

function parseBilibili(url: URL, host: string, unknown: boolean): SocialPostTarget | null {
  const video = url.pathname.match(unknown ? /^\/video\/(BV[\da-z]{10})\/?$/i : /^\/video\/(BV[\da-z]+|av\d+)\/?$/i)
  if (video) {
    const id = video[1] ?? ''
    const normalizedId = /^av/i.test(id) ? id.toLowerCase() : `BV${id.slice(2)}`
    const part = url.searchParams.getAll('p')
    const canonical = `https://www.bilibili.com/video/${normalizedId}`
    const base = target('bilibili', normalizedId, canonical)
    if (!part.length) return base
    if (part.length !== 1 || !/^[1-9]\d*$/.test(part[0]!)) {
      return { ...base, lookupKey: base.lookupKey + ':invalid-part', invalidPart: true }
    }
    const selected = target('bilibili', normalizedId, `${canonical}?p=${part[0]}`)
    return { ...selected, lookupKey: `${selected.lookupKey}:p${part[0]}` }
  }
  if (unknown || !hostMatches(host, 'b23.tv')) return null
  const code = url.pathname.match(/^\/([\w-]+)\/?$/)?.[1]
  return code ? shareTarget('bilibili', code, `https://b23.tv/${code}`, `bilibili:share:${code}`) : null
}

function parseThreads(url: URL, unknown: boolean): SocialPostTarget | null {
  // Threads writes a handle as `%40`; the path is read with the `@` a member would type.
  const path = url.pathname.replace(/%40/gi, '@')
  const match = path.match(/^\/@([\w.]+)\/post\/([\w-]+)(?:\/media)?\/?$/)
  if (match) {
    const [, profile = '', id = ''] = match
    return target('threads', id, `https://www.threads.com/@${profile}/post/${id}`, profile)
  }
  if (unknown) return null
  const post = path.match(/^\/post\/([\w-]+)\/?$/)?.[1]
  if (post) return target('threads', post, `https://www.threads.com/post/${post}`)
  // A short or share id is not a post code, so its key keeps the two apart; the post code comes from the redirect.
  const short = path.match(/^\/t\/([\w-]+)\/?$/)?.[1]
  if (short) return target('threads', short, `https://www.threads.com/t/${short}`)
  const share = path.match(/^\/share\/([\w-]+)\/?$/)?.[1]
  if (share) {
    return {
      ...target('threads', share, `https://www.threads.com/share/${share}`),
      lookupKey: `threads:share:${share}`
    }
  }
  return null
}

const NUMERIC_ID = /^\d+$/
// On a mirror host a Facebook id must be long enough to be distinctive; the address is rebuilt from it.
const LONG_NUMERIC_ID = /^\d{15,}$/

/** A Facebook post's own link: the group or page it is in is its profile, which marks it resolved. */
function facebookPost(url: URL, unknown: boolean): SocialPostTarget | null {
  const post = (id: string, canonicalUrl: string, profile: string): SocialPostTarget => ({
    ...target('facebook', id, canonicalUrl, profile),
    lookupKey: `facebook:post:${id}`
  })
  if (!unknown) {
    const group = url.pathname.match(/^\/groups\/([\w.-]+)\/(?:permalink|posts)\/(\d+)\/?$/)
    if (group) {
      const [, name = '', id = ''] = group
      return post(id, `https://www.facebook.com/groups/${name}/permalink/${id}/`, name)
    }
  }
  const page = url.pathname.match(/^\/([\w.-]+)\/posts\/([\w-]+)\/?$/)
  if (page) {
    const [, name = '', id = ''] = page
    // On a mirror host only a pfbid names a post; any other id is too generic.
    return !unknown || /^pfbid[a-z0-9]+$/i.test(id)
      ? post(id, `https://www.facebook.com/${name}/posts/${id}`, name)
      : null
  }
  if (unknown) return null
  const story = url.searchParams.get('story_fbid')
  const owner = url.searchParams.get('id')
  if (
    (url.pathname === '/permalink.php' || url.pathname === '/story.php') &&
    story &&
    owner &&
    /^[\w-]+$/.test(story) &&
    NUMERIC_ID.test(owner)
  ) {
    return post(story, `https://www.facebook.com/permalink.php?story_fbid=${story}&id=${owner}`, owner)
  }
  return null
}

/** A Facebook post or photo link, shared or resolved, is read from its page; a video link goes to yt-dlp. */
export function isFacebookPost(target: SocialPostTarget): boolean {
  return (
    target.platform === 'facebook' &&
    (target.lookupKey.startsWith('facebook:post') || target.lookupKey.startsWith('facebook:photo:'))
  )
}

/** A post or photo whose address names it outright. A photo needs no profile; a share still needs its redirect. */
export function isResolvedFacebookPost(target: SocialPostTarget): boolean {
  return isFacebookPost(target) && (Boolean(target.profile) || target.lookupKey.startsWith('facebook:photo:'))
}

function parseFacebook(url: URL, host: string, unknown: boolean): SocialPostTarget | null {
  if (hostMatches(host, 'fb.watch')) {
    const id = url.pathname.match(/^\/([\w-]+)\/?$/)?.[1]
    return id ? shareTarget('facebook', id, `https://fb.watch/${id}/`, `facebook:watch:${id}`) : null
  }
  const numericId = unknown ? LONG_NUMERIC_ID : NUMERIC_ID
  if (!unknown) {
    // A share id is not a video id, so its key keeps the two apart. Each share is resolved through its redirect.
    const share = url.pathname.match(/^\/share\/(?:(p|v|r)\/)?([\w-]+)\/?$/)
    if (share) {
      const [, kind, id = ''] = share
      if (kind === 'p') {
        return shareTarget('facebook', id, `https://www.facebook.com/share/p/${id}/`, `facebook:post-share:${id}`)
      }
      if (kind) {
        return shareTarget('facebook', id, `https://www.facebook.com/share/${kind}/${id}/`, `facebook:share:${id}`)
      }
      // A bare share may name a post or a video; its redirect says which.
      return shareTarget('facebook', id, `https://www.facebook.com/share/${id}/`, `facebook:short:${id}`)
    }
    const photo = /^\/photo(?:\.php)?\/?$/.test(url.pathname) ? url.searchParams.get('fbid') : null
    if (photo && NUMERIC_ID.test(photo)) {
      return {
        ...target('facebook', photo, `https://www.facebook.com/photo/?fbid=${photo}`),
        lookupKey: `facebook:photo:${photo}`
      }
    }
  }
  const post = facebookPost(url, unknown)
  if (post) return post
  const reel = url.pathname.match(/^\/reel\/(\d+)\/?$/)?.[1]
  if (reel && numericId.test(reel)) return target('facebook', reel, `https://www.facebook.com/reel/${reel}`)
  const watch = /^\/watch\/?$/.test(url.pathname) ? url.searchParams.get('v') : null
  if (watch && numericId.test(watch)) return target('facebook', watch, `https://www.facebook.com/watch/?v=${watch}`)
  const videoPath = unknown ? /^\/([\w.-]+)\/videos\/(\d+)\/?$/ : /^\/([\w.-]+)\/videos\/(?:[\w.-]+\/)?(\d+)\/?$/
  const video = url.pathname.match(videoPath)
  if (video && numericId.test(video[2] ?? '')) {
    const [, page = '', id = ''] = video
    return target('facebook', id, `https://www.facebook.com/${page}/videos/${id}/`)
  }
  return null
}

function parseFor(platform: SocialPlatform, url: URL, host: string, unknown: boolean): SocialPostTarget | null {
  switch (platform) {
    case 'x':
      return parseX(url, unknown)
    case 'bluesky':
      return parseBluesky(url, unknown)
    case 'youtube':
      return parseYouTube(url, host, unknown)
    case 'tiktok':
      return parseTikTok(url, host, unknown)
    case 'reddit':
      return parseReddit(url, host, unknown)
    case 'instagram':
      return parseInstagram(url, host, unknown)
    case 'bilibili':
      return parseBilibili(url, host, unknown)
    case 'threads':
      return parseThreads(url, unknown)
    case 'facebook':
      return parseFacebook(url, host, unknown)
  }
}

// LinkedIn is recognised, never read. Its links name no post target for intake, autofetch, search or a read, and no
// other platform's path rules apply on its hosts. Official hosts are linkedin.com with any subdomain, and lnkd.in
// with or without www. Profiles, articles and URN types other than activity are not posts. See
// docs/trd/tools.md#social-post-reader.
const LINKEDIN_POST_PATH = /^\/posts\/(?:[\w.%-]+?-)?activity-\d+(?:-[\w-]+)?\/?$/i
const LINKEDIN_UPDATE_PATH = /^\/feed\/update\/urn(?::|%3A)li(?::|%3A)activity(?::|%3A)\d+\/?$/i
const LINKEDIN_SHORT_PATH = /^\/[\w-]+\/?$/

/** A LinkedIn host: linkedin.com with any subdomain, mobile and regional included, or the lnkd.in domain. */
function isLinkedInHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.+$/, '')
  return hostMatches(host, 'linkedin.com') || hostMatches(host, 'lnkd.in')
}

/** Normalise equivalent spellings for read permissions while keeping the original address for the reader. */
function readPolicyUrl(value: string): URL | undefined {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
  // URL drops default ports and empty credentials. Check the raw authority for an empty user.
  if (url.port || url.username || url.password || /^[^:/?#]+:\/\/[^/?#]*@/.test(value.trim())) return undefined
  url.protocol = 'https:'
  url.hostname = url.hostname.replace(/\.+$/, '')
  return url
}

function isLinkedInLink(url: URL): boolean {
  const host = url.hostname
  if (host === 'lnkd.in' || host === 'www.lnkd.in') return LINKEDIN_SHORT_PATH.test(url.pathname)
  return (
    hostMatches(host, 'linkedin.com') &&
    (LINKEDIN_POST_PATH.test(url.pathname) || LINKEDIN_UPDATE_PATH.test(url.pathname))
  )
}

// Rednote (Xiaohongshu) is recognised, never read: its note pages redirect to login on both deployments. Each host
// below owns its paths, so a path there never reaches the unknown-host parsers. The two domains take apex and www
// only. xhslink.com takes a bare code or `o/{code}`, and xhslink.cn takes `o/{code}`. A bare `o` is the route.
const REDNOTE_NOTE_PATH = /^\/(?:explore|discovery\/item)\/[0-9a-f]{24}\/?$/i
const XHSLINK_COM_PATH = /^\/(?!o\/?$)(?:o\/)?[a-z0-9]+\/?$/i
const XHSLINK_CN_PATH = /^\/o\/[a-z0-9]+\/?$/i
const REDNOTE_PATHS = new Map<string, RegExp>([
  ['xiaohongshu.com', REDNOTE_NOTE_PATH],
  ['www.xiaohongshu.com', REDNOTE_NOTE_PATH],
  ['rednote.com', REDNOTE_NOTE_PATH],
  ['www.rednote.com', REDNOTE_NOTE_PATH],
  ['xhslink.com', XHSLINK_COM_PATH],
  ['xhslink.cn', XHSLINK_CN_PATH]
])

function isRednoteHost(hostname: string): boolean {
  return REDNOTE_PATHS.has(hostname.toLowerCase().replace(/\.+$/, ''))
}

/** Display name for a recognised post link with no approved read operation. */
export function recognitionOnlyName(value: string): 'LinkedIn' | 'Rednote' | null {
  const url = readPolicyUrl(value)
  if (!url) return null
  if (isLinkedInLink(url)) return 'LinkedIn'
  const pattern = REDNOTE_PATHS.get(url.hostname)
  if (!pattern) return null
  try {
    return pattern.test(decodeURI(url.pathname)) ? 'Rednote' : null
  } catch {
    return null
  }
}

function parseUrl(value: string, officialOnly: boolean): SocialPostTarget | null {
  const trimmed = value.trim()
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }

  const authority = trimmed.match(/^https:\/\/([^/?#]+)/i)?.[1]
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
  if (isLinkedInHost(host) || isRednoteHost(host)) return null
  const platform = platformForHost(host)
  let parsed: SocialPostTarget | null = null
  if (platform) parsed = parseFor(platform, url, host, false)
  else if (!officialOnly) {
    for (const candidate of UNKNOWN_HOST_PLATFORMS) {
      parsed = parseFor(candidate, url, host, true)
      if (parsed) break
    }
  }
  if (!parsed) return null
  return trimmed === parsed.canonicalUrl ? parsed : { ...parsed, originalUrl: trimmed }
}

/** A post link on any host. A link on an unknown host has the platform's own address as its target. */
export function parseSocialPostUrl(value: string): SocialPostTarget | null {
  return parseUrl(value, false)
}

/** A post link on a platform's own domain only. Used for the address a redirect names. */
export function parseOfficialSocialPostUrl(value: string): SocialPostTarget | null {
  return parseUrl(value, true)
}

/** Classify a URL for a read permission check without changing its eligibility for intake or fetch. */
export function readPolicyTarget(value: string): SocialPostTarget | null {
  const url = readPolicyUrl(value)
  const target = url && parseSocialPostUrl(url.href)
  return target ? { ...target, originalUrl: value.trim() } : null
}

// A link starts at `http`, and may carry WhatsApp format marks in front of it when they are not part of a word.
const LINK_CANDIDATE = /(?:(?<!\w)[*_~]+)?https?:\/\/[^\s<>()[\]{}]+/gi
const TRAILING_PUNCTUATION = /[.,!?;:'"`]+$/
const FORMAT_MARKS = '*_~'

/** Drops trailing punctuation and the format marks that wrap a link in pairs, nested or not. */
function unwrapLink(candidate: string): string {
  let link = candidate.replace(TRAILING_PUNCTUATION, '')
  for (;;) {
    const mark = link.charAt(0)
    if (mark === '' || !FORMAT_MARKS.includes(mark) || link.length < 2 || !link.endsWith(mark)) return link
    link = link.slice(1, -1).replace(TRAILING_PUNCTUATION, '')
  }
}

/** Receives a link's platform and hostname when its host is no platform's own. Never its path or query. */
export type UnknownHostReport = (entry: { platform: SocialPlatform; hostname: string }) => void

/** Every http(s) link in a text, in order, with trailing punctuation and wrapping format marks removed. */
export function linkUrls(text: string): string[] {
  return (text.match(LINK_CANDIDATE) ?? []).map(unwrapLink).filter((link) => link.length > 0)
}

/** Every supported post link in a text, in order. A link on an unknown host is reported by platform and hostname. */
export function findSocialPostTargets(text: string, onUnknownHost?: UnknownHostReport): SocialPostTarget[] {
  const targets: SocialPostTarget[] = []
  for (const candidate of text.match(LINK_CANDIDATE) ?? []) {
    const link = unwrapLink(candidate)
    const found = parseSocialPostUrl(link)
    if (!found) continue
    const hostname = new URL(link).hostname.toLowerCase()
    if (onUnknownHost && platformForHost(hostname) === null) onUnknownHost({ platform: found.platform, hostname })
    targets.push(found)
  }
  return targets
}

export function findSocialPostTarget(text: string, onUnknownHost?: UnknownHostReport): SocialPostTarget | null {
  return findSocialPostTargets(text, onUnknownHost)[0] ?? null
}

export function findLinkTarget(texts: string[], onUnknownHost?: UnknownHostReport): SocialPostTarget | null {
  for (const text of texts) {
    const target = findSocialPostTarget(text, onUnknownHost)
    if (target) return target
  }
  return null
}
