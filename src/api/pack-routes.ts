import { z } from 'zod'
import { checkLoadedPack } from '../character/check.js'
import { checkDraft } from '../character/draft.js'
import type { Pack } from '../character/loader.js'
import type { PackPreview } from '../character/preview.js'
import { PACK_ID } from '../character/schema.js'
import type { RouteResult, SiteApiDeps } from './routes.js'
import { getStudioPack, StudioPackError } from './studio-packs.js'

export interface PackValidation {
  ceiling: number
  harnessRules: string
}

export interface PackRoutes extends Pick<SiteApiDeps, 'packs' | 'paths' | 'storage'> {
  packValidation?: PackValidation
  packPreview?: (pack: Pack, message: string, live: boolean) => Promise<PackPreview>
}

const id = z.string().regex(PACK_ID)
const checkInput = z.strictObject({ draft: z.unknown(), existingId: id.optional() })
const message = z.string().min(1).max(16_000)
const previewInput = z.union([
  z.strictObject({ id, message, live: z.boolean().default(false) }),
  z.strictObject({ draft: z.unknown(), message, live: z.boolean().default(false) })
])

function installedPack(options: PackRoutes, id: string): Pack | undefined {
  // Studio read verifies the complete layout (including assets) and pack identity.
  getStudioPack(options, id)
  return options.packs().packs.get(id)
}

/** The new owner-only, non-publishing routes. Never send document bodies to diagnostics. */
export async function handlePack(options: PackRoutes, operation: 'check' | 'try', body: unknown): Promise<RouteResult> {
  const validation = options.packValidation
  if (!validation) return { status: 503, body: { error: 'capability_unavailable' } }
  try {
    if (operation === 'check') {
      const parsed = checkInput.safeParse(body)
      if (!parsed.success) return { status: 400, body: { error: 'invalid_body' } }
      const assets = parsed.data.existingId ? installedPack(options, parsed.data.existingId) : undefined
      const { check } = checkDraft(parsed.data.draft, { ...validation, assets })
      return { status: 200, body: check }
    }
    if (!options.packPreview) return { status: 503, body: { error: 'capability_unavailable' } }
    const parsed = previewInput.safeParse(body)
    if (!parsed.success) return { status: 400, body: { error: 'invalid_body' } }
    const input = parsed.data
    let pack: Pack | undefined
    if ('id' in input) {
      pack = installedPack(options, input.id)
      if (!pack) return { status: 404, body: { error: 'not_found' } }
      const check = checkLoadedPack(pack, validation.ceiling, validation.harnessRules)
      if (!check.ok) return { status: 400, body: { error: 'invalid_pack', ...check } }
    } else {
      const result = checkDraft(input.draft, validation)
      if (!result.pack) return { status: 400, body: { error: 'invalid_pack', ...result.check } }
      pack = result.pack
    }
    try {
      return { status: 200, body: await options.packPreview(pack, input.message, input.live) }
    } catch {
      return { status: 503, body: { error: 'preview_unavailable' } }
    }
  } catch (error) {
    if (error instanceof StudioPackError) return { status: error.status, body: { error: error.code } }
    throw error
  }
}
