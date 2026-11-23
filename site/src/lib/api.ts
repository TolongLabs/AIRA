import { checkOwnerResponse } from './owner-response'
/* The one door to the brain.
 *
 * Reads are open on loopback; off-loopback the sensitive ones (and every
 * write) need the token from ~/.hermes/brain/.site-token. A 401 asks for it
 * once, remembers it, and retries — the same flow the old app used, so an
 * already-paired browser keeps working. The token never round-trips back out
 * of the API, and it is never put in a URL. */

const TOKEN_KEY = 'tolongai-token'

export async function ownerImage(path: string, signal: AbortSignal): Promise<Blob> {
  const media = new URL(path, window.location.origin)
  if (media.origin !== window.location.origin || media.pathname !== '/api/media') throw new Error('Invalid media URL')
  media.searchParams.delete('token')
  const load = () => fetch(ownerPath(media.pathname + media.search), { headers: authHeaders(), signal })
  let result = await load()
  if (result.status === 401) {
    localStorage.removeItem(TOKEN_KEY)
    await requestToken()
    result = await load()
  }
  if (!result.ok) throw new Error('Could not load image (' + result.status + ')')
  const blob = await result.blob()
  if (!/^image\/(jpeg|png|gif|webp|avif|bmp)$/i.test(blob.type)) throw new Error('Unsupported image format')
  return blob
}

;(function migrateLegacyToken() {
  try {
    const old = localStorage.getItem('mirai-token') ?? localStorage.getItem('memento-token')
    if (old && !localStorage.getItem(TOKEN_KEY)) localStorage.setItem(TOKEN_KEY, old)
    localStorage.removeItem('mirai-token')
    localStorage.removeItem('memento-token')
  } catch {
    /* private mode: fall through, the prompt will just ask again */
  }
})()

const pending = new Map<string, Promise<void>>()

/** Ask for a token, once per storage key, no matter how many calls 401 at once. */
export function requestToken(
  key: string = TOKEN_KEY,
  message = 'This address needs the token from ~/.hermes/brain/.site-token'
): Promise<void> {
  const open = pending.get(key)
  if (open) return open
  const asking = new Promise<void>((resolve) => {
    const done = (value: string) => {
      if (value) localStorage.setItem(key, value)
      bar.remove()
      pending.delete(key)
      resolve()
    }

    const bar = document.createElement('div')
    bar.className =
      'fixed inset-x-0 bottom-0 z-50 flex flex-wrap items-center gap-3 ' +
      'border-t border-line bg-card px-5 py-4 text-[0.95rem] shadow-float'
    const msg = document.createElement('p')
    msg.className = 'm-0 text-muted'
    msg.textContent = message
    const input = document.createElement('input')
    input.type = 'password'
    input.autocomplete = 'off'
    input.placeholder = 'site token'
    input.className = 'min-h-11 flex-1 rounded-[10px] border border-line bg-sunk px-3 text-ink'
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.textContent = 'Save token'
    btn.className = 'min-h-11 rounded-[10px] bg-accent px-4 font-semibold text-on-accent'
    btn.addEventListener('click', () => done(input.value.trim()))
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') done(input.value.trim())
    })
    bar.append(msg, input, btn)
    document.body.appendChild(bar)
    input.focus()
  })
  pending.set(key, asking)
  return asking
}

export function authHeaders(base: Record<string, string> = {}) {
  const t = localStorage.getItem(TOKEN_KEY)
  return t ? { ...base, 'X-TolongAI-Token': t } : base
}

export function ownerPath(path: string): string {
  if (!path.startsWith('/api/')) throw new Error('Invalid owner API path')
  return '/owner-api/' + path.slice('/api/'.length)
}

export class OwnerRequestError extends Error {
  constructor(readonly status:number,message:string){super(message)}
}

export async function get<T = unknown>(path: string): Promise<T> {
  const go = () => fetch(ownerPath(path), { headers: authHeaders({ Accept: 'application/json' }) })
  let r = await go()
  if (r.status === 401) {
    localStorage.removeItem(TOKEN_KEY)
    await requestToken()
    r = await go()
  }
  if (!r.ok) throw new OwnerRequestError(r.status,`Owner request failed (${r.status})`)
  const value: unknown = await r.json()
  checkOwnerResponse(path, value, 'GET')
  return value as T
}

