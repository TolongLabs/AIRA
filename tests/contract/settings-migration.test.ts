import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applySettingsPlan, planSettingsMigration } from '../../src/migration/settings-import.js'
import { getChatByWaId } from '../../src/settings/chats.js'
import { resolveSettings, setSetting } from '../../src/settings/settings.js'
import { tmpDir, tmpStorage } from '../support/tmp.js'

// The settings and binding migration (docs/trd/data.md#migration-from-the-old-store), on an invented copy only.

const NOW = new Date('2026-11-16T12:00:00.000Z')
const GROUP = 'test-group-1@g.us'
const DM = 'test-dm-1@lid'
const PHONE_DM = '1234567890@s.whatsapp.net'

function oldCopy(): string {
  const dir = tmpDir('aira-old-settings-')
  writeFileSync(
    join(dir, 'bindings.yaml'),
    [
      'owner:',
      '  whatsapp: ["+1234567890"]',
      'defaults:',
      '  personality: old-main',
      '  mode: playful',
      '  permissions: { agent: none }',
      'bindings:',
      '  - match: { platform: whatsapp, kind: group, chat: test-group-1.g.us }',
      '    personality: old-main',
      '    mode: playful',
      '    permissions: { agent: none, photos: "off" }',
      '  - match: { platform: whatsapp, kind: dm, chat: "+1234567890" }',
      '    personality: old-family',
      '    mode: family',
      '    permissions: { agent: full, photos: "on", autofetch: "on" }',
      '  - match: { platform: telegram, kind: dm, chat: someone }',
      '    personality: old-main'
    ].join('\n')
  )
  writeFileSync(
    join(dir, 'language.json'),
    JSON.stringify({ 'group/whatsapp/test-group-1.g.us': 'en', 'dm/whatsapp/test-dm-1.lid': 'en+ja', nonsense: 'en' })
  )
  writeFileSync(join(dir, 'lessons.json'), JSON.stringify({ 'group/whatsapp/test-group-1.g.us': true }))
  writeFileSync(join(dir, 'faces.json'), JSON.stringify({ [`whatsapp:${GROUP}`]: { tone: 'warm' } }))
  writeFileSync(
    join(dir, 'quiet.json'),
    JSON.stringify({
      [`whatsapp:${DM}`]: NOW.getTime() / 1000 + 3600,
      [`whatsapp:${GROUP}`]: NOW.getTime() / 1000 - 60
    })
  )
  return dir
}

const characters = new Map([['old-main', 'example']])

describe('settings and binding migration', () => {
  it('plans chats, carried-over settings and a report of what has no new key', () => {
    const plan = planSettingsMigration(oldCopy(), characters, NOW)
    expect(plan.chats).toEqual([
      { waId: GROUP, type: 'group' },
      { waId: PHONE_DM, type: 'dm' },
      { waId: DM, type: 'dm' }
    ])
    expect(plan.settings).toEqual([
      { level: 'global', chat: '', key: 'character', value: 'example' },
      { level: 'chat', chat: GROUP, key: 'character', value: 'example' },
      { level: 'chat', chat: GROUP, key: 'features.photos', value: false },
      { level: 'chat', chat: PHONE_DM, key: 'features.photos', value: true },
      { level: 'chat', chat: PHONE_DM, key: 'features.autofetch', value: true },
      { level: 'chat', chat: GROUP, key: 'language', value: 'en' },
      { level: 'chat', chat: GROUP, key: 'features.lessons', value: true },
      { level: 'chat', chat: DM, key: 'muted', value: { by: 'migration', at: NOW.toISOString() } }
    ])
    expect(plan.reported).toEqual({
      default_mode_no_key: 1,
      default_permissions_no_key: 1,
      owner_no_key: 1,
      agent_no_key: 2,
      mode_no_key: 2,
      phone_binding: 1,
      personality_unmapped: 1,
      binding_unreadable: 1,
      language_invalid: 1,
      'language.json_unreadable': 1,
      tone_no_key: 1,
      mute_expired: 1
    })
  })

  it('applies the plan once: chats active, settings set, and a second run changes nothing', () => {
    const storage = tmpStorage()
    const plan = planSettingsMigration(oldCopy(), characters, NOW)
    expect(applySettingsPlan(storage, plan, () => NOW)).toEqual({
      chatsCreated: 3,
      chatsActivated: 3,
      settingsWritten: 8,
      alreadySet: 0
    })
    const group = getChatByWaId(storage, GROUP)
    expect(group?.status).toBe('active')
    const resolved = resolveSettings(storage, { chatId: group?.chatId ?? '', type: 'group' })
    expect(resolved['features.lessons']).toMatchObject({ value: true, level: 'chat' })
    expect(resolved['character']).toMatchObject({ value: 'example', level: 'chat' })
    const changes = storage.read((db) => db.prepare('SELECT count(*) FROM setting_change').pluck().get())
    expect(applySettingsPlan(storage, plan, () => NOW)).toEqual({
      chatsCreated: 0,
      chatsActivated: 0,
      settingsWritten: 0,
      alreadySet: 0
    })
    expect(storage.read((db) => db.prepare('SELECT count(*) FROM setting_change').pluck().get())).toBe(changes)
  })

  it('never replaces a value already set, and reports it', () => {
    const storage = tmpStorage()
    setSetting(storage, { level: 'global', scope: '', key: 'character', value: 'another', actor: 'owner' })
    const result = applySettingsPlan(storage, planSettingsMigration(oldCopy(), characters, NOW), () => NOW)
    expect(result.alreadySet).toBe(1)
    expect(resolveSettings(storage, { chatId: '', type: 'dm' })['character']).toMatchObject({ value: 'another' })
  })

  it('writes nothing when one step fails: the whole plan is one transaction', () => {
    const storage = tmpStorage()
    const plan = planSettingsMigration(oldCopy(), characters, NOW)
    plan.settings.push({ level: 'chat', chat: 'test-not-planned@g.us', key: 'language', value: 'en' })
    expect(() => applySettingsPlan(storage, plan, () => NOW)).toThrow()
    expect(storage.read((db) => db.prepare('SELECT count(*) FROM chat').pluck().get())).toBe(0)
    expect(storage.read((db) => db.prepare('SELECT count(*) FROM setting').pluck().get())).toBe(0)
  })
})
