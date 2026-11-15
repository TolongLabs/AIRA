import { z } from 'zod'

// One schema for config.yml. Every object is strict: an unknown key stops start-up (docs/trd/data.md).
// Each group is owned by the TRD module named beside it in config.yml.

const onOff = z.enum(['on', 'off'])
const ms = z.number().int().positive()
const count = z.number().int().positive()

const modelTarget = z.strictObject({
  provider: z.string(),
  model: z.string(),
  baseUrl: z.string()
})

export const configSchema = z.strictObject({
  prompt: z.strictObject({
    maxSystemTokens: count
  }),
  judge: z.strictObject({
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
    servers: z.array(z.record(z.string(), z.unknown()))
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
