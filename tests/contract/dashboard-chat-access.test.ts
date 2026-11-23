import { describe, expect, it } from 'vitest'
import { ensureChat, ensureSubject } from '../../src/settings/chats.js'
import { resolveSetting, SettingError, setSetting, unsetSetting } from '../../src/settings/settings.js'
import type { Storage } from '../../src/storage/database.js'
import { tmpStorage } from '../support/tmp.js'

/* allowedSenders scope and turn admission (docs/trd/data.md#setting-keys,
   docs/trd/reliability.md#turn-admission, src/turn/pipeline.ts). Every chat,
   sender and subject here is synthetic: no real name, number or id. */

/** The admission gate in src/turn/pipeline.ts. A scheduled turn skips the sender check. */
function senderAdmitted(allowed: unknown, senderId: string, scheduled: boolean): boolean {
  if (scheduled) return true
  if (allowed === 'all') return true
  return Array.isArray(allowed) && allowed.includes(senderId)
}

function setup() {
  const storage = tmpStorage()
  const group = ensureChat(storage, { waId: 'test-access-group', type: 'group' })
  const dm = ensureChat(storage, { waId: 'test-access-dm', type: 'dm' })
  const listed = ensureSubject(storage, 'test-sender-listed')
  const stranger = ensureSubject(storage, 'test-sender-stranger')
  return { storage, group, dm, listed, stranger }
}

const settingRows = (storage: Storage): number =>
  storage.read((db) => db.prepare('SELECT count(*) FROM setting').pluck().get() as number)

describe('allowedSenders scope and admission', () => {
  it('defaults to all and admits every sender in a group and a DM', () => {
    const { storage, group, dm, listed, stranger } = setup()

    expect(resolveSetting(storage, group, 'allowedSenders')).toEqual({ value: 'all', level: 'default' })
    expect(resolveSetting(storage, dm, 'allowedSenders')).toEqual({ value: 'all', level: 'default' })
    for (const chat of [group, dm]) {
      const allowed = resolveSetting(storage, chat, 'allowedSenders').value
      expect(senderAdmitted(allowed, listed, false)).toBe(true)
      expect(senderAdmitted(allowed, stranger, false)).toBe(true)
    }
  })

  it('a chat-level list allows the listed sender and refuses anyone else, without touching other chats', () => {
    const { storage, group, dm, listed, stranger } = setup()

    setSetting(storage, { level: 'chat', scope: group.chatId, key: 'allowedSenders', value: [listed], actor: 'test' })

    expect(resolveSetting(storage, group, 'allowedSenders')).toEqual({ value: [listed], level: 'chat' })
    expect(resolveSetting(storage, dm, 'allowedSenders')).toEqual({ value: 'all', level: 'default' })

    const groupAllowed = resolveSetting(storage, group, 'allowedSenders').value
    expect(senderAdmitted(groupAllowed, listed, false)).toBe(true)
    expect(senderAdmitted(groupAllowed, stranger, false)).toBe(false)

    const dmAllowed = resolveSetting(storage, dm, 'allowedSenders').value
    expect(senderAdmitted(dmAllowed, stranger, false)).toBe(true)
  })

  it('a scheduled turn skips the sender check', () => {
    const { storage, group, listed, stranger } = setup()

    setSetting(storage, { level: 'chat', scope: group.chatId, key: 'allowedSenders', value: [listed], actor: 'test' })

    const allowed = resolveSetting(storage, group, 'allowedSenders').value
    expect(senderAdmitted(allowed, stranger, false)).toBe(false)
    expect(senderAdmitted(allowed, stranger, true)).toBe(true)
  })

  it('an empty list refuses every live sender', () => {
    const { storage, dm, listed, stranger } = setup()

    setSetting(storage, { level: 'chat', scope: dm.chatId, key: 'allowedSenders', value: [], actor: 'test' })

    const allowed = resolveSetting(storage, dm, 'allowedSenders').value
    expect(senderAdmitted(allowed, listed, false)).toBe(false)
    expect(senderAdmitted(allowed, stranger, false)).toBe(false)
    expect(senderAdmitted(allowed, stranger, true)).toBe(true)
  })

  it('inherits down the hierarchy and clear restores the level above', () => {
    const { storage, group, dm, listed, stranger } = setup()

    setSetting(storage, { level: 'global', scope: '', key: 'allowedSenders', value: [listed], actor: 'test' })
    setSetting(storage, { level: 'type', scope: 'group', key: 'allowedSenders', value: [stranger], actor: 'test' })
    setSetting(storage, { level: 'chat', scope: group.chatId, key: 'allowedSenders', value: [listed], actor: 'test' })

    expect(resolveSetting(storage, group, 'allowedSenders')).toEqual({ value: [listed], level: 'chat' })
    expect(resolveSetting(storage, dm, 'allowedSenders')).toEqual({ value: [listed], level: 'global' })

    expect(unsetSetting(storage, { level: 'chat', scope: group.chatId, key: 'allowedSenders', actor: 'test' })).toBe(
      true
    )
    expect(resolveSetting(storage, group, 'allowedSenders')).toEqual({ value: [stranger], level: 'type' })

    expect(unsetSetting(storage, { level: 'type', scope: 'group', key: 'allowedSenders', actor: 'test' })).toBe(true)
    expect(resolveSetting(storage, group, 'allowedSenders')).toEqual({ value: [listed], level: 'global' })

    expect(unsetSetting(storage, { level: 'type', scope: 'group', key: 'allowedSenders', actor: 'test' })).toBe(false)
  })

  it('refuses values outside the all-or-ids shape and writes nothing', () => {
    const { storage, group } = setup()
    const listed = ensureSubject(storage, 'test-sender-shape')

    const bad: unknown[] = ['everyone', 'ALL', '', [''], ['ok', ''], [42], 42, { allow: 'all' }, null]
    for (const value of bad) {
      expect(() =>
        setSetting(storage, { level: 'chat', scope: group.chatId, key: 'allowedSenders', value, actor: 'test' })
      ).toThrow(SettingError)
    }

    expect(settingRows(storage)).toBe(0)
    expect(resolveSetting(storage, group, 'allowedSenders')).toEqual({ value: 'all', level: 'default' })

    setSetting(storage, { level: 'chat', scope: group.chatId, key: 'allowedSenders', value: [listed], actor: 'test' })
    expect(resolveSetting(storage, group, 'allowedSenders')).toEqual({ value: [listed], level: 'chat' })
  })
})
