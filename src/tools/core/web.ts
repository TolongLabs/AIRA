import { z } from 'zod'
import type { Config } from '../../config/schema.js'
import { SocialPostError } from '../../social/port.js'
import { modelPostResult } from '../../social/result.js'
import { parseSocialPostUrl, recognitionOnlyName } from '../../social/urls.js'
import type { Storage } from '../../storage/database.js'
import { putFile } from '../../storage/files.js'
import { SOURCE_ID, type SourceEntry } from '../../turn/sources.js'
import type { TurnContext } from '../../turn/types.js'
import { isForbiddenUrl, type ToolPorts } from '../ports.js'
import { createSearchDepth, webSearchSchema } from '../search-depth.js'
import type { ToolContext, ToolDefinition, ToolFailure } from '../types.js'

/** Recorded reason for a refused link already watched at intake. The model reads its outcome sentence. */
export const INTAKE_REFUSAL =
  'This link was already opened and watched; its content is in your context. Answer from that.'

/** Recorded reason for a social link intake could not open. The model reads its outcome sentence. */
const INTAKE_FAILED_REASON = 'intake could not open this link'

function alreadyReadAtIntake(url: string, context: Pick<TurnContext, 'intakeWatchedUrls'>): boolean {
  const trimmed = url.trim()
  const canonical = parseSocialPostUrl(trimmed)?.canonicalUrl
  return (
    context.intakeWatchedUrls?.some(
      (watched) =>
        watched === trimmed ||
        (canonical !== undefined && (watched === canonical || parseSocialPostUrl(watched)?.canonicalUrl === canonical))
    ) ?? false
  )
}

/** A social address intake tried and could not open. read_post and read_page refuse it for the rest of the turn. */
function failedAtIntake(url: string, context: Pick<TurnContext, 'intakeTriedSocialUrls'>): boolean {
  const trimmed = url.trim()
  const canonical = parseSocialPostUrl(trimmed)?.canonicalUrl
  return (
    context.intakeTriedSocialUrls?.some(
      (entry) =>
        entry.failed &&
        (entry.url === trimmed ||
          (canonical !== undefined &&
            (entry.url === canonical || parseSocialPostUrl(entry.url)?.canonicalUrl === canonical)))
    ) ?? false
  )
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

/** A read takes one address the turn has seen: a URL, or the source id the turn gave it (docs/trd/tools.md#turn-sources). */
const readSchema = z.strictObject({
  url: z.string().trim().min(1).max(2000).optional().describe('A link this chat or your search showed'),
  source: z.string().trim().regex(SOURCE_ID).optional().describe('The id of such a link, such as s1')
})

/** The address a read opens, or the refusal when the turn never saw it. Runs before any network call. */
function resolveRead(
  args: z.infer<typeof readSchema>,
  context: ToolContext
): ({ ok: true } & SourceEntry) | ToolFailure {
  if ((args.url === undefined) === (args.source === undefined)) {
    return { ok: false, kind: 'invalid', reason: 'give exactly one of url or source', code: 'schema' }
  }
  const seen = context.sources.find(args)
  if (seen === undefined) {
    return { ok: false, kind: 'refused', reason: 'address not seen in this turn', code: 'unseen_link' }
  }
  const name = recognitionOnlyName(seen.url)
  if (name) {
    return {
      ok: false,
      kind: 'refused',
      reason: `${name} links are recognised but never read`,
      code: 'linkedin_recognition_only'
    }
  }
  return { ok: true, ...seen }
}

export function webSearchTool(
  ports: ToolPorts,
  config?: Config['search']['depth']
): ToolDefinition<z.infer<typeof webSearchSchema>> {
  const search = createSearchDepth(ports, config)
  return {
    name: 'web_search',
    description: 'Searches the web. Provide fields for lists, prices, hours and specific facts needing evidence.',
    schema: webSearchSchema,
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
        const data = args.fields
          ? await search.deep(args, context)
          : { results: await search.plain(args.query, context) }
        return { ok: true, data }
      } catch (error) {
        return { ok: false, kind: 'error', reason: 'search failed', cause: error }
      }
    }
  }
}

export function readPageTool(ports: ToolPorts): ToolDefinition<z.infer<typeof readSchema>> {
  return {
    name: 'read_page',
    description: 'Opens and reads one web page.',
    schema: readSchema,
    mode: 'implicit',
    mutates: false,
    feature: 'features.search',
    async handler(args, context) {
      const target = resolveRead(args, context)
      if (!target.ok) return target
      if (isForbiddenUrl(target.url)) {
        return { ok: false, kind: 'refused', reason: 'forbidden address' }
      }
      if (alreadyReadAtIntake(target.url, context)) {
        return { ok: false, kind: 'refused', reason: INTAKE_REFUSAL, code: 'already_read' }
      }
      if (failedAtIntake(target.url, context)) {
        return { ok: false, kind: 'refused', reason: INTAKE_FAILED_REASON, code: 'already_tried' }
      }
      if (!ports.page) {
        return { ok: false, kind: 'unavailable', reason: 'page reader is not set up' }
      }
      try {
        const page = await ports.page.read(target.url, context.signal)
        return { ok: true, data: { title: page.title, text: page.text, url: target.url, source: target.id } }
      } catch (error) {
        return { ok: false, kind: 'error', reason: 'page read failed', code: 'read_failed', cause: error }
      }
    }
  }
}

export function readPostTool(ports: ToolPorts): ToolDefinition<z.infer<typeof readSchema>> {
  return {
    name: 'read_post',
    description: 'Opens one social post with its media.',
    schema: readSchema,
    mode: 'implicit',
    mutates: false,
    feature: 'features.social',
    async handler(args, context) {
      const target = resolveRead(args, context)
      if (!target.ok) return target
      if (isForbiddenUrl(target.url)) {
        return { ok: false, kind: 'refused', reason: 'forbidden address' }
      }
      if (alreadyReadAtIntake(target.url, context)) {
        return { ok: false, kind: 'refused', reason: INTAKE_REFUSAL, code: 'already_read' }
      }
      if (failedAtIntake(target.url, context)) {
        return { ok: false, kind: 'refused', reason: INTAKE_FAILED_REASON, code: 'already_tried' }
      }
      if (!ports.post) {
        return { ok: false, kind: 'unavailable', reason: 'post reader is not set up' }
      }
      try {
        const post = await ports.post.read(target.url, context.signal, context.observeSocialLookup)
        const seen = context.sources.add(post.canonicalUrl ?? target.url, 'canonical') ?? target
        return { ok: true, data: { ...modelPostResult(post), url: seen.url, source: seen.id } }
      } catch (error) {
        if (error instanceof SocialPostError) {
          // read_failed names an error only; timeout and unavailable keep their own kind sentence.
          return error.kind === 'error'
            ? { ok: false, kind: 'error', reason: error.message, code: 'read_failed' }
            : { ok: false, kind: error.kind, reason: error.message }
        }
        return { ok: false, kind: 'error', reason: 'post read failed', code: 'read_failed', cause: error }
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
