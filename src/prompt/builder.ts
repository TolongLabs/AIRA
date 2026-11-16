import { readFileSync } from 'node:fs'
import type { Pack } from '../character/loader.js'
import { forReplay } from '../format/footer.js'
import type { ModelMessage, PromptBlock } from '../models/types.js'
import { displayNames } from '../settings/chats.js'
import type { Storage } from '../storage/database.js'
import type { PromptBuilder, TurnContext, TurnInput } from '../turn/types.js'
import { getChatState, setChatState } from './chat-state.js'
import { type MoodJudge, detectMood } from './mood.js'
import { withQuote } from './quote.js'
import { newSeed } from './random.js'
import { detectLengthBypass, drawShape, shapeText } from './shape.js'

/** What the model sees for a message with no text: a file sent with no caption. */
const NO_TEXT = '(no text, only a file)'

/** A conservative token estimate for the size ceiling: one token per three characters, rounded up. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3)
}

export interface PromptBuilderOptions {
  storage: Storage
  config: {
    prompt: { maxSystemTokens: number }
    judge: { mood: 'on' | 'off'; moodMinProbability: number; timeoutMs: number }
    /** The deployment time zone. Absent: UTC. */
    format?: { timeZone: string }
  }
  /** The text of prompts/harness.md. */
  harnessRules: string
  judge?: MoodJudge
  /** Recalled memory for this turn, already limited to this chat. Memory supplies it later. */
  recall?: (input: TurnInput) => string[]
  /** Text about the tools offered, generated from the registry. Tools supplies it later. */
  toolRules?: (context: TurnContext) => string
  newSeed?: () => number
  now?: () => Date
}

export function loadHarnessRules(path = 'prompts/harness.md'): string {
  return readFileSync(path, 'utf8').trim()
}

export function buildSystemBlocks(input: {
  pack: Pack
  harnessRules: string
  toolRules?: string
  context: string
  tone: string
  shape: string
}): PromptBlock[] {
  const harness = input.toolRules ? `${input.harnessRules}\n\n${input.toolRules}` : input.harnessRules
  return [
    { name: 'core', text: input.pack.card.coreIdentity },
    { name: 'speech', text: input.pack.card.speechRules.map((rule) => `- ${rule}`).join('\n') },
    { name: 'harness', text: harness },
    { name: 'context', text: input.context },
    { name: 'tone', text: `Tone for this message: ${input.tone}` },
    { name: 'shape', text: input.shape }
  ]
}

/** The local time for the model, with its zone and offset, so times it writes and reads are local. */
export function localTimeLine(nowDate: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'long',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'longOffset'
    })
      .formatToParts(nowDate)
      .map((part) => [part.type, part.value])
  )
  const offset = parts['timeZoneName'] === 'GMT' ? '+00:00' : String(parts['timeZoneName']).replace('GMT', '')
  return `Time: ${parts['weekday']} ${parts['year']}-${parts['month']}-${parts['day']} ${parts['hour']}:${parts['minute']}, ${timeZone} (UTC${offset}). Write and read times in this zone; a tool time takes this offset.`
}

function formatContextBlock(input: TurnInput, nowDate: Date, recalled: string[], timeZone: string): string {
  const lines = [`Chat type: ${input.context.chat.type}`, localTimeLine(nowDate, timeZone)]
  const language = input.context.settings['language']?.value
  if (typeof language === 'string' && language !== 'auto') {
    lines.push(`Language: ${language}`)
  }
  if (recalled.length > 0) {
    // A recalled note is data. It must not be able to close its own block and pose as instructions.
    const safe = recalled.map((item) => item.replace(/<\/?memory[^>]*>/gi, '').replace(/\s*\n\s*/g, ' '))
    lines.push('<memory untrusted="true">', ...safe.map((item) => `- ${item}`), '</memory>')
  }
  if (input.media) lines.push(input.media)
  return lines.join('\n')
}

