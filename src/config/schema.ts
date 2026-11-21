import { z } from 'zod'
import { reportFormatSchema } from '../render/types.js'
import { MAX_TIMEOUT_MS, MAX_UPLOAD_BYTES } from '../tools/identify.js'

// One schema for config.yml. Every object is strict: an unknown key stops start-up (docs/trd/data.md).
// Each group is owned by the TRD module named beside it in config.yml.

const onOff = z.enum(['on', 'off'])
const ms = z.number().int().positive()
const count = z.number().int().positive()

const price = z.number().nonnegative().default(0)
/** Claude's effort levels, for the `anthropic` provider and the subscription program (docs/trd/models.md). */
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const modelTarget = (deepEffortDefault: string) =>
  z.strictObject({
    provider: z.string(),
    model: z.string(),
    baseUrl: z.string(),
    // Sent per provider (docs/trd/models.md#providers-and-effort). Empty: the model's own default.
    effort: z.string().default(''),
    // Effort on a `/think` turn (docs/trd/models.md#deeper-thinking). Empty: the role's normal effort.
    deepEffort: z.string().default(deepEffortDefault),
    // US dollars per million tokens. Used for the spend cap when the provider's response reports no cost.
    usdPerMTokIn: price,
    usdPerMTokOut: price,
    usdPerMTokCached: price
  })

/** An absolute path with no `..`, and never the root: a pair that maps `/` would let any path through. */
const absoluteDir = z
  .string()
  .regex(/^\/[^\0]*$/, 'must be an absolute path')
  .refine((path) => path.replace(/\/+$/, '') !== '' && !path.split('/').includes('..'), {
    message: 'must not be the root and must not contain ..'
  })
const gatewayDir = z.strictObject({ host: absoluteDir, container: absoluteDir })

const offsiteObject = z
  .strictObject({
    kind: z.enum(['off', 'rest', 's3']).default('off'),
    repository: z.string().optional(),
    checkEveryHours: count.default(24),
    staleAlertMin: count.default(60)
  })
  .superRefine((offsite, context) => {
    if (offsite.kind === 'off') return
    if (!offsite.repository || offsite.repository.trim() === '') {
      context.addIssue({
        code: 'custom',
        path: ['repository'],
        message: `must be set when kind is ${offsite.kind}`
      })
      return
    }
    const prefix = `${offsite.kind}:`
    if (!offsite.repository.startsWith(prefix) || offsite.repository.length <= prefix.length) {
      context.addIssue({
        code: 'custom',
        path: ['repository'],
        message: `must start with ${prefix}`
      })
    }
  })

const offsiteSchema = z.preprocess((value) => (value === 'off' ? { kind: 'off' } : value), offsiteObject)

