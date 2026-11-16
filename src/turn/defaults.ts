import type { ModelMessage } from '../models/types.js'
import { withQuote } from '../prompt/quote.js'
import type { BuiltPrompt, PromptBuilder, ReplyCleaner, TurnInput } from './types.js'

// The plainest implementation of two pipeline seams. Prompt Engine and Format replace them; tests and the
// restart suite use them as they are.

/** The window as model messages. Consecutive user messages become one, so roles alternate. */
export function windowToMessages(input: TurnInput): ModelMessage[] {
  const messages: ModelMessage[] = []
  for (const message of input.window) {
    const last = messages[messages.length - 1]
    const content = message.role === 'user' ? withQuote(message) : message.content
    if (message.role === 'user' && last?.role === 'user') last.content += `\n\n${content}`
    else messages.push({ role: message.role, content })
  }
  return messages
}

/** Blocks 1 and 2 only: the card's identity and speech rules. */
export const basicPromptBuilder: PromptBuilder = {
  build(input): BuiltPrompt {
    const { card } = input.context.character
    return {
      system: [
        { name: 'core', text: card.coreIdentity },
        { name: 'speech', text: card.speechRules.map((rule) => `- ${rule}`).join('\n') }
      ],
      messages: windowToMessages(input),
      record: {}
    }
  }
}

/** Trims the reply and returns it as one bubble. */
export const plainCleaner: ReplyCleaner = {
  clean: ({ text }) => ({ content: text.trim(), bubbleCount: 1, steps: [] })
}
