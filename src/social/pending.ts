// Share only pending work. A caller leaving cannot cancel another caller's operation.
export class PendingRequests<T> {
  private readonly entries = new Map<string, { controller: AbortController; work: Promise<T>; callers: number }>()

  run(key: string, signal: AbortSignal | undefined, start: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason)
    let entry = this.entries.get(key)
    if (!entry) {
      const controller = new AbortController()
      const work = Promise.resolve().then(() => {
        controller.signal.throwIfAborted()
        return start(controller.signal)
      })
      entry = { controller, work, callers: 0 }
      this.entries.set(key, entry)
    }
    const current = entry
    current.callers++
    return new Promise<T>((resolve, reject) => {
      let active = true
      const leave = () => {
        if (!active) return
        active = false
        signal?.removeEventListener('abort', cancel)
        if (--current.callers === 0 && this.entries.get(key) === current) this.entries.delete(key)
      }
      const cancel = () => {
        leave()
        if (current.callers === 0) current.controller.abort()
        reject(signal?.reason)
      }
      signal?.addEventListener('abort', cancel, { once: true })
      current.work.then(
        (value) => {
          leave()
          resolve(value)
        },
        (error: unknown) => {
          leave()
          reject(error)
        }
      )
    })
  }
}
