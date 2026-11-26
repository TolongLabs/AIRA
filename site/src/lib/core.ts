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
  deliveryTarget?: string | null
  hasPortrait?: boolean
  settingsRevision?: string
  chatId: string
  waId: string
  lastInboundAt?: string | null
  storedLabel: string
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
  hasPortrait?: boolean
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

export type StandaloneInstallationMode = 'legacy' | 'standalone'
export type StandaloneConfiguration = 'setup_required' | 'configured' | 'invalid' | 'pending_activation'
export type StandaloneChatbot = 'inactive' | 'ready' | 'degraded'
export type StandaloneActivation = 'idle' | 'requested' | 'starting'

/** The verified Hermes route receipt, as reported by authenticated owner health
 *  (docs/trd/system.md#standalone-hermes-transport). Absent until verified. */
export interface StandaloneHermes {
  state: 'connected' | 'disconnected' | 'invalid' | 'unsupported'
  adapterVersion: string | null
  profile: string | null
  verifiedAt: string | null
}

export interface StandaloneCapabilities {
  hostOwnerService: boolean
  subscriptionRunner: boolean
  fileBrowser: boolean
  gatewayConnection: boolean
  scheduler: boolean
  /** Absent on older cores; only an explicit true enables the existing Reports control. */
  reportDocuments?: boolean
  inboundMedia?: boolean
}

export type StandaloneControls = Required<Pick<StandaloneCapabilities, 'reportDocuments' | 'inboundMedia'>>

export interface CoreHealth {
  status: 'ready' | 'starting'
  version: string
  activeTurns: number
  roles: Record<string, { configured: boolean; breakerOpen: boolean }>
  /** Standalone-only readiness shape. Absent on legacy, which keeps the legacy envelope. */
  schemaVersion?: 1
  installationMode?: StandaloneInstallationMode
  configuration?: StandaloneConfiguration
  chatbot?: StandaloneChatbot
  chatbotReason?: string | null
  appliedRevision?: string | null
  capabilities?: StandaloneCapabilities
  hermes?: StandaloneHermes
}

/** One model role as the standalone readback reports it: the full target plus
 *  key presence only. Raw credentials are never returned
 *  (docs/trd/dashboard-state.md#typed-owner-operations). */
export interface StandaloneModelTarget {
  provider: string
  model: string
  baseUrl: string
  effort: string
  deepEffort: string
  usdPerMTokIn: number
  usdPerMTokOut: number
  usdPerMTokCached: number
  credentialConfigured: boolean
}

export interface StandaloneModelPair {
  main: StandaloneModelTarget | null
  fallback: StandaloneModelTarget | null
  media?: StandaloneMediaTarget | null
}

export interface StandaloneMediaTarget {
  provider: 'gemini'
  model: string
  credentialConfigured: boolean
}

export type StandaloneMediaInput = Omit<StandaloneMediaTarget, 'credentialConfigured'> & { apiKey?: string | null }

/** The GET/PUT standalone-config envelope and the POST activate readback. */
export interface StandaloneConfigState {
  schemaVersion: 1
  optionalRoles?: ['media']
  configuration: StandaloneConfiguration
  savedRevision: string | null
  appliedRevision: string | null
  activation: StandaloneActivation
  lastFailure: string | null
  saved: StandaloneModelPair | null
  applied: StandaloneModelPair | null
}

/** A model role as the dashboard writes it. `apiKey` is write-only: absent or
 *  empty keeps the saved key, null clears it. A null role disables it. */
export interface StandaloneModelInput {
  provider: string
  model: string
  baseUrl: string
  effort: string
  deepEffort: string
  usdPerMTokIn: number
  usdPerMTokOut: number
  usdPerMTokCached: number
  apiKey?: string | null
}

export interface CoreConfigStatus {
  appliedRevision: string | null
  currentRevision: string | null
  status: 'current' | 'pending_restart' | 'invalid' | 'inaccessible' | 'memory_only'
  checkedAt: string
  appliedAt: string
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
    readonly code: string,
    readonly requestId?: string
  ) {
    super(code)
  }
}

type CoreTransport = (path: string, init: RequestInit) => Promise<Response>
let transport: CoreTransport = (path, init) => fetch(path, init)

export function useCoreTransport(next: CoreTransport) {
  transport = next
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  headers.set('accept', 'application/json')
  const res = await transport(path, { ...init, headers })
  const body = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok)
    throw new CoreError(res.status, body.error ?? `http_${res.status}`, res.headers.get('x-request-id') ?? undefined)
  return body as T
}

