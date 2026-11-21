// AIRA short links: GET /<code> redirects; POST /api/links (bearer secret) stores a URL and returns its code.
export interface Env {
  LINKS: KVNamespace
  LINKS_SECRET: string
}

const ALPHABET = '23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ'
const CODE = /^[2-9a-hjkmnp-zA-HJ-NP-Z]{6}$/
const TTL_SECONDS = 60 * 60 * 24 * 365

function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6))
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('')
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function validUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 2048) return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    if (url.username || url.password) return null
    return url.toString()
  } catch {
    return null
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/api/links') {
      if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })
      const auth = request.headers.get('authorization') ?? ''
      if (!env.LINKS_SECRET || !safeEqual(auth, `Bearer ${env.LINKS_SECRET}`)) {
        return new Response('unauthorized', { status: 401 })
      }
      const body = (await request.json().catch(() => null)) as { url?: unknown } | null
      const target = validUrl(body?.url)
      if (!target) return Response.json({ error: 'invalid url' }, { status: 400 })

      const hashKey = `u:${await sha256(target)}`
      let code = await env.LINKS.get(hashKey)
      if (!code) {
        for (let attempt = 0; attempt < 5 && !code; attempt++) {
          const candidate = newCode()
          if (!(await env.LINKS.get(`c:${candidate}`))) code = candidate
        }
        if (!code) return Response.json({ error: 'no code' }, { status: 503 })
        await env.LINKS.put(`c:${code}`, target, { expirationTtl: TTL_SECONDS })
        await env.LINKS.put(hashKey, code, { expirationTtl: TTL_SECONDS })
      }
      return Response.json({ code, short: `${url.origin}/${code}` })
    }

    const code = url.pathname.slice(1)
    if (request.method === 'GET' && CODE.test(code)) {
      const target = await env.LINKS.get(`c:${code}`)
      if (target) return Response.redirect(target, 302)
    }
    return new Response('not found', { status: 404 })
  }
}
