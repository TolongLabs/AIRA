import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ChatInfo, createFakeBridge, type FakeBridge, type RecordedCall } from '../bridge.js'
import {
  DM_MEMBER,
  GROUP_MEMBERS,
  MAX_NAME,
  MAX_TEXT,
  type MessagesResult,
  type SendInput,
  type SendResult,
  type SimBackend,
  type SimChat,
  SimInputError,
  slug
} from './backend.js'
import { ChatLog, type PreviewMessage, quoteText, textFields } from './model.js'

// Level 2 of the WhatsApp simulator (docs/trd/harness.md#whatsapp-simulator): a real staging gateway talks to a fake
// bridge, and the preview draws what the gateway sent to the bridge. Nothing here runs a core.

export interface Level2Options {
  /** A fake bridge that is already running. Absent: the sim starts one on `bridgePort`. */
  bridgeUrl?: string
  /** The port of the bridge the sim starts. The gateway's own default is 3000. */
  bridgePort?: number
  /** The ids the gateway knows the two chats by. */
  dmId?: string
  groupId?: string
  /** Folders the gateway's media may come from: its media cache and the core's data folder. */
  mediaRoots?: string[]
}

export interface Level2 extends SimBackend {
  /** Where the staging gateway should find its bridge. */
  readonly bridgeUrl: string
  /** Reads the bridge's new calls into the chats now. Called on every poll; tests call it directly. */
  sync(): Promise<void>
}

interface LiveChat extends SimChat {
  log: ChatLog
  /** When the gateway last said it was typing, in ms. */
  typingAt: number
  /** When the newest message from a member was injected, in ms. */
  lastInboundAt: number
}

/** How long a typing call keeps the indicator up. The gateway repeats it while a turn runs. */
const TYPING_MS = 6000

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {}

function text(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string') return value
  }
  return ''
}

