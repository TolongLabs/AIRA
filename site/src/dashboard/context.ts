import { createContext } from 'react'
export const DashboardContext = createContext(false)

/** Rendering mode from the public document hint. Authorization and runtime
 *  capabilities still come from protected core routes (docs/trd/site.md#standalone-first-run). */
export type Installation = 'legacy' | 'standalone'
export const InstallationContext = createContext<Installation>('legacy')
