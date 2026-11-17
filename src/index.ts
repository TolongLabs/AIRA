import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { type App, createApp } from './app.js'
import { loadConfig, requireDeployable } from './config/loader.js'
import { createLogger } from './records/logger.js'
import { createRedactor } from './records/redact.js'
import { recordFailure } from './records/turn-record.js'

// The entry point of the container (deploy/Dockerfile). Any failure before "ready" exits non-zero with one clear
// message, so the updater returns to the previous image.

export const VERSION = '0.0.0'
const PORT = 9881

export async function main(): Promise<void> {
  const redactor = createRedactor({
    secrets: Object.values(process.env).filter((value): value is string => typeof value === 'string')
  })
  const boot = createLogger({ level: 'info', module: 'boot', redactor })
  let app: App | undefined
  const recordProcessFailure = (stage: string, error: unknown): void => {
    if (!app) return
    try {
      app.storage.tx((db) => recordFailure(db, { stage, kind: 'internal', error, handledBy: 'process' }, redactor))
    } catch (recordError) {
      boot.error('process.failure_not_recorded', { error: recordError })
    }
  }
  const onUnhandledRejection = (reason: unknown): void => {
    boot.error('process.unhandled_rejection', { error: reason })
    recordProcessFailure('unhandled_rejection', reason)
  }
  const onUncaughtException = (error: unknown): void => {
    boot.error('process.uncaught_exception', { error })
    recordProcessFailure('uncaught_exception', error)
  }
  process.on('unhandledRejection', onUnhandledRejection)
  process.on('uncaughtException', onUncaughtException)

  try {
    const config = loadConfig(process.env['AIRA_CONFIG'] ?? 'config.yml')
    requireDeployable(config)
    const siteDir = resolve('site/dist')
    app = await createApp({
      config,
      env: process.env,
      version: VERSION,
      ...(existsSync(siteDir) ? { siteDir } : {})
    })
    const activeApp = app
    const address = await activeApp.listen(PORT, '0.0.0.0')
    boot.info('core.ready', { version: VERSION, port: address.port })
    const siteAddress = await activeApp.listenSite(config.site.port, '0.0.0.0')
    if (siteAddress) boot.info('site_api.ready', { port: siteAddress.port })
    else boot.info('site_api.off')

    // A verified snapshot before a deploy: the updater sends this signal and waits for the snapshot.
    const onSnapshot = () => {
      void activeApp
        .snapshot('deploy')
        .then((result) => boot.info('storage.snapshot', { reason: 'deploy', state: result.state }))
        .catch((error: unknown) => {
          boot.error('storage.snapshot_failed', { reason: 'deploy', error })
        })
    }
    const stop = () => {
      boot.info('core.stopping')
      void activeApp
        .close()
        .then(() => {
          cleanup()
          process.exit(0)
        })
        .catch((error: unknown) => {
          boot.error('core.stop_failed', { error })
          cleanup()
          process.exit(1)
        })
    }
    const cleanup = () => {
      process.off('SIGUSR2', onSnapshot)
      process.off('SIGTERM', stop)
      process.off('SIGINT', stop)
      process.off('unhandledRejection', onUnhandledRejection)
      process.off('uncaughtException', onUncaughtException)
    }
    process.on('SIGUSR2', onSnapshot)
    process.on('SIGTERM', stop)
    process.on('SIGINT', stop)
  } catch (error) {
    process.off('unhandledRejection', onUnhandledRejection)
    process.off('uncaughtException', onUncaughtException)
    boot.error('core.start_failed', { error })
    process.exitCode = 1
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) void main()