export async function post<T = unknown>(path: string, body: unknown): Promise<T> {
  const go = () =>
    fetch(ownerPath(path), {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body)
    })
  let r = await go()
  if (r.status === 401) {
    localStorage.removeItem(TOKEN_KEY)
    await requestToken()
    r = await go()
  }
  if (!r.ok) {
    let message = `HTTP ${r.status}`
    try {
      const j = (await r.json()) as { error?: string }
      if (j?.error) message = j.error
    } catch {
      /* keep the status line */
    }
    throw new OwnerRequestError(r.status,message)
  }
  const value: unknown = await r.json()
  checkOwnerResponse(path, value, 'POST')
  return value as T
}

/** POST a multipart form, reporting upload progress as a 0–1 fraction.
 *
 * fetch() cannot report how much of a request body has gone, and a 100 MB
 * file over a phone's uplink is minutes of a spinner with no sign it is
 * moving. XMLHttpRequest can, so this one call uses it. Same token flow as
 * post(): a 401 asks once and retries. The server's error text, when it sends
 * one, is what the caller gets. */
export async function postForm<T = unknown>(
  path: string,
  form: FormData,
  onProgress?: (fraction: number) => void
): Promise<T> {
  const go = () =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const x = new XMLHttpRequest()
      x.open('POST', ownerPath(path))
      for (const [k, v] of Object.entries(authHeaders())) x.setRequestHeader(k, v)
      x.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total)
      }
      x.onload = () => resolve({ status: x.status, body: x.responseText })
      x.onerror = () => reject(new Error('The connection dropped before the send finished.'))
      x.send(form)
    })
  let r = await go()
  if (r.status === 401) {
    localStorage.removeItem(TOKEN_KEY)
    await requestToken()
    r = await go()
  }
  let j: (T & { error?: string }) | null = null
  try {
    j = JSON.parse(r.body) as T & { error?: string }
  } catch {
    /* keep the status line */
  }
  if (r.status < 200 || r.status >= 300)
    throw Object.assign(new Error(j?.error || `HTTP ${r.status}`), {
      body: j,
      uncertain: (r.status >= 500 && !j?.error) || r.status === 502 || r.status === 504
    })
  if (!j) throw Object.assign(new Error('Missing send acknowledgement'), { uncertain: true })
  checkOwnerResponse(path, j, 'POST')
  return j as T
}

/* ── shapes the API actually returns ──────────────────────────────────── */

export interface Quote {
  price?: number
  change_pct?: number | null
  ts?: number
  name?: string
  currency?: string
  exchange?: string
  source?: string
}

export interface NewsItem {
  title?: string
  link?: string
  published?: string
  /** who wrote it — the RSS <source> element, or the article's own host */
  source?: string
  domain?: string
  ts?: number
  /** how many other outlets ran the same story */
  also?: number
}

export interface ChatSummary {
  name: string
  kind?: string
  personality?: string
  mode?: string
  agent?: string
  proactive?: boolean
  /** unix seconds of the last real conversation; null = bound but never used */
  last_seen?: number | null
}

export interface RecentNode {
  title: string
  type: string
  ts?: number
  url?: string
  /** the gloss or summary — why this node exists */
  sub?: string
  /** how many nodes connect to it; 0 means an orphan */
  links?: number
  /** the first thing it connects to, e.g. the song a word was met in */
  linked_to?: string
}

export interface Dashboard {
  generated?: number
  brain?: Record<string, number>
  recent?: RecentNode[]
  activity?: number[]
  chat_summaries?: ChatSummary[]
  services?: Record<string, string>
  markets?: {
    quotes?: Record<string, Quote>
    news?: Record<string, { ts?: number; items?: NewsItem[] }>
  }
}

export interface CronJob {
  job_id: string
  /** the last run's outcome. "error" on a job cron KEPT rather than
      deleted, so the failure can be seen instead of vanishing. */
  last_status?: string
  last_error?: string | null
  name?: string
  schedule?: string
  /** how many runs, as Hermes says it: "forever", "once", "7 times", "3/7" */
  repeat?: string
  enabled?: boolean
  state?: string
  next_run_at?: string
  prompt?: string
  prompt_preview?: string
  deliver?: string
  /** Where deliver="origin" points. Without this the UI cannot name the
   *  destination and falls back to a positional label. */
  origin?: { platform?: string; chat_id?: string; chat_name?: string }
}

