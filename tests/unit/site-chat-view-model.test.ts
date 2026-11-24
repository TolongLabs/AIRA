import { describe, expect, it } from 'vitest'
import {
  CHAT_FEATURE_DEFINITIONS,
  ChatSettingsViewModel,
  personaChoices,
  READ_ONLY_SETTINGS
} from '../../site/src/lib/chat-view-model.js'
import { type CoreCharacter, type CoreChat, CoreError, reasonText } from '../../site/src/lib/core.js'

function makeChat(overrides: Partial<CoreChat> = {}): CoreChat {
  return {
    chatId: 'c_123456',
    waId: '0000000000@g.us',
    storedLabel: '',
    type: 'group',
    label: '',
    status: 'pending',
    settings: {},
    ...overrides
  }
}

function makeCharacter(overrides: Partial<CoreCharacter> = {}): CoreCharacter {
  return {
    id: 'aira',
    displayName: 'Aira',
    aliases: ['Example', 'AIRA'],
    source: 'repository',
    languages: ['en'],
    ...overrides
  }
}

describe('ChatSettingsViewModel labels', () => {
  it('separates storedLabel from the fallback label placeholder and dirtiness check', () => {
    const vm = new ChatSettingsViewModel(
      makeChat({
        storedLabel: '',
        label: 'Weekend Crew'
      }),
      []
    )

    expect(vm.storedLabel).toBe('')
    expect(vm.displayLabel).toBe('Weekend Crew')
    expect(vm.labelPlaceholder).toBe('Weekend Crew')
    expect(vm.isLabelDirty('')).toBe(false)
    expect(vm.isLabelDirty('   ')).toBe(false)
    expect(vm.isLabelDirty('Weekend Crew')).toBe(true)
    expect(vm.isLabelDirty('Custom Crew')).toBe(true)
  })

  it('falls back to waId for displayLabel and Add a label for placeholder when unlabeled', () => {
    const vm = new ChatSettingsViewModel(makeChat({ waId: '0000000000@s.whatsapp.net' }), [])

    expect(vm.displayLabel).toBe('0000000000@s.whatsapp.net')
    expect(vm.labelPlaceholder).toBe('Add a label')
  })

  it('marks clearing an existing storedLabel as dirty', () => {
    const vm = new ChatSettingsViewModel(makeChat({ storedLabel: 'Pinned Crew', label: 'Pinned Crew' }), [])

    expect(vm.isLabelDirty('Pinned Crew')).toBe(false)
    expect(vm.isLabelDirty('  Pinned Crew  ')).toBe(false)
    expect(vm.isLabelDirty('')).toBe(true)
  })
})

describe('ChatSettingsViewModel replies toggle', () => {
  it('requires a loaded character pack to turn on a pending chat', () => {
    const noChar = new ChatSettingsViewModel(makeChat({ status: 'pending' }), [makeCharacter()])
    const unloaded = new ChatSettingsViewModel(
      makeChat({
        status: 'pending',
        settings: { character: { value: 'missing', level: 'chat' } }
      }),
      [makeCharacter()]
    )
    const loaded = new ChatSettingsViewModel(
      makeChat({
        status: 'pending',
        settings: { character: { value: 'aira', level: 'global' } }
      }),
      [makeCharacter()]
    )

    expect(noChar.canToggleReplies(false)).toBe(false)
    expect(unloaded.canToggleReplies(false)).toBe(false)
    expect(loaded.canToggleReplies(false)).toBe(true)
    expect(loaded.canToggleReplies(true)).toBe(false)
  })

  it('always allows turning off an active chat even when its character is not loaded', () => {
    const activeWithoutPack = new ChatSettingsViewModel(
      makeChat({
        status: 'active',
        settings: { character: { value: 'missing', level: 'chat' } }
      }),
      []
    )

    expect(activeWithoutPack.boundPack).toBeUndefined()
    expect(activeWithoutPack.canToggleReplies(false)).toBe(true)
    expect(activeWithoutPack.canToggleReplies(true)).toBe(false)
  })
})

