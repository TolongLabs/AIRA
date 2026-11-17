import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { type App, createApp, SECRET_NAMES } from '../../../src/app.js'
import type { Config } from '../../../src/config/schema.js'
import type { ModelClient } from '../../../src/models/types.js'
import { createLogger, type Logger } from '../../../src/records/logger.js'
import { createRedactor, secretsFromEnv } from '../../../src/records/redact.js'
import { formatTurn, readTurn, stageDurations } from '../../../src/records/turn-view.js'
import { ensureChat, setChatStatus } from '../../../src/settings/chats.js'
import { resolveSettings, setSetting } from '../../../src/settings/settings.js'
import { FakeGateway } from '../gateway.js'
import {
  DM_MEMBER,
  GROUP_MEMBERS,
  MAX_NAME,
  MAX_TEXT,
  type SendInput,
  type SendResult,
  type SimBackend,
  type SimChat,
  type SimInfo,
  SimInputError,
  slug,
  type TurnPanel
} from './backend.js'
import { ChatLog, type MessageDraft, quoteText, shapeReply, textFields } from './model.js'
import { findPhoto, findSticker, photoUrl, stickerUrl } from './stickers.js'

// Level 1 of the WhatsApp simulator (docs/trd/harness.md#whatsapp-simulator): the core runs in this process, and
// each message goes to it as the gateway would send it. The preview stands in for the gateway and the phone.

export interface Level1Options {
  config: Config
  env: NodeJS.ProcessEnv
  /** Model clients to use instead of the configured endpoints. Tests pass a scripted model here. */
  clients?: { main?: ModelClient; fallback?: ModelClient }
  /** The data folder. A scratch folder when absent; it is removed on close. */
  dataDir?: string
  /** The character both chats are bound to. Absent: the data folder's global binding, else `example`. */
  character?: string
  /** The repository root: its `characters/` folder holds the packs that ship with the release. */
  repositoryDir?: string
  /** Pause before each bubble after the first, as the gateway does. Tests switch it off. Default on. */
  pace?: boolean
  logger?: Logger
}

export interface Level1 extends SimBackend {
  readonly app: App
  readonly dataDir: string
  readonly character: string
}

interface LiveChat extends SimChat {
  log: ChatLog
  pending: number
  /** The core's own id for the chat. */
  coreId: string
}

interface DrawContext {
  ms: number
  /** The member's message, which the first bubble quotes. */
  quote?: { id: string; sender: string; text: string }
}

const RUN = Date.now().toString(36)

/** The gateway's typing pause before a bubble that is not the first (deploy/gateway/brain/bubbles.py). */
export function typingPauseMs(bubble: string): number {
  return Math.min(2000, 100 + 10 * bubble.length)
}

const sleep = (ms: number): Promise<void> => (ms > 0 ? new Promise((done) => setTimeout(done, ms)) : Promise.resolve())

