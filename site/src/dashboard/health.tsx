import { ServiceRow } from '@/components/service-row'
import { useApi, Toaster } from '@/lib/hooks'
import type { Dashboard } from '@/lib/api'

export default function Health() {
  const { data, error, loading, reload } = useApi<Dashboard>('/api/dashboard')
  return (
    <section>
      <Toaster />
      <h2>Service Health</h2>
      {error ? (
        <p role="alert">Service status unavailable.</p>
      ) : loading ? (
        <p role="status">Loading…</p>
      ) : (
        <div>
          {Object.entries(data?.services ?? {}).map(([unit, state]) => (
            <ServiceRow key={unit} unit={unit} state={state} onDone={() => void reload()} />
          ))}
        </div>
      )}
    </section>
  )
}
