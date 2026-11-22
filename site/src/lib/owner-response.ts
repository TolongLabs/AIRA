/** Validate the top-level collections each owner page needs before enabling its actions. */
const fields = {
  '/api/settings': { bindings: 'object', markets: 'object', tts: 'object', models: 'object' },
  '/api/dashboard': { brain: 'object', services: 'object', recent: 'array' },
  '/api/cron': { jobs: 'array' },
  '/api/chats': { chats: 'array' },
  '/api/notices': { sessions: 'array', routes: 'array', targets: 'array' },
  '/api/graph': { nodes: 'array', edges: 'array' },
  '/api/library/index': { items: 'object', types: 'array' },
  '/api/send': { recipients: 'array', recent: 'array', files: 'array' },
  '/api/env': { brand: 'string', timezone: 'string' }
} as const

export function checkOwnerResponse(path: string, value: unknown, method: 'GET' | 'POST') {
  const route = path.split('?')[0] ?? path
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid response from ' + route)
  const row = value as Record<string, unknown>
  if (row.success === false || (typeof row.error === 'string' && row.error))
    throw new Error(typeof row.error === 'string' ? row.error : 'Owner service refused the operation')
  if (method !== 'GET' || !(route in fields)) return
  for (const [key, kind] of Object.entries(fields[route as keyof typeof fields])) {
    const item = row[key]
    if (item === null || (Array.isArray(item) ? 'array' : typeof item) !== kind)
      throw new Error('Invalid ' + key + ' in ' + route)
  }
}
