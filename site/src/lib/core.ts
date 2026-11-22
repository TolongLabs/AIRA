/* The chatbot's own API, served by the core on this origin (docs/trd/site.md#serving-the-site).
 *
 * The server binds to a private loopback or Tailscale address and enforces Host
 * and Origin checks on writes, so calls need no bearer token. */

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

export interface ToolFooterConfig {
  icon?: string
  labels?: Record<string, string>
}

export interface FooterKindInfo {
  kind: string
  defaultLabel: string
}

export interface CoreCharacter {
  id: string
  displayName: string
  aliases?: string[]
  source: 'repository' | 'data'
  languages: string[]
  toolFooter?: ToolFooterConfig
}

export interface CoreToolFeature {
  key: string
  tools: { name: string; mode: 'implicit' | 'explicit' | 'both'; commands: string[] }[]
}

export type SocialCapabilityKey = 'features.social' | 'features.autofetch'

export interface CoreToolCatalog {
  features: CoreToolFeature[]
  socialCapabilities?: Record<
    SocialCapabilityKey,
    { id: string; name: string; operations: ('text' | 'preview' | 'photos' | 'video')[] }[]
  >
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
  const headers = new Headers(init.headers)
  headers.set('accept', 'application/json')
  const res = await fetch(path, { ...init, headers })
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
  tools: () => call<CoreToolCatalog>('/api/tools'),
  chats: () => call<{ chats: CoreChat[] }>('/api/chats'),
  characters: () =>
    call<{ characters: CoreCharacter[]; faults: { id: string; reason: string }[]; footerKinds: FooterKindInfo[] }>(
      '/api/characters'
    ),
  setStatus: (chatId: string, status: CoreChat['status']) =>
    put<{ changed: boolean }>(`/api/chats/${encodeURIComponent(chatId)}/status`, { status }),
  setLabel: (chatId: string, label: string) =>
    put<{ changed: boolean }>('/api/chats/' + encodeURIComponent(chatId) + '/label', { label }),
  /** `value: null` clears the row at that level, so the level above applies again. */
  setSetting: (level: SettingLevel, scope: string, key: string, value: unknown) =>
    put<{ changed: boolean }>('/api/settings', { level, scope, key, value }),
  /** `null` removes an icon or label key so the code default applies again. */
  setFooter: (id: string, patch: { icon?: string | null; labels?: Record<string, string | null> }) =>
    put<{ id: string; toolFooter: ToolFooterConfig; changed: boolean }>(
      `/api/characters/${encodeURIComponent(id)}/footer`,
      patch
    )
}

/** A reason code in plain words, for a toast. */
export function reasonText(error: unknown): string {
  if (!(error instanceof CoreError)) return 'The core did not answer.'
  const words: Record<string, string> = {
    invalid_setting: 'That value is not allowed for this setting.',
    unknown_character: 'That character is not loaded.',
    invalid_character_id: 'That character id is not valid.',
    invalid_chat_id: 'That chat id is not valid.',
    pack_read_only: 'Built-in repository packs cannot be edited here.',
    pack_unparseable: 'The pack’s card.yml could not be parsed or validated.',
    invalid_footer: 'Footer icon must be one emoji; labels must be 1 to 40 chars without _ * ~ ` < > or line breaks.',
    unknown_footer_kind: 'That footer kind is not known by this core.',
    invalid_body: 'The request body was not valid.',
    not_found: 'That item no longer exists.',
    origin_refused: 'This page is not on the core’s own address.',
    host_refused: 'Open the site by its IP address, not a name.'
  }
  return words[error.code] ?? `The core refused it (${error.code}).`
}
