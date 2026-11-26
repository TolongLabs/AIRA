import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { assertPrivateDirectory, ensurePrivateDirectory, readPrivateText, writePrivateText } from './private-store.js'
import { type Config, configSchema } from './schema.js'

// Standalone model revision authority (docs/trd/dashboard-state.md#model-revision-authority).
const id = z.uuid().nullable()
const pointerSchema = z.strictObject({
  schemaVersion: z.literal(1),
  savedRevision: id,
  appliedRevision: id,
  requestedRevision: id,
  startingRevision: id,
  appliedAt: z.string().nullable(),
  lastFailure: z.literal('activation_failed').nullable()
})
type Pointer = z.infer<typeof pointerSchema>

const safeUrl = (text: string): boolean => {
  try {
    const url = new URL(text)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      return false
    if (
      ['localhost', '127.0.0.1', '[::1]', 'host.docker.internal'].includes(url.hostname) &&
      ['9881', '9890'].includes(url.port)
    )
      return false
    return true
  } catch {
    return false
  }
}
const targetSchema = z.strictObject({
  provider: z.enum(['anthropic', 'openai-compatible']),
  model: z.string().trim().min(1).max(256),
  baseUrl: z.string().max(2048).refine(safeUrl),
  effort: z.string().max(64),
  deepEffort: z.string().max(64),
  usdPerMTokIn: z.number().nonnegative(),
  usdPerMTokOut: z.number().nonnegative(),
  usdPerMTokCached: z.number().nonnegative()
})
const keySchema = z
  .string()
  .max(8192)
  .refine((key) => !/[\r\n\0]/.test(key))
const writableTarget = targetSchema.extend({ apiKey: keySchema.nullable().optional() }).nullable()
const mediaTargetSchema = z.strictObject({
  provider: z.literal('gemini'),
  model: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/)
})
const writableMedia = mediaTargetSchema.extend({ apiKey: keySchema.nullable().optional() }).nullable().optional()
const writeSchema = z.strictObject({
  expectedRevision: id,
  main: writableTarget,
  fallback: writableTarget,
  media: writableMedia
})
const activationSchema = z.strictObject({ expectedRevision: id })
const settingsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  main: targetSchema.nullable(),
  fallback: targetSchema.nullable()
})
const credentialsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  main: keySchema.nullable(),
  fallback: keySchema.nullable()
})
type Settings = z.infer<typeof settingsSchema>
type Credentials = z.infer<typeof credentialsSchema>
const mediaSettingsSchema = z.strictObject({ schemaVersion: z.literal(1), media: mediaTargetSchema.nullable() })
const mediaCredentialsSchema = z.strictObject({ schemaVersion: z.literal(1), media: keySchema.nullable() })
type MediaTarget = z.infer<typeof mediaTargetSchema>
type Media = { target: MediaTarget | null; key: string | null }
type Revision = { settings: Settings; credentials: Credentials; media: Media }
type ReadTarget = z.infer<typeof targetSchema> & { credentialConfigured: boolean }
type ReadPair = {
  main: ReadTarget | null
  fallback: ReadTarget | null
  media: (MediaTarget & { credentialConfigured: boolean }) | null
}
export interface StandaloneModelSnapshot {
  schemaVersion: 1
  optionalRoles: ['media']
  configuration: 'setup_required' | 'configured' | 'invalid' | 'pending_activation'
  savedRevision: string | null
  appliedRevision: string | null
  activation: 'idle' | 'requested' | 'starting'
  lastFailure: 'activation_failed' | null
  saved: ReadPair | null
  applied: ReadPair | null
}
export interface StandaloneBoot {
  config: Config
  env: NodeJS.ProcessEnv
  revision: string | null
  claimed: boolean
  configured: boolean
}

export class StandaloneModelError extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(code)
  }
}

function initialPointer(): Pointer {
  return {
    schemaVersion: 1,
    savedRevision: null,
    appliedRevision: null,
    requestedRevision: null,
    startingRevision: null,
    appliedAt: null,
    lastFailure: null
  }
}

function sanitized(revision: Revision | null): ReadPair | null {
  if (!revision) return null
  const role = (name: 'main' | 'fallback'): ReadTarget | null => {
    const target = revision.settings[name]
    return target ? { ...target, credentialConfigured: Boolean(revision.credentials[name]) } : null
  }
  const media = revision.media
  return {
    main: role('main'),
    fallback: role('fallback'),
    media: media.target ? { ...media.target, credentialConfigured: Boolean(media.key) } : null
  }
}
const configured = (revision: Revision | null): boolean => Boolean(revision?.settings.main && revision.credentials.main)

const disabled: Config['llm']['main'] = {
  provider: '',
  model: '',
  baseUrl: '',
  effort: '',
  deepEffort: '',
  usdPerMTokIn: 0,
  usdPerMTokOut: 0,
  usdPerMTokCached: 0
}

