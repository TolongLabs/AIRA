import type { ConfigField, DeploymentModel, DeploymentSettings } from './dashboard-types.js'
import type { Config } from './schema.js'
import type { ConfigStatusSnapshot } from './status.js'

// The dashboard reports presence only. This inventory also feeds log redaction.
export const credentialPurposes = {
  LLM_API_KEY: 'Primary model API',
  LLM_FALLBACK_API_KEY: 'Fallback model API',
  RUNNER_TOKEN: 'Claude Code host runner',
  TYPESAFE_API_KEY: 'Mood and memory judge',
  MEDIA_WATCHER_API_KEY: 'Media watcher',
  EXA_API_KEY: 'Web search and page reading',
  SERPAPI_API_KEY: 'Reverse-image search',
  YOUTUBE_API_KEY: 'YouTube replies',
  APIFY_API_TOKEN: 'Social mirrors',
  APIFY_API_KEY: 'Social mirrors (alternate key)',
  LINKS_SECRET: 'Signed links',
  FEEDBACK_SYNC_URL: 'Feedback sync destination',
  FEEDBACK_SYNC_SECRET: 'Feedback sync authentication',
  AIRA_BACKUP_PASSWORD: 'Backup encryption',
  RESTIC_REST_USERNAME: 'REST backup username',
  RESTIC_REST_PASSWORD: 'REST backup password',
  AWS_ACCESS_KEY_ID: 'S3 backup access key',
  AWS_SECRET_ACCESS_KEY: 'S3 backup secret',
  OPENAI_API_KEY: 'Development tooling'
} as const

type Policy<T> =
  NonNullable<T> extends readonly unknown[]
    ? 'count'
    : NonNullable<T> extends object
      ? { [K in keyof NonNullable<T>]-?: Policy<NonNullable<T>[K]> }
      : NonNullable<T> extends string
        ? 'value' | 'presence' | 'origin'
        : 'value'
const target = {
  provider: 'value',
  model: 'value',
  baseUrl: 'origin',
  effort: 'value',
  deepEffort: 'value',
  usdPerMTokIn: 'value',
  usdPerMTokOut: 'value',
  usdPerMTokCached: 'value'
} as const
// Every schema field requires an explicit display policy. Lists can include chat IDs or executable arguments.
const fields = {
  feedback: { formUrl: 'presence', referenceEntryId: 'presence', pollMinutes: 'value', refTtlHours: 'value' },
  research: { maxSearches: 'value', maxPages: 'value', deadlineMs: 'value', offerMinutes: 'value' },
  prompt: { maxSystemTokens: 'value' },
  judge: {
    model: 'value',
    mood: 'value',
    moodMinProbability: 'value',
    memoryAdmit: 'value',
    memoryVerify: 'value',
    timeoutMs: 'value'
  },
  format: { bubbleMaxChars: 'value', maxBubbles: 'value', leakCheck: 'value', timeZone: 'value' },
  tools: { maxCallsPerTurn: 'value', timeBudgetMs: 'value', defaultTimeoutMs: 'value' },
  owner: { marketsConfig: 'presence', claudeProjectsDir: 'presence', noticeRoutesFile: 'presence', timeoutMs: 'value' },
  search: {
    provider: 'value',
    pageMaxChars: 'value',
    depth: { maxSearches: 'value', maxPages: 'value', maxProviderCalls: 'value' }
  },
  links: { baseUrl: 'origin', timeoutMs: 'value' },
  identify: { timeoutMs: 'value', maxUploadBytes: 'value' },
  lessons: { lyricsProvider: 'value' },
  mcp: { servers: 'count' },
  memory: { enabled: 'value', episodeIdleMs: 'value', episodeMaxMessages: 'value', recallTokenBudget: 'value' },
  embeddings: { provider: 'value' },
  llm: {
    transport: 'value',
    fallbackTransport: 'value',
    main: target,
    fallback: target,
    turnDeadlineMs: 'value',
    maxRetries: 'value',
    breakerMs: 'value',
    monthlyBudgetUsd: 'value',
    subscription: { runnerUrl: 'origin', toolServerPort: 'value', toolServerUrl: 'origin' }
  },
  media: {
    watcher: { model: 'value' },
    gatewayDirs: 'count',
    maxVideoSeconds: 'value',
    maxLinkVideoSeconds: 'value',
    linkWatchMs: 'value',
    linkSegmentSeconds: 'value',
    linkFirstSegmentSeconds: 'value',
    maxLinkSegments: 'value',
    linkFps: 'value',
    timeoutMs: 'value'
  },
  social: {
    mirrors: {
      tiktok: 'value',
      reddit: 'value',
      rednote: 'value',
      douyin: 'value',
      linkedin: 'value',
      redditGroupChatIds: 'count'
    },
    timeoutMs: 'value',
    httpReaderTimeoutMs: 'value',
    ytDlpTimeoutMs: 'value',
    cacheTtlMs: 'value',
    maxCacheEntries: 'value',
    maxTextChars: 'value',
    maxReplies: 'value',
    maxReplyChars: 'value',
    ytDlpPath: 'presence'
  },
  render: {
    typstPath: 'presence',
    timeoutMs: 'value',
    maxPages: 'value',
    maxBytes: 'value',
    report: {
      pageSize: 'value',
      accent: 'value',
      fontSize: 'value',
      cover: 'value',
      sourcesAppendix: 'value',
      header: 'presence'
    }
  },
  turn: { batchMs: 'value' },
  shutdown: { graceMs: 'value' },
  alerts: { minGapMs: 'value' },
  records: { retentionDays: 'value', diagnosticsHours: 'value', windowDays: 'value', feedbackDays: 'value' },
  log: { level: 'value' },
  gateway: { hostDataDir: 'presence', selfIds: 'count', jobs: 'count' },
  storage: {
    path: 'presence',
    minFreeMb: 'value',
    criticalFreeMb: 'value',
    checkEveryMin: 'value',
    cacheMaxMb: 'value'
  },
  backup: {
    everyMin: 'value',
    keepDays: 'value',
    offsite: { kind: 'value', repository: 'presence', checkEveryHours: 'value', staleAlertMin: 'value' }
  },
  archive: { enabled: 'value' },
  site: { port: 'value', allowedOrigins: 'count' }
} as const satisfies Policy<Config>

