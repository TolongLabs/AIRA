import type { CoreChat } from './core'
import type { SendRecipient } from './api'

export function fileRecipient(chat: Pick<CoreChat, 'deliveryTarget' | 'type' | 'waId'>, recipients: SendRecipient[]) {
  const canonical =
    chat.deliveryTarget === undefined ? 'whatsapp:' + chat.waId.replace(/^whatsapp:/, '') : chat.deliveryTarget
  if (!canonical) return undefined
  const exact = recipients.find((r) => r.kind === chat.type && r.target === canonical)
  if (exact || chat.type !== 'dm') return exact
  const phone = /^whatsapp:\+?(\d{6,15})@(?:s\.whatsapp\.net|c\.us)$/.exec(canonical)?.[1]
  if (!phone) return undefined
  const matches = recipients.filter((r) => r.kind === 'dm' && r.number?.replace(/^\+/, '') === phone)
  return matches.length === 1 ? matches[0] : undefined
}