function runtimeConfig(base: Config, revision: Revision | null): Config {
  return configSchema.parse({
    ...base,
    llm: {
      ...base.llm,
      transport: 'api',
      fallbackTransport: 'api',
      main: revision?.settings.main ?? disabled,
      fallback: revision?.settings.fallback ?? disabled
    },
    media: {
      ...base.media,
      watcher: { model: configured(revision) && revision?.media.key ? (revision.media.target?.model ?? null) : null },
      gatewayDirs: []
    }
  })
}

function runtime(base: Config, revision: Revision | null, revisionId: string | null, claimed: boolean): StandaloneBoot {
  const active = configured(revision)
  const env: NodeJS.ProcessEnv = {}
  if (active && revision) {
    if (revision.credentials.main) env.LLM_API_KEY = revision.credentials.main
    if (revision.settings.fallback && revision.credentials.fallback)
      env.LLM_FALLBACK_API_KEY = revision.credentials.fallback
    if (revision.media.target && revision.media.key) env.MEDIA_WATCHER_API_KEY = revision.media.key
  }
  return { config: runtimeConfig(base, revision), env, revision: revisionId, claimed, configured: active }
}

function invalidSnapshot(pointer = initialPointer()): StandaloneModelSnapshot {
  return {
    schemaVersion: 1,
    optionalRoles: ['media'],
    configuration: 'invalid',
    savedRevision: pointer.savedRevision,
    appliedRevision: pointer.appliedRevision,
    activation: 'idle',
    lastFailure: pointer.lastFailure,
    saved: null,
    applied: null
  }
}