export const configSchema = z.strictObject({
  feedback: z
    .strictObject({
      formUrl: z.union([z.literal(''), z.url().refine((value) => new URL(value).protocol === 'https:')]).default(''),
      referenceEntryId: z.string().regex(/^\d*$/).default(''),
      pollMinutes: count.default(5),
      refTtlHours: count.default(168)
    })
    .prefault({}),
  research: z
    .strictObject({
      maxSearches: count.max(6).default(6),
      maxPages: count.max(8).default(8),
      deadlineMs: ms.max(120000).default(120000),
      offerMinutes: count.default(30)
    })
    .default({ maxSearches: 6, maxPages: 8, deadlineMs: 120000, offerMinutes: 30 }),
  prompt: z.strictObject({
    maxSystemTokens: count
  }),
  judge: z.strictObject({
    // The hosted judge's versioned model id. Empty means no judge: mood by rules only, and memory admits nothing.
    model: z.string().default(''),
    mood: onOff,
    moodMinProbability: z.number().min(0).max(1),
    memoryAdmit: z.number().min(0).max(1),
    memoryVerify: z.number().min(0).max(1),
    timeoutMs: ms.default(1500)
  }),
  format: z.strictObject({
    bubbleMaxChars: count,
    maxBubbles: count,
    leakCheck: onOff,
    // The time zone code writes times in (docs/trd/prompt-engine.md#configuration).
    timeZone: z
      .string()
      .refine((zone) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: zone })
          return true
        } catch {
          return false
        }
      }, 'must be an IANA time zone')
      .default('Asia/Kuala_Lumpur')
  }),
  tools: z.strictObject({
    maxCallsPerTurn: count,
    timeBudgetMs: ms,
    defaultTimeoutMs: ms
  }),
  // The owner's market and coding-session tools (docs/trd/tools.md#owner-tools). An empty path turns its tool off.
  owner: z
    .strictObject({
      marketsConfig: z.string().default(''),
      claudeProjectsDir: z.string().default(''),
      noticeRoutesFile: z.string().default(''),
      timeoutMs: ms.default(15000)
    })
    .default({ marketsConfig: '', claudeProjectsDir: '', noticeRoutesFile: '', timeoutMs: 15000 }),
  search: z.strictObject({
    provider: z.string().min(1),
    pageMaxChars: count.default(12_000),
    depth: z
      .strictObject({
        maxSearches: count.max(2).default(2),
        maxPages: z.number().int().min(0).max(2).default(2),
        maxProviderCalls: count.max(3).default(3)
      })
      .prefault({})
  }),
  links: z
    .strictObject({
      baseUrl: z
        .union([
          z.literal(''),
          z.url().refine((value) => {
            const url = new URL(value)
            return (
              (url.protocol === 'https:' || url.protocol === 'http:') &&
              !url.username &&
              !url.password &&
              url.pathname === '/' &&
              !url.search &&
              !url.hash
            )
          }, 'Expected an HTTP or HTTPS origin')
        ])
        .default(''),
      timeoutMs: ms.default(800)
    })
    .prefault({}),
  // Reverse-image hints (docs/trd/tools.md#reverse-image-hints). A value above a hard maximum stops start-up.
  identify: z
    .strictObject({
      timeoutMs: ms.max(MAX_TIMEOUT_MS).default(6000),
      maxUploadBytes: count.max(MAX_UPLOAD_BYTES).default(500_000)
    })
    .prefault({}),
  lessons: z
    .strictObject({
      // The lyrics provider for lyrics_search and lyrics_fetch, or `off`.
      lyricsProvider: z.string().min(1)
    })
    .default({ lyricsProvider: 'off' }),
  mcp: z.strictObject({
    servers: z.array(
      z.strictObject({
        id: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
        transport: z.literal('stdio'),
        // The program and its arguments. Never run through a shell.
        command: z.array(z.string().min(1)).min(1),
        // The allowlist of the server's tools. Anything else is ignored.
        tools: z.array(z.string().min(1)),
        // The chat ids that may use it. Empty means none.
        chats: z.array(z.string().min(1)),
        timeoutMs: ms.default(10000)
      })
    )
  }),
  memory: z.strictObject({
    enabled: onOff,
    episodeIdleMs: ms,
    episodeMaxMessages: count,
    recallTokenBudget: count
  }),
  embeddings: z.strictObject({
    provider: z.string().min(1)
  }),
  llm: z
    .strictObject({
      transport: z.enum(['api', 'subscription']),
      main: modelTarget('high'),
      fallback: modelTarget('max'),
      turnDeadlineMs: ms,
      maxRetries: z.number().int().min(0),
      breakerMs: ms,
      monthlyBudgetUsd: z.number().nonnegative(),
      // Used only when transport is `subscription` (docs/trd/models.md#host-runner-service).
      subscription: z
        .strictObject({
          // The host runner service. Loopback only.
          runnerUrl: z.string().regex(/^http:\/\/(127\.0\.0\.1|localhost|host\.docker\.internal):\d+$/),
          // The port of the core's tool server for the program, and the address the program reaches it at.
          toolServerPort: z.number().int().min(1024).max(65535),
          toolServerUrl: z.string().regex(/^http:\/\/(127\.0\.0\.1|localhost):\d+$/)
        })
        .default({
          runnerUrl: 'http://127.0.0.1:9882',
          toolServerPort: 9883,
          toolServerUrl: 'http://127.0.0.1:9883'
        })
    })
    .superRefine((llm, context) => {
      // Claude refuses an effort outside its list, and an OpenAI-compatible server checks its own.
      const claudeEffort = (effort: string) => effort === '' || (CLAUDE_EFFORTS as readonly string[]).includes(effort)
      for (const role of ['main', 'fallback'] as const) {
        const target = llm[role]
        const claude = target.provider === 'anthropic' || (role === 'main' && llm.transport === 'subscription')
        for (const field of ['effort', 'deepEffort'] as const) {
          if (claude && !claudeEffort(target[field])) {
            context.addIssue({
              code: 'custom',
              path: [role, field],
              message: `must be empty or one of ${CLAUDE_EFFORTS.join(', ')}`
            })
          }
        }
      }
    }),
  media: z.strictObject({
    watcher: z.strictObject({
      model: z.string().min(1).nullable()
    }),
    // The gateway's media folders as the gateway writes them in its notes, and where this process mounts them.
    gatewayDirs: z.array(gatewayDir).default([]),
    maxVideoSeconds: count,
    maxLinkVideoSeconds: count.default(600),
    linkWatchMs: ms.default(12000),
    linkSegmentSeconds: count.default(180),
    linkFirstSegmentSeconds: count.default(60),
    maxLinkSegments: count.default(4),
    linkFps: z.number().positive().default(0.25),
    timeoutMs: ms.default(30000)
  }),
  social: z
    .strictObject({
      timeoutMs: ms.default(6000),
      // Limits per HTTP reader and per extractor, each clipped to the lookup's deadline (docs/trd/tools.md).
      httpReaderTimeoutMs: ms.default(2500),
      ytDlpTimeoutMs: ms.default(4500),
      cacheTtlMs: z.number().int().min(0).default(900000),
      maxCacheEntries: z.number().int().min(1).default(256),
      maxTextChars: z.number().int().min(1).default(1500),
      maxReplies: z.number().int().min(1).max(50).default(5),
      maxReplyChars: z.number().int().min(1).default(280),
      ytDlpPath: z.string().min(1).default('yt-dlp')
    })
    .prefault({}),
  // Report PDF renderer (docs/trd/research.md#the-renderer).
  render: z
    .strictObject({
      // Path or command name of the Typst binary used to compile PDFs.
      typstPath: z.string().min(1).default('typst'),
      // Longest wait for one PDF compilation before it is killed.
      timeoutMs: ms.default(20000),
      // Maximum page count allowed for a rendered report PDF.
      maxPages: count.default(30),
      // Maximum byte size allowed for a rendered report PDF (5 MiB).
      maxBytes: count.default(5242880),
      // Default report layout and typography profile.
      report: reportFormatSchema.prefault({})
    })
    .prefault({}),
  turn: z.strictObject({
    batchMs: ms
  }),
  shutdown: z.strictObject({
    graceMs: ms
  }),
  alerts: z.strictObject({
    minGapMs: ms
  }),
  records: z.strictObject({
    retentionDays: count,
    diagnosticsHours: count,
    windowDays: count,
    feedbackDays: count.default(90)
  }),
  log: z.strictObject({
    level: z.enum(['error', 'warn', 'info', 'debug'])
  }),
  gateway: z.strictObject({
    // The data volume's path on the host. Empty in the repository; requireDeployable refuses an empty value.
    hostDataDir: z.string(),
    // The bot's own WhatsApp ids, so a mention of the bot is told from a name call. Host only.
    selfIds: z.array(z.string().min(1)).default([]),
    // The owner's gateway jobs the core runs, each with its chat (docs/trd/system.md#gateway-jobs). Host only.
    jobs: z
      .array(z.strictObject({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), chat: z.string().min(1) }))
      .default([])
  }),
  storage: z
    .strictObject({
      path: z.string().min(1),
      minFreeMb: count,
      criticalFreeMb: count,
      checkEveryMin: count,
      cacheMaxMb: count
    })
    .refine((s) => s.criticalFreeMb < s.minFreeMb, {
      message: 'storage.criticalFreeMb must be below storage.minFreeMb'
    }),
  backup: z.strictObject({
    everyMin: count,
    keepDays: count,
    offsite: offsiteSchema.prefault({})
  }),
  archive: z.strictObject({
    enabled: onOff
  }),
  site: z.strictObject({
    port: z.number().int().min(1).max(65535),
    // Origins whose browser writes are accepted (docs/trd/site.md#write-routes).
    allowedOrigins: z.array(z.url()).default([])
  })
})

export type Config = z.infer<typeof configSchema>
