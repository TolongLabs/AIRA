import { useEffect, useState } from 'react'
import { core, type CoreChat } from '@/lib/core'
import { dashboardHref } from './navigation'

const pageSize = 20
export default function Directory() {
  const [rows, setRows] = useState<CoreChat[] | null>(null)
  const [error, setError] = useState(false)
  const params = new URLSearchParams(location.search)
  const [query, setQuery] = useState(params.get('search') ?? '')
  const [status, setStatus] = useState(params.get('status') ?? 'all')
  const [page, setPage] = useState(Math.max(1, Number(params.get('page')) || 1))
  useEffect(() => {
    let live = true
    core.chats().then(
      (data) => {
        if (live) setRows(data.chats)
      },
      () => {
        if (live) setError(true)
      }
    )
    return () => {
      live = false
    }
  }, [])
  const filtered = rows
    ?.filter((c) => (status === 'all' || c.status === status) && c.label.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => a.label.localeCompare(b.label))
  const pages = Math.max(1, Math.ceil((filtered?.length ?? 0) / pageSize))
  const current = Math.min(page, pages)
  useEffect(() => {
    const url = new URL(location.href)
    for (const [key, value] of [
      ['search', query],
      ['status', status === 'all' ? '' : status],
      ['page', page === 1 ? '' : String(page)]
    ]) {
      if (value) url.searchParams.set(key, value)
      else url.searchParams.delete(key)
    }
    history.replaceState(null, '', url)
  }, [query, status, page])
  return (
    <section className="directory">
      <label>
        Search chats{' '}
        <input
          type="search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setPage(1)
          }}
        />
      </label>
      <label>
        Access{' '}
        <select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value)
            setPage(1)
          }}
        >
          <option value="all">All Chats</option>
          <option value="active">Active</option>
          <option value="pending">Pending</option>
        </select>
      </label>
      {error ? (
        <p role="alert">Chat directory unavailable.</p>
      ) : !filtered ? (
        <p role="status">Loading…</p>
      ) : !filtered.length ? (
        <p>No matching chats.</p>
      ) : (
        <>
          <table>
            <caption>Chat Directory</caption>
            <thead>
              <tr>
                <th scope="col">Chat</th>
                <th scope="col">Type</th>
                <th scope="col">Access</th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice((current - 1) * pageSize, current * pageSize).map((c) => (
                <tr key={c.chatId}>
                  <td>
                    <a href={dashboardHref('chats/' + encodeURIComponent(c.chatId) + '/settings')}>
                      {c.label || 'Unnamed Chat'}
                    </a>
                  </td>
                  <td>{c.type === 'group' ? 'Group' : 'Direct'}</td>
                  <td>{c.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            {pageSize} per page · Page {current} of {pages}
          </p>
          <button disabled={current <= 1} onClick={() => setPage(current - 1)}>
            Previous
          </button>
          <button disabled={current >= pages} onClick={() => setPage(current + 1)}>
            Next
          </button>
        </>
      )}
    </section>
  )
}
