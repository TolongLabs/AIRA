import { isoNow, type Storage } from '../storage/database.js'
import {
  definitionFor,
  type PlatformOperation,
  platformSwitchKey,
  SETTING_KEYS,
  type SettingDefinition
} from './keys.js'

// Settings hierarchy and resolution (docs/trd/data.md#settings-hierarchy).

type Clock = () => Date
const wallClock: Clock = () => new Date()

export class SettingError extends Error {
  override name = 'SettingError'
  readonly kind = 'config_invalid'
}

export type SettingLevel = 'global' | 'type' | 'chat'

export interface Resolved {
  value: unknown
  /** Where the value came from. 'default' is the built-in default; 'unset' means no value anywhere. */
  level: SettingLevel | 'default' | 'unset'
}

function defaultFor(def: SettingDefinition): Resolved {
  return 'default' in def ? { value: def.default, level: 'default' } : { value: undefined, level: 'unset' }
}

function parseRowValue(def: SettingDefinition, raw: string): { ok: true; value: unknown } | { ok: false } {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false }
  }
  const checked = def.schema.safeParse(parsed)
  return checked.success ? { ok: true, value: checked.data } : { ok: false }
}

/** Every key with its value and the level it came from. The nearest level that has a value wins. */
export function resolveSettings(
  storage: Storage,
  chat: { chatId: string; type: 'dm' | 'group' },
  ignore?: { level: SettingLevel; key: string }
): Record<string, Resolved> {
  const rows = storage.read(
    (db) =>
      db
        .prepare(
          `SELECT level, key, value
           FROM setting
           WHERE (level = 'chat' AND scope = ?)
              OR (level = 'type' AND scope = ?)
              OR (level = 'global' AND scope = '')
           ORDER BY CASE level WHEN 'chat' THEN 1 WHEN 'type' THEN 2 ELSE 3 END`
        )
        .all(chat.chatId, chat.type) as { level: SettingLevel; key: string; value: string }[]
  )

  const resolved: Record<string, Resolved> = {}
  for (const row of rows) {
    if (row.level === ignore?.level && row.key === ignore.key) continue
    if (Object.hasOwn(resolved, row.key)) continue
    const def = definitionFor(row.key)
    if (!def) continue
    const parsed = parseRowValue(def, row.value)
    if (!parsed.ok) continue
    resolved[row.key] = { value: parsed.value, level: row.level }
  }

  for (const [key, def] of Object.entries(SETTING_KEYS)) {
    if (!Object.hasOwn(resolved, key)) {
      resolved[key] = defaultFor(def)
    }
  }

  return resolved
}

/** Resolves a single setting key for a chat. Throws SettingError if the key is unknown. */
export function resolveSetting(
  storage: Storage,
  chat: { chatId: string; type: 'dm' | 'group' },
  key: string
): Resolved {
  const def = definitionFor(key)
  if (!def) throw new SettingError(`unknown setting key: ${key}`)

  const rows = storage.read(
    (db) =>
      db
        .prepare(
          `SELECT level, value
           FROM setting
           WHERE key = ?
             AND ((level = 'chat' AND scope = ?)
               OR (level = 'type' AND scope = ?)
               OR (level = 'global' AND scope = ''))
           ORDER BY CASE level WHEN 'chat' THEN 1 WHEN 'type' THEN 2 ELSE 3 END`
        )
        .all(key, chat.chatId, chat.type) as { level: SettingLevel; value: string }[]
  )

  for (const row of rows) {
    const parsed = parseRowValue(def, row.value)
    if (parsed.ok) return { value: parsed.value, level: row.level }
  }

  return defaultFor(def)
}

/** True unless the chat's switch for this platform and operation is off. A missing settings map or value counts as on. */
export function platformSwitchOn(
  settings: Record<string, Resolved> | undefined,
  operation: PlatformOperation,
  platform: string
): boolean {
  return settings?.[platformSwitchKey(operation, platform)]?.value !== false
}

function validateScope(level: SettingLevel, scope: string): void {
  if (level === 'global' && scope !== '') {
    throw new SettingError("global setting scope must be ''")
  }
  if (level === 'type' && scope !== 'dm' && scope !== 'group') {
    throw new SettingError("type setting scope must be 'dm' or 'group'")
  }
  if (level !== 'global' && level !== 'type' && level !== 'chat') {
    throw new SettingError(`invalid setting level: ${String(level)}`)
  }
}

/** Validates, writes and logs one value in one transaction. Throws SettingError and writes nothing when invalid. */
export function setSetting(
  storage: Storage,
  input: { level: SettingLevel; scope: string; key: string; value: unknown; actor: string },
  now: Clock = wallClock
): void {
  const def = definitionFor(input.key)
  if (!def) throw new SettingError(`unknown setting key: ${input.key}`)

  validateScope(input.level, input.scope)

  const checked = def.schema.safeParse(input.value)
  if (!checked.success) {
    const issues = checked.error.issues.map((issue) => issue.message).join('; ')
    throw new SettingError(`invalid value for ${input.key}: ${issues}`)
  }

  const newValue = JSON.stringify(checked.data)

  storage.tx((db) => {
    if (input.level === 'chat') {
      const exists = db.prepare('SELECT 1 FROM chat WHERE chat_id = ?').pluck().get(input.scope)
      if (exists === undefined) throw new SettingError(`unknown chat: ${input.scope}`)
    }

    const oldValue = db
      .prepare('SELECT value FROM setting WHERE level = ? AND scope = ? AND key = ?')
      .pluck()
      .get(input.level, input.scope, input.key) as string | undefined

    const at = isoNow(now)
    db.prepare(
      `INSERT INTO setting (level, scope, key, value, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (level, scope, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(input.level, input.scope, input.key, newValue, at)

    db.prepare(
      `INSERT INTO setting_change (target, actor, level, scope, key, old_value, new_value, changed_at)
       VALUES ('setting', ?, ?, ?, ?, ?, ?, ?)`
    ).run(input.actor, input.level, input.scope, input.key, oldValue ?? null, newValue, at)
  })
}

/** Deletes the row at one level, which restores inheritance from the level above. Logs the change. */
export function unsetSetting(
  storage: Storage,
  input: { level: SettingLevel; scope: string; key: string; actor: string },
  now: Clock = wallClock
): boolean {
  validateScope(input.level, input.scope)
  return storage.tx((db) => {
    const oldValue = db
      .prepare('SELECT value FROM setting WHERE level = ? AND scope = ? AND key = ?')
      .pluck()
      .get(input.level, input.scope, input.key) as string | undefined
    if (oldValue === undefined) return false

    db.prepare('DELETE FROM setting WHERE level = ? AND scope = ? AND key = ?').run(input.level, input.scope, input.key)
    db.prepare(
      `INSERT INTO setting_change (target, actor, level, scope, key, old_value, new_value, changed_at)
       VALUES ('setting', ?, ?, ?, ?, ?, NULL, ?)`
    ).run(input.actor, input.level, input.scope, input.key, oldValue, isoNow(now))
    return true
  })
}