describe('ChatSettingsViewModel read-only and clearable settings', () => {
  it('blocks clearing read-only settings even at chat level and allows clearing editable chat overrides', () => {
    const vm = new ChatSettingsViewModel(
      makeChat({
        settings: {
          allowedSenders: { value: ['123'], level: 'chat' },
          muted: { value: { by: 'owner', at: '2026-01-01T00:00:00Z' }, level: 'chat' },
          model: { value: { provider: 'anthropic', model: 'claude' }, level: 'chat' },
          language: { value: 'ms', level: 'chat' },
          replyLength: { value: 'short', level: 'type' },
          freeResponse: { value: false, level: 'global' },
          expressions: { value: true, level: 'default' }
        }
      }),
      []
    )

    expect([...READ_ONLY_SETTINGS]).toEqual(['allowedSenders', 'muted', 'model'])

    for (const key of ['allowedSenders', 'muted', 'model']) {
      expect(vm.isReadOnlySetting(key)).toBe(true)
      expect(vm.canClearSetting(key)).toBe(false)
    }

    expect(vm.isReadOnlySetting('language')).toBe(false)
    expect(vm.canClearSetting('language')).toBe(true)
    expect(vm.canClearSetting('replyLength')).toBe(false)
    expect(vm.canClearSetting('freeResponse')).toBe(false)
    expect(vm.canClearSetting('expressions')).toBe(false)
    expect(vm.canClearSetting('unsetKey')).toBe(false)
  })

  it('returns resolved setting values or fallback when missing or undefined', () => {
    const vm = new ChatSettingsViewModel(
      makeChat({
        settings: {
          language: { value: 'ms', level: 'chat' },
          footerEmoji: { value: undefined, level: 'unset' }
        }
      }),
      []
    )

    expect(vm.settingValue('language', 'auto')).toBe('ms')
    expect(vm.settingValue('footerEmoji', '✨')).toBe('✨')
    expect(vm.settingValue('replyLength', 'default')).toBe('default')
  })
})

describe('ChatSettingsViewModel wakeNames', () => {
  it('includes displayName and aliases from boundPack, trimmed and deduplicated case-insensitively', () => {
    const vm = new ChatSettingsViewModel(
      makeChat({
        settings: {
          character: { value: 'aira', level: 'chat' }
        }
      }),
      [
        makeCharacter({
          displayName: ' Aira ',
          aliases: ['AIRA', 'Example', '  example ', '  ', 'Ai']
        })
      ]
    )

    expect(vm.wakeNames()).toEqual(['Aira', 'Example', 'Ai'])
  })

  it('replaces boundPack names when non-empty nameCall.names are set, matching gateway resolveNames', () => {
    const vm = new ChatSettingsViewModel(
      makeChat({
        settings: {
          character: { value: 'aira', level: 'chat' },
          'nameCall.names': { value: ['Taiga', ' taiga ', 'Ah Boy'], level: 'chat' }
        }
      }),
      [makeCharacter({ displayName: 'Aira', aliases: ['Example'] })]
    )

    expect(vm.wakeNames()).toEqual(['Taiga', 'Ah Boy'])
  })

  it('returns empty when no boundPack or nameCall names exist', () => {
    const vm = new ChatSettingsViewModel(makeChat(), [])
    expect(vm.wakeNames()).toEqual([])
  })
})

describe('CHAT_FEATURE_DEFINITIONS and reasonText', () => {
  it('includes features.feedback, features.identify, and features.research among all 15 switches', () => {
    const keys = CHAT_FEATURE_DEFINITIONS.map((entry) => entry.key)
    expect(CHAT_FEATURE_DEFINITIONS).toHaveLength(15)
    expect(keys).toContain('features.feedback')
    expect(keys).toContain('features.identify')
    expect(keys).toContain('features.research')
  })

  it('maps missing_character and internal reason codes to plain-word messages', () => {
    expect(reasonText(new CoreError(400, 'missing_character'))).toBe('An active chat requires a loaded character.')
    expect(reasonText(new CoreError(500, 'internal'))).toBe(
      'The core hit an internal error while saving. Reload to check the current value.'
    )
  })
})

describe('personaChoices', () => {
  const pack = (id: string, source: CoreCharacter['source']): CoreCharacter => ({
    id,
    displayName: id,
    source,
    languages: ['en']
  })
  const all = [pack('example', 'repository'), pack('mine', 'data')]

  it('hides the repository placeholder pack', () => {
    expect(personaChoices(all).map((c) => c.id)).toEqual(['mine'])
  })

  it('keeps the placeholder when the chat already uses it, and an uploaded pack with the same id', () => {
    expect(personaChoices(all, 'example').map((c) => c.id)).toEqual(['example', 'mine'])
    expect(personaChoices([pack('example', 'data')]).map((c) => c.id)).toEqual(['example'])
  })
})
