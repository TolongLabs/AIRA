import { useEffect, useState } from 'react'
import { core, type CoreChat } from '@/lib/core'
import { chatHref } from './navigation'

import SelectionTable from './selection-table'
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
  async function changeAccess(chat:CoreChat,status:CoreChat['status']){
    await core.setStatus(chat.chatId,status)
    setRows(previous=>previous?.map(row=>row.chatId===chat.chatId?{...row,status}:row)??null)
  }
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
        <SelectionTable rows={filtered} caption="Chat Directory" viewId={JSON.stringify([query,status])} page={page} onPageChange={setPage}
          getKey={c=>c.chatId} getRowLabel={c=>c.label||c.chatId}
          columns={[
            {id:'name',header:'Chat',render:c=><><a href={chatHref('chats/'+encodeURIComponent(c.chatId)+'/settings')}>{c.label||'Unnamed Chat'}</a><small>{c.chatId}</small></>},
            {id:'type',header:'Type',render:c=>c.type==='group'?'Group':'Direct'},
            {id:'status',header:'Access',render:c=>c.status}
          ]}
          bulkActions={[
            {id:'activate',label:'Activate',confirmMessage:'Allow AIRA to respond in these selected chats under their sender policies?',run:c=>changeAccess(c,'active')},
            {id:'pending',label:'Set Pending',confirmMessage:'Stop AIRA from answering in these selected chats?',run:c=>changeAccess(c,'pending')}
          ]}/>

      )}
    </section>
  )
}
