// A quoted message enters the model input as labelled, untrusted data (docs/trd/system.md#gateway-contract).

/** The quote as a block placed before the message that quotes it. It must not be able to close its own block. */
export function quoteBlock(quote: { text: string; ofAira: boolean }): string {
  const text = quote.text.replace(/<\/?quoted[^>]*>/gi, '').trim()
  return `<quoted from="${quote.ofAira ? 'aira' : 'member'}" untrusted="true">${text}</quoted>`
}

/** A user message's text as the model sees it: its quote first, when it has one. */
export function withQuote(message: { content: string; quote?: { text: string; ofAira: boolean } }): string {
  return message.quote ? `${quoteBlock(message.quote)}\n${message.content}` : message.content
}
