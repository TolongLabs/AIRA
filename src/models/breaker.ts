export interface Breaker {
  /** True while the role's breaker is open. */
  isOpen(role: string): boolean
  open(role: string): void
  /** Roles whose breaker is open, for the health report. */
  openRoles(): string[]
}

export function createBreaker(options: {
  breakerMs: number
  now?: () => Date
  onOpen?: (role: string) => void
}): Breaker {
  const now = options.now ?? (() => new Date())
  const openUntil = new Map<string, number>()

  const isOpen = (role: string): boolean => {
    const until = openUntil.get(role)
    if (until === undefined) return false
    if (now().getTime() < until) return true
    openUntil.delete(role)
    return false
  }

  return {
    isOpen,
    open(role) {
      const wasOpen = isOpen(role)
      openUntil.set(role, now().getTime() + options.breakerMs)
      if (!wasOpen) {
        options.onOpen?.(role)
      }
    },
    openRoles() {
      const open: string[] = []
      for (const role of [...openUntil.keys()]) {
        if (isOpen(role)) open.push(role)
      }
      return open
    }
  }
}
