export const previewMount =
  typeof location !== 'undefined' && location.pathname.startsWith('/app/preview/') ? '/app/preview' : ''
export const destinations = [
  ['overview', 'Overview'],
  ['chats', 'Chats'],
  ['characters', 'Character Studio'],
  ['library', 'Library'],
  ['automations', 'Automations'],
  ['markets', 'Markets'],
  ['system', 'System']
] as const

export function dashboardHref(path: string) {
  return previewMount + '/' + path
}

export function chatHref(path: string) {
  const query = new URLSearchParams()
  const current = new URLSearchParams(location.search)
  for (const key of ['search', 'status', 'order', 'page']) {
    const value = current.get(key)
    if (value) query.set(key, value)
  }
  return dashboardHref(path) + (query.size ? '?' + query : '')
}
