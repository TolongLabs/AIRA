import { z } from 'zod'

// One schema for config.yml. Every object is strict: an unknown key stops start-up (docs/trd/data.md).
// Each group is owned by the TRD module named beside it in config.yml.

const onOff = z.enum(['on', 'off'])
const ms = z.number().int().positive()
const count = z.number().int().positive()

const price = z.number().nonnegative().default(0)
/** Claude's effort levels, for the `anthropic` provider and the subscription program (docs/trd/models.md). */
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const modelTarget = z.strictObject({
  provider: z.string(),
  model: z.string(),
  baseUrl: z.string(),
  // Sent per provider (docs/trd/models.md#providers-and-effort). Empty: the model's own default.
  effort: z.string().default(''),
  // US dollars per million tokens. Used for the spend cap when the provider's response reports no cost.
  usdPerMTokIn: price,
  usdPerMTokOut: price,
  usdPerMTokCached: price
})

export const configSchema = z.strictObject({
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
    leakCheck: onOff
  }),
  tools: z.strictObject({
    maxCallsPerTurn: count,
    timeBudgetMs: ms,
    defaultTimeoutMs: ms
  }),
  search: z.strictObject({
    provider: z.string().min(1)
  }),
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
      main: modelTarget,
      fallback: modelTarget,
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
        if (claude && !claudeEffort(target.effort)) {
          context.addIssue({
            code: 'custom',
            path: [role, 'effort'],
            message: `must be empty or one of ${CLAUDE_EFFORTS.join(', ')}`
          })
        }
      }
    }),
  media: z.strictObject({
    watcher: z.strictObject({
      model: z.string().min(1).nullable()
    }),
    maxVideoSeconds: count,
    timeoutMs: ms.default(30000)
  }),
  turn: z.strictObject({
    batchMs: ms,
    mediaWaitMs: ms
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
    windowDays: count
  }),
  log: z.strictObject({
    level: z.enum(['error', 'warn', 'info', 'debug'])
  }),
  deploy: z.strictObject({
    checkEveryMin: count,
    waitForIdleMs: ms,
    healthTimeoutMs: ms
  }),
  gateway: z.strictObject({
    // The data volume's path on the host. Empty in the repository; requireDeployable refuses an empty value.
    hostDataDir: z.string(),
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
    offsite: z.string().min(1)
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
