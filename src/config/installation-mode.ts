import { ConfigError } from './loader.js'

// The install authority (docs/trd/deployment.md#installation-modes). Explicit in the private Compose
// environment as AIRA_INSTALL_MODE. Absent means the established host-managed install.
export type InstallationMode = 'legacy' | 'standalone'

export function installationModeFromEnv(env: NodeJS.ProcessEnv = process.env): InstallationMode {
  const raw = env['AIRA_INSTALL_MODE']
  if (raw === undefined) return 'legacy'
  if (raw === 'legacy' || raw === 'standalone') return raw
  throw new ConfigError('AIRA_INSTALL_MODE must be "legacy" or "standalone"')
}
