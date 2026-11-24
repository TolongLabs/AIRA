/** Owner-visible readback of the configuration applied at startup. */
export interface DeploymentModel {
  model: string
  connection: string
  endpoint: string
  effort: string
  deepEffort: string
  credential: string
  configured: boolean
}
export interface DeploymentSettings {
  activation: 'current' | 'pending_restart' | 'invalid' | 'inaccessible' | 'memory_only'
  appliedAt: string
  models: { main: DeploymentModel; fallback: DeploymentModel }
  groups: Record<string, Record<string, string | number | boolean>>
  credentials: { name: string; purpose: string; present: boolean }[]
}

export interface ConfigField {
  kind: 'string' | 'number' | 'boolean' | 'list'
  display: string
  value?: string | number | boolean
}
export interface HostSettingsSnapshot {
  revision: string
  state: 'current' | 'pending' | 'applying' | 'restored' | 'failed'
  fields: Record<string, Record<string, ConfigField>>
  credentials: { name: string; purpose: string; present: boolean }[]
  router: { available: boolean; status: string; legacy?: { available: boolean; status: string } }
}
