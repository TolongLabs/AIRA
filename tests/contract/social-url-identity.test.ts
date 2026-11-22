import { expect, it } from 'vitest'
import { resolveShareLink } from '../../src/social/share.js'
import {
  findSocialPostTargets,
  parseOfficialSocialPostUrl,
  parseSocialPostUrl,
  readPolicyTarget
} from '../../src/social/urls.js'

import { socialUrlPairs } from '../support/social-url-pairs.js'

it.each(Object.entries(socialUrlPairs))(
  'keeps %s post identity across intake, permission checks and redirect parsing',
  (platform, [alias, canonical]) => {
    const url = 'https://' + alias
    const canonicalUrl = 'https://' + canonical
    const encoded = new URL(canonicalUrl)
    encoded.pathname = encoded.pathname.replace(/[a-z0-9]/i, (c) => '%' + c.charCodeAt(0).toString(16))
    const direct = parseSocialPostUrl(canonicalUrl)
    expect(direct?.platform).toBe(platform)
    const expected = { platform, lookupKey: direct!.lookupKey, canonicalUrl }
    for (const parsed of [
      parseSocialPostUrl(encoded.href),
      parseSocialPostUrl(url),
      readPolicyTarget(url),
      parseOfficialSocialPostUrl(url),
      findSocialPostTargets(url)[0]
    ]) {
      expect(parsed).toMatchObject(expected)
    }
  }
)

it('keeps Reddit video CDN asset identifiers out of the post namespace', () => {
  expect(parseSocialPostUrl('https://v.redd.it/example123')).toBeNull()
})

const shortLinks = {
  tiktok: ['vm.tiktok.com/Example', 'vt.tiktok.com/Example', 'www.tiktok.com/t/Example/'],
  reddit: ['www.reddit.com/r/example/s/Sample123', 'www.reddit.com/u/example/s/Sample456'],
  instagram: ['www.instagram.com/share/p/SampleABC/', 'www.instagram.com/share/reel/SampleDEF/'],
  bilibili: ['b23.tv/Example'],
  facebook: ['fb.watch/Example/', 'www.facebook.com/share/p/Example/'],
  lemon8: ['s.lemon8-app.com/s/Example', 'v.lemon8-app.com/al/Example'],
  rednote: ['xhslink.com/o/Example', 'xhslink.cn/o/Example', 'xhslink.com/Example'],
  douyin: ['v.douyin.com/Example/'],
  linkedin: ['lnkd.in/p/Example', 'lnkd.in/Example']
} as const

for (const platform of Object.keys(shortLinks) as (keyof typeof shortLinks)[]) {
  it.each(shortLinks[platform])('resolves %s to its official post before reader selection', async (address) => {
    const [alias, canonical] = socialUrlPairs[platform]
    const [share] = findSocialPostTargets('看「https://' + address + '」。')
    expect(share).toMatchObject({ platform, needsRedirect: true })
    const resolved = await resolveShareLink(share!, async (input, init) => {
      expect(input).toBe(share!.canonicalUrl)
      expect(init?.redirect).toBe('manual')
      return new Response(null, { status: 302, headers: { location: 'https://' + alias } })
    })
    expect(resolved?.lookupKey).toBe(parseOfficialSocialPostUrl('https://' + canonical)?.lookupKey)
    expect(resolved?.canonicalUrl).toBe('https://' + canonical)
  })
}

it.each([
  ['https://www.youtube.com/watch/?v=abcdefghijk', 'youtube:abcdefghijk'],
  ['https://www.reddit.com/gallery/abc123', 'reddit:abc123'],
  [
    'https://www.linkedin.com/embed/feed/update/urn%3Ali%3Aactivity%3A1234567890123456789/',
    'linkedin:1234567890123456789'
  ]
])('reads the stable post ID in %s', (url, lookupKey) => {
  expect(parseSocialPostUrl(url)?.lookupKey).toBe(lookupKey)
})

it('preserves encoded separators, query bytes and the original source address', () => {
  expect(parseSocialPostUrl('https://www.douyin.com/video%2f1234567890123456789')).toBeNull()
  expect(parseSocialPostUrl('https://www.douyin.com/video%252f1234567890123456789')).toBeNull()
  const url = 'https://www.rednote.com/%64iscovery/item/0123456789abcdef01234567?xsec_token=sample%2Btoken'
  expect(parseSocialPostUrl(url)?.originalUrl).toBe(url)
})
