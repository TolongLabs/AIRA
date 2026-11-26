import { useEffect, useState } from 'react'
import { core } from '@/lib/core'

/** Read only authenticated owner health; old or unreachable cores keep the control hidden. */
export function useReportDocumentCapability(standalone: boolean): boolean {
  const [available, setAvailable] = useState(false)
  useEffect(() => {
    if (!standalone) return
    let live = true
    let generation = 0
    const refresh = () => {
      const current = ++generation
      void core.health().then(
        (health) => {
          if (live && current === generation)
            setAvailable(health.installationMode === 'standalone' && health.capabilities?.reportDocuments === true)
        },
        () => {
          if (live && current === generation) setAvailable(false)
        }
      )
    }
    refresh()
    window.addEventListener('focus', refresh)
    return () => {
      live = false
      window.removeEventListener('focus', refresh)
    }
  }, [standalone])
  return standalone && available
}
