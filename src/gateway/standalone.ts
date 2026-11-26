import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { readPrivateText, writePrivateText } from '../config/private-store.js'
import { ensurePrivateToken, verifyStandaloneOwnerToken } from '../config/standalone-owner.js'
import { getChat, getChatByWaId } from '../settings/chats.js'
import { resolveSetting } from '../settings/settings.js'
import type { Storage } from '../storage/database.js'
import type { TurnReply } from '../turn/pipeline.js'
import {
  PORTABLE_REMINDER_PREFIX,
  type ReminderOccurrence,
  type ReminderScope,
  reminderChatEnabled,
  sameReminderScope
} from './reminder-scope.js'
import type { GatewayRequest } from './request.js'
import { createStandaloneDeliveryLedger } from './standalone-delivery.js'
import { decodeDirectMedia, directMediaSchema } from './standalone-media.js'
import { createStandaloneReminderQueue } from './standalone-reminders.js'

export const STANDALONE_ADAPTER_VERSION = 'hermes-v0.23.4'
export const STANDALONE_ADAPTER_VERSIONS = ['hermes-v0.23.2', 'hermes-v0.23.3', STANDALONE_ADAPTER_VERSION] as const
const adapterVersionSchema = z.enum(STANDALONE_ADAPTER_VERSIONS)
const profileId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
const identifier = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9@._:+-]+$/)
const receiptSchema = z.strictObject({
  schemaVersion: z.literal(1),
  state: z.literal('connected'),
  adapterVersion: z.string().min(1).max(80),
  profile: profileId,
  verifiedAt: z.iso.datetime()
})
const disconnectReceipt = z.strictObject({ schemaVersion: z.literal(1), state: z.literal('disconnected') })
const attachment = z.strictObject({
  schemaVersion: z.literal(1),
  adapterVersion: adapterVersionSchema,
  profile: profileId,
  action: z.enum(['connect', 'disconnect'])
})
const turnSchema = z.strictObject({
  schemaVersion: z.literal(1),
  profile: profileId,
  platform: z.literal('whatsapp'),
  kind: z.enum(['dm', 'group']),
  chat: identifier,
  sender: identifier,
  mid: identifier.refine((mid) => !mid.startsWith(PORTABLE_REMINDER_PREFIX)),
  text: z.string().trim().min(1).max(32_768)
})
const directMediaItems = [
  z.literal('text'),
  z.literal('document'),
  z.literal('receive-image'),
  z.literal('receive-audio'),
  z.literal('receive-video'),
  z.literal('receive-pdf')
] as const
const directMediaCapabilities = z.tuple(directMediaItems)
const schedulerCapabilities = z.tuple([...directMediaItems, z.literal('scheduler')])
const typedCapabilities = z.union([
  z.tuple([z.literal('text')]),
  z.tuple([z.literal('text'), z.literal('document')]),
  directMediaCapabilities,
  schedulerCapabilities
])
type TypedCapabilities = z.infer<typeof typedCapabilities>
const typedReceipt = receiptSchema.extend({
  schemaVersion: z.literal(2),
  routeId: z.uuid(),
  capabilities: typedCapabilities
})
const connectedReceipt = z.union([receiptSchema, typedReceipt])
const deadlineMs = z.number().int().safe()
const typedAttachment = z.discriminatedUnion('action', [
  attachment.extend({
    schemaVersion: z.literal(2),
    action: z.literal('connect'),
    capabilities: typedCapabilities,
    deadlineMs
  }),
  attachment.extend({ schemaVersion: z.literal(2), action: z.literal('disconnect'), routeId: z.uuid(), deadlineMs }),
  attachment.extend({ schemaVersion: z.literal(2), action: z.literal('downgrade'), routeId: z.uuid(), deadlineMs })
])
const typedTurn = turnSchema.extend({ schemaVersion: z.literal(2), routeId: z.uuid() })
const mediaTurn = typedTurn.extend({ media: directMediaSchema })
const deliveryBinding = z.strictObject({
  schemaVersion: z.literal(2),
  routeId: z.uuid(),
  profile: profileId,
  chat: identifier,
  mid: identifier,
  id: z.uuid()
})
const deliveryAck = deliveryBinding.extend({ outcome: z.enum(['confirmed', 'failed', 'unknown']) })
const schedulerScope = z.strictObject({ schemaVersion: z.literal(2), routeId: z.uuid(), profile: profileId })
const schedulerClaim = schedulerScope.extend({ id: z.uuid() })
const schedulerAck = schedulerClaim.extend({ outcome: z.enum(['confirmed', 'failed', 'unknown']) })
type StructuredTurn = Pick<z.infer<typeof turnSchema>, 'platform' | 'kind' | 'chat' | 'sender' | 'mid' | 'text'>
type InactiveRoute = {
  state: 'disconnected' | 'invalid' | 'unsupported'
  adapterVersion: null
  profile: null
  verifiedAt: null
  protocolVersion?: never
  routeId?: never
  capabilities?: never
}
type ConnectedRoute = {
  state: 'connected'
  adapterVersion: (typeof STANDALONE_ADAPTER_VERSIONS)[number]
  profile: string
  verifiedAt: string
}
type V1Route = ConnectedRoute & { protocolVersion?: never; routeId?: never; capabilities?: never }
type V2Route = ConnectedRoute & { protocolVersion: 2; routeId: string; capabilities: TypedCapabilities }
export type HermesRouteStatus = InactiveRoute | V1Route | V2Route