function formatMessages(input: TurnInput, names: Map<string, string> = new Map()): ModelMessage[] {
  const isGroup = input.context.chat.type === 'group'
  const memberNumbers = new Map<string, number>()
  const messages: ModelMessage[] = []

  for (const message of input.window) {
    if (message.role === 'assistant') {
      messages.push({ role: 'assistant', content: forReplay(message.content) })
      continue
    }
    // A file sent with no caption has no text, and a model API refuses an empty message.
    let content = withQuote(message.content.trim() === '' ? { ...message, content: NO_TEXT } : message)
    if (isGroup) {
      const senderKey = message.senderId ?? ''
      let memberNumber = memberNumbers.get(senderKey)
      if (memberNumber === undefined) {
        memberNumber = memberNumbers.size + 1
        memberNumbers.set(senderKey, memberNumber)
      }
      // A member the gateway named is called by name; anyone else keeps a stable number.
      const name = names.get(senderKey)
      content = `[${name ? name.replace(/[[\]\n]/g, '') : `member ${memberNumber}`}] ${content}`
    }
    const last = messages[messages.length - 1]
    if (last?.role === 'user') last.content += `\n\n${content}`
    else messages.push({ role: 'user', content })
  }

  return messages
}

export function createPromptBuilder(options: PromptBuilderOptions): PromptBuilder {
  const generateSeed = options.newSeed ?? newSeed
  const clock = options.now ?? (() => new Date())

  return {
    async build(input) {
      const pack = input.context.character
      const userTexts = input.window.filter((m) => m.role === 'user').map((m) => m.content)

      const judge = options.config.judge.mood === 'on' ? options.judge : undefined
      const moodResult = await detectMood(pack, userTexts, {
        judge,
        minProbability: options.config.judge.moodMinProbability,
        timeoutMs: options.config.judge.timeoutMs
      })

      const lastPending = input.pending[input.pending.length - 1]
      const bypassReason = detectLengthBypass({ userText: lastPending?.content ?? '' })

      const seed = generateSeed()
      const rawLastOpener = getChatState(options.storage, {
        chatId: input.context.chat.chatId,
        characterId: pack.id,
        key: 'lastOpener'
      })
      const lastOpener = typeof rawLastOpener === 'string' ? rawLastOpener : undefined
      const rawLastEnding = getChatState(options.storage, {
        chatId: input.context.chat.chatId,
        characterId: pack.id,
        key: 'lastEnding'
      })
      const lastEnding = typeof rawLastEnding === 'string' ? rawLastEnding : undefined

      const rawReplyLength = input.context.settings['replyLength']?.value
      const replyLength = rawReplyLength === 'short' || rawReplyLength === 'long' ? rawReplyLength : 'default'

      const shape = drawShape({
        pack,
        mood: moodResult.mood,
        replyLength,
        lastOpener,
        lastEnding,
        bypassReason,
        seed
      })

      for (const [key, value] of [
        ['lastOpener', shape.opener],
        ['lastEnding', shape.ending]
      ] as const) {
        if (value === undefined) continue
        options.storage.tx((db) => {
          setChatState(db, { chatId: input.context.chat.chatId, characterId: pack.id, key }, value, clock)
        })
      }

      const moodObj = pack.moods.get(moodResult.mood) ?? pack.moods.get(pack.defaultMood)
      const tone = moodObj?.tone ?? ''
      const recalled = options.recall ? options.recall(input) : []
      const contextText = formatContextBlock(input, clock(), recalled, options.config.format?.timeZone ?? 'UTC')
      const toolRules = options.toolRules ? options.toolRules(input.context) : undefined

      const system = buildSystemBlocks({
        pack,
        harnessRules: options.harnessRules,
        toolRules,
        context: contextText,
        tone,
        shape: shapeText(shape)
      })

      const systemTokens = estimateTokens(system.map((block) => block.text).join('\n\n'))
      if (systemTokens > options.config.prompt.maxSystemTokens) {
        throw new Error(
          `prompt for pack ${pack.id} exceeds maxSystemTokens (${systemTokens} > ${options.config.prompt.maxSystemTokens})`
        )
      }

      return {
        system,
        messages: formatMessages(
          input,
          input.context.chat.type === 'group'
            ? displayNames(options.storage, [...new Set(input.window.flatMap((m) => (m.senderId ? [m.senderId] : [])))])
            : new Map()
        ),
        record: {
          mood: moodResult.mood,
          moodSource: moodResult.source,
          shapeSeed: seed,
          lengthBypass: bypassReason,
          systemTokens
        },
        shape
      }
    }
  }
}