/** A job that has finished. Cron pops those out of jobs.json, so this comes
 *  from the mirrored note, which is the only record that outlives them. */
export interface CronArchived {
  name: string
  /** fired | failed | cancelled | finished (outcome not recoverable) */
  status: string
  when?: string
  summary?: string
  scope?: string
  updated?: string
}

/** One row of /api/chats — the directory merges the channel list, session
 *  history, bindings and proactive config, so a chat arrives already knowing
 *  how it is bound. */
/** One chat's slice of the token ledger. Every field is a number the API
    already returned on a turn the router made anyway. */
export interface Spend {
  turns: number
  /** everything sent to the model, cache reads and writes included */
  billed_input: number
  cache_read: number
  cache_create: number
  input: number
  output: number
  /** billed_input + output — volume, not price */
  tokens: number
  cost_usd: number
  ms: number
}

export interface Chat {
  jid: string
  target: string
  platform: string
  kind: string
  name?: string
  label?: string
  /** the JID with the parts a filename cannot hold escaped — what bindings key on */
  sanitised?: string
  /** the phone number behind a DM. A row is keyed on the number until its
      owner first messages, then WhatsApp swaps in a display name — so without
      this, a number you just allowlisted becomes unfindable the moment it
      starts working. */
  number?: string
  scope_key?: string
  personality?: string
  mode?: string
  agent?: string
  /** reply language: a "+"-joined subset of en/ja/zh, e.g. "en+ja" */
  language?: string
  lessons?: boolean
  /** which anime archetype she plays here */
  register?: string
  /** how loudly that register runs, 0 (plain) to 4 (maximum) */
  kawaii?: number
  /** which market a bare ticker means here: sg | my | jp | … */
  region?: string
  proactive?: boolean
  last_seen?: number
  /** allowed to message her, but has never written — keyed on the number */
  pending?: boolean
  /** the tickers this chat actually follows, already resolved */
  watchlist?: string[]
  /** it has a list of its own */
  own_watchlist?: boolean
  /** it has explicitly asked to follow the default list. A chat that is
      neither own_watchlist nor inherits_watchlist follows NOTHING — that is
      the state every chat starts in. */
  inherits_watchlist?: boolean
  /** group only: she answers here without being @-tagged */
  free_response?: boolean
  /** epoch seconds the introduction was last sent to this chat */
  intro_sent?: number | null
  /** false = send the plain fixed greeting, not one written in her voice */
  intro_voice?: boolean
  /** "on" = she may fetch and send a photograph here. Default "off". */
  photos?: 'on' | 'off'
  /** group only: "on" = a post link sent here gets its media back, no words */
  autofetch?: 'on' | 'off'
  /** this chat's OWN model choice per role; "" = follow the default */
  chat_model?: string
  agent_model?: string
  /** what those actually resolve to once defaults are applied */
  chat_model_effective?: string
  agent_model_effective?: string
  /** how her replies come back here: null = follow the global default */
  voice_mode?: 'off' | 'voice_only' | 'all' | null
  /** Which LANGUAGE her voice note is in here — a different axis from
      whether she speaks at all. null means this chat has made no choice
      and follows the global default, which is not the same as "auto". */
  tts_language?: 'auto' | 'ja' | 'en' | null
  /** true when this chat has its OWN binding rule; false when persona and
      mode are the defaults showing through. Touching anything on the Access
      tab pins them, so the UI has to be able to say which state it is in. */
  bound?: boolean
  /** what this chat has cost, all time and over the last 30 days */
  usage?: { all?: Spend | null; recent?: Spend | null }
  /** group only: the gateway's group allowlist is in force at all */
  gated?: boolean
  /** group only: the gateway will hear this group. False = every message from
   *  it is dropped before she sees it, and every setting here is inert. */
  allowed?: boolean
  /** names of groups this person has actually spoken in; no DM required */
  heard_in?: string[]
}

