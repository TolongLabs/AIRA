import { z } from 'zod'

// One schema for config.yml. Every object is strict: an unknown key stops start-up (docs/trd/data.md).
// Each group is owned by the TRD module named beside it in config.yml.

const onOff = z.enum(['on', 'off'])
const ms = z.number().int().positive()
const count = z.number().int().positive()

const price = z.number().nonnegative().default(0)
const modelTarget = z.strictObject({
  provider: z.string(),
  model: z.string(),
  baseUrl: z.string(),
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
  llm: z.strictObject({
    transport: z.enum(['api', 'subscription']),
    main: modelTarget,
    fallback: modelTarget,
    turnDeadlineMs: ms,
    maxRetries: z.number().int().min(0),
    breakerMs: ms,
    monthlyBudgetUsd: z.number().nonnegative()
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
    hostDataDir: z.string()
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
  })
})

export type Config = z.infer<typeof configSchema>
