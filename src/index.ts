import { pathToFileURL } from 'node:url'
import { createApp } from './app.js'
import { loadConfig, requireDeployable } from './config/loader.js'
import { createLogger } from './records/logger.js'

// The entry point of the container (deploy/Dockerfile). Any failure before "ready" exits non-zero with one clear
// message, so the updater returns to the previous image.

export const VERSION = '0.0.0'
const PORT = 9881

export async function main(): Promise<void> {
  const boot = createLogger({ level: 'info', module: 'boot' })
  try {
    const config = loadConfig(process.env['AIRA_CONFIG'] ?? 'config.yml')
    requireDeployable(config)
    const app = await createApp({ config, env: process.env, version: VERSION })
    const address = await app.listen(PORT, '0.0.0.0')
    boot.info('core.ready', { version: VERSION, port: address.port })
    const siteAddress = await app.listenSite(config.site.port, '0.0.0.0')
    if (siteAddress) boot.info('site_api.ready', { port: siteAddress.port })
    else boot.info('site_api.off')

    // A verified snapshot before a deploy: the updater sends this signal and waits for the snapshot.
    process.on('SIGUSR2', () => {
      void app
        .snapshot('deploy')
        .then((result) => boot.info('storage.snapshot', { reason: 'deploy', state: result.state }))
    })
    const stop = () => {
      boot.info('core.stopping')
      void app.close().then(() => process.exit(0))
    }
    process.on('SIGTERM', stop)
    process.on('SIGINT', stop)
  } catch (error) {
    boot.error('core.start_failed', { error })
    process.exitCode = 1
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) void main()
