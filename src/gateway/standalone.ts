import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { readPrivateText, writePrivateText } from '../config/private-store.js'
import { ensurePrivateToken, verifyStandaloneOwnerToken } from '../config/standalone-owner.js'
import { getChatByWaId } from '../settings/chats.js'
import type { Storage } from '../storage/database.js'
import type { GatewayRequest } from './request.js'
import { createStandaloneDeliveryLedger } from './standalone-delivery.js'

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
  mid: identifier,
  text: z.string().trim().min(1).max(32_768)
})
const textCapabilities = z.tuple([z.literal('text')])
const typedReceipt = receiptSchema.extend({
  schemaVersion: z.literal(2),
  routeId: z.uuid(),
  capabilities: textCapabilities
})
const connectedReceipt = z.union([receiptSchema, typedReceipt])
const typedAttachment = z.discriminatedUnion('action', [
  attachment.extend({ schemaVersion: z.literal(2), action: z.literal('connect'), capabilities: textCapabilities }),
  attachment.extend({ schemaVersion: z.literal(2), action: z.literal('disconnect'), routeId: z.uuid() })
])
const typedTurn = turnSchema.extend({ schemaVersion: z.literal(2), routeId: z.uuid() })
const deliveryBinding = z.strictObject({
  schemaVersion: z.literal(2),
  routeId: z.uuid(),
  profile: profileId,
  chat: identifier,
  mid: identifier,
  id: z.uuid()
})
const deliveryAck = deliveryBinding.extend({ outcome: z.enum(['confirmed', 'failed', 'unknown']) })
type StructuredTurn = Pick<z.infer<typeof turnSchema>, 'platform' | 'kind' | 'chat' | 'sender' | 'mid' | 'text'>
export interface HermesRouteStatus {
  state: 'connected' | 'disconnected' | 'invalid' | 'unsupported'
  adapterVersion: (typeof STANDALONE_ADAPTER_VERSIONS)[number] | null
  profile: string | null
  verifiedAt: string | null
  protocolVersion?: 2
  routeId?: string
  capabilities?: ['text']
}

export class StandaloneGatewayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(code)
  }
}

const detached: HermesRouteStatus = { state: 'disconnected', adapterVersion: null, profile: null, verifiedAt: null }

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
      return {
        state: 'connected',
        adapterVersion: adapterVersion.data,
        profile: parsed.data.profile,
        verifiedAt: parsed.data.verifiedAt,
        ...(parsed.data.schemaVersion === 2
          ? { protocolVersion: 2 as const, routeId: parsed.data.routeId, capabilities: parsed.data.capabilities }
          : {})
      }
    } catch {
      return { ...detached, state: 'invalid' }
    }
  }

  const authorized = (header: string | undefined): boolean => {
    const candidate = header?.match(/^Bearer ([0-9a-f]{64})$/)?.[1]
    return candidate !== undefined && verifyStandaloneOwnerToken(token, candidate)
  }

  const delivery = createStandaloneDeliveryLedger(storage, {
    now,
    currentRoute: () => {
      const route = status()
      return route.state === 'connected' && route.protocolVersion === 2 ? (route.routeId ?? null) : null
    }
  })

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
      parsed.data.action === 'disconnect' &&
      (current.adapterVersion !== parsed.data.adapterVersion || current.protocolVersion === 2)
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
    const current = status()
    const { profile, adapterVersion } = parsed.data
    if (current.state === 'connected' && current.profile !== profile)
      throw new StandaloneGatewayError(409, 'hermes_profile_conflict')
    if (parsed.data.action === 'disconnect') {
      if (
        current.state !== 'connected' ||
        current.protocolVersion !== 2 ||
        current.routeId !== parsed.data.routeId ||
        current.adapterVersion !== adapterVersion
      )
        throw new StandaloneGatewayError(409, 'hermes_contract_failed')
      return persist({ schemaVersion: 1, state: 'disconnected' })
    }
    if (current.state === 'connected' && current.protocolVersion === 2 && current.adapterVersion === adapterVersion)
      return current
    return persist({
      schemaVersion: 2,
      state: 'connected',
      adapterVersion,
      profile,
      verifiedAt: now().toISOString(),
      routeId: randomUUID(),
      capabilities: parsed.data.capabilities
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
    return { request: asTurn(parsed.data), routeId: parsed.data.routeId }
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

  return { status, authorized, attach, attachTyped, parseTurn, parseTypedTurn, claimTyped, ackTyped, delivery }
}

export type StandaloneGateway = ReturnType<typeof createStandaloneGateway>
