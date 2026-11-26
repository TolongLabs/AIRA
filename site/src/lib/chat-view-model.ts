import type { CoreCharacter, CoreChat, Resolved, StandaloneControls } from './core.js'

export interface ChatFeatureDefinition {
  key: string
  label: string
  hint: string
}

/** The personas a chat may pick: the repository's placeholder pack is hidden unless the chat already uses it. */
export function personaChoices(characters: readonly CoreCharacter[], current?: string | null): CoreCharacter[] {
  return characters.filter((c) => c.id !== 'example' || c.source !== 'repository' || c.id === current)
}

/** Settings edited elsewhere or managed by commands, never cleared from the Chats tab. */
export const READ_ONLY_SETTINGS = new Set(['allowedSenders', 'muted', 'model'])

/** Feature toggle definitions shown in the Chats -> Features tab. */
export const CHAT_FEATURE_DEFINITIONS: readonly ChatFeatureDefinition[] = [
  { key: 'features.reminders', label: 'Reminders', hint: 'Off: /remind and set-reminder tools are not offered.' },
  { key: 'features.search', label: 'Web search', hint: 'Off: no search or page reading.' },
  { key: 'features.social', label: 'Social posts', hint: 'Off: links to posts are not read.' },
  { key: 'features.photos', label: 'Photos', hint: 'Off: no photo is sent.' },
  { key: 'features.media', label: 'Media watching', hint: 'Off: pictures, audio and video are not read.' },
  {
    key: 'features.think',
    label: 'Deeper thinking',
    hint: 'Off: /think is removed and the turn runs at normal effort.'
  },
  { key: 'features.feedback', label: 'Feedback', hint: 'Allow feedback reports from this chat.' },
  { key: 'features.identify', label: 'Image identification', hint: 'Allow the identification tool in this chat.' },
  { key: 'features.research', label: 'Research', hint: 'Allow research jobs from this chat.' },
  { key: 'features.reports', label: 'Reports', hint: 'Off: /doc is not offered.' },
  { key: 'features.proactive', label: 'Messages first', hint: 'Off: replies only when written to.' },
  { key: 'features.voice', label: 'Voice notes', hint: 'Off: replies are text.' },
  {
    key: 'features.autofetch',
    label: 'Post media',
    hint: "Send a linked post's own photos or video to this chat."
  },
  { key: 'features.lessons', label: 'Lessons', hint: 'Off: songs, words and the library are not offered.' },
  {
    key: 'features.owner',
    label: 'Owner tools',
    hint: "Markets and Claude Code sessions. For the owner's own chats."
  }
]

// Standalone enables text features and explicitly negotiated portable operations.
export const standaloneChatFeature = (key: string, controls: StandaloneControls) =>
  ['features.search', 'features.social', 'features.think'].includes(key) ||
  (key === 'features.reports' && controls.reportDocuments) ||
  (key === 'features.media' && controls.inboundMedia)

/** Presentation and validation helpers for one chat's resolved settings row. */
export class ChatSettingsViewModel {
  constructor(
    readonly chat: CoreChat,
    readonly characters: readonly CoreCharacter[]
  ) {}

  get storedLabel(): string {
    return this.chat.storedLabel
  }

  get displayLabel(): string {
    return this.chat.label || this.chat.waId
  }

  get labelPlaceholder(): string {
    return this.chat.label || 'Add a label'
  }

  isLabelDirty(draft: string): boolean {
    return draft.trim() !== this.chat.storedLabel
  }

  get effectiveCharacterId(): string | undefined {
    const value = this.chat.settings['character']?.value
    return typeof value === 'string' && value !== '' ? value : undefined
  }

  get boundPack(): CoreCharacter | undefined {
    const id = this.effectiveCharacterId
    return id === undefined ? undefined : this.characters.find((character) => character.id === id)
  }

  canToggleReplies(busy: boolean): boolean {
    if (busy) return false
    if (this.chat.status === 'active') return true
    return this.boundPack !== undefined
  }

  isReadOnlySetting(key: string): boolean {
    return READ_ONLY_SETTINGS.has(key)
  }

  canClearSetting(key: string): boolean {
    if (this.isReadOnlySetting(key)) return false
    return this.chat.settings[key]?.level === 'chat'
  }

  wakeNames(): string[] {
    const custom = this.chat.settings['nameCall.names']?.value
    const customList = Array.isArray(custom)
      ? this.dedupeNames(custom.filter((item): item is string => typeof item === 'string'))
      : []
    if (customList.length > 0) return customList
    const pack = this.boundPack
    if (!pack) return []
    return this.dedupeNames([pack.displayName, ...(pack.aliases ?? [])])
  }

  private dedupeNames(candidates: readonly string[]): string[] {
    const seen = new Set<string>()
    const out: string[] = []
    for (const candidate of candidates) {
      const trimmed = candidate.trim()
      if (trimmed === '') continue
      const key = trimmed.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(trimmed)
    }
    return out
  }

  settingValue<T>(key: string, fallback: T): T {
    const resolved: Resolved | undefined = this.chat.settings[key]
    return resolved && resolved.value !== undefined ? (resolved.value as T) : fallback
  }
}