function put<T>(path: string, body: unknown): Promise<T> {
  return call<T>(path, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
}

function post<T>(path: string, body: unknown): Promise<T> {
  return call<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
}

export const core = {
  health: () => call<CoreHealth>('/api/health'),
  senders: (id: string) =>
    call<{ senders: { id: string; label: string | null }[] }>('/api/chats/' + encodeURIComponent(id) + '/senders'),
  activity: () => call<{ start: string; today: string; counts: { day: string; count: number }[] }>('/api/activity'),
  profileImage: (kind: 'chats' | 'characters', id: string) =>
    call<{ image: string | null }>(`/api/${kind}/${encodeURIComponent(id)}/profile-image`),
  saveImage: (kind: 'chats' | 'characters', id: string, image: string, mime: string) =>
    put<{ saved: boolean }>(`/api/${kind}/${encodeURIComponent(id)}/profile-image`, { image, mime }),
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
  setSetting: (level: SettingLevel, scope: string, key: string, value: unknown, expectedRevision?: string) =>
    put<{ changed: boolean }>('/api/settings', { level, scope, key, value, expectedRevision }),
  /** `null` removes an icon or label key so the code default applies again. */
  setFooter: (
    id: string,
    patch: { icon?: string | null; labels?: Record<string, string | null> },
    expectedRevision?: string
  ) =>
    put<{ id: string; revision?: string; toolFooter: ToolFooterConfig; changed: boolean }>(
      `/api/characters/${encodeURIComponent(id)}/footer`,
      expectedRevision === undefined ? patch : { ...patch, expectedRevision }
    ),
  /** One pack's footer with its opaque revision for the owner preview flow. */
  getFooter: (id: string) =>
    call<{ id: string; revision: string; toolFooter: ToolFooterConfig }>(
      `/api/characters/${encodeURIComponent(id)}/footer`
    ),
  /** Deployment activation readback: opaque revisions and status only, no values or paths. */
  config: () => call<CoreConfigStatus>('/api/config'),
  /** Standalone model revisions: sanitized saved/applied pairs, revision ids and activation status. */
  standaloneConfig: () => call<StandaloneConfigState>('/api/standalone-config'),
  /** Save a standalone model revision. The reply is the readback, not proof of activation. */
  saveStandaloneConfig: (body: {
    expectedRevision: string | null
    main: StandaloneModelInput | null
    fallback: StandaloneModelInput | null
    media?: StandaloneMediaInput | null
  }) => put<StandaloneConfigState>('/api/standalone-config', body),
  /** Request activation of the saved revision. 202 means accepted, not applied: poll the readback. */
  activateStandaloneConfig: (expectedRevision: string | null) =>
    post<StandaloneConfigState>('/api/standalone-config/activate', { expectedRevision })
}

/** A reason code in plain words, for a toast. */
export function reasonText(error: unknown): string {
  if (!(error instanceof CoreError)) return 'The core did not answer.'
  const words: Record<string, string> = {
    stale_revision: 'Settings changed in another session. Reload to compare before saving again.',
    revision_required: 'This form needs a fresh revision. Reload to compare before saving again.',
    invalid_setting: 'That value is not allowed for this setting.',
    unknown_character: 'That character is not loaded.',
    missing_character: 'An active chat requires a loaded character.',
    invalid_character_id: 'That character id is not valid.',
    invalid_chat_id: 'That chat id is not valid.',
    pack_read_only: 'Built-in repository packs cannot be edited here.',
    pack_unparseable: 'The pack’s card.yml could not be parsed or validated.',
    invalid_footer: 'Footer icon must be one emoji; labels must be 1 to 40 chars without _ * ~ ` < > or line breaks.',
    unknown_footer_kind: 'That footer kind is not known by this core.',
    invalid_body: 'The request body was not valid.',
    not_found: 'That item no longer exists.',
    internal: 'The core hit an internal error while saving. Reload to check the current value.',
    origin_refused: 'This page is not on the core’s own address.',
    host_refused: 'Open the site by its IP address, not a name.',
    model_config_invalid: 'That model setup is not valid. Check the fields and save again.',
    activation_in_progress: 'An activation is already running. Wait for the readback to settle.',
    capability_unavailable: 'Not available on this installation.'
  }
  const message = words[error.code] ?? `The core refused it (${error.code}).`
  return error.requestId ? message + ' Reference ' + error.requestId : message
}
