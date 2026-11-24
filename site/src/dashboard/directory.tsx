import { Loading } from '@/dashboard/loading'
import { useEffect, useState } from 'react'
import { ChevronRight, Search } from 'lucide-react'
import { Input } from '@/components/ui'
import { FormSelect } from './form-select'
import { WorkspaceTools } from './workspace-tools'
import { core, type CoreChat } from '@/lib/core'
import { chatHref } from './navigation'
import SelectionTable from './selection-table'

function inbound(iso: string | null | undefined): string {
  if (!iso) return 'Never'
  const date = new Date(iso)
  return Number.isFinite(date.getTime())
    ? date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
    : 'Unknown'
}

export default function Directory() {
  const [rows, setRows] = useState<CoreChat[] | null>(null)
  const [personas, setPersonas] = useState<Map<string, string> | null>(null)
  const [error, setError] = useState(false)
  const [personaId, setPersonaId] = useState('')
  const [readbackFailed, setReadbackFailed] = useState(false)
  const params = new URLSearchParams(location.search)
  const [query, setQuery] = useState(params.get('search') ?? '')
  const [status, setStatus] = useState(params.get('status') ?? 'all')
  const [order, setOrder] = useState(params.get('order') ?? 'recent')
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
    core.characters().then(
      (data) => {
        if (live) setPersonas(new Map(data.characters.map((pack) => [pack.id, pack.displayName])))
      },
      () => {
        if (live) setPersonas(new Map())
      }
    )
    return () => {
      live = false
    }
  }, [])

  const named = new Map<string, string>()
  const unnamed = { group: 0, dm: 0 }
  for (const chat of rows ?? []) {
    named.set(
      chat.chatId,
      chat.label.trim() || (chat.type === 'group' ? 'Unnamed group ' : 'Unnamed direct chat ') + ++unnamed[chat.type]
    )
  }
  const label = (chat: CoreChat) => named.get(chat.chatId) ?? 'Unnamed chat'
  const filtered = rows
    ?.filter(
      (chat) =>
        (status === 'all' || chat.status === status) && label(chat).toLowerCase().includes(query.trim().toLowerCase())
    )
    .sort(
      (a, b) =>
        (order === 'recent' ? (b.lastInboundAt ?? '').localeCompare(a.lastInboundAt ?? '') : 0) ||
        label(a).localeCompare(label(b), undefined, { numeric: true })
    )
  async function changeAccess(chat: CoreChat, status: CoreChat['status']) {
    await core.setStatus(chat.chatId, status)
    setRows((previous) => previous?.map((row) => (row.chatId === chat.chatId ? { ...row, status } : row)) ?? null)
  }
  async function reloadAssignments() {
    try {
      setRows((await core.chats()).chats)
      setReadbackFailed(false)
    } catch {
      setReadbackFailed(true)
    }
  }
  async function assignPersona(chat: CoreChat) {
    if (!chat.settingsRevision) throw new Error('Chat revision unavailable. Refresh the directory.')
    await core.setSetting('chat', chat.chatId, 'character', personaId, chat.settingsRevision)
  }

  const viewParams = new URLSearchParams(location.search)
  for (const [key, value] of [
    ['search', query],
    ['status', status === 'all' ? '' : status],
    ['order', order === 'recent' ? '' : order],
    ['page', page === 1 ? '' : String(page)]
  ]) {
    if (value) viewParams.set(key, value)
    else viewParams.delete(key)
  }
  const viewQuery = viewParams.toString()
  useEffect(() => {
    const url = new URL(location.href)
    url.search = viewQuery
    history.replaceState(history.state, '', url)
  }, [viewQuery])
  function fromDirectory(path: string) {
    return chatHref(path, viewParams)
  }
  return (
    <section className="directory">
      <WorkspaceTools>
        <a className="workspace-tool" href={fromDirectory('chats/defaults')}>
          Chat Defaults
        </a>
        <a className="workspace-tool" href={fromDirectory('chats/files')}>
          Send File
        </a>
      </WorkspaceTools>
      <div className="directory-filters">
        <div className="directory-search">
          <Search aria-hidden="true" size={16} />
          <Input
            type="search"
            aria-label="Search chats"
            placeholder="Search Chats"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setPage(1)
            }}
          />
        </div>
        <FormSelect
          label="Filter replies"
          options={[
            { value: 'all', label: 'All Statuses' },
            { value: 'active', label: 'Active' },
            { value: 'pending', label: 'Pending' }
          ]}
          value={status}
          onChange={(value) => {
            setStatus(value)
            setPage(1)
          }}
        />
        <FormSelect
          label="Sort chats"
          options={[
            { value: 'recent', label: 'Recent Activity' },
            { value: 'name', label: 'Chat Name' }
          ]}
          value={order}
          onChange={(value) => {
            setOrder(value)
            setPage(1)
          }}
        />
      </div>
      {readbackFailed && (
        <p role="alert">
          Could not reload persona assignments. <button onClick={() => void reloadAssignments()}>Retry</button>
        </p>
      )}
      {error ? (
        <p role="alert">Chat directory unavailable.</p>
      ) : !filtered ? (
        <Loading>Loading…</Loading>
      ) : !filtered.length ? (
        <p>No matching chats.</p>
      ) : (
        <SelectionTable
          rows={filtered}
          caption="Chat Directory"
          viewId={JSON.stringify([query, status, order])}
          page={page}
          pageSize={10}
          onPageChange={setPage}
          getKey={(chat) => chat.chatId}
          getRowLabel={label}
          columns={[
            {
              id: 'name',
              header: 'Chat',
              render: (chat) => (
                <div className="directory-chat">
                  <span className="directory-avatar" aria-hidden="true">
                    {label(chat)
                      .split(/\s+/)
                      .slice(0, 2)
                      .map((word) => Array.from(word)[0])
                      .join('')
                      .toUpperCase()}
                  </span>
                  <div>
                    <a href={fromDirectory('chats/' + encodeURIComponent(chat.chatId) + '/settings')}>{label(chat)}</a>
                    <small>{chat.type === 'group' ? 'Group Chat' : 'Direct Chat'}</small>
                  </div>
                </div>
              )
            },
            {
              id: 'persona',
              header: 'Persona',
              render: (chat) => {
                const id = chat.settings['character']?.value
                if (typeof id !== 'string' || !id) return 'Unassigned'
                return personas ? (personas.get(id) ?? 'Unavailable') : 'Loading…'
              }
            },
            {
              id: 'status',
              header: 'Replies',
              render: (chat) => (
                <span className="directory-replies" data-active={chat.status === 'active'}>
                  {chat.status === 'active' ? 'Active' : 'Pending'}
                </span>
              )
            },
            { id: 'activity', header: 'Last Inbound', render: (chat) => inbound(chat.lastInboundAt) },
            {
              id: 'settings',
              header: 'Actions',
              render: (chat) => (
                <a
                  className="directory-settings"
                  aria-label={'Settings for ' + label(chat)}
                  href={fromDirectory('chats/' + encodeURIComponent(chat.chatId) + '/settings')}
                >
                  Settings <ChevronRight size={14} aria-hidden="true" />
                </a>
              )
            }
          ]}
          bulkActions={[
            ...(!readbackFailed && personas?.size
              ? [
                  {
                    id: 'assign',
                    primary: true,
                    label: 'Assign Persona',
                    confirmMessage: 'Choose a persona for the selected chats.',
                    configure: (
                      <FormSelect
                        label="Persona to assign"
                        placeholder="Choose a persona"
                        value={personaId}
                        options={[...personas].map(([value, label]) => ({ value, label }))}
                        onChange={setPersonaId}
                      />
                    ),
                    confirmDisabled: !personaId,
                    run: assignPersona,
                    onFinish: reloadAssignments
                  }
                ]
              : []),
            {
              id: 'activate',
              label: 'Activate',
              confirmMessage: 'Allow AIRA to respond in these selected chats under their sender policies?',
              run: (chat) => changeAccess(chat, 'active')
            },
            {
              id: 'pending',
              label: 'Set Pending',
              confirmMessage: 'Stop AIRA from answering in these selected chats?',
              run: (chat) => changeAccess(chat, 'pending')
            }
          ]}
        />
      )}
    </section>
  )
}
