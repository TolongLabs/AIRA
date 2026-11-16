import type { Resolved } from '../settings/settings.js'

export interface NameCallPack {
  card: {
    displayName: string
    aliases?: string[]
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Returns the chat's `nameCall.names` when set, else the bound character's display name and aliases. */
export function resolveNames(
  settings: Record<string, Pick<Resolved, 'value'> | undefined>,
  pack: NameCallPack | undefined
): string[] {
  const custom = settings['nameCall.names']?.value
  if (Array.isArray(custom) && custom.length > 0) {
    return custom.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
  }
  if (!pack) return []
  const seen = new Set<string>()
  const names: string[] = []
  for (const candidate of [pack.card.displayName, ...(pack.card.aliases ?? [])]) {
    const key = candidate.toLowerCase()
    if (candidate.trim() === '' || seen.has(key)) continue
    seen.add(key)
    names.push(candidate)
  }
  return names
}

/** True when any name appears in `text` as a whole word in any case. */
export function matchesName(text: string, names: readonly string[]): boolean {
  return names.some((name) => {
    if (name.trim() === '') return false
    return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, 'iu').test(text)
  })
}
