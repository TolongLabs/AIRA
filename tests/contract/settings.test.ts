import { describe, expect, it } from 'vitest'
import {
  ensureChat,
  ensureSubject,
  getChat,
  getChatByWaId,
  linkIdentity,
  listChats,
  setChatLabel,
  setChatStatus
} from '../../src/settings/chats.js'
import { SETTING_KEYS, definitionFor } from '../../src/settings/keys.js'
import { SettingError, resolveSetting, resolveSettings, setSetting, unsetSetting } from '../../src/settings/settings.js'
import type { Storage } from '../../src/storage/database.js'
import { tmpStorage } from '../support/tmp.js'

const clockAt = (iso: string) => () => new Date(iso)

const count = (storage: Storage, table: string): number =>
  storage.read((db) => db.prepare(`SELECT count(*) FROM ${table}`).pluck().get() as number)

interface ChangeRow {
  target: string
  actor: string
  level: string | null
  scope: string | null
  key: string
  old_value: string | null
  new_value: string | null
  changed_at: string
}

const allChanges = (storage: Storage): ChangeRow[] =>
  storage.read((db) => db.prepare('SELECT * FROM setting_change ORDER BY id').all() as ChangeRow[])

describe('settings resolution', () => {
  it('returns every key in SETTING_KEYS with defaults and character unset on an empty database', () => {
    const storage = tmpStorage()
    const chat = ensureChat(storage, { waId: 'fake-dm-one', type: 'dm' })
    const resolved = resolveSettings(storage, chat)

    expect(Object.keys(resolved).sort()).toEqual(Object.keys(SETTING_KEYS).sort())
    expect(resolved.character).toEqual({ value: undefined, level: 'unset' })
    expect(resolved.quietHours).toEqual({ value: undefined, level: 'unset' })
    expect(resolved.language).toEqual({ value: 'auto', level: 'default' })
    expect(resolved.freeResponse).toEqual({ value: false, level: 'default' })
    expect(resolved.replyLength).toEqual({ value: 'default', level: 'default' })
    expect(resolved.expressions).toEqual({ value: true, level: 'default' })
    expect(resolved.muted).toEqual({ value: false, level: 'default' })
    expect(resolved['features.memory']).toEqual({ value: true, level: 'default' })
    expect(resolved['features.context']).toEqual({ value: true, level: 'default' })
    expect(resolved['features.think']).toEqual({ value: true, level: 'default' })
    expect(resolved['context.maxMessages']).toEqual({ value: 40, level: 'default' })
    expect(resolved['memory.pageMessages']).toEqual({ value: 25, level: 'default' })
    expect(resolved['tools.maxPerMessage']).toEqual({ value: 3, level: 'default' })
    expect(resolved['report.defaultFormat']).toEqual({ value: 'pdf', level: 'default' })
  })

  it('accepts only boolean values for the memory and think switches', () => {
    const storage = tmpStorage()
    for (const key of ['features.memory', 'features.think']) {
      for (const value of ['false', 0, 1, null, {}]) {
        expect(() => setSetting(storage, { level: 'global', scope: '', key, value, actor: 'test' })).toThrow(
          SettingError
        )
      }
    }
    expect(count(storage, 'setting')).toBe(0)
  })

  it('resolves nearest level: chat overrides type, type overrides global, global overrides default', () => {
    const storage = tmpStorage()
    const chat = ensureChat(storage, { waId: 'fake-dm-two', type: 'dm' })

    expect(resolveSetting(storage, chat, 'replyLength')).toEqual({ value: 'default', level: 'default' })

    setSetting(storage, { level: 'global', scope: '', key: 'replyLength', value: 'short', actor: 's_admin' })
    expect(resolveSetting(storage, chat, 'replyLength')).toEqual({ value: 'short', level: 'global' })

    setSetting(storage, { level: 'type', scope: 'dm', key: 'replyLength', value: 'long', actor: 's_admin' })
    expect(resolveSetting(storage, chat, 'replyLength')).toEqual({ value: 'long', level: 'type' })

    setSetting(storage, { level: 'chat', scope: chat.chatId, key: 'replyLength', value: 'default', actor: 's_admin' })
    expect(resolveSetting(storage, chat, 'replyLength')).toEqual({ value: 'default', level: 'chat' })
  })

  it('does not apply a dm type row to a group chat or one chat row to another chat', () => {
    const storage = tmpStorage()
    const dm = ensureChat(storage, { waId: 'fake-dm-a', type: 'dm' })
    const group = ensureChat(storage, { waId: 'fake-group-a', type: 'group' })

    setSetting(storage, { level: 'type', scope: 'dm', key: 'freeResponse', value: true, actor: 's_admin' })
    setSetting(storage, { level: 'chat', scope: dm.chatId, key: 'language', value: 'es', actor: 's_admin' })

    expect(resolveSetting(storage, dm, 'freeResponse')).toEqual({ value: true, level: 'type' })
    expect(resolveSetting(storage, group, 'freeResponse')).toEqual({ value: false, level: 'default' })
    expect(resolveSetting(storage, group, 'language')).toEqual({ value: 'auto', level: 'default' })
  })

  it('unsetting chat restores type and unsetting type restores global', () => {
    const storage = tmpStorage()
    const chat = ensureChat(storage, { waId: 'fake-dm-b', type: 'dm' })

    setSetting(storage, { level: 'global', scope: '', key: 'expressions', value: false, actor: 's_admin' })
    setSetting(storage, { level: 'type', scope: 'dm', key: 'expressions', value: true, actor: 's_admin' })
    setSetting(storage, { level: 'chat', scope: chat.chatId, key: 'expressions', value: false, actor: 's_admin' })

    expect(resolveSetting(storage, chat, 'expressions')).toEqual({ value: false, level: 'chat' })

    expect(unsetSetting(storage, { level: 'chat', scope: chat.chatId, key: 'expressions', actor: 's_admin' })).toBe(
      true
    )
    expect(resolveSetting(storage, chat, 'expressions')).toEqual({ value: true, level: 'type' })

    expect(unsetSetting(storage, { level: 'type', scope: 'dm', key: 'expressions', actor: 's_admin' })).toBe(true)
    expect(resolveSetting(storage, chat, 'expressions')).toEqual({ value: false, level: 'global' })

    expect(unsetSetting(storage, { level: 'type', scope: 'dm', key: 'expressions', actor: 's_admin' })).toBe(false)
  })

  it('skips a stored value that no longer passes its schema during resolution', () => {
    const storage = tmpStorage()
    const chat = ensureChat(storage, { waId: 'fake-dm-badrow', type: 'dm' })

    setSetting(storage, { level: 'global', scope: '', key: 'replyLength', value: 'short', actor: 's_admin' })
    storage.tx((db) => {
      db.prepare(
        `INSERT INTO setting (level, scope, key, value, updated_at)
         VALUES ('chat', ?, 'replyLength', '"gigantic"', '2026-01-01T00:00:00.000Z')`
      ).run(chat.chatId)
    })

    expect(resolveSetting(storage, chat, 'replyLength')).toEqual({ value: 'short', level: 'global' })
    expect(resolveSettings(storage, chat).replyLength).toEqual({ value: 'short', level: 'global' })
  })

  it('throws SettingError when resolving an unknown key', () => {
    const storage = tmpStorage()
    const chat = ensureChat(storage, { waId: 'fake-dm-unknown', type: 'dm' })
    expect(() => resolveSetting(storage, chat, 'noSuchKey')).toThrow(SettingError)
  })
})

