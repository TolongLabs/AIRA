import { useEffect, useMemo, useState } from 'react'
import { core, type CoreCharacter } from '@/lib/core'
import { Input } from '@/components/ui'
import { FormSelect } from './form-select'
import { WorkspaceTools } from './workspace-tools'
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
    if (sort === 'language') list.sort((a, b) => (a.languages[0] ?? '').localeCompare(b.languages[0] ?? ''))
    return list
  }, [rows, query, source, sort])

  return (
    <section className="studio-catalogue" aria-label="Character studio">
      <WorkspaceTools>
        <a className="workspace-tool" data-primary href={studioHref(studioPaths.create)}>
          Create
        </a>
        <a className="workspace-tool" href={studioHref(studioPaths.import)}>
          Import
        </a>
      </WorkspaceTools>
      <div className="studio-catalogue-meta">
        <span>Persona Catalogue</span>
        {rows && (
          <span>
            {visible.length} {visible.length === 1 ? 'Persona' : 'Personas'}
          </span>
        )}
      </div>
      <div className="studio-controls" role="search">
        <Input
          type="search"
          aria-label="Search personas"
          value={query}
          placeholder="Search Personas"
          onChange={(event) => setQuery(event.target.value)}
        />
        <FormSelect<SourceFilter>
          label="Filter personas"
          value={source}
          onChange={setSource}
          options={[
            { value: 'all', label: 'All sources' },
            { value: 'data', label: 'Editable' },
            { value: 'repository', label: 'Built-in' }
          ]}
        />
        <FormSelect<SortKey>
          label="Sort personas"
          value={sort}
          onChange={setSort}
          options={[
            { value: 'name', label: 'Name' },
            { value: 'source', label: 'Source' },
            { value: 'language', label: 'Language' }
          ]}
        />
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
                  <div className="studio-card-meta">
                    <span className="studio-card-name">{row.displayName}</span>
                    <span>
                      {row.source === 'data' ? 'Data Pack' : 'Built-In'} ·{' '}
                      {row.source === 'repository' ? 'Read Only' : row.languages.join(' · ') || 'No language set'}
                    </span>
                  </div>
                </a>
                {row.source === 'data' && (
                  <a className="studio-card-links" href={studioHref(studioPaths.footer(row.id))}>
                    Tool wording
                  </a>
                )}
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