export interface Settings {
  personalities?: string[]
  modes?: string[]
  temperaments?: string[]
  registers?: { value: string; label: string; blurb: string; sounds: string[] }[]
  kawaii_levels?: { value: number; label: string; detail: string }[]
  bindings?: {
    defaults?: { personality?: string; mode?: string; agent?: string }
    rows?: unknown[]
  }
  /** song lessons: ModelScope models paused for quota or credit, and the last failure */
  lessons?: {
    paused?: { model: string; until: number; why: string }[]
    last?: { at?: number; model?: string; line?: string }
    daily_allowance?: number
    usage_page?: string
  }
  /** which engine answers web searches, and whether Exa is usable */
  search?: {
    mode: string
    modes: { id: string; label: string; note: string }[]
    exa_key: boolean
    /** epoch seconds Exa is switched off until, 0 when it is on */
    exa_off_until?: number
    exa_off_reason?: string
    /** this month's Exa spend, added up from the cost Exa reports per search */
    usage?: { month?: string; dollars?: number; searches?: number } | null
  }
  /** learning from every message: the owner's switch and what it is doing.
      Counts only — the server never sends a lesson, a rule or a chat. */
  learning?: {
    learning: 'on' | 'off'
    /** AIRA_LEARN=0 is set, so learning is off whatever is chosen here */
    env_off: boolean
    /** grading calls made today (UTC day) against the day cap */
    calls_today: number
    day_cap: number
    /** chats that keep any lesson or style rule, and how many in all */
    chats: number
    lessons: number
    style_rules: number
    error?: string
  }
  models?: {
    catalogue?: { id: string; label: string; note?: string; kind: string }[]
    chat?: string
    agent?: string
    ollama?: { enabled: boolean; endpoint: string; fallback: string }
    /** reasoning effort for her chat turns, and what may be chosen */
    effort?: string
    efforts?: { id: string; label: string; note?: string }[]
    /** where each provider's list came from: live, cached, or not here */
    providers?: Record<string, { state: string; count?: number; error?: string }>
    local_available?: boolean
    env_chat?: string
    env_agent?: string
  }
  languages?: { value: string; label: string; codes: string[] }[]
  regions?: { value: string; label: string; currency: string; indices: string[] }[]
  language_codes?: { code: string; name: string }[]
  timezones?: { value: string; label: string }[]
  markets?: {
    watchlist?: string[]
    alerts?: {
      symbol: string
      direction: 'above' | 'below' | 'moves'
      level: number
      /** chat this one rule answers; absent means default_target */
      to?: string
    }[]
    /** where an alert with no chat of its own is delivered */
    default_target?: string
    /** the hourly world-news digest; composed on the machine, no model */
    news_digest?: {
      enabled?: boolean
      to?: string[]
      /** hours of the day to send on; absent means every hour */
      hours?: number[]
    }
  }
  avatar?: { model?: string; mirror?: boolean }
  /** the master voice-note switch; `enabled` false silences every chat */
  tts?: {
    enabled?: boolean
    /** `voice.auto_tts` in config.yaml. There is no UI for it: it is read
        only so the page can warn if somebody hand-edited it to true, which
        would make every unset chat speak. */
    auto_tts?: boolean
    /** chats set to speak (all | voice_only) */
    speaking?: number
    /** chats explicitly silenced */
    silenced?: number
    /** whether the chosen engine reads the language setting at all */
    lang_aware?: boolean
    /** which engine speaks — key under tts.providers in config.yaml */
    provider?: string
    /** every configured engine, in config-file order */
    providers?: string[]
    /** default audio language for chats that have not chosen */
    lang?: 'auto' | 'ja' | 'en'
    /** how many chats override that default */
    lang_overrides?: number
    /** override keys no chat row can show or clear (legacy or
        non-WhatsApp); still in force on the gateway */
    unreachable?: string[]
    lang_unreachable?: string[]
    /** which languages the server offers. Sent rather than hard-coded so
        ungating zh is a server change, not a frontend release. */
    langs?: string[]
  }
  /** bare JID hermes sends shutdown notices and unaddressed cron jobs to */
  home_channel?: string
  home?: { ip?: string; token_set?: boolean }
  proactive?: unknown[]
}

