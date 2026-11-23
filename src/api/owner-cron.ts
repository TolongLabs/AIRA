import { randomUUID } from 'node:crypto'
import { request } from 'node:http'
import { getChatByWaId } from '../settings/chats.js'
import type { Storage } from '../storage/database.js'

type Row = Record<string, unknown>
const object = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value)
const mark = /^\[AIRA-SCHEDULED v1 kind=job id=(site_[a-f0-9]{32})\]$/m
const reply = (status: number, error: string) => ({ status, body: { error } })

export function ownerCronTransport(origin: string, socketPath: string | undefined, token: string, path = '/api/cron') {
  return (body?: Row): Promise<{ status: number; body: Row }> =>
    new Promise((resolve, reject) => {
      const payload = body && JSON.stringify(body)
      const req = request(
        new URL(path, origin),
        {
          method: body ? 'POST' : 'GET',
          socketPath,
          signal: AbortSignal.timeout(15_000),
          headers: {
            'x-tolongai-token': token,
            ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {})
          }
        },
        (res) => {
          void (async () => {
            const chunks: Buffer[] = []
            let length = 0
            for await (const chunk of res) {
              length += chunk.length
              if (length > 4 * 1024 * 1024) throw new Error('Owner response exceeds size limit')
              chunks.push(Buffer.from(chunk))
            }
            if (res.statusCode === 401 || ((res.statusCode ?? 502) >= 400 && length === 0)) {
              resolve(
                reply(
                  res.statusCode ?? 502,
                  res.statusCode === 401 ? 'Owner token required' : 'Owner service refused request'
                )
              )
              return
            }
            const result: unknown = JSON.parse(Buffer.concat(chunks).toString())
            if (!object(result)) throw new Error('Invalid job response')
            resolve({ status: res.statusCode ?? 502, body: result })
          })().catch(reject)
        }
      )
      req.on('error', reject)
      req.end(payload)
    })
}

export async function changeOwnerJob(storage: Storage, input: unknown, call: ReturnType<typeof ownerCronTransport>) {
  if (!object(input)) return reply(400, 'invalid_job')
  // Read through the host service first: only the authenticated owner may register a binding.
  const listed = await call()
  if (listed.status !== 200) return listed
  if (!Array.isArray(listed.body.jobs)) return reply(502, 'invalid_owner_jobs')
  const prompt = typeof input.prompt === 'string' ? input.prompt : ''
  if (prompt.includes('[AIRA-SCHEDULED') || prompt.includes('[HERMES-SCOPE')) return reply(400, 'reserved_job_marker')
  if (input.action === 'create') {
    const dest = typeof input.deliver === 'string' && /^whatsapp:([^,:]+)$/.exec(input.deliver)?.[1]
    const chat = dest ? getChatByWaId(storage, dest) : undefined
    if (chat?.status !== 'active') return reply(400, 'Choose one active WhatsApp chat for this routine')
    if (!prompt.trim()) return reply(400, 'missing_prompt')
    const tag = 'site_' + randomUUID().replaceAll('-', '')
    storage.tx((db) => db.prepare('INSERT INTO site_job(tag,chat_id) VALUES (?,?)').run(tag, chat.chatId))
    const result = await call({ ...input, prompt: `[AIRA-SCHEDULED v1 kind=job id=${tag}]\n${prompt}` }).catch(
      (): { status: number; body: Row } => reply(502, 'Owner connection interrupted')
    )
    if (result.status === 200 && result.body.success === true && typeof result.body.job_id === 'string') return result
    if (result.status >= 400 && result.status < 500) {
      storage.tx((db) => db.prepare('DELETE FROM site_job WHERE tag=?').run(tag))
      return result
    }
    // A disconnected acknowledgement can follow a successful write. Re-read before removing its scope.
    const refreshed = await call().catch(() => undefined)
    if (refreshed?.status === 200 && Array.isArray(refreshed.body.jobs)) {
      const saved = refreshed.body.jobs.find(
        (row: unknown) => object(row) && mark.exec(String(row.prompt ?? row.prompt_preview ?? ''))?.[1] === tag
      )
      if (object(saved) && typeof saved.job_id === 'string')
        return { status: 200, body: { success: true, job_id: saved.job_id } }
      storage.tx((db) => db.prepare('DELETE FROM site_job WHERE tag=?').run(tag))
    }
    return reply(502, 'Could not confirm creation. Check scheduled jobs before retrying.')
  }
  const job = listed.body.jobs.find((j: unknown) => object(j) && j.job_id === input.job_id)
  if (!object(job)) return reply(404, 'unknown_job')
  const text = String(job.prompt ?? job.prompt_preview ?? '')
  const tag = mark.exec(text)?.[1]
  if (
    String(job.name).startsWith('aira:') ||
    String(job.job_id).startsWith('aira:') ||
    (!tag && text.includes('[AIRA-SCHEDULED'))
  )
    return reply(403, 'core_managed_job')
  if (tag && input.deliver !== undefined && input.deliver !== job.deliver)
    return reply(400, 'Create a separate routine for a different destination')
  const result = await call(
    tag && prompt ? { ...input, prompt: `[AIRA-SCHEDULED v1 kind=job id=${tag}]\n${prompt}` } : input
  )
  if (tag && input.action === 'remove' && result.status === 200 && result.body.success === true)
    storage.tx((db) => db.prepare('DELETE FROM site_job WHERE tag=?').run(tag))
  return result
}