export function createStandaloneModelStore(dataRoot: string, base: Config) {
  const directory = join(dataRoot, 'standalone')
  const revisions = join(directory, 'revisions')
  const pointerPath = join(directory, 'models.json')

  const readPointer = (): Pointer => {
    if (!existsSync(directory)) return initialPointer()
    assertPrivateDirectory(directory)
    const raw = readPrivateText(pointerPath)
    if (raw === undefined) return initialPointer()
    const pointer = pointerSchema.parse(JSON.parse(raw))
    if (pointer.requestedRevision !== null && pointer.startingRevision !== null)
      throw new Error('invalid activation state')
    if (pointer.requestedRevision !== null && pointer.requestedRevision !== pointer.savedRevision)
      throw new Error('invalid revision')
    if (pointer.startingRevision !== null && pointer.startingRevision !== pointer.savedRevision)
      throw new Error('invalid revision')
    return pointer
  }

  const writePointer = (pointer: Pointer): void => {
    ensurePrivateDirectory(directory)
    writePrivateText(pointerPath, JSON.stringify(pointer) + '\n', true)
  }

  const readRevision = (revision: string | null): Revision | null => {
    if (revision === null) return null
    assertPrivateDirectory(revisions)
    const settings = readPrivateText(join(revisions, revision + '.json'))
    const credentials = readPrivateText(join(revisions, revision + '.credentials.json'))
    if (settings === undefined || credentials === undefined) throw new Error('missing revision')
    const mediaSettings = readPrivateText(join(revisions, revision + '.media.json'))
    const mediaCredentials = readPrivateText(join(revisions, revision + '.media.credentials.json'))
    let media: Media = { target: null, key: null }
    if (mediaSettings !== undefined || mediaCredentials !== undefined) {
      if (mediaSettings === undefined || mediaCredentials === undefined) throw new Error('missing media revision')
      media = {
        target: mediaSettingsSchema.parse(JSON.parse(mediaSettings)).media,
        key: mediaCredentialsSchema.parse(JSON.parse(mediaCredentials)).media
      }
      if (media.target === null && media.key !== null) throw new Error('invalid media credential reference')
    }
    const value = {
      settings: settingsSchema.parse(JSON.parse(settings)),
      credentials: credentialsSchema.parse(JSON.parse(credentials)),
      media
    }
    if ((!value.settings.main && value.credentials.main) || (!value.settings.fallback && value.credentials.fallback))
      throw new Error('invalid credential reference')
    runtimeConfig(base, value)
    return value
  }

  const snapshot = (): StandaloneModelSnapshot => {
    let pointer: Pointer
    try {
      pointer = readPointer()
    } catch {
      return invalidSnapshot()
    }
    try {
      const saved = readRevision(pointer.savedRevision)
      const applied = readRevision(pointer.appliedRevision)
      return {
        schemaVersion: 1,
        optionalRoles: ['media'],
        configuration:
          pointer.savedRevision !== pointer.appliedRevision
            ? 'pending_activation'
            : configured(applied)
              ? 'configured'
              : 'setup_required',
        savedRevision: pointer.savedRevision,
        appliedRevision: pointer.appliedRevision,
        activation: pointer.startingRevision ? 'starting' : pointer.requestedRevision ? 'requested' : 'idle',
        lastFailure: pointer.lastFailure,
        saved: sanitized(saved),
        applied: sanitized(applied)
      }
    } catch {
      return invalidSnapshot(pointer)
    }
  }

  const writable = (): Pointer => {
    try {
      const pointer = readPointer()
      if (pointer.startingRevision || pointer.requestedRevision)
        throw new StandaloneModelError(409, 'activation_in_progress')
      readRevision(pointer.savedRevision)
      readRevision(pointer.appliedRevision)
      return pointer
    } catch (error) {
      if (error instanceof StandaloneModelError) throw error
      throw new StandaloneModelError(503, 'configuration_unavailable')
    }
  }

  const save = (input: unknown): StandaloneModelSnapshot => {
    const parsed = writeSchema.safeParse(input)
    if (!parsed.success) throw new StandaloneModelError(400, 'model_config_invalid')
    const pointer = writable()
    if (pointer.savedRevision !== parsed.data.expectedRevision) throw new StandaloneModelError(409, 'stale_revision')
    const previous = readRevision(pointer.savedRevision)
    const settings: Settings = { schemaVersion: 1, main: null, fallback: null }
    const credentials: Credentials = { schemaVersion: 1, main: null, fallback: null }
    for (const role of ['main', 'fallback'] as const) {
      const target = parsed.data[role]
      if (target === null) continue
      const { apiKey, ...fields } = target
      settings[role] = fields
      credentials[role] = apiKey === undefined || apiKey === '' ? (previous?.credentials[role] ?? null) : apiKey
    }
    let media: Media = previous?.media ?? { target: null, key: null }
    const mediaInput = parsed.data.media
    if (mediaInput === null) media = { target: null, key: null }
    else if (mediaInput !== undefined) {
      const { apiKey, ...target } = mediaInput
      media = { target, key: apiKey === undefined || apiKey === '' ? media.key : apiKey }
    }
    const revision = { settings, credentials, media }
    try {
      runtimeConfig(base, revision)
    } catch {
      throw new StandaloneModelError(400, 'model_config_invalid')
    }
    const revisionId = randomUUID()
    try {
      ensurePrivateDirectory(directory)
      ensurePrivateDirectory(revisions)
      if (
        !writePrivateText(join(revisions, revisionId + '.json'), JSON.stringify(settings) + '\n') ||
        !writePrivateText(join(revisions, revisionId + '.credentials.json'), JSON.stringify(credentials) + '\n') ||
        !writePrivateText(
          join(revisions, revisionId + '.media.json'),
          JSON.stringify({ schemaVersion: 1, media: media.target }) + '\n'
        ) ||
        !writePrivateText(
          join(revisions, revisionId + '.media.credentials.json'),
          JSON.stringify({ schemaVersion: 1, media: media.key }) + '\n'
        )
      )
        throw new Error('revision collision')
      writePointer({ ...pointer, savedRevision: revisionId, lastFailure: null })
    } catch {
      throw new StandaloneModelError(503, 'configuration_unavailable')
    }
    return snapshot()
  }

  const requestActivation = (input: unknown): StandaloneModelSnapshot => {
    const parsed = activationSchema.safeParse(input)
    if (!parsed.success) throw new StandaloneModelError(400, 'model_config_invalid')
    const pointer = writable()
    if (pointer.savedRevision !== parsed.data.expectedRevision) throw new StandaloneModelError(409, 'stale_revision')
    if (!pointer.savedRevision) throw new StandaloneModelError(400, 'model_setup_required')
    if (pointer.savedRevision !== pointer.appliedRevision) {
      try {
        writePointer({ ...pointer, requestedRevision: pointer.savedRevision, lastFailure: null })
      } catch {
        throw new StandaloneModelError(503, 'configuration_unavailable')
      }
    }
    return snapshot()
  }

  const beginBoot = (): StandaloneBoot => {
    try {
      let pointer = readPointer()
      if (pointer.startingRevision) {
        pointer = { ...pointer, startingRevision: null, requestedRevision: null, lastFailure: 'activation_failed' }
        writePointer(pointer)
      }
      if (pointer.requestedRevision) {
        const candidate = pointer.requestedRevision
        try {
          const revision = readRevision(candidate)
          const boot = runtime(base, revision, candidate, true)
          writePointer({ ...pointer, requestedRevision: null, startingRevision: candidate })
          return boot
        } catch {
          pointer = { ...pointer, requestedRevision: null, lastFailure: 'activation_failed' }
          writePointer(pointer)
        }
      }
      return runtime(base, readRevision(pointer.appliedRevision), pointer.appliedRevision, false)
    } catch {
      return runtime(base, null, null, false)
    }
  }

  const completeActivation = (revision: string): void => {
    const pointer = readPointer()
    if (pointer.startingRevision !== revision) throw new Error('activation claim differs')
    readRevision(revision)
    writePointer({
      ...pointer,
      appliedRevision: revision,
      startingRevision: null,
      appliedAt: new Date().toISOString(),
      lastFailure: null
    })
  }

  const failActivation = (revision: string): void => {
    const pointer = readPointer()
    if (pointer.startingRevision === revision)
      writePointer({ ...pointer, startingRevision: null, lastFailure: 'activation_failed' })
  }

  return { snapshot, save, requestActivation, beginBoot, completeActivation, failActivation }
}
export type StandaloneModelStore = ReturnType<typeof createStandaloneModelStore>
