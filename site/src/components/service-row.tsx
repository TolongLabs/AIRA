import { useState } from 'react'
import { RotateCw, Square, Play } from 'lucide-react'
import { get, post, type Dashboard } from '@/lib/api'
import { toast } from '@/lib/hooks'
import { Button, ConfirmAction } from '@/components/ui'

export function ServiceRow({
  unit,
  state,
  onDone,
  controlsOnly = false
}: {
  unit: string
  state: string
  onDone: () => void
  controlsOnly?: boolean
}) {
  const on = state === 'active'
  const tone = on ? 'var(--up)' : state === 'failed' ? 'var(--down)' : 'var(--amber)'
  /* One flight at a time: without this the buttons stay live during the
     call and every click fires another. */
  const [busy, setBusy] = useState(false)

  async function act(action: 'start' | 'stop' | 'restart', rethrow: boolean) {
    if (busy) return
    setBusy(true)
    try {
      await post('/api/services', { unit, action })
      const expected = action === 'stop' ? 'inactive' : 'active'
      let actual: string | undefined
      for (const delay of [1000, 1000, 2000, 3000]) {
        await new Promise((resolve) => window.setTimeout(resolve, delay))
        try {
          actual = (await get<Dashboard>('/api/dashboard')).services?.[unit]
        } catch {
          actual = undefined
        }
        if (actual === expected) break
      }
      if (actual !== expected) throw new Error(`Could not confirm ${unit} is ${expected}`)
      toast(`${unit} ${action} ✓`)
      window.setTimeout(onDone, 900)
    } catch (e) {
      toast((e as Error).message, false)
      /* Rethrown only for the stop confirm so its strip stays open on a
         failed stop. Restart/start have no confirm to hold open, and
         rethrowing there leaks an unhandled rejection. */
      if (rethrow) throw e
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-line-2 py-2.5 first:border-t-0 first:pt-0">
      {!controlsOnly && (
        <>
          <span className="size-2 shrink-0 rounded-full" style={{ background: tone }} />
          <span className="min-w-0 flex-1 truncate text-[0.95rem]">{unit}</span>
          <span className="text-[0.82rem] text-muted">{state}</span>
        </>
      )}
      <div className="flex gap-1">
        {controlsOnly ? (
          <ConfirmAction
            label="Restart Service"
            confirmLabel="Restart"
            icon={<RotateCw />}
            disabled={busy}
            question={`Restart ${unit}?`}
            warning="This service will be briefly unavailable."
            onConfirm={() => act('restart', true)}
          />
        ) : (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void act('restart', false)}
            title="restart"
            aria-label="Restart"
          >
            <RotateCw />
          </Button>
        )}
        {on ? (
          /* Was an ICON-ONLY button whose accessible name went "stop" ->
             "really stop?" on the same element. A screen-reader user hears
             nothing change, presses Enter again, and a live service stops. */
          <ConfirmAction
            label={controlsOnly ? 'Stop Service' : 'stop'}
            confirmLabel="Stop"
            icon={<Square />}
            question={`Stop ${unit}?`}
            warning="It stays down until you start it again."
            disabled={busy}
            onConfirm={() => act('stop', true)}
          />
        ) : (
          <Button
            size="sm"
            variant={controlsOnly ? 'outline' : 'ghost'}
            title="start"
            aria-label={controlsOnly ? undefined : 'Start'}
            disabled={busy}
            onClick={() => void act('start', false)}
          >
            <Play /> {controlsOnly && 'Start Service'}
          </Button>
        )}
      </div>
    </div>
  )
}