describe('settings validation and change log', () => {
  it('refuses invalid values for every schema kind without writing and without leaking the value', () => {
    const storage = tmpStorage()
    const chat = ensureChat(storage, { waId: 'fake-dm-val', type: 'dm' })

    const invalidCases: { key: string; value: unknown; sentinel: string }[] = [
      { key: 'freeResponse', value: 'secret-bool-value', sentinel: 'secret-bool-value' },
      { key: 'replyLength', value: 'huge-secret-length', sentinel: 'huge-secret-length' },
      {
        key: 'quietHours',
        value: { start: '25:99', end: '07:00', timeZone: 'UTC' },
        sentinel: '25:99'
      },
      {
        key: 'quietHours',
        value: { start: '22:00', end: '07:00', timeZone: 'Mars/Olympus_Secret' },
        sentinel: 'Mars/Olympus_Secret'
      },
      {
        key: 'muted',
        value: { by: '', at: 'not-a-date-secret' },
        sentinel: 'not-a-date-secret'
      },
      { key: 'character', value: 'BAD CHAR SECRET!', sentinel: 'BAD CHAR SECRET!' },
      { key: 'unknownSecretKey', value: 'secret-val', sentinel: 'secret-val' }
    ]

    for (const tc of invalidCases) {
      let caught: unknown
      try {
        setSetting(storage, { level: 'chat', scope: chat.chatId, key: tc.key, value: tc.value, actor: 's_admin' })
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(SettingError)
      expect((caught as Error).message).not.toContain(tc.sentinel)
    }

    expect(count(storage, 'setting')).toBe(0)
    expect(count(storage, 'setting_change')).toBe(0)
  })

  it('refuses a wrong scope for each level and an unknown chat id', () => {
    const storage = tmpStorage()

    expect(() =>
      setSetting(storage, { level: 'global', scope: 'dm', key: 'freeResponse', value: true, actor: 's_admin' })
    ).toThrow(SettingError)
    expect(() =>
      setSetting(storage, { level: 'type', scope: '', key: 'freeResponse', value: true, actor: 's_admin' })
    ).toThrow(SettingError)
    expect(() =>
      setSetting(storage, {
        level: 'chat',
        scope: 'c_missing000001',
        key: 'freeResponse',
        value: true,
        actor: 's_admin'
      })
    ).toThrow(SettingError)

    expect(count(storage, 'setting')).toBe(0)
    expect(count(storage, 'setting_change')).toBe(0)
  })

  it('logs exactly one setting_change row per write and unset with old and new JSON values', () => {
    const storage = tmpStorage()

    setSetting(
      storage,
      { level: 'global', scope: '', key: 'freeResponse', value: true, actor: 's_one' },
      clockAt('2026-01-01T00:00:00.000Z')
    )
    setSetting(
      storage,
      { level: 'global', scope: '', key: 'freeResponse', value: false, actor: 's_two' },
      clockAt('2026-01-01T00:01:00.000Z')
    )
    unsetSetting(
      storage,
      { level: 'global', scope: '', key: 'freeResponse', actor: 's_three' },
      clockAt('2026-01-01T00:02:00.000Z')
    )
    unsetSetting(
      storage,
      { level: 'global', scope: '', key: 'freeResponse', actor: 's_three' },
      clockAt('2026-01-01T00:03:00.000Z')
    )

    expect(allChanges(storage)).toEqual([
      {
        id: 1,
        target: 'setting',
        actor: 's_one',
        level: 'global',
        scope: '',
        key: 'freeResponse',
        old_value: null,
        new_value: 'true',
        changed_at: '2026-01-01T00:00:00.000Z'
      },
      {
        id: 2,
        target: 'setting',
        actor: 's_two',
        level: 'global',
        scope: '',
        key: 'freeResponse',
        old_value: 'true',
        new_value: 'false',
        changed_at: '2026-01-01T00:01:00.000Z'
      },
      {
        id: 3,
        target: 'setting',
        actor: 's_three',
        level: 'global',
        scope: '',
        key: 'freeResponse',
        old_value: 'false',
        new_value: null,
        changed_at: '2026-01-01T00:02:00.000Z'
      }
    ])
  })

  it('supports dynamic mcp.<id> keys: default false, settable, and listed only when a row applies', () => {
    const storage = tmpStorage()
    const dm = ensureChat(storage, { waId: 'fake-dm-mcp', type: 'dm' })
    const group = ensureChat(storage, { waId: 'fake-grp-mcp', type: 'group' })

    expect(definitionFor('mcp.calendar')).toBeDefined()
    expect(definitionFor('mcp.INVALID')).toBeUndefined()
    expect(resolveSetting(storage, dm, 'mcp.calendar')).toEqual({ value: false, level: 'default' })
    expect(resolveSettings(storage, dm)['mcp.calendar']).toBeUndefined()

    setSetting(storage, { level: 'type', scope: 'dm', key: 'mcp.calendar', value: true, actor: 's_admin' })
    expect(resolveSettings(storage, dm)['mcp.calendar']).toEqual({ value: true, level: 'type' })
    expect(resolveSettings(storage, group)['mcp.calendar']).toBeUndefined()
  })

  it('accepts tools.maxPerMessage from 1 to 8 (default 3) and rejects 0 and 9', () => {
    const storage = tmpStorage()
    const chat = ensureChat(storage, { waId: '0000000000@g.us', type: 'group' })

    expect(resolveSetting(storage, chat, 'tools.maxPerMessage')).toEqual({ value: 3, level: 'default' })

    for (const value of [1, 8]) {
      setSetting(storage, { level: 'chat', scope: chat.chatId, key: 'tools.maxPerMessage', value, actor: 's_admin' })
      expect(resolveSetting(storage, chat, 'tools.maxPerMessage')).toEqual({ value, level: 'chat' })
    }

    for (const bad of [0, 9, 2.5, '3']) {
      expect(() =>
        setSetting(storage, {
          level: 'chat',
          scope: chat.chatId,
          key: 'tools.maxPerMessage',
          value: bad,
          actor: 's_admin'
        })
      ).toThrow(SettingError)
    }
    expect(resolveSetting(storage, chat, 'tools.maxPerMessage')).toEqual({ value: 8, level: 'chat' })
  })

  it('accepts features.context boolean (default true) and rejects non-booleans', () => {
    const storage = tmpStorage()
    const chat = ensureChat(storage, { waId: '0000000000@g.us', type: 'group' })

    expect(resolveSetting(storage, chat, 'features.context')).toEqual({ value: true, level: 'default' })
    setSetting(storage, { level: 'chat', scope: chat.chatId, key: 'features.context', value: false, actor: 's_admin' })
    expect(resolveSetting(storage, chat, 'features.context')).toEqual({ value: false, level: 'chat' })

    for (const bad of ['false', 0, 1, null, {}]) {
      expect(() =>
        setSetting(storage, {
          level: 'chat',
          scope: chat.chatId,
          key: 'features.context',
          value: bad,
          actor: 's_admin'
        })
      ).toThrow(SettingError)
    }
    expect(resolveSetting(storage, chat, 'features.context')).toEqual({ value: false, level: 'chat' })
  })

  it('accepts context.maxMessages from 0 to 100 (default 40) and rejects out-of-range values', () => {
    const storage = tmpStorage()
    const chat = ensureChat(storage, { waId: '0000000000@g.us', type: 'group' })

    expect(resolveSetting(storage, chat, 'context.maxMessages')).toEqual({ value: 40, level: 'default' })

    for (const value of [0, 5, 100]) {
      setSetting(storage, { level: 'chat', scope: chat.chatId, key: 'context.maxMessages', value, actor: 's_admin' })
      expect(resolveSetting(storage, chat, 'context.maxMessages')).toEqual({ value, level: 'chat' })
    }

    for (const bad of [-1, 101, 5.5, '40', null]) {
      expect(() =>
        setSetting(storage, {
          level: 'chat',
          scope: chat.chatId,
          key: 'context.maxMessages',
          value: bad,
          actor: 's_admin'
        })
      ).toThrow(SettingError)
    }
    expect(resolveSetting(storage, chat, 'context.maxMessages')).toEqual({ value: 100, level: 'chat' })
  })

  it('accepts memory.pageMessages from 5 to 50 (default 25) and rejects out-of-range values', () => {
    const storage = tmpStorage()
    const chat = ensureChat(storage, { waId: '0000000000@g.us', type: 'group' })

    expect(resolveSetting(storage, chat, 'memory.pageMessages')).toEqual({ value: 25, level: 'default' })

    for (const value of [5, 25, 50]) {
      setSetting(storage, { level: 'chat', scope: chat.chatId, key: 'memory.pageMessages', value, actor: 's_admin' })
      expect(resolveSetting(storage, chat, 'memory.pageMessages')).toEqual({ value, level: 'chat' })
    }

    for (const bad of [4, 51, 10.5, '25', null]) {
      expect(() =>
        setSetting(storage, {
          level: 'chat',
          scope: chat.chatId,
          key: 'memory.pageMessages',
          value: bad,
          actor: 's_admin'
        })
      ).toThrow(SettingError)
    }
    expect(resolveSetting(storage, chat, 'memory.pageMessages')).toEqual({ value: 50, level: 'chat' })
  })

  it('accepts report.defaultFormat pdf or markdown (default pdf) and rejects other values', () => {
    const storage = tmpStorage()
    const chat = ensureChat(storage, { waId: '0000000000@g.us', type: 'group' })

    expect(resolveSetting(storage, chat, 'report.defaultFormat')).toEqual({ value: 'pdf', level: 'default' })

    for (const value of ['markdown', 'pdf'] as const) {
      setSetting(storage, { level: 'chat', scope: chat.chatId, key: 'report.defaultFormat', value, actor: 's_admin' })
      expect(resolveSetting(storage, chat, 'report.defaultFormat')).toEqual({ value, level: 'chat' })
    }

    for (const bad of ['md', 'docx', 'PDF', 123, null]) {
      expect(() =>
        setSetting(storage, {
          level: 'chat',
          scope: chat.chatId,
          key: 'report.defaultFormat',
          value: bad,
          actor: 's_admin'
        })
      ).toThrow(SettingError)
    }
    expect(resolveSetting(storage, chat, 'report.defaultFormat')).toEqual({ value: 'pdf', level: 'chat' })
  })
})

describe('chats and identities', () => {
  it('ensureChat creates a pending chat once and does not change existing row on repeat', () => {
    const storage = tmpStorage()
    const first = ensureChat(storage, { waId: 'fake-wa-chat-1', type: 'dm' }, clockAt('2026-01-01T00:00:00.000Z'))
    expect(first.created).toBe(true)
    expect(first.status).toBe('pending')
    expect(first.chatId).toMatch(/^c_[0-9a-f]{12}$/)

    const second = ensureChat(storage, { waId: 'fake-wa-chat-1', type: 'group' }, clockAt('2026-01-01T00:01:00.000Z'))
    expect(second.created).toBe(false)
    expect(second.chatId).toBe(first.chatId)
    expect(second.type).toBe('dm')

    expect(getChat(storage, first.chatId)).toEqual({
      chatId: first.chatId,
      waId: 'fake-wa-chat-1',
      type: 'dm',
      label: '',
      status: 'pending'
    })
    expect(getChatByWaId(storage, 'fake-wa-chat-1')?.chatId).toBe(first.chatId)
    expect(count(storage, 'setting_change')).toBe(0)
  })

  it('setChatStatus activates and logs once; repeated status returns false and logs nothing', () => {
    const storage = tmpStorage()
    const chat = ensureChat(storage, { waId: 'fake-wa-chat-2', type: 'dm' })

    expect(
      setChatStatus(
        storage,
        { chatId: chat.chatId, status: 'active', actor: 's_admin' },
        clockAt('2026-01-01T00:00:00.000Z')
      )
    ).toBe(true)
    expect(setChatStatus(storage, { chatId: chat.chatId, status: 'active', actor: 's_admin' })).toBe(false)
    expect(setChatStatus(storage, { chatId: 'c_missing000001', status: 'active', actor: 's_admin' })).toBe(false)

    expect(getChat(storage, chat.chatId)?.status).toBe('active')
    expect(allChanges(storage)).toEqual([
      {
        id: 1,
        target: 'chat',
        actor: 's_admin',
        level: 'chat',
        scope: chat.chatId,
        key: 'status',
        old_value: '"pending"',
        new_value: '"active"',
        changed_at: '2026-01-01T00:00:00.000Z'
      }
    ])
  })

  it('listChats orders by created_at then chat_id', () => {
    const storage = tmpStorage()
    const c1 = ensureChat(storage, { waId: 'fake-wa-order-1', type: 'dm' }, clockAt('2026-01-01T00:00:02.000Z'))
    const c2 = ensureChat(storage, { waId: 'fake-wa-order-2', type: 'dm' }, clockAt('2026-01-01T00:00:01.000Z'))
    const c3 = ensureChat(storage, { waId: 'fake-wa-order-3', type: 'group' }, clockAt('2026-01-01T00:00:01.000Z'))

    const listed = listChats(storage).map((c) => c.chatId)
    const tied = [c2.chatId, c3.chatId].sort()
    expect(listed).toEqual([...tied, c1.chatId])
  })

  it('identities are stable per id, linkable to an existing subject, and never leak waId or label to setting_change', () => {
    const storage = tmpStorage()
    const waOne = 'fake-person-alpha'
    const waTwo = 'fake-person-beta'
    const secretLabel = 'Fake Private Group Name'
    const chat = ensureChat(storage, { waId: 'fake-wa-chat-priv', type: 'group' })

    const s1 = ensureSubject(storage, waOne)
    expect(s1).toMatch(/^s_[0-9a-f]{12}$/)
    expect(ensureSubject(storage, waOne)).toBe(s1)

    const s2 = ensureSubject(storage, waTwo)
    expect(s2).not.toBe(s1)

    linkIdentity(storage, { waId: waTwo, subjectId: s1, actor: 's_admin' }, clockAt('2026-01-01T00:00:00.000Z'))
    expect(ensureSubject(storage, waTwo)).toBe(s1)

    expect(() =>
      linkIdentity(storage, { waId: 'fake-person-gamma', subjectId: 's_000000000000', actor: 's_admin' })
    ).toThrow(SettingError)

    expect(
      setChatLabel(
        storage,
        { chatId: chat.chatId, label: secretLabel, actor: 's_admin' },
        clockAt('2026-01-01T00:01:00.000Z')
      )
    ).toBe(true)

    const changes = allChanges(storage)
    expect(changes).toHaveLength(2)
    expect(changes[0]).toMatchObject({
      target: 'chat',
      actor: 's_admin',
      level: null,
      scope: null,
      key: 'identity',
      old_value: JSON.stringify(s2),
      new_value: JSON.stringify(s1)
    })
    expect(changes[1]).toMatchObject({
      target: 'chat',
      actor: 's_admin',
      level: 'chat',
      scope: chat.chatId,
      key: 'label',
      old_value: null,
      new_value: null
    })

    const rawDump = JSON.stringify(changes)
    expect(rawDump).not.toContain(waOne)
    expect(rawDump).not.toContain(waTwo)
    expect(rawDump).not.toContain('fake-wa-chat-priv')
    expect(rawDump).not.toContain(secretLabel)
  })
})
