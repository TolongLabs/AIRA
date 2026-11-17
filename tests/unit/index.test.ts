import { afterEach, describe, expect, it, vi } from 'vitest'
import type { App } from '../../src/app.js'
import type { Storage } from '../../src/storage/database.js'
import { tmpStorage } from '../support/tmp.js'

const mocks = vi.hoisted(() => ({
  app: undefined as App | undefined
}))

vi.mock('../../src/config/loader.js', () => ({
  loadConfig: () => ({ site: { port: 0 } }),
  requireDeployable: () => {}
}))

vi.mock('../../src/app.js', () => ({
  createApp: async () => mocks.app as App
}))

import { main } from '../../src/index.js'

function makeStubApp(storage: Storage, overrides: Partial<App> = {}): App {
  return {
    storage,
    listen: async () => ({ address: '127.0.0.1', family: 'IPv4', port: 9881 }),
    listenSite: async () => undefined,
    snapshot: async () => ({ id: 1, state: 'verified', file: 'snap.db' }),
    close: async () => {},
    ...overrides
  } as unknown as App
}

describe('process entry point', () => {
  const signalNames = ['SIGUSR2', 'SIGTERM', 'SIGINT'] as const
  let initialSignals: Map<NodeJS.Signals, NodeJS.SignalsListener[]>
  let initialRejections: NodeJS.UnhandledRejectionListener[] = []
  let initialExceptions: NodeJS.UncaughtExceptionListener[] = []
  const storages: Storage[] = []

  function snapshotListeners() {
    initialSignals = new Map(signalNames.map((event) => [event, [...process.listeners(event)]]))
    initialRejections = [...process.listeners('unhandledRejection')]
    initialExceptions = [...process.listeners('uncaughtException')]
  }

  function restoreListeners() {
    if (initialSignals) {
      for (const event of signalNames) {
        const keep = new Set(initialSignals.get(event) ?? [])
        for (const listener of process.listeners(event)) {
          if (!keep.has(listener)) process.off(event, listener)
        }
      }
    }
    const keepRejections = new Set(initialRejections)
    for (const listener of process.listeners('unhandledRejection')) {
      if (!keepRejections.has(listener)) process.off('unhandledRejection', listener)
    }
    const keepExceptions = new Set(initialExceptions)
    for (const listener of process.listeners('uncaughtException')) {
      if (!keepExceptions.has(listener)) process.off('uncaughtException', listener)
    }
  }

  function testStorage(): Storage {
    const storage = tmpStorage()
    storages.push(storage)
    return storage
  }

  afterEach(() => {
    restoreListeners()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    for (const storage of storages.splice(0)) storage.close()
    mocks.app = undefined
  })

  it('logs one error line and keeps the process alive when app.snapshot rejects on SIGUSR2', async () => {
    snapshotListeners()
    const storage = testStorage()
    mocks.app = makeStubApp(storage, {
      snapshot: vi.fn().mockRejectedValueOnce(new Error('snapshot write failed'))
    })

    const lines: Record<string, unknown>[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      for (const line of String(chunk).trim().split('\n')) {
        if (line.startsWith('{')) lines.push(JSON.parse(line) as Record<string, unknown>)
      }
      return true
    }) as typeof process.stdout.write)
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

    await main()
    process.emit('SIGUSR2', 'SIGUSR2')
    await new Promise((resolve) => setTimeout(resolve, 20))

    const errorLines = lines.filter((line) => line['level'] === 'error')
    expect(errorLines).toHaveLength(1)
    expect(errorLines[0]).toMatchObject({ event: 'storage.snapshot_failed', reason: 'deploy' })
    expect(exitSpy).not.toHaveBeenCalled()
    expect(process.exitCode).not.toBe(1)
  })

  it('logs an error with redaction and writes an internal failure row on unhandledRejection and uncaughtException', async () => {
    snapshotListeners()
    const secret = 'unhandled-process-secret-999'
    vi.stubEnv('AIRA_TEST_PROCESS_SECRET', secret)
    const storage = testStorage()
    mocks.app = makeStubApp(storage)

    const lines: Record<string, unknown>[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      for (const line of String(chunk).trim().split('\n')) {
        if (line.startsWith('{')) lines.push(JSON.parse(line) as Record<string, unknown>)
      }
      return true
    }) as typeof process.stdout.write)
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

    await main()
    const rejectionHandler = process.listeners('unhandledRejection').at(-1)
    const exceptionHandler = process.listeners('uncaughtException').at(-1)
    expect(rejectionHandler).toBeTypeOf('function')
    expect(exceptionHandler).toBeTypeOf('function')

    const invokeRejection = rejectionHandler as (reason: unknown, promise: Promise<unknown>) => void
    const invokeException = exceptionHandler as (error: Error, origin: string) => void
    invokeRejection(new Error(`rejection with ${secret}`), Promise.resolve())
    invokeException(new Error(`exception with ${secret}`), 'uncaughtException')

    const errorLines = lines.filter((line) => line['level'] === 'error')
    expect(errorLines).toEqual([
      expect.objectContaining({ event: 'process.unhandled_rejection' }),
      expect.objectContaining({ event: 'process.uncaught_exception' })
    ])
    expect(JSON.stringify(errorLines)).not.toContain(secret)
    expect(JSON.stringify(errorLines)).toContain('[secret]')

    const failures = storage.read((db) =>
      db.prepare('SELECT stage, kind, message, handled_by FROM failure ORDER BY id').all()
    ) as Record<string, unknown>[]
    expect(failures).toEqual([
      {
        stage: 'unhandled_rejection',
        kind: 'internal',
        message: 'rejection with [secret]',
        handled_by: 'process'
      },
      {
        stage: 'uncaught_exception',
        kind: 'internal',
        message: 'exception with [secret]',
        handled_by: 'process'
      }
    ])
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('logs an error if app.close rejects on SIGTERM', async () => {
    snapshotListeners()
    const storage = testStorage()
    mocks.app = makeStubApp(storage, {
      close: vi.fn().mockRejectedValueOnce(new Error('tool server stuck'))
    })

    const lines: Record<string, unknown>[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      for (const line of String(chunk).trim().split('\n')) {
        if (line.startsWith('{')) lines.push(JSON.parse(line) as Record<string, unknown>)
      }
      return true
    }) as typeof process.stdout.write)
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

    await main()
    process.emit('SIGTERM', 'SIGTERM')
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(lines.filter((line) => line['level'] === 'error')).toEqual([
      expect.objectContaining({ event: 'core.stop_failed' })
    ])
    expect(exitSpy).toHaveBeenCalledWith(1)
  })
})
