/* The chatbot's own API, served by the core on this origin (docs/trd/site.md#serving-the-site).
 *
 * Every route needs the site token. The first 401 asks for it once, keeps it in
 * local storage under its own key — it is not the old site's token — and the
 * call is tried again. The token goes in the Authorization header, never in a URL. */
import { requestToken } from './api'

const TOKEN_KEY = 'aira-site-token'
const ASK = 'This page needs the AIRA site token (SITE_TOKEN in the core’s .env).'

export type SettingLevel = 'global' | 'type' | 'chat'
export type SourceLevel = SettingLevel | 'default' | 'unset'

export interface Resolved {
  value: unknown
  level: SourceLevel
}

export interface CoreChat {
  chatId: string
  waId: string
  type: 'dm' | 'group'
  label: string
  status: 'pending' | 'active'
  settings: Record<string, Resolved>
}

export interface CoreCharacter {
  id: string
  displayName: string
  source: 'repository' | 'data'
  languages: string[]
}

/** A refusal from the core, with its reason code. The body never holds message text. */
export class CoreError extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(code)
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const go = () => {
    const token = localStorage.getItem(TOKEN_KEY)
    const headers = new Headers(init.headers)
    headers.set('accept', 'application/json')
    if (token) headers.set('authorization', `Bearer ${token}`)
    return fetch(path, { ...init, headers })
  }
  let res = await go()
  if (res.status === 401) {
    localStorage.removeItem(TOKEN_KEY)
    await requestToken(TOKEN_KEY, ASK)
    res = await go()
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) throw new CoreError(res.status, body.error ?? `http_${res.status}`)
  return body as T
}

function put<T>(path: string, body: unknown): Promise<T> {
  return call<T>(path, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
}

export const core = {
  chats: () => call<{ chats: CoreChat[] }>('/api/chats'),
  characters: () => call<{ characters: CoreCharacter[]; faults: { id: string; reason: string }[] }>('/api/characters'),
  setStatus: (chatId: string, status: CoreChat['status']) =>
    put<{ changed: boolean }>(`/api/chats/${encodeURIComponent(chatId)}/status`, { status }),
  /** `value: null` clears the row at that level, so the level above applies again. */
  setSetting: (level: SettingLevel, scope: string, key: string, value: unknown) =>
    put<{ changed: boolean }>('/api/settings', { level, scope, key, value })
}

/** A reason code in plain words, for a toast. */
export function reasonText(error: unknown): string {
  if (!(error instanceof CoreError)) return 'The core did not answer.'
  const words: Record<string, string> = {
    invalid_setting: 'That value is not allowed for this setting.',
    unknown_character: 'That character is not loaded.',
    not_found: 'That chat no longer exists.',
    origin_refused: 'This page is not on the core’s own address.',
    host_refused: 'Open the site by its IP address, not a name.',
    unauthorized: 'The site token was not accepted.'
  }
  return words[error.code] ?? `The core refused it (${error.code}).`
}
