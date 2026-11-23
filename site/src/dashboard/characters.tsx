import { useEffect, useMemo, useState } from 'react'
import { core, type CoreCharacter } from '@/lib/core'
import { studioHref, studioPaths } from './studio-client'
import './studio.css'

type SourceFilter = 'all' | 'repository' | 'data'
type SortKey = 'name' | 'source' | 'language'

function matches(row: CoreCharacter, query: string): boolean {
  const hay = [row.displayName, row.id, ...(row.aliases ?? [])].join(' ').toLowerCase()
  return hay.includes(query.trim().toLowerCase())
}

function Artwork({ row }: { row: CoreCharacter }) {
  // No authorized art endpoint exists, so the tile is a legible initial.
  // It never stands in for a real persona image.
  const initial = row.displayName.trim().charAt(0).toUpperCase() || row.id.charAt(0).toUpperCase() || '?'
  return (
    <span className="studio-art" aria-hidden="true">
      {initial}
    </span>
  )
}

export default function Catalogue() {
  const [rows, setRows] = useState<CoreCharacter[] | null>(null)
  const [faults, setFaults] = useState<{ id: string; reason: string }[]>([])
  const [error, setError] = useState(false)
  const params = new URLSearchParams(location.search)
  const [query, setQuery] = useState(params.get('search') ?? '')
  const [source, setSource] = useState<SourceFilter>((params.get('source') as SourceFilter) || 'all')
  const [sort, setSort] = useState<SortKey>((params.get('sort') as SortKey) || 'name')

  useEffect(() => {
    let live = true
    core
      .characters()
      .then((data) => {
        if (!live) return
        setRows(data.characters)
        setFaults(data.faults)
      })
      .catch(() => {
        if (live) setError(true)
      })
    return () => {
      live = false
    }
  }, [])

  useEffect(() => {
    const url = new URL(location.href)
    for (const [key, value] of [
      ['search', query],
      ['source', source === 'all' ? '' : source],
      ['sort', sort === 'name' ? '' : sort]
    ]) {
      if (value) url.searchParams.set(key, value)
      else url.searchParams.delete(key)
    }
    history.replaceState(null, '', url)
  }, [query, source, sort])

  const visible = useMemo(() => {
    const list = (rows ?? [])
      .filter((row) => (source === 'all' || row.source === source) && matches(row, query))
      .slice()
    if (sort === 'name') list.sort((a, b) => a.displayName.localeCompare(b.displayName))
    if (sort === 'source')
      list.sort((a, b) => a.source.localeCompare(b.source) || a.displayName.localeCompare(b.displayName))
    if (sort === 'language')
      list.sort((a, b) => (a.languages[0] ?? '').localeCompare(b.languages[0] ?? ''))
    return list
  }, [rows, query, source, sort])

  return (
    <section className="studio-catalogue" aria-label="Character studio">
      <div className="studio-toolbar">
        <div className="studio-controls" role="search">
          <label>
            Search{' '}
            <input
              type="search"
              value={query}
              placeholder="Name, id or alias"
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <label>
            Source{' '}
            <select value={source} onChange={(e) => setSource(e.target.value as SourceFilter)}>
              <option value="all">All sources</option>
              <option value="data">Editable</option>
              <option value="repository">Built-in</option>
            </select>
          </label>
          <label>
            Sort{' '}
            <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
              <option value="name">Name</option>
              <option value="source">Source</option>
              <option value="language">Language</option>
            </select>
          </label>
        </div>
        <div className="studio-actions">
          <a className="studio-button" href={studioHref(studioPaths.create)}>
            Create
          </a>
          <a className="studio-button" href={studioHref(studioPaths.import)}>
            Import
          </a>
        </div>
      </div>

      {error ? (
        <p role="alert">Characters unavailable. The core did not answer.</p>
      ) : !rows ? (
        <p role="status">Loading…</p>
      ) : (
        <>
          {!visible.length && <p>No matching characters.</p>}
          <ul className="studio-grid">
            {visible.map((row) => (
              <li key={row.id} className="studio-card">
                <a className="studio-card-link" href={studioHref(studioPaths.edit(row.id))}>
                  <Artwork row={row} />
                  <span className="studio-card-name">{row.displayName}</span>
                </a>
                <span className="studio-card-meta">
                  <span className={'studio-source studio-source-' + row.source}>
                    {row.source === 'data' ? 'Editable' : 'Built-in'}
                  </span>
                  <span className="studio-card-id">{row.id}</span>
                  <span>{row.languages.join(' · ') || 'No language set'}</span>
                </span>
                <span className="studio-card-links">
                  {row.source === 'data' ? (
                    <a href={studioHref(studioPaths.footer(row.id))}>Tool wording</a>
                  ) : (
                    <span title="Built-in packs cannot be edited here">Read-only — copy to edit</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
          {!!faults.length && (
            <section className="studio-faults" aria-label="Packs that failed to load">
              <h2>Could not load</h2>
              <ul>
                {faults.map((fault) => (
                  <li key={fault.id}>
                    <strong>{fault.id}</strong> — {fault.reason}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </section>
  )
}
