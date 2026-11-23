export const previewMount = '/app/preview'
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
