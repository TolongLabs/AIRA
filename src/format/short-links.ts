import type { Config } from '../config/schema.js'
import { BUBBLE_BREAK } from '../gateway/response.js'
import { isForbiddenUrl } from '../tools/ports.js'
import type { CleanedReply } from '../turn/types.js'
import { GATEWAY_CHUNK_LIMIT } from './bubbles.js'
import { domainOf, SOURCES_MARK } from './footer.js'

const CODE = /^[a-zA-Z0-9]{6}$/

export function createFooterLinks(config: Config['links'], secret?: string, fetcher: typeof fetch = fetch) {
  if (!config.baseUrl || !secret) return undefined
  const base = new URL(config.baseUrl).origin

  return async (reply: CleanedReply, timeLeftMs: number): Promise<string> => {
    const footer = reply.footerSources
    const timeoutMs = Math.min(config.timeoutMs, timeLeftMs)
    if (!footer || timeoutMs <= 0) return reply.content

    const abort = new AbortController()
    const codes = new Map<string, string>()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          abort.abort()
          resolve()
        }, timeoutMs)
      })
      const requests = footer.urls.map(async (url) => {
        if (isForbiddenUrl(url)) return
        try {
          const response = await fetcher(`${base}/api/links`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ url }),
            signal: abort.signal,
            redirect: 'error'
          })
          if (!response.ok) return
          const body = (await response.json()) as { code?: unknown } | null
          if (!abort.signal.aborted && typeof body?.code === 'string' && CODE.test(body.code)) {
            codes.set(url, body.code)
          }
        } catch {
          // Keep the domain when the Worker cannot provide a code within the deadline.
        }
      })
      await Promise.race([Promise.all(requests), deadline])
    } finally {
      clearTimeout(timer)
    }

    const sourceAt = reply.content.lastIndexOf(`\n${footer.line}`)
    if (sourceAt < 0) return reply.content
    const at = sourceAt + 1
    const bubbleBreak = `\n${BUBBLE_BREAK}\n`
    const lastBreak = reply.content.lastIndexOf(bubbleBreak, at)
    const start = lastBreak < 0 ? 0 : lastBreak + bubbleBreak.length
    const lines = footer.urls.map((url) => {
      const code = codes.get(url)
      return `${SOURCES_MARK} ${domainOf(url)}${code ? ` ${base}/${code}` : ''}`
    })
    const sourceLines = lines.join('\n')
    if (at - start + sourceLines.length >= GATEWAY_CHUNK_LIMIT) return reply.content
    return reply.content.slice(0, at) + sourceLines + reply.content.slice(at + footer.line.length)
  }
}
