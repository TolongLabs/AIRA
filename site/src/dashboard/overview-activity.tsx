import { useEffect, useId, useState } from 'react'
import { Activity } from 'lucide-react'
import { core, type CoreChat } from '@/lib/core'
import { ChartTooltip, useChartTooltip } from './chart-tooltip'
import { Loading } from './loading'

// Adapted from ObsidianUI Status Bars. Each cell represents a chat rather than a day.
// Keep the strip's single keyboard stop, pointer tracking and tap-to-pin interaction.
export function ChatStatusBars({ chats }: { chats: CoreChat[] }) {
  const tip = useChartTooltip()
  const { active } = tip
  const uid = useId()
  if (!chats.length) return <p>No chats yet.</p>
  function indexAt(x: number, box: DOMRect) {
    return Math.max(0, Math.min(chats.length - 1, Math.floor(((x - box.left) / box.width) * chats.length)))
  }
  const chat = active === null ? null : chats[active]
  function label(c: CoreChat) {
    const name = c.label.trim()
    const disclosable =
      name !== c.waId && !/^(?:whatsapp:.*|[+\d][\d .()-]{5,}|\S+@(?:g\.us|lid|s\.whatsapp\.net))$/i.test(name)
    return (disclosable && name) || (c.type === 'group' ? 'Unnamed group' : 'Unnamed direct chat')
  }
  return (
    <div
      className="chat-strip-wrap"
      onPointerLeave={(e) => {
        if (e.pointerType !== 'touch') tip.leave()
      }}
    >
      <div
        role="grid"
        aria-label="Chat reply status"
        aria-readonly="true"
        tabIndex={0}
        aria-activedescendant={chat ? uid + '-' + active : undefined}
        aria-describedby={chat ? tip.id : undefined}
        onFocus={(e) => {
          if (e.currentTarget.matches(':focus-visible')) tip.show(0)
        }}
        onBlur={tip.hide}
        onPointerMove={(e) => {
          if (e.pointerType !== 'touch') tip.hover(indexAt(e.clientX, e.currentTarget.getBoundingClientRect()))
        }}
        onClick={(e) => {
          const i = indexAt(e.clientX, e.currentTarget.getBoundingClientRect())
          tip.pin(i)
        }}
        onKeyDown={(e) => {
          const i = active ?? 0
          const next: Record<string, number> = {
            Home: 0,
            End: chats.length - 1,
            ArrowLeft: Math.max(0, i - 1),
            ArrowRight: Math.min(chats.length - 1, i + 1)
          }
          if (e.key === 'Escape') tip.hide()
          else if (e.key in next) {
            e.preventDefault()
            tip.show(next[e.key]!)
          }
        }}
      >
        <div ref={tip.plot} role="row" className="chat-status-bars">
          {chats.map((c, i) => (
            <span
              key={c.chatId}
              id={uid + '-' + i}
              role="gridcell"
              aria-label={label(c) + ' · ' + c.status}
              data-status={c.status}
              data-current={i === active}
            />
          ))}
        </div>
      </div>
      {chat && (
        <ChartTooltip tip={tip}>
          <b>{label(chat)}</b>
          <span>
            {chat.type === 'group' ? 'Group' : 'Direct chat'} · {chat.status === 'active' ? 'Active' : 'Pending'}
          </span>
          <small>
            {chat.lastInboundAt
              ? 'Last inbound ' + new Date(chat.lastInboundAt).toLocaleDateString()
              : 'No recorded inbound'}
          </small>
        </ChartTooltip>
      )}
    </div>
  )
}

const shortDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
const fullDate = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC'
})
const messages = (count: number) => count.toLocaleString() + ' inbound ' + (count === 1 ? 'message' : 'messages')
const format = (day: string) => shortDate.format(new Date(day + 'T12:00Z'))