function origin(value: unknown): string {
  if (!value) return 'Not set'
  try {
    const url = new URL(String(value))
    if (url.protocol === 'https:' || url.protocol === 'http:') return url.origin
  } catch {
    /* A custom endpoint can be configured without a displayable origin. */
  }
  return 'Configured'
}

type FieldMap = { readonly [key: string]: 'value' | 'presence' | 'origin' | 'count' | FieldMap }
function project(policy: FieldMap, values: object, prefix = ''): Record<string, string | number | boolean> {
  const rows: Record<string, string | number | boolean> = {}
  for (const [key, rule] of Object.entries(policy)) {
    const name = prefix + key
    const v: unknown = Object.hasOwn(values, key) ? Reflect.get(values, key) : undefined
    if (typeof rule === 'object') {
      if (v && typeof v === 'object') Object.assign(rows, project(rule, v, name + '.'))
      continue
    }
    if (rule === 'presence') rows[name] = v ? 'Configured' : 'Not set'
    else if (rule === 'count') rows[name] = Array.isArray(v) ? v.length + ' entries' : 'Not set'
    else if (rule === 'origin') rows[name] = origin(v)
    else if (typeof v === 'number' || typeof v === 'boolean') rows[name] = v
    else rows[name] = typeof v === 'string' && v ? v : 'Not set'
  }
  return rows
}

export function deploymentSettings(
  config: Config,
  env: NodeJS.ProcessEnv,
  status: ConfigStatusSnapshot,
  roles: Record<string, { configured: boolean }>
): DeploymentSettings {
  function model(role: 'main' | 'fallback'): DeploymentModel {
    const target = config.llm[role]
    const runner = (role === 'main' ? config.llm.transport : config.llm.fallbackTransport) === 'subscription'
    const legacy = !runner && target.provider === 'aira-router'
    const effort = target.effort || (runner ? 'medium' : 'Provider default')
    return {
      model: target.model || (runner ? 'Claude Code default' : 'Not set'),
      connection: runner
        ? 'Claude Code subscription'
        : target.provider === 'anthropic'
          ? 'Anthropic API'
          : target.provider === 'openai-compatible'
            ? 'OpenAI-compatible API'
            : legacy
              ? 'AIRA router · Claude Code'
              : 'Not set',
      endpoint: legacy ? 'Private host socket' : origin(runner ? config.llm.subscription.runnerUrl : target.baseUrl),
      effort,
      deepEffort: target.deepEffort || effort,
      credential: legacy
        ? 'Host Claude login'
        : runner
          ? 'RUNNER_TOKEN'
          : role === 'main'
            ? 'LLM_API_KEY'
            : 'LLM_FALLBACK_API_KEY',
      configured: roles[role]?.configured ?? false
    }
  }
  const groups: DeploymentSettings['groups'] = {}
  for (const key of Object.keys(fields) as (keyof Config)[]) groups[key] = project(fields[key], config[key])
  for (const [index, server] of config.mcp.servers.entries()) {
    const name = 'servers[' + index + '].'
    Object.assign(groups['mcp']!, {
      [name + 'id']: server.id,
      [name + 'transport']: server.transport,
      [name + 'timeoutMs']: server.timeoutMs,
      [name + 'command']: server.command.length ? 'Configured' : 'Not set',
      [name + 'tools']: server.tools.length + ' entries',
      [name + 'chats']: server.chats.length + ' entries'
    })
  }
  return {
    activation: status.status,
    appliedAt: status.appliedAt,
    models: { main: model('main'), fallback: model('fallback') },
    groups,
    credentials: Object.entries(credentialPurposes).map(([name, purpose]) => ({
      name,
      purpose,
      present: Boolean(env[name])
    }))
  }
}

/** Editable leaf paths come from the same disclosure policy as the startup snapshot. */
export function hostConfigFields(config: Config) {
  const result: Record<string, Record<string, ConfigField>> = {}
  for (const key of Object.keys(fields) as (keyof Config)[]) {
    const group: Record<string, ConfigField> = {}
    const display = project(fields[key], config[key])
    function visit(policy: FieldMap, values: object, prefix: string) {
      for (const [key, rule] of Object.entries(policy)) {
        const name = prefix + key
        const value: unknown = Object.hasOwn(values, key) ? Reflect.get(values, key) : undefined
        if (typeof rule === 'object') {
          visit(rule, value && typeof value === 'object' ? value : {}, name + '.')
          continue
        }
        const kind =
          rule === 'count'
            ? 'list'
            : typeof value === 'number'
              ? 'number'
              : typeof value === 'boolean'
                ? 'boolean'
                : 'string'
        group[name] = { kind, display: String(display[name] ?? 'Not set') }
        if (rule === 'value' && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'))
          group[name].value = value
      }
    }
    visit(fields[key], config[key], '')
    result[key] = group
  }
  return result
}
