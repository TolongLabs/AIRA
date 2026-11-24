import { useEffect, useId, useRef, useState } from 'react'
import { Activity } from 'lucide-react'
import { core, type CoreChat } from '@/lib/core'
import { Loading } from './loading'

// Adapted from ObsidianUI Status Bars. Each cell represents a chat rather than a day.
// Keep the strip's single keyboard stop, pointer tracking and tap-to-pin interaction.
export function ChatStatusBars({ chats }: { chats: CoreChat[] }) {
  const [active, setActive] = useState<number | null>(null)
  const [pinned, setPinned] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const uid = useId()
  function hide() {
    setActive(null)
    setPinned(false)
  }
  useEffect(() => {
    if (!pinned) return
    const away = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) hide()
    }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [pinned])
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
      ref={root}
      onPointerLeave={(e) => {
        if (!pinned && e.pointerType === 'mouse') hide()
      }}
    >
      <div
        role="grid"
        aria-label="Chat reply status"
        aria-readonly="true"
        tabIndex={0}
        aria-activedescendant={chat ? uid + '-' + active : undefined}
        aria-describedby={chat ? uid + '-tip' : undefined}
        onFocus={(e) => {
          if (e.currentTarget.matches(':focus-visible')) setActive(0)
        }}
        onBlur={hide}
        onPointerMove={(e) => {
          if (e.pointerType === 'mouse' && !pinned)
            setActive(indexAt(e.clientX, e.currentTarget.getBoundingClientRect()))
        }}
        onClick={(e) => {
          const i = indexAt(e.clientX, e.currentTarget.getBoundingClientRect())
          if (pinned && i === active) hide()
          else {
            setActive(i)
            setPinned(true)
          }
        }}
        onKeyDown={(e) => {
          const i = active ?? 0
          const next: Record<string, number> = {
            Home: 0,
            End: chats.length - 1,
            ArrowLeft: Math.max(0, i - 1),
            ArrowRight: Math.min(chats.length - 1, i + 1)
          }
          if (e.key === 'Escape') hide()
          else if (e.key in next) {
            e.preventDefault()
            setActive(next[e.key]!)
          }
        }}
      >
        <div role="row" className="chat-status-bars">
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
        <div
          id={uid + '-tip'}
          role="tooltip"
          className="chat-status-tip"
          style={{ left: `clamp(0px,calc(${((active! + 0.5) / chats.length) * 100}% - 90px),max(0px,100% - 180px))` }}
        >
          <b>{label(chat)}</b>
          <span>
            {chat.type === 'group' ? 'Group' : 'Direct chat'} · {chat.status === 'active' ? 'Active' : 'Pending'}
          </span>
          <small>
            {chat.lastInboundAt
              ? 'Last inbound ' + new Date(chat.lastInboundAt).toLocaleDateString()
              : 'No recorded inbound'}
          </small>
        </div>
      )}
    </div>
  )
}

const shortDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
const format = (day: string) => shortDate.format(new Date(day + 'T12:00Z'))

export function ActivityCalendar() {
  const [data, setData] = useState<Awaited<ReturnType<typeof core.activity>> | null>(null)
  const [error, setError] = useState(false)
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
          <div className="traffic-axis">
            <span>{days[0] && format(days[0])}</span>
            <span>Today</span>
          </div>
          <div className="traffic-grid" aria-label="Daily inbound messages">
            {days.map((d, i) => {
              const n = counts.get(d) ?? 0
              return (
                <button
                  key={d}
                  type="button"
                  aria-label={format(d) + ', ' + n + ' inbound messages'}
                  tabIndex={day === d ? 0 : -1}
                  data-level={n ? 1 + Math.round(Math.sqrt(n / max) * 3) : 0}
                  onFocus={() => setSelected(d)}
                  onPointerEnter={() => setSelected(d)}
                  onClick={() => setSelected(d)}
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
                      const idx = Math.min(days.length - 1, Math.max(0, i + move[e.key]!))
                      ;(e.currentTarget.parentElement?.children[idx] as HTMLElement)?.focus()
                    }
                  }}
                />
              )
            })}
          </div>
          <small aria-live="polite">
            {day && format(day) + ' (UTC) · ' + (counts.get(day) ?? 0) + ' inbound messages'}
          </small>
        </>
      )}
    </section>
  )
}