export function ActivityCalendar() {
  const [data, setData] = useState<Awaited<ReturnType<typeof core.activity>> | null>(null)
  const [error, setError] = useState(false)
  const tip = useChartTooltip()
  const [selected, setSelected] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    core.activity().then(
      (d) => {
        if (live) setData(d)
      },
      () => {
        if (live) setError(true)
      }
    )
    return () => {
      live = false
    }
  }, [])
  const counts = new Map(data?.counts?.map((row) => [row.day, row.count]))
  const days: string[] = []
  if (data)
    for (let ms = Date.parse(data.start); ms <= Date.parse(data.today) && days.length < 91; ms += 86400000)
      days.push(new Date(ms).toISOString().slice(0, 10))
  const max = Math.max(1, ...counts.values())
  const day = selected ?? days.at(-1)
  const activeDay = tip.active === null ? undefined : days[tip.active]
  return (
    <section className="insight insight-traffic" aria-label="Activity">
      <div className="insight-heading">
        <Activity aria-hidden="true" />
        <h2>Activity</h2>
      </div>
      {error ? (
        <p>Traffic unavailable.</p>
      ) : !data ? (
        <Loading layout="metric" />
      ) : (
        <>
          <div className="traffic-summary">
            <strong>
              {Array.from(counts.values())
                .reduce((a, b) => a + b, 0)
                .toLocaleString()}
            </strong>
            <span>inbound messages · 13 weeks</span>
          </div>
          <div className="traffic-calendar">
            <div className="traffic-axis" aria-hidden="true">
              <span>{days[0] && format(days[0])}</span>
              <span>Today</span>
            </div>
            <div className="traffic-weekdays" aria-hidden="true">
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((weekday, i) => (
                <span key={weekday}>{i % 2 === 1 ? weekday : ''}</span>
              ))}
            </div>
            <div
              ref={tip.plot}
              className="traffic-grid"
              role="group"
              aria-label="Daily inbound messages, Sunday through Saturday, UTC"
              onPointerLeave={(e) => {
                if (e.pointerType !== 'touch') tip.leave()
              }}
            >
              {days.map((d, i) => {
                const n = counts.get(d) ?? 0
                return (
                  <button
                    key={d}
                    type="button"
                    aria-label={format(d) + ' (UTC), ' + messages(n)}
                    aria-describedby={tip.active === i ? tip.id : undefined}
                    tabIndex={day === d ? 0 : -1}
                    data-level={n ? 1 + Math.round(Math.sqrt(n / max) * 3) : 0}
                    data-current={tip.active === i}
                    onFocus={(e) => {
                      setSelected(d)
                      if (e.currentTarget.matches(':focus-visible')) tip.show(i)
                    }}
                    onBlur={tip.hide}
                    onPointerEnter={(e) => {
                      if (e.pointerType !== 'touch') tip.hover(i)
                    }}
                    onClick={() => tip.pin(i)}
                    onKeyDown={(e) => {
                      const move: Record<string, number> = {
                        ArrowLeft: -7,
                        ArrowRight: 7,
                        ArrowUp: -1,
                        ArrowDown: 1,
                        Home: -91,
                        End: 91
                      }
                      if (e.key in move) {
                        e.preventDefault()
                        const index = Math.min(days.length - 1, Math.max(0, i + move[e.key]!))
                        ;(tip.plot.current?.children[index] as HTMLButtonElement)?.focus()
                      }
                    }}
                  />
                )
              })}
            </div>
            <div className="traffic-key">
              <span>Fewer</span>
              {[0, 1, 2, 3, 4].map((level) => (
                <i key={level} data-level={level} aria-hidden="true" />
              ))}
              <span>More</span>
            </div>
          </div>
          {activeDay && (
            <ChartTooltip tip={tip}>
              <b>{fullDate.format(new Date(activeDay + 'T12:00Z'))} (UTC)</b>
              <span>{messages(counts.get(activeDay) ?? 0)}</span>
            </ChartTooltip>
          )}
        </>
      )}
    </section>
  )
}
