import { z } from 'zod'
import { SocialPostError } from '../../social/port.js'
import { parseSocialPostUrl } from '../../social/urls.js'
import type { Storage } from '../../storage/database.js'
import { putFile } from '../../storage/files.js'
import type { TurnContext } from '../../turn/types.js'
import { type ToolPorts, isForbiddenUrl } from '../ports.js'
import type { ToolDefinition, ToolFailure } from '../types.js'

function alreadyReadAtIntake(url: string, context: Pick<TurnContext, 'intakeUrls'>): boolean {
  const canonical = parseSocialPostUrl(url)?.canonicalUrl
  return canonical !== undefined && (context.intakeUrls?.includes(canonical) ?? false)
}

const MAX_PHOTO_BYTES = 5_000_000
const MAX_PHOTO_CANDIDATES = 3

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
      } catch (error) {
        return { ok: false, kind: 'error', reason: 'search failed', cause: error }
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
      route: (rest) => (parseSocialPostUrl(rest.trim().split(/\s+/)[0] ?? '') ? 'read_post' : undefined)
    },
    async handler(args, context) {
      if (isForbiddenUrl(args.url)) {
        return { ok: false, kind: 'refused', reason: 'forbidden address' }
      }
      if (alreadyReadAtIntake(args.url, context)) {
        return { ok: false, kind: 'refused', reason: 'already read at intake' }
      }
      if (!ports.page) {
        return { ok: false, kind: 'unavailable', reason: 'page reader is not set up' }
      }
      try {
        const page = await ports.page.read(args.url, context.signal)
        return { ok: true, data: { title: page.title, text: page.text } }
      } catch (error) {
        return { ok: false, kind: 'error', reason: 'page read failed', cause: error }
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
      if (alreadyReadAtIntake(args.url, context)) {
        return { ok: false, kind: 'refused', reason: 'already read at intake' }
      }
      if (!ports.post) {
        return { ok: false, kind: 'unavailable', reason: 'post reader is not set up' }
      }
      try {
        const post = await ports.post.read(args.url, context.signal)
        return { ok: true, data: { ...post } }
      } catch (error) {
        if (error instanceof SocialPostError) return { ok: false, kind: error.kind, reason: error.message }
        return { ok: false, kind: 'error', reason: 'post read failed', cause: error }
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

      let candidates: { url: string }[]
      try {
        candidates = await ports.search.images(args.query, context.signal)
      } catch (error) {
        return { ok: false, kind: 'error', reason: 'photo search failed', cause: error }
      }
      if (candidates.length === 0) {
        return { ok: false, kind: 'unavailable', reason: 'no photo found' }
      }

      let lastFailure: ToolFailure | undefined
      for (const candidate of candidates.slice(0, MAX_PHOTO_CANDIDATES)) {
        if (isForbiddenUrl(candidate.url)) {
          lastFailure = { ok: false, kind: 'refused', reason: 'forbidden address' }
          if (context.signal.aborted) break
          continue
        }

        let downloaded: { data: Buffer; contentType: string }
        try {
          downloaded = await ports.page.download(candidate.url, context.signal, MAX_PHOTO_BYTES)
        } catch (error) {
          lastFailure = { ok: false, kind: 'error', reason: 'photo download failed', cause: error }
          if (context.signal.aborted) break
          continue
        }

        const mime = downloaded.contentType.split(';')[0]?.trim().toLowerCase() ?? ''
        const ext = IMAGE_EXTENSIONS[mime]
        if (!ext) {
          lastFailure = { ok: false, kind: 'invalid', reason: 'downloaded file is not an image' }
          continue
        }
        if (downloaded.data.length > MAX_PHOTO_BYTES) {
          lastFailure = { ok: false, kind: 'invalid', reason: 'photo exceeds size limit' }
          continue
        }

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

      return lastFailure ?? { ok: false, kind: 'unavailable', reason: 'no photo found' }
    }
  }
}
