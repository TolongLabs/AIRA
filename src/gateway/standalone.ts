import { join } from 'node:path'
import { z } from 'zod'
import { readPrivateText, writePrivateText } from '../config/private-store.js'
import { ensurePrivateToken, verifyStandaloneOwnerToken } from '../config/standalone-owner.js'
import type { GatewayRequest } from './request.js'

export const STANDALONE_ADAPTER_VERSION = 'hermes-v0.23.4'
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
  adapterVersion: z.literal(STANDALONE_ADAPTER_VERSION),
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
export interface HermesRouteStatus {
  state: 'connected' | 'disconnected' | 'invalid' | 'unsupported'
  adapterVersion: typeof STANDALONE_ADAPTER_VERSION | null
  profile: string | null
  verifiedAt: string | null
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

export function createStandaloneGateway(dataRoot: string, now: () => Date = () => new Date()) {
  const token = ensurePrivateToken(dataRoot, 'gateway.token')
  const receiptPath = join(dataRoot, 'standalone', 'hermes.json')

  const status = (): HermesRouteStatus => {
    try {
      const raw = readPrivateText(receiptPath, 4096)
      if (raw === undefined) return { ...detached }
      const value: unknown = JSON.parse(raw)
      if (disconnectReceipt.safeParse(value).success) return { ...detached }
      const parsed = receiptSchema.safeParse(value)
      if (!parsed.success) return { ...detached, state: 'invalid' }
      if (parsed.data.adapterVersion !== STANDALONE_ADAPTER_VERSION) return { ...detached, state: 'unsupported' }
      return {
        state: 'connected',
        adapterVersion: STANDALONE_ADAPTER_VERSION,
        profile: parsed.data.profile,
        verifiedAt: parsed.data.verifiedAt
      }
    } catch {
      return { ...detached, state: 'invalid' }
    }
  }

  const authorized = (header: string | undefined): boolean => {
    const candidate = header?.match(/^Bearer ([0-9a-f]{64})$/)?.[1]
    return candidate !== undefined && verifyStandaloneOwnerToken(token, candidate)
  }

  const attach = (input: unknown): HermesRouteStatus => {
    const parsed = attachment.safeParse(input)
    if (!parsed.success) throw new StandaloneGatewayError(400, 'hermes_contract_failed')
    const current = status()
    if (current.state === 'connected' && current.profile !== parsed.data.profile)
      throw new StandaloneGatewayError(409, 'hermes_profile_conflict')
    try {
      const receipt =
        parsed.data.action === 'connect'
          ? {
              schemaVersion: 1,
              state: 'connected',
              adapterVersion: STANDALONE_ADAPTER_VERSION,
              profile: parsed.data.profile,
              verifiedAt: now().toISOString()
            }
          : { schemaVersion: 1, state: 'disconnected' }
      writePrivateText(receiptPath, JSON.stringify(receipt) + '\n', true)
    } catch {
      throw new StandaloneGatewayError(503, 'hermes_contract_failed')
    }
    return status()
  }

  const parseTurn = (input: unknown): Extract<GatewayRequest, { type: 'turn' }> => {
    const parsed = turnSchema.safeParse(input)
    if (!parsed.success) throw new StandaloneGatewayError(400, 'gateway_malformed')
    const current = status()
    if (current.state !== 'connected' || current.profile !== parsed.data.profile)
      throw new StandaloneGatewayError(403, 'hermes_profile_refused')
    const { platform, kind, chat, sender, mid, text } = parsed.data
    return {
      type: 'turn',
      marker: { platform, kind, chat, sender, mid },
      text,
      earlier: '',
      attachments: [],
      stream: false,
      includeUsage: false
    }
  }

  return { status, authorized, attach, parseTurn }
}

export type StandaloneGateway = ReturnType<typeof createStandaloneGateway>