export const hasDocumentCapability = (route: HermesRouteStatus | undefined): boolean =>
  route?.state === 'connected' &&
  route.protocolVersion === 2 &&
  route.capabilities.some((capability) => capability === 'document')

export const hasMediaCapability = (route: HermesRouteStatus | undefined): boolean =>
  route?.state === 'connected' &&
  route.protocolVersion === 2 &&
  route.capabilities.some((capability) => capability === 'receive-image')

export const hasSchedulerCapability = (route: HermesRouteStatus | undefined): boolean =>
  route?.state === 'connected' &&
  route.protocolVersion === 2 &&
  route.capabilities.some((capability) => capability === 'scheduler')

export class StandaloneGatewayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(code)
  }
}

const detached: InactiveRoute = { state: 'disconnected', adapterVersion: null, profile: null, verifiedAt: null }

export function createStandaloneGateway(dataRoot: string, storage: Storage, now: () => Date = () => new Date()) {
  const token = ensurePrivateToken(dataRoot, 'gateway.token')
  const receiptPath = join(dataRoot, 'standalone', 'hermes.json')

  const status = (): HermesRouteStatus => {
    try {
      const raw = readPrivateText(receiptPath, 4096)
      if (raw === undefined) return { ...detached }
      const value: unknown = JSON.parse(raw)
      if (disconnectReceipt.safeParse(value).success) return { ...detached }
      const parsed = connectedReceipt.safeParse(value)
      if (!parsed.success) return { ...detached, state: 'invalid' }
      const adapterVersion = adapterVersionSchema.safeParse(parsed.data.adapterVersion)
      if (!adapterVersion.success) return { ...detached, state: 'unsupported' }
      const route: ConnectedRoute = {
        state: 'connected',
        adapterVersion: adapterVersion.data,
        profile: parsed.data.profile,
        verifiedAt: parsed.data.verifiedAt
      }
      return parsed.data.schemaVersion === 2
        ? { ...route, protocolVersion: 2, routeId: parsed.data.routeId, capabilities: parsed.data.capabilities }
        : route
    } catch {
      return { ...detached, state: 'invalid' }
    }
  }

  const authorized = (header: string | undefined): boolean => {
    const candidate = header?.match(/^Bearer ([0-9a-f]{64})$/)?.[1]
    return candidate !== undefined && verifyStandaloneOwnerToken(token, candidate)
  }

  const canDeliverDocument = (routeId: string | undefined, chatId: string): boolean => {
    const route = status()
    if (
      !routeId ||
      route.state !== 'connected' ||
      route.protocolVersion !== 2 ||
      route.routeId !== routeId ||
      !hasDocumentCapability(route)
    )
      return false
    const chat = getChat(storage, chatId)
    return chat?.status === 'active' && resolveSetting(storage, chat, 'features.reports').value === true
  }

  const canReceiveMedia = (routeId: string | undefined, chatId: string): boolean => {
    const route = status()
    if (!routeId || route.routeId !== routeId || !hasMediaCapability(route)) return false
    const chat = getChat(storage, chatId)
    return (
      chat?.status === 'active' &&
      resolveSetting(storage, chat, 'features.media').value === true &&
      resolveSetting(storage, chat, 'muted').value === false
    )
  }

  const currentReminderScope = (): ReminderScope | null => {
    const route = status()
    return route.state === 'connected' && route.protocolVersion === 2 && hasSchedulerCapability(route)
      ? { routeId: route.routeId, profile: route.profile }
      : null
  }

  const reminderScopeFor = (routeId: string | undefined, chatId: string): ReminderScope | null => {
    const scope = currentReminderScope()
    return scope && scope.routeId === routeId && reminderChatEnabled(storage, chatId) ? scope : null
  }

  const mayRunReminder = (scope: ReminderScope, chatId: string): boolean =>
    sameReminderScope(reminderScopeFor(scope.routeId, chatId), scope)

  const delivery = createStandaloneDeliveryLedger(storage, {
    now,
    filesDir: join(dataRoot, 'files'),
    mayDeliverDocument: canDeliverDocument,
    currentRoute: () => {
      const route = status()
      return route.state === 'connected' && route.protocolVersion === 2 ? (route.routeId ?? null) : null
    }
  })
  const reminders = createStandaloneReminderQueue(storage, delivery, currentReminderScope, now)

  const persist = (receipt: unknown): HermesRouteStatus => {
    try {
      writePrivateText(receiptPath, JSON.stringify(receipt) + '\n', true)
    } catch {
      throw new StandaloneGatewayError(503, 'hermes_contract_failed')
    }
    return status()
  }

  const attach = (input: unknown): HermesRouteStatus => {
    const parsed = attachment.safeParse(input)
    if (!parsed.success) throw new StandaloneGatewayError(400, 'hermes_contract_failed')
    const current = status()
    if (current.state === 'connected' && current.profile !== parsed.data.profile)
      throw new StandaloneGatewayError(409, 'hermes_profile_conflict')
    if (
      current.state === 'connected' &&
      (current.protocolVersion === 2 ||
        (parsed.data.action === 'disconnect' && current.adapterVersion !== parsed.data.adapterVersion))
    )
      throw new StandaloneGatewayError(409, 'hermes_contract_failed')
    return persist(
      parsed.data.action === 'connect'
        ? {
            schemaVersion: 1,
            state: 'connected',
            adapterVersion: parsed.data.adapterVersion,
            profile: parsed.data.profile,
            verifiedAt: now().toISOString()
          }
        : { schemaVersion: 1, state: 'disconnected' }
    )
  }

  const attachTyped = (input: unknown): HermesRouteStatus => {
    const parsed = typedAttachment.safeParse(input)
    if (!parsed.success) throw new StandaloneGatewayError(400, 'hermes_contract_failed')
    const remaining = parsed.data.deadlineMs - now().getTime()
    if (remaining <= 0 || remaining > 10_000) throw new StandaloneGatewayError(409, 'hermes_contract_failed')
    const current = status()
    const { profile, adapterVersion } = parsed.data
    if (current.state === 'connected' && current.profile !== profile)
      throw new StandaloneGatewayError(409, 'hermes_profile_conflict')
    if (parsed.data.action !== 'connect') {
      if (
        current.state !== 'connected' ||
        current.protocolVersion !== 2 ||
        current.routeId !== parsed.data.routeId ||
        (parsed.data.action === 'disconnect' && current.adapterVersion !== adapterVersion)
      )
        throw new StandaloneGatewayError(409, 'hermes_contract_failed')
      return persist(
        parsed.data.action === 'disconnect'
          ? { schemaVersion: 1, state: 'disconnected' }
          : { schemaVersion: 1, state: 'connected', adapterVersion, profile, verifiedAt: now().toISOString() }
      )
    }
    const capabilities = parsed.data.capabilities
    if (
      current.state === 'connected' &&
      current.protocolVersion === 2 &&
      current.adapterVersion === adapterVersion &&
      current.capabilities.length === capabilities.length &&
      current.capabilities.every((capability, index) => capability === capabilities[index])
    )
      return current
    return persist({
      schemaVersion: 2,
      state: 'connected',
      adapterVersion,
      profile,
      verifiedAt: now().toISOString(),
      routeId: randomUUID(),
      capabilities
    })
  }

  const asTurn = ({
    platform,
    kind,
    chat,
    sender,
    mid,
    text
  }: StructuredTurn): Extract<GatewayRequest, { type: 'turn' }> => ({
    type: 'turn',
    marker: { platform, kind, chat, sender, mid },
    text,
    earlier: '',
    attachments: [],
    stream: false,
    includeUsage: false
  })

  const parseTurn = (input: unknown): Extract<GatewayRequest, { type: 'turn' }> => {
    const parsed = turnSchema.safeParse(input)
    if (!parsed.success) throw new StandaloneGatewayError(400, 'gateway_malformed')
    const current = status()
    if (current.state !== 'connected' || current.profile !== parsed.data.profile || current.protocolVersion === 2)
      throw new StandaloneGatewayError(403, 'hermes_profile_refused')
    return asTurn(parsed.data)
  }

  const isSameV1Route = (captured: HermesRouteStatus): boolean => {
    const current = status()
    return (
      captured.state === 'connected' &&
      captured.protocolVersion !== 2 &&
      current.state === 'connected' &&
      current.protocolVersion !== 2 &&
      current.profile === captured.profile &&
      current.adapterVersion === captured.adapterVersion &&
      current.verifiedAt === captured.verifiedAt
    )
  }

  const requireTypedRoute = (profile: string, routeId: string): void => {
    const current = status()
    if (
      current.state !== 'connected' ||
      current.protocolVersion !== 2 ||
      current.profile !== profile ||
      current.routeId !== routeId
    )
      throw new StandaloneGatewayError(403, 'hermes_profile_refused')
  }

  const parseTypedTurn = (input: unknown) => {
    const parsed = typedTurn.safeParse(input)
    if (!parsed.success) throw new StandaloneGatewayError(400, 'gateway_malformed')
    requireTypedRoute(parsed.data.profile, parsed.data.routeId)
    return { request: { ...asTurn(parsed.data), typedRouteId: parsed.data.routeId }, routeId: parsed.data.routeId }
  }

  const parseMediaTurn = (input: unknown) => {
    const parsed = mediaTurn.safeParse(input)
    if (!parsed.success) throw new StandaloneGatewayError(400, 'gateway_malformed')
    const { profile, routeId, chat: waId, kind, media } = parsed.data
    requireTypedRoute(profile, routeId)
    const chat = getChatByWaId(storage, waId)
    if (!chat || chat.type !== kind || !canReceiveMedia(routeId, chat.chatId))
      throw new StandaloneGatewayError(409, 'media_unavailable')
    const attachment = decodeDirectMedia(media)
    if (!attachment) throw new StandaloneGatewayError(400, 'gateway_malformed')
    return { request: { ...asTurn(parsed.data), typedRouteId: routeId, attachments: [attachment] }, routeId }
  }

  const bindDelivery = (input: z.infer<typeof deliveryBinding>) => {
    requireTypedRoute(input.profile, input.routeId)
    const chat = getChatByWaId(storage, input.chat)
    if (!chat) throw new StandaloneGatewayError(409, 'delivery_unavailable')
    return { routeId: input.routeId, chatId: chat.chatId, mid: input.mid, id: input.id }
  }

  const claimTyped = (input: unknown) => {
    const parsed = deliveryBinding.safeParse(input)
    if (!parsed.success) throw new StandaloneGatewayError(400, 'gateway_malformed')
    const claimed = delivery.claim(bindDelivery(parsed.data))
    if (!claimed) throw new StandaloneGatewayError(409, 'delivery_unavailable')
    return claimed
  }

  const ackTyped = (input: unknown): void => {
    const parsed = deliveryAck.safeParse(input)
    if (!parsed.success) throw new StandaloneGatewayError(400, 'gateway_malformed')
    if (!delivery.ack({ ...bindDelivery(parsed.data), outcome: parsed.data.outcome }))
      throw new StandaloneGatewayError(409, 'delivery_unavailable')
  }

  function requireScheduler(scope: ReminderScope): void {
    if (!sameReminderScope(currentReminderScope(), scope))
      throw new StandaloneGatewayError(403, 'hermes_profile_refused')
  }

  async function pollReminder(input: unknown, run: (occurrence: ReminderOccurrence) => Promise<TurnReply | null>) {
    const parsed = schedulerScope.safeParse(input)
    if (!parsed.success) throw new StandaloneGatewayError(400, 'gateway_malformed')
    requireScheduler(parsed.data)
    return reminders.poll(parsed.data, run)
  }

  function claimReminder(input: unknown) {
    const parsed = schedulerClaim.safeParse(input)
    if (!parsed.success) throw new StandaloneGatewayError(400, 'gateway_malformed')
    requireScheduler(parsed.data)
    const result = reminders.claim(parsed.data, parsed.data.id)
    if (!result) throw new StandaloneGatewayError(409, 'delivery_unavailable')
    return result
  }

  function ackReminder(input: unknown): void {
    const parsed = schedulerAck.safeParse(input)
    if (!parsed.success) throw new StandaloneGatewayError(400, 'gateway_malformed')
    requireScheduler(parsed.data)
    if (!reminders.ack(parsed.data, parsed.data.id, parsed.data.outcome))
      throw new StandaloneGatewayError(409, 'delivery_unavailable')
  }

  return {
    status,
    authorized,
    attach,
    attachTyped,
    parseTurn,
    isSameV1Route,
    parseTypedTurn,
    parseMediaTurn,
    claimTyped,
    ackTyped,
    delivery,
    canDeliverDocument,
    canReceiveMedia,
    reminderScopeFor,
    mayRunReminder,
    pollReminder,
    claimReminder,
    ackReminder
  }
}

export type StandaloneGateway = ReturnType<typeof createStandaloneGateway>