export async function startLevel1(options: Level1Options): Promise<Level1> {
  const scratch = options.dataDir === undefined
  const dataDir = resolve(options.dataDir ?? mkdtempSync(join(tmpdir(), 'aira-sim-')))
  mkdirSync(dataDir, { recursive: true })
  const repositoryDir = resolve(options.repositoryDir ?? '.')
  const pace = options.pace ?? true
  const config: Config = {
    ...options.config,
    storage: { ...options.config.storage, path: dataDir },
    gateway: { ...options.config.gateway, hostDataDir: dataDir }
  }
  const redactor = createRedactor({ secrets: secretsFromEnv(SECRET_NAMES, options.env) })
  // Warnings and errors go to the terminal. The site API has no token here, and says so at every start: not news.
  const logger =
    options.logger ??
    createLogger({
      level: 'warn',
      module: 'core',
      redactor,
      sink: (line) => {
        if (!line.includes('"site_api.no_token"')) process.stderr.write(`${line}\n`)
      }
    })

  const cleanup = (): void => {
    if (scratch) rmSync(dataDir, { recursive: true, force: true })
  }

  let app: App
  try {
    app = await createApp({
      config,
      env: options.env,
      logger,
      repositoryCharactersDir: join(repositoryDir, 'characters'),
      ...(options.clients ? { clients: options.clients } : {})
    })
  } catch (error) {
    cleanup()
    throw error
  }

  try {
    const address = (await app.listen(0, '127.0.0.1')) as AddressInfo
    const gateway = new FakeGateway({ baseUrl: `http://127.0.0.1:${address.port}` })
    const roots = { dataDir, repositoryDir }
    const chats: LiveChat[] = []
    let counter = 0
    let character = ''

    const settingsOf = (chat: { chatId: string; type: 'dm' | 'group' }) => resolveSettings(app.storage, chat)

    /** Creates, activates and binds one chat. Returns its live state. */
    const openChat = (kind: 'dm' | 'group'): LiveChat => {
      counter += 1
      const waId = `sim-${kind}-${RUN}-${counter}`
      const core = ensureChat(app.storage, { waId, type: kind })
      setChatStatus(app.storage, { chatId: core.chatId, status: 'active', actor: 'sim' })
      let id = options.character
      if (id !== undefined) {
        setSetting(app.storage, { level: 'chat', scope: core.chatId, key: 'character', value: id, actor: 'sim' })
      } else {
        // The global binding only: a type-level value could bind the DM and the group to different characters.
        const global = app.storage.read(
          (db) =>
            db
              .prepare("SELECT value FROM setting WHERE level = 'global' AND scope = '' AND key = 'character'")
              .pluck()
              .get() as string | undefined
        )
        const bound = global === undefined ? undefined : (JSON.parse(global) as unknown)
        id = typeof bound === 'string' ? bound : 'example'
        if (typeof bound !== 'string') {
          setSetting(app.storage, { level: 'chat', scope: core.chatId, key: 'character', value: id, actor: 'sim' })
        }
      }
      const loaded = app.packs()
      if (!loaded.packs.has(id)) {
        const faults = loaded.faults.map((fault) => `  ${fault.message}`).join('\n')
        throw new Error(
          `character "${id}" is not loaded. Loaded: ${[...loaded.packs.keys()].join(', ') || '(none)'}.` +
            (faults ? `\n${faults}` : '')
        )
      }
      character = id
      return {
        id: waId,
        title: kind === 'dm' ? (loaded.packs.get(id)?.card.displayName ?? 'AIRA') : 'Weekend Crew',
        kind,
        members: kind === 'dm' ? [DM_MEMBER] : GROUP_MEMBERS,
        log: new ChatLog(`sim-${RUN}-${kind}-${counter}`),
        pending: 0,
        coreId: core.chatId
      }
    }

    chats.push(openChat('dm'), openChat('group'))

    const liveChat = (id: string): LiveChat => {
      const chat = chats.find((candidate) => candidate.id === id)
      if (!chat) throw new SimInputError('unknown chat', 404)
      return chat
    }

    const freeResponse = (chat: LiveChat): boolean =>
      settingsOf({ chatId: chat.coreId, type: chat.kind })['freeResponse']?.value === true

    const publicChat = (chat: LiveChat): SimChat => ({
      id: chat.id,
      title: chat.title,
      kind: chat.kind,
      members: chat.members,
      ...(chat.kind === 'group' ? { freeResponse: freeResponse(chat) } : {})
    })

    const turn = (turnId: string): TurnPanel | undefined => {
      const view = app.storage.read((db) => readTurn(db, turnId))
      if (!view) return undefined
      const t = view.turn
      return {
        id: turnId,
        text: formatTurn(view),
        summary: {
          kind: t['kind'],
          state: t['state'],
          outcome: t['outcome'],
          character: t['character_id'],
          mood: t['mood'],
          moodSource: t['mood_source'],
          transport: t['transport'],
          role: t['role'],
          model: t['model'],
          attempts: t['attempts'],
          inputTokens: t['input_tokens'],
          outputTokens: t['output_tokens'],
          cachedTokens: t['cached_tokens'],
          costUsd: t['cost_usd'],
          replyChars: t['reply_chars'],
          bubbleCount: t['bubble_count'],
          sticker: t['sticker_id']
        },
        stages: stageDurations(t),
        modelCalls: view.modelCalls.map((row) => ({
          role: row['role'],
          model: row['model'],
          attempt: row['attempt'],
          durationMs: row['duration_ms'],
          inputTokens: row['input_tokens'],
          outputTokens: row['output_tokens'],
          failure: row['failure_kind']
        })),
        toolCalls: view.toolCalls.map((row) => ({
          tool: row['tool'],
          source: row['source'],
          outcome: row['outcome'],
          durationMs: row['duration_ms']
        })),
        failures: view.failures.map((row) => ({
          stage: row['stage'],
          kind: row['kind'],
          handledBy: row['handled_by'],
          message: row['message']
        }))
      }
    }

    /** Draws what the gateway would send for one delivered reply. */
    async function draw(chat: LiveChat, delivery: Awaited<ReturnType<FakeGateway['send']>>, ctx: DrawContext) {
      const { log } = chat
      const panel = delivery.turnId ? turn(delivery.turnId) : undefined
      const faults = [...new Set((panel?.failures ?? []).map((failure) => String(failure['kind'])))]
      const turnInfo = { ...(delivery.turnId ? { id: delivery.turnId } : {}), ms: ctx.ms, faults }

      if (delivery.status === 'failed') {
        const reason = delivery.httpStatus === undefined ? 'no_response' : `http_${delivery.httpStatus}`
        log.add({
          kind: 'note',
          html: '',
          text: '',
          note: { tone: 'error', text: `No answer from the core: ${reason} after ${delivery.attempts} attempts` }
        })
        return
      }

      const shape = shapeReply(delivery.content)
      if (shape.kind === 'none') {
        const outcome = panel?.summary['outcome'] ?? panel?.summary['state']
        const why = typeof outcome === 'string' && outcome !== '' ? ` (${outcome})` : ''
        log.add({ kind: 'note', html: '', text: '', note: { tone: 'info', text: `No reply sent${why}` } })
      } else {
        let first = true
        const next = async (pause: number): Promise<void> => {
          if (!first && pace) await sleep(pause)
        }
        for (const bubble of shape.bubbles) {
          await next(typingPauseMs(bubble))
          const quote = first ? ctx.quote : undefined
          log.add({ kind: 'aira', ...textFields(bubble), turn: turnInfo, ...(quote ? { quote } : {}) })
          first = false
        }
        for (const media of shape.media) {
          await next(400)
          const draft: MessageDraft = { kind: 'aira', html: '', text: '', turn: turnInfo }
          if (media.kind === 'sticker') {
            const found = findSticker(roots, media.pack as string, media.file as string)
            if (found) draft.sticker = { url: stickerUrl(media.pack as string, media.file as string), name: media.name }
            else {
              log.add({
                kind: 'note',
                html: '',
                text: '',
                note: { tone: 'error', text: `sticker_missing: ${media.pack}/${media.file}` }
              })
              continue
            }
          } else {
            const shown = media.stored !== undefined && findPhoto(dataDir, media.stored) !== undefined
            draft.attachment = {
              name: media.name,
              kind: media.kind,
              ...(shown && media.stored ? { url: photoUrl(media.stored) } : {})
            }
          }
          if (first && ctx.quote) draft.quote = ctx.quote
          log.add(draft)
          first = false
        }
      }

      if (faults.length > 0 && panel) {
        const where = panel.failures.map((failure) => `${failure['kind']} at ${failure['stage']}`).join('; ')
        log.add({ kind: 'note', html: '', text: '', note: { tone: 'error', text: `Turn failure: ${where}` } })
      }
    }

    return {
      level: 1,
      app,
      dataDir,
      get character() {
        return character
      },
      stickerRoots: roots,

      info(): SimInfo {
        return { level: 1, character, chats: chats.map(publicChat), canReset: true, hasRecords: true }
      },

      async messages(chatId, after) {
        const chat = liveChat(chatId)
        return { messages: chat.log.since(after), typing: chat.pending > 0, rev: chat.log.rev }
      },

      async send(chatId: string, input: SendInput): Promise<SendResult> {
        const chat = liveChat(chatId)
        const text = input.text.trim()
        const sender = input.sender.trim()
        if (text === '') throw new SimInputError('the message is empty')
        if (text.length > MAX_TEXT) throw new SimInputError(`the message is over ${MAX_TEXT} characters`)
        if (sender === '' || sender.length > MAX_NAME) throw new SimInputError('the sender name is empty or too long')

        const quoted = input.replyTo ? chat.log.find(input.replyTo) : undefined
        if (input.replyTo && !quoted) throw new SimInputError('the message to reply to is not in this chat')
        const quoteOfAira = quoted?.kind === 'aira'
        const addressed = chat.kind === 'dm' || freeResponse(chat) || input.mention || quoteOfAira

        const message = chat.log.add({
          kind: 'member',
          sender,
          ...textFields(text),
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

        if (!addressed) {
          chat.log.add({
            kind: 'note',
            html: '',
            text: '',
            note: {
              tone: 'info',
              text: 'The gateway does not forward this message: it does not mention AIRA or reply to her, and the chat is not on free response.'
            }
          })
          return { message, addressed: false, done: Promise.resolve() }
        }

        const started = performance.now()
        chat.pending += 1
        const quote = quoted
          ? { text: quoted.text || quoteText(quoted), id: quoted.id, ofAira: quoteOfAira }
          : undefined
        const done = (async () => {
          try {
            const delivery = await gateway.send({
              chat: { waId: chat.id, kind: chat.kind },
              sender: `sim-member-${slug(sender)}`,
              mid: message.id,
              text,
              ...(quote ? { quote } : {})
            })
            await draw(chat, delivery, {
              ms: Math.round(performance.now() - started),
              quote: { id: message.id, sender, text: quoteText(message) }
            })
          } catch (error) {
            chat.log.add({
              kind: 'note',
              html: '',
              text: '',
              note: { tone: 'error', text: `sim_error: ${error instanceof Error ? error.message : String(error)}` }
            })
          } finally {
            chat.pending -= 1
          }
        })()
        return { message, addressed: true, done }
      },

      reset(chatId: string): SimChat {
        const old = liveChat(chatId)
        const fresh = openChat(old.kind)
        chats[chats.indexOf(old)] = fresh
        return publicChat(fresh)
      },

      setFreeResponse(chatId: string, value: boolean): void {
        const chat = liveChat(chatId)
        if (chat.kind !== 'group') throw new SimInputError('free response is a group setting')
        setSetting(app.storage, { level: 'chat', scope: chat.coreId, key: 'freeResponse', value, actor: 'sim' })
      },

      turn,

      async close(): Promise<void> {
        try {
          await app.close()
        } finally {
          cleanup()
        }
      }
    }
  } catch (error) {
    try {
      await app.close()
    } finally {
      cleanup()
    }
    throw error
  }
}