export async function startLevel2(options: Level2Options = {}): Promise<Level2> {
  const dmId = options.dmId ?? 'sim-dm-0001'
  const groupId = options.groupId ?? 'sim-group-0001'
  const declared: SimChat[] = [
    { id: dmId, title: 'Direct chat', kind: 'dm', members: [DM_MEMBER] },
    { id: groupId, title: 'Weekend Crew', kind: 'group', members: GROUP_MEMBERS }
  ]
  const chats: LiveChat[] = declared.map((chat) => ({
    ...chat,
    log: new ChatLog(`sim-${chat.kind}`),
    typingAt: 0,
    lastInboundAt: 0
  }))

  let bridge: FakeBridge | undefined
  let filesDir: string | undefined
  let bridgeUrl = options.bridgeUrl?.replace(/\/+$/, '')
  if (bridgeUrl === undefined) {
    filesDir = mkdtempSync(join(tmpdir(), 'aira-sim-bridge-'))
    const known: ChatInfo[] = chats.map((chat) => ({
      id: chat.id,
      name: chat.title,
      isGroup: chat.kind === 'group',
      members: chat.members.map((name) => ({ id: `sim-member-${slug(name)}`, name }))
    }))
    bridge = createFakeBridge({ filesDir, chats: known, mediaRoots: options.mediaRoots ?? [] })
    bridgeUrl = await bridge.start(options.bridgePort ?? 3000)
  }
  const base = bridgeUrl

  const bridgeFetch = async (path: string, init?: RequestInit): Promise<Response> => {
    try {
      return await fetch(`${base}${path}`, init)
    } catch {
      throw new SimInputError(`the fake bridge at ${base} is not reachable`, 502)
    }
  }

  const liveChat = (id: string): LiveChat => {
    const chat = chats.find((candidate) => candidate.id === id)
    if (!chat) throw new SimInputError('unknown chat', 404)
    return chat
  }
  const find = (id: string): { chat: LiveChat; message: PreviewMessage } | undefined => {
    for (const chat of chats) {
      const message = chat.log.find(id)
      if (message) return { chat, message }
    }
    return undefined
  }

  /** One recorded call of the gateway, drawn. */
  function apply(call: RecordedCall): void {
    const body = asRecord(call.payload)
    const chatId = text(body, 'chatId', 'chat')
    const chat = chats.find((candidate) => candidate.id === chatId)
    const at = Date.parse(call.at)

    if (call.route === '/typing') {
      if (chat) chat.typingAt = at
      return
    }
    if (call.route === '/edit') {
      const found = find(text(body, 'messageId', 'id'))
      const edited = text(body, 'message', 'text')
      if (found && found.message.kind === 'aira') {
        found.chat.log.update(found.message, { ...textFields(edited), edited: true })
      }
      return
    }
    if (call.route === '/react') {
      const found = find(text(body, 'messageId', 'id'))
      if (found) found.chat.log.update(found.message, { reaction: text(body, 'emoji', 'reaction') })
      return
    }
    if (call.route !== '/send' && call.route !== '/send-media') return
    if (!chat) return

    chat.typingAt = 0
    const replyTo = text(body, 'replyTo')
    const quoted = replyTo === '' ? undefined : chat.log.find(replyTo)
    const quote = quoted
      ? { id: quoted.id, sender: quoted.kind === 'aira' ? 'AIRA' : (quoted.sender ?? ''), text: quoteText(quoted) }
      : undefined
    const turn = { ms: Math.max(0, at - chat.lastInboundAt), faults: [] as string[] }
    const common = {
      kind: 'aira' as const,
      at: call.at,
      ...(call.messageId ? { id: call.messageId } : {}),
      ...(quote ? { quote } : {}),
      ...(chat.lastInboundAt > 0 ? { turn } : {})
    }

    if (call.route === '/send') {
      const sent = text(body, 'message', 'text')
      if (sent.trim() !== '') chat.log.add({ ...common, ...textFields(sent) })
      return
    }

    const file = call.file
    const caption = text(body, 'caption')
    // The gateway's own type wins. A WebP file counts as a sticker only when no type was sent.
    const sentType = text(body, 'mediaType', 'type')
    const sticker = sentType === 'sticker' || (sentType === '' && file?.contentType === 'image/webp')
    const name = file?.name ?? 'file'
    const url = `/file/${call.seq}`
    if (sticker) chat.log.add({ ...common, html: '', text: '', sticker: { url, name } })
    else {
      const photo = file !== undefined && /^image\/(png|jpeg|gif|webp)$/.test(file.contentType)
      chat.log.add({
        ...common,
        ...textFields(caption),
        attachment: { name, kind: photo ? 'photo' : 'file', ...(photo ? { url } : {}) }
      })
    }
  }

  let cursor = 0
  let inflight: Promise<void> | undefined
  async function pull(): Promise<void> {
    const response = await bridgeFetch(`/control/calls?after=${cursor}`)
    if (!response.ok) throw new SimInputError(`the fake bridge answered ${response.status} to /control/calls`, 502)
    const { calls, last } = (await response.json()) as { calls: RecordedCall[]; last: number }
    // The bridge was reset: its numbers start again, and what it recorded before is gone.
    if (last < cursor) {
      cursor = 0
      return pull()
    }
    for (const call of calls) {
      apply(call)
      cursor = Math.max(cursor, call.seq)
    }
    cursor = Math.max(cursor, last)
  }
  const sync = (): Promise<void> => {
    inflight ??= pull().finally(() => {
      inflight = undefined
    })
    return inflight
  }

  return {
    level: 2,
    bridgeUrl: base,

    info() {
      return {
        level: 2,
        chats: chats.map(({ id, title, kind, members }) => ({ id, title, kind, members })),
        canReset: false,
        hasRecords: false
      }
    },

    sync,

    async messages(chatId: string, after: number): Promise<MessagesResult> {
      const chat = liveChat(chatId)
      await sync()
      return { messages: chat.log.since(after), typing: Date.now() - chat.typingAt < TYPING_MS, rev: chat.log.rev }
    },

    async send(chatId: string, input: SendInput): Promise<SendResult> {
      const chat = liveChat(chatId)
      const message = input.text.trim()
      const sender = input.sender.trim()
      if (message === '') throw new SimInputError('the message is empty')
      if (message.length > MAX_TEXT) throw new SimInputError(`the message is over ${MAX_TEXT} characters`)
      if (sender === '' || sender.length > MAX_NAME) throw new SimInputError('the sender name is empty or too long')
      const quoted = input.replyTo ? chat.log.find(input.replyTo) : undefined
      if (input.replyTo && !quoted) throw new SimInputError('the message to reply to is not in this chat')

      const response = await bridgeFetch('/control/inject', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat: chat.id,
          sender: `sim-member-${slug(sender)}`,
          senderName: sender,
          text: message,
          isGroup: chat.kind === 'group',
          ...(chat.kind === 'group' && input.mention ? { mentionsBot: true } : {}),
          // The gateway passes up to 500 characters of a quote; the shortened text is for display only.
          ...(quoted
            ? {
                quoted: {
                  id: quoted.id,
                  text: (quoted.text || quoteText(quoted)).slice(0, 500),
                  fromMe: quoted.kind === 'aira'
                }
              }
            : {})
        })
      })
      if (!response.ok) throw new SimInputError(`the fake bridge answered ${response.status} to /control/inject`, 502)
      const { id } = (await response.json()) as { id: string }

      chat.lastInboundAt = Date.now()
      const sent = chat.log.add({
        id,
        kind: 'member',
        sender,
        ...textFields(message),
        ...(chat.kind === 'group' && input.mention ? { mention: true } : {}),
        ...(quoted
          ? {
              quote: {
                id: quoted.id,
                sender: quoted.kind === 'aira' ? 'AIRA' : (quoted.sender ?? ''),
                text: quoteText(quoted)
              }
            }
          : {})
      })
      // The gateway decides whether a group message is for AIRA. The preview cannot know.
      return { message: sent, addressed: true, done: Promise.resolve() }
    },

    async file(seq: number) {
      const response = await bridgeFetch(`/control/file/${seq}`)
      if (!response.ok) return undefined
      return {
        type: response.headers.get('content-type') ?? 'application/octet-stream',
        body: Buffer.from(await response.arrayBuffer())
      }
    },

    async close(): Promise<void> {
      await bridge?.stop()
      if (filesDir) rmSync(filesDir, { recursive: true, force: true })
    }
  }
}
