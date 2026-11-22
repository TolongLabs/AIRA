import { platformSwitchOn } from '../settings/settings.js'
import { readPolicyTarget, type SocialPostTarget } from '../social/urls.js'
import type { TurnContext } from '../turn/types.js'

/**
 * The post a read names when the chat's read switch for its platform is off, else undefined. Page reads, post reads and
 * automatic page reads from typed search share this check. It runs before any network call.
 */
export function switchedOffPost(url: string, settings: TurnContext['settings'] | undefined): SocialPostTarget | undefined {
  const target = readPolicyTarget(url)
  return target && !platformSwitchOn(settings, 'social', target.platform) ? target : undefined
}
