import { z } from 'zod'
import { type GatewayDir, loadGatewayFile } from '../../media/files.js'
import { type IdentifyMatch, type IdentifyPort, isUploadType, MAX_TIMEOUT_MS, MAX_UPLOAD_BYTES } from '../identify.js'
import { isForbiddenUrl } from '../ports.js'
import type { HandlerResult, ToolDefinition } from '../types.js'

// identify_image (docs/trd/tools.md#reverse-image-hints). Read-only and implicit. Its matches are untrusted hints.

export const TOO_LARGE_OUTCOME = 'The picture was too large to look up closely.'

const argsSchema = z.strictObject({
  attachment: z.number().int().min(0)
})

export type IdentifyArgs = z.infer<typeof argsSchema>

export interface IdentifyToolOptions {
  port: IdentifyPort
  /** The gateway's media folders, which a local picture's path must lie under. */
  gatewayDirs: readonly GatewayDir[]
  /** Largest local picture uploaded. A larger one is never sent. */
  maxUploadBytes: number
  /** Limit for the upload and the search together. */
  timeoutMs: number
}

function hintsOf(matches: IdentifyMatch[]) {
  return {
    untrusted: true,
    hints: 'unverified',
    outcome: matches.length > 0 ? 'matches' : 'no_matches',
    matches
  }
}

export function identifyImageTool(options: IdentifyToolOptions): ToolDefinition<IdentifyArgs> {
  // Both limits are capped here too, so no caller can lift them past the config's hard maximums.
  const maxUploadBytes = Math.min(options.maxUploadBytes, MAX_UPLOAD_BYTES)
  const timeoutMs = Math.min(options.timeoutMs, MAX_TIMEOUT_MS)
  return {
    name: 'identify_image',
    description:
      "Finds unverified reverse-image hints for one of this turn's pictures, by its attachment index from 0. Name an exact product only after web_search finds a maker or shop listing that matches.",
    schema: argsSchema,
    mode: 'implicit',
    mutates: false,
    feature: 'features.identify',
    timeoutMs,
    async handler(args, context): Promise<HandlerResult> {
      const image = context.images?.[args.attachment]
      if (image === undefined) {
        return { ok: false, kind: 'refused', reason: 'no picture with that attachment index in this turn' }
      }
      try {
        if (image.kind === 'url') {
          if (!image.url.startsWith('https://') || isForbiddenUrl(image.url)) {
            return { ok: false, kind: 'refused', reason: 'picture link is not a public https address' }
          }
          return { ok: true, data: hintsOf(await options.port.byUrl(image.url, context.signal)) }
        }
        const loaded = await loadGatewayFile(image.attachment, options.gatewayDirs, maxUploadBytes)
        if (!loaded.ok && loaded.reason === 'too large') {
          return { ok: true, data: { untrusted: true, hints: 'unverified', outcome: TOO_LARGE_OUTCOME, matches: [] } }
        }
        if (!loaded.ok || loaded.kind !== 'image' || !isUploadType(loaded.file.contentType)) {
          return { ok: false, kind: 'unavailable', reason: 'picture could not be read' }
        }
        const matches = await options.port.byFile(loaded.file.data, loaded.file.contentType, context.signal)
        return { ok: true, data: hintsOf(matches) }
      } catch (error) {
        return { ok: false, kind: 'error', reason: 'picture lookup failed', cause: error }
      }
    }
  }
}
