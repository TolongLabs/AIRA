import { z } from 'zod'
import type { Storage } from '../../storage/database.js'
import { putFile } from '../../storage/files.js'
import { type ToolPorts, isForbiddenUrl } from '../ports.js'
import type { ToolDefinition } from '../types.js'

const SOCIAL_HOSTS = [
  'x.com',
  'twitter.com',
  'instagram.com',
  'threads.net',
  'tiktok.com',
  'bsky.app',
  'youtube.com',
  'youtu.be',
  'reddit.com',
  'facebook.com',
  'bilibili.com'
]

function isSocialUrl(raw: string): boolean {
  const token = raw.trim().split(/\s+/)[0]
  if (!token) return false
  let parsed: URL
  try {
    parsed = new URL(token)
  } catch {
    return false
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '')
  return SOCIAL_HOSTS.some((social) => host === social || host.endsWith(`.${social}`))
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif'
}

const querySchema = z.strictObject({
  query: z.string().trim().min(1).max(200)
})

const urlSchema = z.strictObject({
  url: z.string().trim().min(1).max(2000)
})

export function webSearchTool(ports: ToolPorts): ToolDefinition<z.infer<typeof querySchema>> {
  return {
    name: 'web_search',
    description: 'Searches the web.',
    schema: querySchema,
    mode: 'both',
    mutates: false,
    feature: 'features.search',
    command: {
      names: ['search'],
      kind: 'skill',
      usage: '/search <query>'
    },
    async handler(args, context) {
      if (!ports.search) {
        return { ok: false, kind: 'unavailable', reason: 'search is not set up' }
      }
      try {
        const results = await ports.search.search(args.query, context.signal)
        return { ok: true, data: { results: results.slice(0, 8) } }
      } catch {
        return { ok: false, kind: 'error', reason: 'search failed' }
      }
    }
  }
}

export function readPageTool(ports: ToolPorts): ToolDefinition<z.infer<typeof urlSchema>> {
  return {
    name: 'read_page',
    description: 'Opens and reads one web page.',
    schema: urlSchema,
    mode: 'both',
    mutates: false,
    feature: 'features.search',
    command: {
      names: ['read'],
      kind: 'skill',
      usage: '/read <url>',
      route: (rest) => (isSocialUrl(rest) ? 'read_post' : undefined)
    },
    async handler(args, context) {
      if (isForbiddenUrl(args.url)) {
        return { ok: false, kind: 'refused', reason: 'forbidden address' }
      }
      if (!ports.page) {
        return { ok: false, kind: 'unavailable', reason: 'page reader is not set up' }
      }
      try {
        const page = await ports.page.read(args.url, context.signal)
        return { ok: true, data: { title: page.title, text: page.text } }
      } catch {
        return { ok: false, kind: 'error', reason: 'page read failed' }
      }
    }
  }
}

export function readPostTool(ports: ToolPorts): ToolDefinition<z.infer<typeof urlSchema>> {
  return {
    name: 'read_post',
    description: 'Opens one social post with its media.',
    schema: urlSchema,
    mode: 'both',
    mutates: false,
    feature: 'features.social',
    async handler(args, context) {
      if (isForbiddenUrl(args.url)) {
        return { ok: false, kind: 'refused', reason: 'forbidden address' }
      }
      if (!ports.post) {
        return { ok: false, kind: 'unavailable', reason: 'post reader is not set up' }
      }
      try {
        const post = await ports.post.read(args.url, context.signal)
        return { ok: true, data: { author: post.author, text: post.text, media: post.media } }
      } catch {
        return { ok: false, kind: 'error', reason: 'post read failed' }
      }
    }
  }
}

export function sendPhotoTool(storage: Storage, ports: ToolPorts): ToolDefinition<z.infer<typeof querySchema>> {
  return {
    name: 'send_photo',
    description: 'Finds one real photo and attaches it to the reply.',
    schema: querySchema,
    mode: 'both',
    mutates: true,
    feature: 'features.photos',
    command: {
      names: ['photo'],
      kind: 'skill',
      usage: '/photo <query>'
    },
    async handler(args, context) {
      if (!ports.search?.images || !ports.page) {
        return { ok: false, kind: 'unavailable', reason: 'photo search is not set up' }
      }

      let firstUrl: string | undefined
      try {
        const images = await ports.search.images(args.query, context.signal)
        firstUrl = images[0]?.url
      } catch {
        return { ok: false, kind: 'error', reason: 'photo search failed' }
      }
      if (!firstUrl) {
        return { ok: false, kind: 'unavailable', reason: 'no photo found' }
      }
      if (isForbiddenUrl(firstUrl)) {
        return { ok: false, kind: 'refused', reason: 'forbidden address' }
      }

      let downloaded: { data: Buffer; contentType: string }
      try {
        downloaded = await ports.page.download(firstUrl, context.signal, 5_000_000)
      } catch {
        return { ok: false, kind: 'error', reason: 'photo download failed' }
      }

      const mime = downloaded.contentType.split(';')[0]?.trim().toLowerCase() ?? ''
      if (!mime.startsWith('image/')) {
        return { ok: false, kind: 'invalid', reason: 'downloaded file is not an image' }
      }
      const ext = IMAGE_EXTENSIONS[mime] ?? '.jpg'
      const stored = putFile(
        storage,
        ports.filesDir,
        {
          data: downloaded.data,
          ext,
          kind: 'photo'
        },
        context.now
      )

      const { data } = context.commit(() => ({
        data: { attached: true },
        receipt: {
          kind: 'photo.found',
          target: stored.sha256,
          state: { attachment: stored.path }
        }
      }))
      return { ok: true, data }
    }
  }
}
