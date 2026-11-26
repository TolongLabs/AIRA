import { useEffect, useState } from 'react'
import { core, type StandaloneControls } from '@/lib/core'

const unavailable: StandaloneControls = { reportDocuments: false, inboundMedia: false }

/** Read only authenticated owner health; old or unreachable cores keep the control hidden. */
export function useStandaloneCapabilities(standalone: boolean): StandaloneControls {
  const [available, setAvailable] = useState(unavailable)
  useEffect(() => {
    if (!standalone) return
    let live = true
    let generation = 0
    const refresh = () => {
      const current = ++generation
      void core.health().then(
        (health) => {
          if (live && current === generation)
            setAvailable(
              health.installationMode === 'standalone'
                ? {
                    reportDocuments: health.capabilities?.reportDocuments === true,
                    inboundMedia: health.capabilities?.inboundMedia === true
                  }
                : unavailable
            )
        },
        () => {
          if (live && current === generation) setAvailable(unavailable)
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
  return standalone ? available : unavailable
}
