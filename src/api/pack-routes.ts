import { z } from 'zod'
import { checkLoadedPack } from '../character/check.js'
import { checkDraft } from '../character/draft.js'
import type { Pack } from '../character/loader.js'
import type { PackPreview } from '../character/preview.js'
import { PACK_ID } from '../character/schema.js'
import type { RouteResult, SiteApiDeps } from './routes.js'
import { readStudioPack, StudioPackError } from './studio-packs.js'

export interface PackValidation {
  ceiling: number
  harnessRules: string
}

export interface PackRoutes extends Pick<SiteApiDeps, 'packs' | 'paths' | 'storage'> {
  packValidation?: PackValidation
  packPreview?: (pack: Pack, message: string, live: boolean) => Promise<PackPreview>
}

const id = z.string().regex(PACK_ID)
const draftInput = z.unknown().refine((value) => value !== undefined)
const checkInput = z.strictObject({ draft: draftInput, existingId: id.optional() })
const message = z.string().min(1).max(16_000)
const previewInput = z.union([
  z.strictObject({ id, message, live: z.boolean().default(false) }),
  z.strictObject({ draft: draftInput, message, live: z.boolean().default(false) })
])

/** The new owner-only, non-publishing routes. Never send document bodies to diagnostics. */
export async function handlePack(options: PackRoutes, operation: 'check' | 'try', body: unknown): Promise<RouteResult> {
  const validation = options.packValidation
  if (!validation) return { status: 503, body: { error: 'capability_unavailable' } }
  try {
    if (operation === 'check') {
      const parsed = checkInput.safeParse(body)
      if (!parsed.success) return { status: 400, body: { error: 'invalid_body' } }
      const assets = parsed.data.existingId ? readStudioPack(options, parsed.data.existingId).pack : undefined
      const { check, pack } = checkDraft(parsed.data.draft, { ...validation, assets })
      // Only revision-aware update checks need the normalized card for an exact diff.
      return { status: 200, body: parsed.data.existingId && pack ? { ...check, normalizedCard: pack.card } : check }
    }
    if (!options.packPreview) return { status: 503, body: { error: 'capability_unavailable' } }
    const parsed = previewInput.safeParse(body)
    if (!parsed.success) return { status: 400, body: { error: 'invalid_body' } }
    const input = parsed.data
    let pack: Pack | undefined
    if ('id' in input) {
      pack = readStudioPack(options, input.id).pack
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
    if (error instanceof StudioPackError)
      return { status: error.status, body: { error: error.code === 'not_found' ? 'pack_not_found' : error.code } }
    throw error
  }
}