/* ── library ───────────────────────────────────────────────────────────── */

export interface LibItem {
  id: string
  type: string
  title: string
  sub: string
  /** the chat this entry was filed from; "shared library" when it belongs to
   *  everyone (songs, vocabulary — a dictionary is worth sharing) */
  owner?: string
  /** absent on a neighbour returned inside another item's `links` */
  links?: number
  /** songs only: how many lines were worked through */
  lines?: number
  /** glossed kinds only (vocab/grammar/song/note): has a human checked it.
   *  Absent on kinds that carry no provenance — a source is filed, not
   *  reviewed — so `undefined` and `false` mean different things here. */
  reviewed?: boolean
  /** the date this was first used in a lesson, when it has been */
  taught?: string
  /** the day it was collected, YYYY-MM-DD. The list is ordered by this
   *  newest-first, so showing it is what makes the order legible — an
   *  unexplained order reads as no order at all. */
  when?: string
}

export interface LibIndex {
  counts: Record<string, number>
  items: Record<string, LibItem[]>
  types: string[]
  edges: number
  ledger?: {
    total?: LedgerRow
    by_song?: (LedgerRow & { name: string })[]
    /** Turns that only TALKED about these songs — not what building them cost. */
    chat?: LedgerRow
  }
}

export interface LedgerRow {
  turns: number
  billed_input: number
  cache_read: number
  output: number
  cost_usd: number
}

/** One line of a song, as the glosser filed it. */
export interface SongLine {
  i: number
  ja: string
  reading?: string
  en?: string
  zh?: string
  notes?: string
  vocab?: string[]
  grammar?: string[]
}

export interface LibDetail {
  item: {
    id: string
    type: string
    title: string
    /** the chat this entry was filed from */
    owner?: string
    /** the node's prose, for the kinds whose content is prose */
    body?: string
    data: {
      artist?: string
      lines?: SongLine[]
      reading?: string
      gloss_en?: string
      gloss_zh?: string
      pos?: string
      explanation?: string
      explanation_zh?: string
    }
  }
  links: (LibItem & { rel: string; out: boolean })[]
  prev: LibItem | null
  next: LibItem | null
  position: { at: number; of: number }
}

export interface HistoryPoint {
  0: number
  1: number
}

export interface History {
  symbol: string
  span: string
  points: [number, number][]
  currency?: string
  name?: string
  price?: number
}

/* ── send ─────────────────────────────────────────────────────────────── */

/** A chat a file may be sent to: the Chats page's list, named for a picker. */
export interface SendRecipient {
  /** "whatsapp:<jid>" — the only form the server accepts */
  target: string
  name: string
  /** "group" or "dm" */
  kind: string
  number?: string
  /** allowed to write, but has not yet */
  pending?: boolean
}

/** A file sitting directly in ~/Desktop or ~/Desktop/taildrop. */
export interface BoxFile {
  path: string
  name: string
  /** "Desktop" or "taildrop" */
  folder: string
  size: number
  /** unix seconds */
  mtime: number
}

/** One line of the send log. Never the file's bytes or the message's words. */
export interface SendRecord {
  at: number
  name: string
  size: number
  target: string
  recipient: string
  kind: string
  source: 'upload' | 'box'
  document: boolean
  with_message: boolean
  ok: boolean
  /** why it failed, in words; "" when it went */
  error: string
}

export interface SendView {
  recipients: SendRecipient[]
  files: BoxFile[]
  folders: string[]
  recent: SendRecord[]
  max_bytes: number
  max_message: number
}

/** One entry on the WhatsApp front door. `name`/`chat_id` are empty until the
 *  person actually messages: WhatsApp gives us a LID, and a LID cannot be
 *  derived from a phone number — only observed once they write. */
export interface AllowedNumber {
  number: string
  name: string
  /** "<lid>@lid" once WhatsApp has assigned one; "" before they ever write */
  chat_id: string
  kind: string
  /** true once there is an actual conversation on file to configure */
  met: boolean
  /** how many groups they have spoken in — contact without a DM */
  groups: number
  /** unix seconds of the last time she heard from them anywhere */
  last_seen: number | null
}
